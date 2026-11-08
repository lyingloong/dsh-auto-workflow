/** Safety regressions from the independent audit. Green means the defect is blocked.
 * Only disposable OS-temp repositories are mutated; no install, remote access,
 * live model call, or Git operation on this checkout is performed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, lstat, cp } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { DevelopmentStore } from '../docs/examples/development/store.mjs';
import { git, prepare, snapshot, recordReview, integrate, cleanup } from '../docs/examples/development/worktrees.mjs';
import { stage } from '../docs/examples/development/driver.mjs';
import { normalizeDefinition } from '../src/definition.mjs';
import { newRunState, enqueue, run, decide, waitingHumanTokens } from '../src/runtime.mjs';
import { createExecutors } from '../src/executors.mjs';

const example = fileURLToPath(new URL('../docs/examples/development/', import.meta.url));
async function fixture(t, { materialize = false } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'audit-development-')));
  assert.ok(path.basename(root).startsWith('audit-development-'));
  const repo = path.join(root, 'repo');
  await mkdir(repo);
  t.after(async () => {
    assert.equal(await realpath(root), root);
    assert.ok(path.basename(root).startsWith('audit-development-'));
    await rm(root, { recursive: true, force: true });
  });
  await git(repo, 'init', '--initial-branch=main');
  for (const [key, value] of Object.entries({
    'user.name': 'Independent Audit', 'user.email': 'audit@invalid.local',
    'core.autocrlf': 'false', 'core.hooksPath': path.join(root, 'no-hooks'),
    'commit.gpgsign': 'false',
  })) await git(repo, 'config', key, value);
  await writeFile(path.join(repo, 'base.txt'), 'base\n');
  await writeFile(path.join(repo, '.gitignore'), 'local-only.txt\n');
  if (materialize) await cp(example, path.join(repo, 'docs', 'examples', 'development'), { recursive: true });
  await git(repo, 'add', '--all');
  await git(repo, 'commit', '-m', 'disposable audit base');
  const store = await DevelopmentStore.create({ dataRoot: path.join(root, 'data'), repoRoot: repo, integrationMode: 'local' });
  return { root, repo, store };
}
const requirement = (id, extra = {}) => ({ id, source: 'user', title: id, description: `Audit ${id}`, risk: 'low', ...extra });
async function prepared(store, id = 'req-audit') {
  await store.upsertRequirement(requirement(id));
  const [envelope] = await store.claimBatch(1);
  await store.route(id, envelope.claimId);
  const ready = await prepare(store, id, envelope.claimId);
  const item = await store.beginEngineering(id, envelope.claimId, { expectedRevision: ready.revision, expectedEpoch: ready.engineeringEpoch });
  return { id, claimId: envelope.claimId, dataRef: store.ref(id), cwd: item.worktreePath, revision: item.revision, expectedRevision: item.revision, engineeringEpoch: item.engineeringEpoch };
}
async function implemented(store, item, file = 'implementation.txt', contents = 'implemented\n') {
  await writeFile(path.join(item.cwd, file), contents);
  await git(item.cwd, 'add', '--force', file);
  await git(item.cwd, 'commit', '-m', 'disposable audit implementation');
  return snapshot(store, item.id, item.claimId, { expectedRevision: item.revision, engineeringEpoch: item.engineeringEpoch, summary: 'Audit implementation', verification: 'isolated test' });
}
async function review(store, item, artifact, decision = 'pass') {
  return recordReview(store, item.id, item.claimId, {
    artifactRef: artifact.artifactRef, commit: artifact.commit, decision,
    summary: decision === 'pass' ? 'Reviewed pinned commit' : 'Missing a necessary case',
    verification: 'isolated fixture checks', reviewer: 'audit-reviewer',
  });
}
async function approved(store, item, artifact) {
  await review(store, item, artifact);
  await store.mergeDecision(item.id, item.claimId, { decision: 'approve', artifactRef: artifact.artifactRef, actor: 'audit-human' });
}
function memoryIO() {
  const values = new Map(); let sequence = 0;
  return {
    put: async value => { const ref = `audit-${++sequence}`; values.set(ref, structuredClone(value)); return ref; },
    get: async ref => structuredClone(values.get(ref)), archive: async () => {},
  };
}
async function graphFixture(t, reply) {
  const fixtureValue = await fixture(t, { materialize: true });
  const raw = JSON.parse(await readFile(path.join(example, 'workflow.json'), 'utf8'));
  for (const node of raw.nodes.filter(node => node.type === 'gate')) node.config.delayMs = 0; // Scheduling only; no node/edge removed.
  const definition = normalizeDefinition(raw), io = memoryIO();
  const state = await newRunState({ definition, cwd: fixtureValue.repo, permissions: {
    command: { mode: 'allowlist', allow: ['node docs/examples/development/driver.mjs'] },
  }, input: { dataRoot: fixtureValue.store.root } }, io);
  const calls = [];
  const executors = createExecutors({ cwd: fixtureValue.repo, exec: {}, ctx: { get: name => name === 'subagents' ? {
    startActivation: async request => {
      const prompt = request.request.prompt[0].text;
      const nodeId = request.label.slice('workflow:'.length);
      const input = JSON.parse(prompt.split('Input:\n')[1].split('\n\nContext:\n')[0]);
      calls.push({ nodeId, input, cwd: request.request.cwd });
      const answer = await reply({ nodeId, input, fixture: fixtureValue, calls });
      return { childId: `audit-child-${calls.length}`, result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: JSON.stringify(answer) }] }), dispose: async () => {} };
    },
  } : null } });
  return { ...fixtureValue, definition, io, state, executors, calls };
}
async function engineerReply({ input, calls }) {
  const round = calls.filter(call => call.nodeId === 'engineer').length;
  await writeFile(path.join(input.cwd, 'change.txt'), `round ${round}\n`);
  await git(input.cwd, 'add', 'change.txt');
  await git(input.cwd, 'commit', '-m', `disposable graph round ${round}`);
  return { outcome: 'complete', output: { summary: `round ${round}`, verification: 'real temporary commit and clean HEAD' } };
}
const reviewReply = decision => ({ outcome: decision, output: { decision, summary: decision === 'pass' ? 'Pinned commit passes' : 'Another required case', verification: 'temporary fixture check', reviewer: 'audit-reviewer' } });

test('audit coverage: complete production graph uses real command executor + model-text parser through all feedback loops and merge', { timeout: 60_000 }, async t => {
  const fx = await graphFixture(t, async args => {
    const { nodeId, input, calls } = args;
    if (nodeId === 'miner') return { outcome: 'proposal', output: { proposal: { title: 'Audit mined', description: 'Concrete bounded behavior', risk: 'mid', priority: 2 } } };
    if (nodeId === 'analyst-revise') {
      const item = JSON.parse(await readFile(input.dataRef, 'utf8'));
      return { outcome: 'complete', output: { proposal: { expectedRevision: item.revision, title: 'Revised same item', description: 'Bounded to requested feedback', risk: 'mid' } } };
    }
    if (nodeId === 'engineer') return engineerReply(args);
    assert.equal(nodeId, 'reviewer');
    assert.equal(await git(input.cwd, 'rev-parse', 'HEAD'), input.commit);
    return reviewReply(calls.filter(call => call.nodeId === 'reviewer').length === 1 ? 'revise' : 'pass');
  });
  await fx.store.upsertSeed({ id: 'seed-audit', title: 'Audit seed', evidence: 'Real temporary source' });
  await enqueue(fx.state, { nodeId: 'mine-gate', input: { dataRoot: fx.store.root } }, fx.io);
  let producerEnabled = true;
  const command = fx.executors.command, injectedBusy = new Set();
  fx.executors.command = async args => {
    // Inject admission contention BEFORE invoking each real command once. The
    // real-lock test below separately verifies the driver's busy classification.
    if (!injectedBusy.has(args.node.id)) { injectedBusy.add(args.node.id); return { outcome: 'busy', output: structuredClone(args.input) }; }
    const output = await command(args);
    if (args.node.id === 'route') producerEnabled = false;
    return output;
  };
  const runSlice = () => run(fx.state, fx.executors, { io: fx.io, control: () => ({ nodes: { 'mine-gate': producerEnabled } }), maxSteps: 150 });
  const choose = async (nodeId, outcome, note) => {
    const token = waitingHumanTokens(fx.state).find(token => token.nodeId === nodeId);
    assert.ok(token, JSON.stringify(fx.state.tokens));
    await decide(fx.state, { tokenId: token.id, outcome, output: { note, actor: 'audit-human' } }, fx.io);
    await runSlice();
  };
  await runSlice();
  assert.equal((await fx.store.get('req-audit')).status, 'requirement-pending');
  await choose('requirement-human', 'reject', 'Keep identity; narrow scope');
  assert.equal((await fx.store.get('req-audit')).revision, 2);
  await choose('requirement-human', 'approve', 'Approve revised requirement');
  const before = await fx.store.get('req-audit');
  assert.equal(before.status, 'human-pending');
  assert.equal(before.reviews.length, 2);
  await choose('merge-human', 'revise', 'Add the final case');
  const after = await fx.store.get('req-audit');
  assert.equal(after.implementation.artifactRevision, 3);
  assert.equal(after.worktreePath, before.worktreePath);
  const worktreePath = after.worktreePath;
  assert.equal(await git(worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'), 'auto/req-audit');
  await choose('merge-human', 'approve', 'Approve exact reviewed artifact');
  const merged = await fx.store.get('req-audit');
  assert.equal(merged.status, 'merged');
  assert.equal(merged.integration.state, 'verified');
  assert.equal(merged.worktreePath, null);
  assert.equal(merged.cleanedWorktreePath, worktreePath);
  await assert.rejects(lstat(worktreePath), { code: 'ENOENT' });
  assert.equal(await git(fx.repo, 'branch', '--format=%(refname:short)'), 'main');
  assert.equal(fx.state.counts.packetsFailed, 0, JSON.stringify(fx.state.tokens));
  assert.equal(fx.calls.filter(call => call.nodeId === 'miner').length, 1);
  for (const call of fx.calls.filter(call => ['engineer', 'reviewer'].includes(call.nodeId))) assert.equal(call.cwd, worktreePath);
});

test('audit coverage: real command graph permits simultaneous three engineers plus three reviewers', { timeout: 60_000 }, async t => {
  const active = { engineer: 0, reviewer: 0 }, peak = { engineer: 0, reviewer: 0 };
  let firstThreeDone = 0, releaseFirst, releaseOverlap, simultaneous = false;
  const first = new Promise(resolve => { releaseFirst = resolve; });
  const overlap = new Promise(resolve => { releaseOverlap = resolve; });
  const fx = await graphFixture(t, async args => {
    const { nodeId, calls } = args;
    assert.ok(['engineer', 'reviewer'].includes(nodeId));
    const ordinal = calls.filter(call => call.nodeId === nodeId).length;
    active[nodeId]++; peak[nodeId] = Math.max(peak[nodeId], active[nodeId]);
    if (active.engineer === 3 && active.reviewer === 3) { simultaneous = true; releaseOverlap(); }
    try {
      if (nodeId === 'engineer') {
        const result = await engineerReply(args);
        if (ordinal <= 3) { if (++firstThreeDone === 3) releaseFirst(); await first; }
        else await overlap;
        return result;
      }
      await overlap;
      return reviewReply('pass');
    } finally { active[nodeId]--; }
  });
  for (let index = 0; index < 6; index++) await fx.store.upsertRequirement(requirement(`req-pool-${index}`));
  await enqueue(fx.state, { input: { dataRoot: fx.store.root } }, fx.io);
  await run(fx.state, fx.executors, { io: fx.io, maxSteps: 150 });
  assert.equal(simultaneous, true);
  assert.deepEqual(peak, { engineer: 3, reviewer: 3 });
  assert.equal(waitingHumanTokens(fx.state).length, 6);
  assert.equal(fx.state.counts.packetsFailed, 0, JSON.stringify(fx.state.tokens));
});

test('audit regression: more than three valid revisions persist every review and reach Human on the same id/worktree', { timeout: 60_000 }, async t => {
  const fx = await graphFixture(t, async args => args.nodeId === 'engineer' ? engineerReply(args) : reviewReply(args.calls.filter(call => call.nodeId === 'reviewer').length <= 4 ? 'revise' : 'pass'));
  await fx.store.upsertRequirement(requirement('req-cap'));
  await run(fx.state, fx.executors, { io: fx.io, maxSteps: 150 });
  const item = await fx.store.get('req-cap');
  assert.equal(fx.calls.filter(call => call.nodeId === 'reviewer').length, 5);
  assert.equal(fx.state.counts.packetsFailed, 0, JSON.stringify(fx.state.tokens));
  assert.equal(item.status, 'human-pending');
  assert.equal(item.reviews.length, 5);
  assert.deepEqual(item.reviews.map(entry => entry.decision), ['revise', 'revise', 'revise', 'revise', 'pass']);
  assert.equal(item.implementation.artifactRevision, 5); assert.equal(item.engineeringEpoch, 5);
  assert.equal(new Set(fx.calls.map(call => call.cwd)).size, 1);
  assert.equal(waitingHumanTokens(fx.state).length, 1);
});

test('audit regression: old requirement approval cannot approve a newer revision under the same claim', async t => {
  const { store } = await fixture(t);
  const id = 'req-stale';
  await store.upsertRequirement(requirement(id, { source: 'mined', seedId: 'seed-stale', risk: 'mid' }));
  const [envelope] = await store.claimBatch(1);
  await stage('route', envelope);
  const obsoleteApproval = { ...envelope, expectedRevision: 1, decision: 'approve', actor: 'human-reviewed-r1' };
  await stage('requirement-decision', { ...envelope, expectedRevision: 1, decision: 'reject', note: 'Narrow scope' });
  await stage('revise-proposal', { ...envelope, proposal: { expectedRevision: 1, title: 'Changed scope', description: 'Revision two not seen by old approver', risk: 'high' } });
  await stage('route', envelope);
  assert.equal((await store.get(id)).revision, 2);
  await assert.rejects(stage('requirement-decision', obsoleteApproval), /Stale requirement approval revision/);
  assert.equal((await store.get(id)).status, 'requirement-pending');
  assert.equal((await store.get(id)).requirementApproval, null);
  await stage('requirement-decision', { ...obsoleteApproval, expectedRevision: 2, actor: 'human-reviewed-r2' });
  assert.equal((await store.get(id)).requirementApproval.revision, 2);
});

test('audit regression: stale engineering admission and snapshot cannot cross a rework epoch', async t => {
  const { store } = await fixture(t);
  const item = await prepared(store);
  await writeFile(path.join(item.cwd, 'implementation.txt'), 'first attempt\n');
  await git(item.cwd, 'add', '--all'); await git(item.cwd, 'commit', '-m', 'disposable first attempt');
  const oldResponse = { ...item, summary: 'Old engineering attempt', verification: 'Only old attempt checked' };
  const first = await stage('snapshot', oldResponse);
  await review(store, item, first.output, 'revise');
  const ready = await store.get(item.id);
  await assert.rejects(stage('snapshot', oldResponse), /Stale/);
  await assert.rejects(store.beginEngineering(item.id, item.claimId, { expectedRevision: 1, expectedEpoch: 0 }), /Stale/);
  await store.beginEngineering(item.id, item.claimId, { expectedRevision: ready.revision, expectedEpoch: ready.engineeringEpoch });
  await assert.rejects(stage('snapshot', oldResponse), /Stale/);
  const current = await store.get(item.id);
  assert.equal(current.status, 'engineering'); assert.equal(current.engineeringEpoch, 2);
  assert.equal(current.implementation.artifactRevision, 1);
  const fresh = await stage('snapshot', { ...oldResponse, engineeringEpoch: current.engineeringEpoch, verification: 'Fresh round reviewed the feedback' });
  assert.equal(fresh.output.artifactRevision, 2);
});

test('audit regression: approved merge refuses ignored target collisions before Git changes the target', async t => {
  const { store, repo } = await fixture(t);
  const item = await prepared(store);
  const artifact = await implemented(store, item, 'local-only.txt', 'reviewed replacement\n');
  await approved(store, item, artifact);
  await writeFile(path.join(repo, 'local-only.txt'), 'valuable untracked local contents\n');
  assert.equal(await git(repo, 'status', '--porcelain'), '');
  assert.ok((await git(repo, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z')).split('\0').includes('local-only.txt'), 'explicit ignored-file preflight can detect the endangered data');
  const head = await git(repo, 'rev-parse', 'HEAD');
  await assert.rejects(integrate(store, item.id, item.claimId), /overwrite ignored local data/);
  assert.equal(await readFile(path.join(repo, 'local-only.txt'), 'utf8'), 'valuable untracked local contents\n');
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), head);
  assert.equal((await store.get(item.id)).status, 'approved');
  await assert.rejects(git(repo, 'rev-parse', '--verify', 'MERGE_HEAD'));
  await rm(path.join(repo, 'local-only.txt')); // Only the fixture-owned file.
  await mkdir(path.join(repo, 'local-only.txt'));
  await writeFile(path.join(repo, 'local-only.txt', 'nested-data'), 'nested valuable data');
  await assert.rejects(integrate(store, item.id, item.claimId), /overwrite ignored local data/);
  assert.equal(await readFile(path.join(repo, 'local-only.txt', 'nested-data'), 'utf8'), 'nested valuable data');
});

test('audit regression: cleanup force-removes ignored worktree leftovers after verified merge', async t => {
  const { store } = await fixture(t);
  const item = await prepared(store); const artifact = await implemented(store, item);
  await approved(store, item, artifact); await integrate(store, item.id, item.claimId);
  await writeFile(path.join(item.cwd, 'local-only.txt'), 'disposable worktree-local data\n');
  assert.equal(await git(item.cwd, 'status', '--porcelain'), '');
  assert.equal((await cleanup(store, item.id, item.claimId, { cleanup: true })).outcome, 'cleaned');
  await assert.rejects(lstat(item.cwd), { code: 'ENOENT' });
  assert.ok((await store.get(item.id)).cleanedWorktreePath);
});

test('audit regression: uncertain snapshot reconciles explicitly then resumes the real CLI graph without overwrite', async t => {
  const { store, repo } = await fixture(t, { materialize: true });
  const item = await prepared(store);
  await writeFile(path.join(item.cwd, 'implementation.txt'), 'implemented\n');
  await git(item.cwd, 'add', '--all'); await git(item.cwd, 'commit', '-m', 'disposable artifact crash');
  const save = store.save.bind(store);
  store.save = async value => {
    if (value.status === 'reviewing') throw new Error('injected failure after immutable artifact write');
    return save(value);
  };
  const input = { ...item, summary: 'implemented', verification: 'verified' };
  await assert.rejects(snapshot(store, item.id, item.claimId, input), /injected/);
  store.save = save;
  const reopened = await DevelopmentStore.open(store.root);
  const pending = await reopened.get(item.id);
  assert.equal(pending.status, 'snapshot-pending');
  const artifactRef = pending.pendingSnapshot.artifactRef;
  const immutableBefore = await readFile(artifactRef, 'utf8');
  assert.equal(JSON.parse(immutableBefore).commit, await git(item.cwd, 'rev-parse', 'HEAD'));
  await assert.rejects(snapshot(reopened, item.id, item.claimId, input), /explicitly reconcile-snapshot/);
  await assert.rejects(stage('reconcile-snapshot', { ...input, decision: 'finalize', note: 'Inspected uncertain write', engineeringEpoch: 0 }), /matching uncertain/);
  const recovered = await stage('reconcile-snapshot', { ...input, decision: 'finalize', note: 'Operator checked intent, pinned HEAD and exact artifact' });
  assert.equal(recovered.outcome, 'complete');
  assert.equal((await reopened.get(item.id)).status, 'reviewing');
  assert.equal((await reopened.get(item.id)).pendingSnapshot, null);
  assert.equal((await reopened.get(item.id)).snapshotReconciliations.length, 1);
  assert.equal(await readFile(artifactRef, 'utf8'), immutableBefore);
  await assert.rejects(stage('reconcile-snapshot', { ...input, decision: 'finalize', note: 'Duplicate decision' }), /matching uncertain/);
  const raw = JSON.parse(await readFile(path.join(example, 'workflow.json'), 'utf8')); raw.entry = 'review-input';
  const io = memoryIO();
  const state = await newRunState({ definition: normalizeDefinition(raw), cwd: repo, permissions: { command: { mode: 'allowlist', allow: ['node docs/examples/development/driver.mjs'] } }, input: recovered.output }, io);
  const executors = createExecutors({ cwd: repo, exec: {}, ctx: { get: () => ({ startActivation: async request => {
    assert.equal(request.label, 'workflow:reviewer', 'recovery must not rerun engineering');
    return { childId: 'audit-recovered-review', result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: JSON.stringify(reviewReply('pass')) }] }), dispose: async () => {} };
  } }) } });
  await run(state, executors, { io, maxSteps: 50 });
  assert.equal(state.counts.packetsFailed, 0, JSON.stringify(state.tokens));
  const [human] = waitingHumanTokens(state); assert.equal(human.nodeId, 'merge-human');
  await decide(state, { tokenId: human.id, outcome: 'approve', output: { note: 'Approve the explicitly reconciled and reviewed artifact' } }, io);
  await run(state, executors, { io, maxSteps: 50 });
  assert.equal(state.counts.packetsFailed, 0, JSON.stringify(state.tokens));
  assert.equal((await store.get(item.id)).status, 'merged');
});

test('audit regression: lock contention safely requeues exact inputs and preserves claims and the producer', { timeout: 40_000 }, async t => {
  const { store, repo } = await fixture(t, { materialize: true });
  await store.upsertRequirement(requirement('req-lock'));
  const [envelope] = await store.claimBatch(1);
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const holder = store.locked(async () => { entered(); await delay(11_500); });
  await ready;
  const io = memoryIO();
  const raw = JSON.parse(await readFile(path.join(example, 'workflow.json'), 'utf8'));
  raw.entry = 'route';
  raw.nodes.find(node => node.id === 'mine-gate').config.delayMs = 0;
  const state = await newRunState({ definition: normalizeDefinition(raw), cwd: repo, permissions: { command: { mode: 'allowlist', allow: ['node docs/examples/development/driver.mjs'] } }, input: envelope }, io);
  await enqueue(state, { nodeId: 'mine-gate', input: { dataRoot: store.root } }, io);
  const executors = createExecutors({ cwd: repo, exec: {}, ctx: {} });
  const command = executors.command, busyNodes = new Set(); let producerEnabled = true;
  executors.command = async args => {
    const response = await command(args);
    if (response.outcome === 'busy') { busyNodes.add(args.node.id); assert.deepEqual(response.output, args.input); }
    if (args.node.id === 'seed-batch' && response.outcome === 'idle') producerEnabled = false;
    return response;
  };
  await run(state, executors, { io, maxSteps: 50, control: () => ({ nodes: { prepare: false, 'mine-gate': producerEnabled } }) });
  await holder;
  assert.equal(state.counts.packetsFailed, 0, JSON.stringify(state.tokens));
  assert.deepEqual([...busyNodes].sort(), ['route', 'seed-batch']);
  assert.ok(state.tokens.some(token => token.nodeId === 'mine-gate' && token.status === 'ready'));
  assert.ok(state.tokens.some(token => token.nodeId === 'prepare' && token.status === 'ready'));
  assert.equal((await store.get('req-lock')).status, 'ready');
  assert.equal((await store.get('req-lock')).claimId, envelope.claimId);
  assert.deepEqual(await store.claimBatch(3), [], 'safe busy retry never duplicates admission');
});
