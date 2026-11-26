/** Self-healing store/integration locks for the development example. */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { DevelopmentStore } from '../docs/examples/development/store.mjs';

const execute = promisify(execFile);
const driver = fileURLToPath(new URL('../docs/examples/development/driver.mjs', import.meta.url));
const holder = fileURLToPath(new URL('./fixtures/hold-lock.mjs', import.meta.url));

async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aw-locks-')));
  t.after(async () => { assert.ok(path.basename(root).startsWith('aw-locks-')); await rm(root, { recursive: true, force: true }); });
  const repo = path.join(root, 'repo'); await mkdir(repo);
  const store = await DevelopmentStore.create({ dataRoot: path.join(root, 'data'), repoRoot: repo, integrationMode: 'local', ...options });
  return { root, store };
}

async function writeLock(store, name, { ageMs = 0, token = 'old-token', pid = 999_999, host = 'old-host' } = {}) {
  const lock = path.join(store.root, 'locks', `${name}.lock`);
  await mkdir(lock, { recursive: true });
  const at = new Date(Date.now() - ageMs).toISOString();
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ token, pid, host, acquiredAt: at, updatedAt: at, runId: 'run-old', tokenId: 'token-old' }));
  return lock;
}

async function events(store) {
  try { return await readFile(path.join(store.root, 'locks', 'events.log'), 'utf8'); }
  catch { return ''; }
}

test('a stale lock is taken over, audited and released', async t => {
  const { store } = await fixture(t);
  const lock = await writeLock(store, 'store', { ageMs: 10 * 60_000 });
  assert.equal(await store.locked(async () => 'ok', 'store'), 'ok');
  assert.equal(existsSync(lock), false);
  const backups = (await readdir(path.join(store.root, 'locks', '.stale'))).filter(name => name.startsWith('store-'));
  assert.equal(backups.length, 1);
  const log = await events(store);
  assert.match(log, /"event":"takeover"/);
  assert.match(log, /ttl-expired/);
  assert.match(log, /run-old/);
});

test('a live lock is not removed and contention is explicit', async t => {
  const { store } = await fixture(t);
  const lock = await writeLock(store, 'integration', { ageMs: 0 });
  await assert.rejects(
    store.locked(async () => assert.fail('must not enter a live lock'), 'integration', { timeoutMs: 50 }),
    error => error.code === 'business_busy' && /owner pid 999999/.test(error.message) && /old-host/.test(error.message),
  );
  assert.equal(existsSync(lock), true);
  assert.equal((await readdir(path.join(store.root, 'locks', '.stale')).catch(() => [])).length, 0);
});

test('concurrent lockers serialize without losing the lock', async t => {
  const { store } = await fixture(t);
  const order = [];
  await Promise.all([
    store.locked(async () => { order.push('a'); await delay(30); }, 'store'),
    store.locked(async () => { order.push('b'); }, 'store'),
  ]);
  assert.deepEqual(order, ['a', 'b']);
  assert.equal(existsSync(path.join(store.root, 'locks', 'store.lock')), false);
});

test('lock status and explicit repair report stale locks without touching live ones', async t => {
  const { store } = await fixture(t);
  const stale = await writeLock(store, 'store', { ageMs: 10 * 60_000 });
  const live = await writeLock(store, 'integration', { ageMs: 0 });
  const status = await DevelopmentStore.lockStatus({ dataRoot: store.root });
  assert.equal(status.locks.find(lock => lock.name === 'store').stale, true);
  assert.equal(status.locks.find(lock => lock.name === 'integration').stale, false);
  const dry = await DevelopmentStore.repairLocks({ dataRoot: store.root });
  assert.equal(dry.locks.length, 1);
  assert.equal(dry.locks[0].action, 'would-takeover');
  assert.equal(existsSync(stale), true);
  const applied = await DevelopmentStore.repairLocks({ dataRoot: store.root, apply: true });
  assert.equal(applied.locks[0].action, 'takeover');
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(live), true);
  assert.match(await events(store), /"event":"takeover"/);
});

test('an owner-less lock is taken over only after its orphan grace period', async t => {
  const { store } = await fixture(t);
  const lock = path.join(store.root, 'locks', 'store.lock');
  await mkdir(lock, { recursive: true });
  await assert.rejects(store.locked(async () => 'too-early', 'store', { timeoutMs: 50 }), error => error.code === 'business_busy');
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  assert.equal(await store.locked(async () => 'ok', 'store'), 'ok');
  assert.equal(existsSync(lock), false);
});

test('a hard-killed owner is taken over after its heartbeat expires', async t => {
  const { root, store } = await fixture(t, { lockTtlMs: 5_000 });
  const ready = path.join(root, 'held.json');
  const child = spawn(process.execPath, [holder, store.root, ready], { stdio: 'ignore' });
  t.after(() => { try { child.kill(); } catch { /* already gone */ } });
  for (let attempt = 0; attempt < 100 && !existsSync(ready); attempt += 1) await delay(20);
  assert.ok(existsSync(ready), 'child acquired the lock');
  if (process.platform === 'win32') child.kill();
  else child.kill('SIGKILL');
  await new Promise(resolve => child.once('exit', resolve));
  // Age the persisted heartbeat instead of waiting the full TTL in CI.
  const ownerPath = path.join(store.root, 'locks', 'store.lock', 'owner.json');
  const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
  owner.updatedAt = new Date(Date.now() - 60_000).toISOString();
  await writeFile(ownerPath, JSON.stringify(owner));
  assert.equal(await store.locked(async () => 'recovered', 'store'), 'recovered');
  assert.match(await events(store), /ttl-expired/);
});

test('the driver exposes lock status and repair stages', async t => {
  const { store } = await fixture(t);
  await writeLock(store, 'store', { ageMs: 10 * 60_000 });
  const run = async input => {
    const { stdout } = await execute(process.execPath, [driver, 'locks'], { env: { ...process.env, DSH_WORKFLOW_INPUT: JSON.stringify(input) }, windowsHide: true });
    return JSON.parse(stdout);
  };
  const dry = await run({ dataRoot: store.root });
  assert.equal(dry.outcome, 'complete');
  assert.equal(dry.output.locks[0].action, 'would-takeover');
  const applied = await run({ dataRoot: store.root, apply: true });
  assert.equal(applied.output.locks[0].action, 'takeover');
  assert.equal((await run({ dataRoot: store.root })).outcome, 'idle');
});

test('lock TTL is validated and persisted immutably', async t => {
  const { store } = await fixture(t, { lockTtlMs: 5_000 });
  assert.equal((await DevelopmentStore.open(store.root)).config.lockTtlMs, 5_000);
  await assert.rejects(DevelopmentStore.create({ dataRoot: store.root, repoRoot: store.config.repoRoot, integrationMode: 'local', lockTtlMs: 6_000 }), /immutable/);
  await assert.rejects(fixture(t, { lockTtlMs: 1_000 }), /Invalid lock TTL/);
});
