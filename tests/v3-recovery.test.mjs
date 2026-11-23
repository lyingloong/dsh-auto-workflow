/** Scheduling recovery: failed work is evidence, never a silently wedged run. */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { normalizeDefinition } from '../src/definition.mjs';
import { newRunState, enqueue, run } from '../src/runtime.mjs';
import { SessionStore } from '../src/store.mjs';
import { summarizeRun } from '../src/view.mjs';

async function fixture(t, nodes, edges = []) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workflow-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SessionStore(directory);
  const io = store.createIO('run-recovery');
  const definition = normalizeDefinition({ apiVersion: 2, name: 'recovery', nodes, edges });
  const state = await newRunState({ definition, permissions: { command: { mode: 'full' } }, input: { id: 'initial' }, cwd: directory }, io);
  return { io, state };
}

test('a ready token in an inactive packet is archived instead of wedging the run', async t => {
  const { io, state } = await fixture(t, [{ id: 'work', type: 'command', config: { command: 'noop' } }]);
  for (const packet of Object.values(state.packets)) packet.status = 'failed';
  let executed = 0;
  await run(state, { command: async () => { executed += 1; return { outcome: 'complete', output: {} }; } }, { io, maxSteps: 10 });
  assert.equal(executed, 0);
  assert.equal(state.tokens.length, 0);
  assert.equal(state.counts.queued, 0);
  assert.equal(state.status, 'idle');
  const record = state.recent.find(entry => entry.status === 'cancelled' && entry.reason === 'packet_not_active');
  assert.ok(record, 'the unrunnable token is retained as history');
});

test('a failed token stays as hot evidence and is not reported as the current run error', async t => {
  const { io, state } = await fixture(t, [{ id: 'work', type: 'agent', config: { prompt: 'x', outcomes: ['complete'] } }]);
  await run(state, { agent: async () => ({ outcome: 'fail', output: {} }) }, { io, maxSteps: 10 });
  assert.equal(state.tokens.filter(token => token.status === 'failed').length, 1);
  assert.equal(state.counts.failedActive, 1);
  assert.equal(state.counts.failed, 1);
  const view = summarizeRun(state);
  assert.equal(view.error, '', 'a historical failure is not a run-level error');
  assert.equal(view.lastFailure?.code, 'unhandled_failure');
  assert.match(view.lastFailure?.message ?? '', /without a matching edge/);
  const record = state.recent.find(entry => entry.type === 'token' && entry.status === 'failed');
  assert.ok(record, 'the failure record is retained');
});

test('independent ready packets keep executing after another packet fails', async t => {
  const { io, state } = await fixture(t, [
    { id: 'bad', type: 'agent', config: { prompt: 'x', outcomes: ['complete'] } },
    { id: 'good', type: 'command', config: { command: 'noop' } },
  ]);
  await enqueue(state, { nodeId: 'good', input: { id: 'good' } }, io);
  let executed = 0;
  await run(state, {
    agent: async () => ({ outcome: 'fail', output: {} }),
    command: async () => { executed += 1; return { outcome: 'complete', output: { ok: true } }; },
  }, { io, maxSteps: 10 });
  assert.equal(executed, 1);
  assert.equal(state.counts.completed, 1);
  assert.equal(state.counts.failed, 1);
  assert.equal(state.status, 'idle');
});
