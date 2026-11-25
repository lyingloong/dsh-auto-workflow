import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { normalizeDefinition } from '../src/definition.mjs';
import { newRunState, enqueue, run, decide, waitingHumanTokens, waitingTokens } from '../src/runtime.mjs';
import { SessionStore } from '../src/store.mjs';
import { publicRun } from '../src/view.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 1000; i++) { if (predicate()) return; await pause(1); }
  assert.fail('condition did not become true');
}
function graph(nodes, edges = [], extra = {}) {
  return normalizeDefinition({ apiVersion: 2, name: 'generic packets', nodes, edges, ...extra });
}
async function fixture(t, definition, input = {}, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workflow-v3-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SessionStore(directory, options);
  const io = store.createIO('run-test');
  const state = await newRunState({ definition, input, cwd: directory }, io);
  return { directory, store, io, state };
}

test('definition is generic, explicit, bounded, and forwards per-candidate reasoningEffort', () => {
  const definition = graph([{ id: 'worker', type: 'agent', concurrency: 3, config: { models: [{ provider: 'route', model: 'model', reasoningEffort: 'custom-effort' }] } }]);
  assert.equal(definition.concurrency, 4); assert.equal(definition.historyLimit, 100);
  assert.equal(definition.nodes[0].config.models[0].reasoningEffort, 'custom-effort');
  assert.equal(Object.hasOwn(definition.nodes[0], 'inputs'), false);
  assert.throws(() => graph([{ id: 'worker', type: 'agent' }], [], { concurrency: 33 }), /between 1 and 32/);
  assert.throws(() => graph([{ id: 'intent', type: 'agent', config: { outcomes: ['approve'], fallbackOutcome: 'clarify' } }]), /fallbackOutcome/);
  const child = { apiVersion: 2, name: 'serial child', nodes: [{ id: 'child', type: 'agent' }], edges: [] };
  const nested = graph([{ id: 'nested', type: 'subworkflow', config: { definition: child } }]);
  assert.equal(nested.nodes[0].config.definition.concurrency, 1);
  assert.throws(() => graph([{ id: 'nested', type: 'subworkflow', config: { definition: { ...child, nodes: [{ id: 'human', type: 'human' }] } } }]), /cannot contain human/);
});

test('actual overlap3, node/root caps, packet isolation, refs-only checkpoints, lazy views', async t => {
  const definition = graph([
    { id: 'engineer', type: 'agent', concurrency: 3 },
    { id: 'reviewer', type: 'agent', concurrency: 3, inputs: { original: '$input.id', previous: '$prev.id', ownResult: '$nodes.engineer.output.id', packetId: '$packet.id' } },
  ], [{ from: 'engineer', to: 'reviewer' }], { concurrency: 5, historyLimit: 12 });
  const { state, io, store } = await fixture(t, definition, { id: 'p0', large: 'PAYLOAD-SECRET'.repeat(3000) });
  for (let i = 1; i < 8; i++) await enqueue(state, { input: { id: `p${i}`, large: 'PAYLOAD-SECRET'.repeat(3000) } }, io);
  let active = 0, engineering = 0, reviewing = 0, maxActive = 0, maxEngineering = 0, maxReviewing = 0, snapshots = 0;
  const seen = new Set();
  const firstEngineers = deferred(), firstReviewers = deferred();
  let engineersEntered = 0, reviewersEntered = 0;
  const awaitGroup = async group => {
    let timer;
    try {
      await Promise.race([group.promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('worker pool did not admit its first three executions')), 5000);
      })]);
    } finally { clearTimeout(timer); }
  };
  await run(state, { agent: async ({ node, input, context, packet }) => {
    active++; maxActive = Math.max(maxActive, active);
    assert.equal(context.packetId, packet.id); assert.equal(Object.hasOwn(context, 'nodes'), false);
    if (node.id === 'engineer') {
      engineering++; maxEngineering = Math.max(maxEngineering, engineering);
      engineersEntered++;
      if (engineersEntered === 3) firstEngineers.resolve();
      if (engineersEntered <= 3) await awaitGroup(firstEngineers);
    } else {
      reviewing++; maxReviewing = Math.max(maxReviewing, reviewing);
      assert.equal(input.original, input.previous); assert.equal(input.original, input.ownResult); assert.equal(input.packetId, packet.id);
      assert.equal(context.results.engineer.output, undefined); assert.ok(context.results.engineer.outputRef); seen.add(input.original);
      reviewersEntered++;
      if (reviewersEntered === 3) firstReviewers.resolve();
      if (reviewersEntered <= 3) await awaitGroup(firstReviewers);
    }
    await pause(node.id === 'engineer' ? 12 : 5);
    active--; if (node.id === 'engineer') engineering--; else reviewing--;
    return { output: { id: input.id ?? input.original } };
  } }, { io, checkpoint: async snapshot => {
    snapshots++; const text = JSON.stringify(snapshot);
    assert.equal(text.includes('PAYLOAD-SECRET'), false); assert.ok(text.length < 24000, text.length);
    await store.saveRun(snapshot);
  } });
  assert.equal(maxEngineering, 3); assert.equal(maxReviewing, 3); assert.ok(maxActive > 1 && maxActive <= 5);
  assert.equal(seen.size, 8); assert.ok(snapshots >= 32);
  assert.equal(state.status, 'idle'); assert.equal(state.tokens.length, 0); assert.equal(Object.keys(state.packets).length, 0);
  assert.equal(state.counts.completed, 16); assert.equal(state.counts.packetsCompleted, 8); assert.equal(state.nodeStats.engineer.status, 'idle');
  assert.equal(state.recent.length, 12);
  const originalGet = io.get; io.get = () => assert.fail('views must not load artifacts');
  assert.equal(JSON.stringify(publicRun(state)).includes('PAYLOAD-SECRET'), false); io.get = originalGet;
  const saved = JSON.parse(await readFile(path.join(store.runDir(state.runId), 'state.json'), 'utf8'));
  assert.equal(saved.definition, undefined); assert.equal(saved.context, undefined);
  assert.deepEqual((await store.loadRun(state.runId)).definition, definition);
});

test('root capacity is exactly3 even when one node allows32 executions', async t => {
  const { state, io } = await fixture(t, graph([{ id: 'worker', type: 'agent', concurrency: 32 }], [], { concurrency: 3 }));
  for (let i = 0; i < 7; i++) await enqueue(state, { input: { id: i } }, io);
  let active = 0, maximum = 0, admissions = 0; const release = deferred();
  await run(state, { agent: async () => {
    active++; maximum = Math.max(maximum, active); admissions++;
    if (admissions <= 3) { if (admissions === 3) release.resolve(); await release.promise; }
    await pause(3); active--; return { output: null };
  } }, { io });
  assert.equal(maximum, 3); assert.equal(state.counts.packetsCompleted, 8);
});

test('running checkpoint precedes side effects, final checkpoint follows artifacts and successors', async t => {
  const { state, io, store } = await fixture(t, graph([{ id: 'worker', type: 'agent' }]), { id: 'only-input-copy' });
  const beforeFiles = await readdir(path.join(store.runDir(state.runId), 'artifacts')); assert.equal(beforeFiles.length, 1);
  await run(state, { agent: async ({ token }) => {
    const saved = await store.loadRun(state.runId);
    assert.equal(saved.tokens[0].id, token.id); assert.equal(saved.tokens[0].status, 'running');
    assert.equal(saved.tokens[0].outputRef, undefined); assert.equal(saved.tokens[0].input, undefined);
    return { output: { result: true } };
  } }, { io, checkpoint: snapshot => store.saveRun(snapshot) });
  const saved = await store.loadRun(state.runId);
  assert.equal(saved.tokens.length, 0); assert.deepEqual(await store.readArtifact(state.runId, saved.outputRef), { result: true });
  const completed = (await store.readHistory(state.runId)).find(record => record.type === 'token');
  assert.equal(completed.status, 'completed'); assert.ok(completed.inputRef); assert.ok(completed.outputRef);
  assert.equal((await readdir(path.join(store.runDir(state.runId), 'artifacts'))).length, 2);
});

test('external arrivals fill available capacity while another executor is still active', async t => {
  const { state, io } = await fixture(t, graph([{ id: 'worker', type: 'agent', concurrency: 3 }], [], { concurrency: 3 }), { id: 'A' });
  const release = deferred(), entered = [];
  const running = run(state, { agent: async ({ input }) => { entered.push(input.id); if (input.id === 'A') await release.promise; return { output: input }; } }, { io });
  await until(() => entered.includes('A'));
  await enqueue(state, { input: { id: 'B' } }, io);
  await until(() => entered.includes('B'));
  await until(() => state.counts.packetsCompleted === 1); release.resolve(); await running;
  assert.equal(state.counts.packetsCompleted, 2);
});

test('human A does not stall B; decisions retain notes as lazy artifacts', async t => {
  const { state, io } = await fixture(t, graph([
    { id: 'intake', type: 'agent', concurrency: 3 }, { id: 'approval', type: 'human' },
  ], [{ from: 'intake', to: 'approval', on: 'ask' }]), { id: 'A' });
  await enqueue(state, { input: { id: 'B' } }, io);
  await run(state, { agent: async ({ input }) => ({ outcome: input.id === 'A' ? 'ask' : 'complete', output: input }) }, { io });
  assert.equal(state.status, 'waiting'); assert.equal(state.counts.packetsCompleted, 1);
  const [human] = waitingHumanTokens(state); assert.equal(waitingTokens(state).length, 1);
  human.status = 'changed-copy'; assert.equal(state.tokens[0].status, 'waiting');
  await decide(state, { tokenId: human.id, outcome: 'approve', output: { note: 'human kept this feedback' } }, io);
  assert.equal(state.status, 'idle'); assert.equal(state.counts.packetsCompleted, 2);
  assert.deepEqual(await io.get(state.outputRef), { note: 'human kept this feedback' });
});

test('node switches park only their queue and wake while an unrelated task drains', async t => {
  const { state, io, store } = await fixture(t, graph([
    { id: 'disabled', type: 'agent' }, { id: 'live', type: 'agent' },
  ], [], { concurrency: 2 }));
  await store.saveControl({ nodes: { disabled: false } });
  const release = deferred(), entered = [];
  await enqueue(state, { input: { id: 'live' }, nodeId: 'live' }, io);
  const running = run(state, { agent: async ({ node, input }) => { entered.push(node.id); if (node.id === 'live') await release.promise; return { output: input }; } }, { io, control: () => store.loadControl() });
  await until(() => entered.includes('live'));
  assert.equal(entered.includes('disabled'), false); assert.equal(state.nodeStats.disabled.status, 'disabled');
  await store.saveControl({ nodes: { disabled: true } });
  await until(() => entered.includes('disabled')); release.resolve(); await running;
  assert.equal(state.counts.packetsCompleted, 2); assert.equal(state.nodeStats.disabled.status, 'idle');
});

test('global stop drains admitted work, does not admit queued work, then resumes without replay', async t => {
  const { state, io, store } = await fixture(t, graph([{ id: 'worker', type: 'agent' }]), { id: 'first' });
  await enqueue(state, { input: { id: 'next' } }, io);
  const release = deferred(), entered = [];
  const executor = { agent: async ({ input }) => { entered.push(input.id); if (input.id === 'first') await release.promise; return { output: input }; } };
  const running = run(state, executor, { io, control: () => store.loadControl() });
  await until(() => entered.length === 1);
  await store.saveControl({ continuous: false }); release.resolve(); await running;
  assert.deepEqual(entered, ['first']); assert.equal(state.pauseReason, 'control_off');
  await store.saveControl({ continuous: true }); await run(state, executor, { io, control: () => store.loadControl() });
  assert.deepEqual(entered, ['first', 'next']); assert.equal(state.status, 'idle');
});

test('input mapping is snapshotted on queue, not re-resolved at execution', async t => {
  const { state, io } = await fixture(t, graph([
    { id: 'source', type: 'agent' }, { id: 'target', type: 'agent', inputs: { value: '$nodes.source.output.value', original: '$input.value' } },
  ], [{ from: 'source', to: 'target' }]), { value: 'original' });
  await run(state, { agent: async () => ({ output: { value: 'recorded' } }) }, { io, control: { nodes: { target: false } } });
  const packet = Object.values(state.packets)[0];
  packet.results.source.outputRef = await io.put({ value: 'changed-after-queue' });
  let actual;
  await run(state, { agent: async ({ input }) => { actual = input; return { output: input }; } }, { io });
  assert.deepEqual(actual, { value: 'recorded', original: 'original' });
});

test('cwd/url config uses recorded resolved node input while node.inputs $input remains original', async t => {
  const { state, io } = await fixture(t, graph([
    { id: 'prepare', type: 'agent' },
    { id: 'worker', type: 'command', inputs: { cwd: '$prev.cwd', url: '$prev.url', original: '$input.cwd' }, config: { command: 'fake-command', cwd: '$input.cwd' } },
    { id: 'request', type: 'http', config: { url: '$input.url' } },
  ], [{ from: 'prepare', to: 'worker' }, { from: 'worker', to: 'request' }]), { cwd: '/original-packet-cwd' });
  state.permissions = { command: { mode: 'full', allow: [] }, http: { mode: 'full', allow: [] } };
  await run(state, {
    agent: async () => ({ output: { cwd: '/prepared-item-cwd', url: 'https://example.test/recorded' } }),
    command: async ({ node, input }) => {
      assert.equal(input.original, '/original-packet-cwd'); assert.equal(input.cwd, '/prepared-item-cwd');
      assert.equal(node.config.cwd, '/prepared-item-cwd'); return { output: input };
    },
    http: async ({ node, input }) => { assert.equal(node.config.url, input.url); assert.equal(node.config.url, 'https://example.test/recorded'); return { output: null }; },
  }, { io });
  assert.equal(state.counts.packetsCompleted, 1); assert.equal(state.nodeStats.worker.active, 0);
});

test('failed packet and bounded negative-result loop never kill unrelated packets or auto-replay', async t => {
  const { state, io } = await fixture(t, graph([{ id: 'review', type: 'agent', concurrency: 3 }], [{ from: 'review', to: 'review', on: 'needs_revision' }]), { id: 'bad' });
  await enqueue(state, { input: { id: 'good' } }, io);
  const calls = { bad: 0, good: 0 };
  const executor = { agent: async ({ input }) => { calls[input.id]++; return { outcome: input.id === 'bad' ? 'needs_revision' : 'complete', output: input }; } };
  await run(state, executor, { io, maxFailures: 3 });
  assert.deepEqual(calls, { bad: 3, good: 1 }); assert.equal(state.status, 'idle');
  assert.equal(state.tokens[0].error.code, 'failure_budget_exhausted'); assert.equal(state.counts.packetsCompleted, 1);
  await run(state, executor, { io }); assert.deepEqual(calls, { bad: 3, good: 1 });
  await enqueue(state, { input: { id: 'good' } }, io); await run(state, executor, { io }); assert.equal(calls.good, 2);
});

test('deny-by-default permission failure is packet-local and does not invoke the privileged executor', async t => {
  const { state, io } = await fixture(t, graph([
    { id: 'command', type: 'command', config: { command: 'must-not-execute' } }, { id: 'safe', type: 'agent' },
  ]));
  await enqueue(state, { input: {}, nodeId: 'safe' }, io);
  await run(state, { command: () => assert.fail('deny grant must prevent executor side effects'), agent: async () => ({ output: 'safe packet completed' }) }, { io });
  assert.equal(state.tokens.find(token => token.nodeId === 'command').error.code, 'permission_denied');
  assert.equal(state.counts.packetsCompleted, 1); assert.equal(state.status, 'idle');
});

test('orphan running checkpoint is interrupted evidence, never permission to replay', async t => {
  const { state, io } = await fixture(t, graph([{ id: 'worker', type: 'agent' }]));
  state.tokens[0].status = 'running';
  await run(state, { agent: () => assert.fail('orphan side effects must not replay') }, { io });
  assert.equal(state.status, 'interrupted'); assert.equal(state.tokens[0].error.code, 'execution_unknown');
});

test('cancellation drains every active executor and preserves interrupted evidence without replay', async t => {
  const { state, io, store } = await fixture(t, graph([{ id: 'worker', type: 'agent', concurrency: 3 }], [], { concurrency: 3 }));
  await enqueue(state, { input: {} }, io); await enqueue(state, { input: {} }, io);
  const controller = new AbortController(); let entered = 0, drained = 0;
  const running = run(state, { agent: async ({ signal }) => {
    entered++;
    await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
    await pause(5); drained++; return { output: 'uncertain side effects' };
  } }, { io, signal: controller.signal, checkpoint: snapshot => store.saveRun(snapshot) });
  await until(() => entered === 3); controller.abort(); await running;
  assert.equal(drained, 3); assert.equal(state.status, 'interrupted');
  assert.equal(state.tokens.filter(token => token.status === 'interrupted').length, 3);
  await run(state, { agent: () => assert.fail('must not replay cancelled tasks') }, { io });
  assert.equal((await store.loadRun(state.runId)).status, 'interrupted');
});

test('detached fanout leaves independent human-waiting children while producer continues', async t => {
  const { state, io } = await fixture(t, graph([
    { id: 'producer', type: 'fanout', config: { items: '$input.items', target: 'child', detached: true } },
    { id: 'child', type: 'human' }, { id: 'tail', type: 'agent' },
  ], [{ from: 'producer', to: 'tail' }]), { items: [{ id: 'a' }, { id: 'b' }] });
  let tails = 0;
  await run(state, { agent: async () => { tails++; return { output: 'producer moved on' }; } }, { io });
  assert.equal(tails, 1); assert.equal(state.counts.packetsCompleted, 1); assert.equal(waitingHumanTokens(state).length, 2);
  assert.equal(Object.keys(state.packets).length, 2);
});

test('joined fanout waits for child terminal outputs, not first target or human wait', async t => {
  const { state, io } = await fixture(t, graph([
    { id: 'fork', type: 'fanout', config: { items: '$input.items', target: 'child', join: 'join' } },
    { id: 'child', type: 'agent', concurrency: 3 }, { id: 'human', type: 'human' },
    { id: 'join', type: 'join', config: { mode: 'all' } }, { id: 'tail', type: 'agent' },
  ], [{ from: 'child', to: 'human', on: 'ask' }, { from: 'child', to: 'join' }, { from: 'human', to: 'join', on: 'approve' }, { from: 'join', to: 'tail' }]), { items: [{ id: 'a' }, { id: 'b' }] });
  let tailInput;
  const executor = { agent: async ({ node, input }) => node.id === 'tail' ? (tailInput = input, { output: input }) : { outcome: input.id === 'a' ? 'ask' : 'complete', output: input } };
  await run(state, executor, { io });
  assert.equal(tailInput, undefined); assert.equal(waitingHumanTokens(state).length, 1);
  const join = waitingTokens(state).find(token => token.nodeId === 'join'); assert.equal(join.join.arrived, 1);
  const human = waitingHumanTokens(state)[0]; await decide(state, { tokenId: human.id, outcome: 'approve', output: { approved: 'a' } }, io);
  await run(state, executor, { io });
  assert.equal(tailInput.length, 2); assert.ok(tailInput.every(item => item.outputRef && !Object.hasOwn(item, 'output')));
  assert.equal(state.status, 'idle'); assert.equal(state.counts.packetsCompleted, 3);
});

test('fanout snapshots initial item/index mappings and dynamic cwd before any executor starts', async t => {
  const { state, io } = await fixture(t, graph([
    { id: 'fork', type: 'fanout', config: { items: '$input.items', target: 'worker', detached: true } },
    { id: 'worker', type: 'agent', concurrency: 3, inputs: { item: '$item.id', original: '$input.id', index: '$index' }, config: { cwd: '$item.cwd' } },
  ]), { items: [{ id: 'a', cwd: '/fake/a' }, { id: 'b', cwd: '/fake/b' }] });
  const received = [];
  await run(state, { agent: async ({ node, input }) => { received.push({ ...input, cwd: node.config.cwd }); return { output: input }; } }, { io });
  received.sort((a, b) => a.index - b.index);
  assert.deepEqual(received, [{ item: 'a', original: 'a', index: 0, cwd: '/fake/a' }, { item: 'b', original: 'b', index: 1, cwd: '/fake/b' }]);
});

test('pruning retains transitively referenced output artifacts without eagerly reading artifact bodies', async t => {
  const { state, io, store } = await fixture(t, graph([{ id: 'worker', type: 'agent' }], [], { historyLimit: 0 }));
  const leaf = await io.put({ payload: 'lazy child result' });
  const inner = await io.put({ outputRef: leaf });
  const envelope = await io.put([{ outputRef: inner }]);
  const orphan = await io.put({ discard: true }); state.outputRef = envelope;
  const originalReader = store.readArtifact.bind(store);
  store.readArtifact = () => assert.fail('pruning must traverse metadata, not artifact bodies');
  await store.pruneArtifacts(state.runId, state); await store.pruneArtifacts(state.runId, state);
  store.readArtifact = originalReader;
  assert.deepEqual(await io.get(leaf), { payload: 'lazy child result' });
  assert.deepEqual(await io.get(inner), { outputRef: leaf });
  await assert.rejects(io.get(orphan), { code: 'ENOENT' });
});

test('gate delay is scheduling, does not occupy worker capacity or lose input', async t => {
  const { state, io } = await fixture(t, graph([
    { id: 'delay', type: 'gate', config: { delayMs: 25 } }, { id: 'worker', type: 'agent' },
  ], [{ from: 'delay', to: 'worker' }], { concurrency: 1 }), { label: 'delayed' });
  await enqueue(state, { input: { label: 'immediate' }, nodeId: 'worker' }, io);
  const received = [];
  await run(state, { agent: async ({ input }) => { received.push(input.label); return { output: input }; } }, { io });
  assert.deepEqual(received, ['immediate', 'delayed']);
});

test('serial subworkflow preserves root physical capacity and externalizes nested checkpoints', async t => {
  const definition = graph([{ id: 'nested', type: 'subworkflow', concurrency: 3, config: { definition: { apiVersion: 2, name: 'child', nodes: [{ id: 'a', type: 'agent' }, { id: 'b', type: 'agent' }], edges: [{ from: 'a', to: 'b' }] } } }], [], { concurrency: 3 });
  definition.historyLimit = 2;
  const { state, io, store } = await fixture(t, definition, { label: 'first' });
  for (let i = 0; i < 3; i++) await enqueue(state, { input: { label: `child-${i}` } }, io);
  let active = 0, maximum = 0, admissions = 0; const releaseFirstThree = deferred();
  await run(state, { agent: async ({ input }) => {
    active++; maximum = Math.max(maximum, active); admissions++;
    if (admissions <= 3) { if (admissions === 3) releaseFirstThree.resolve(); await releaseFirstThree.promise; }
    await pause(5); active--; return { output: input };
  } }, { io, checkpoint: snapshot => store.saveRun(snapshot) });
  assert.equal(maximum, 3); assert.equal(state.counts.packetsCompleted, 4); assert.equal(state.status, 'idle');
  assert.equal((await store.readHistory(state.runId)).length, 2); assert.equal(io.historyLimit, 2);
  const saved = await readFile(path.join(store.runDir(state.runId), 'state.json'), 'utf8'); assert.equal(saved.includes('"definition"'), false);
});

test('bounded history and artifact pruning preserve only reachable runtime artifacts and never business files', async t => {
  const { state, io, store, directory } = await fixture(t, graph([{ id: 'loop', type: 'agent' }], [{ from: 'loop', to: 'loop' }], { historyLimit: 3 }));
  const business = path.join(directory, 'business.json'); await writeFile(business, '{"keep":true}');
  let call = 0;
  const executor = { agent: async () => ({ output: { iteration: ++call, dataRef: business } }) };
  for (let i = 0; i < 4; i++) await run(state, executor, { io, maxSteps: 12, checkpoint: snapshot => store.saveRun(snapshot) });
  await store.pruneArtifacts(state.runId, state); await store.pruneArtifacts(state.runId, state);
  const history = await store.readHistory(state.runId); assert.equal(history.length, 3); assert.equal(state.recent.length, 3);
  const artifacts = await readdir(path.join(store.runDir(state.runId), 'artifacts')); assert.ok(artifacts.length <= 6, artifacts.length);
  assert.equal(await readFile(business, 'utf8'), '{"keep":true}');
  const checkpointText = await readFile(path.join(store.runDir(state.runId), 'state.json'), 'utf8'); assert.ok(checkpointText.length < 6500, checkpointText.length);
  assert.equal(checkpointText.includes('iteration'), false);
  assert.ok((await store.readArtifact(state.runId, state.tokens[0].inputRef)).iteration > 0);
});

test('explicit idle-run model updates persist once without changing queued inputs or graph contracts', async t => {
  const definition = graph([{ id: 'worker', type: 'agent', config: { provider: 'old-route', model: 'old-model', prompt: 'fixed task contract' } }]);
  const { state, io, store } = await fixture(t, definition, { id: 'queued-before-model-choice' });
  await store.saveRun(state); const originalInputRef = state.tokens[0].inputRef;
  const selected = structuredClone(definition);
  selected.nodes[0].config.models = [{ provider: 'new-route', model: 'new-model', reasoningEffort: 'custom-effort' }];
  selected.nodes[0].config.provider = 'new-route'; selected.nodes[0].config.model = 'new-model';
  state.definition = await store.updateRunDefinition(state.runId, selected); await store.saveRun(state);
  assert.equal((await store.loadRun(state.runId)).definition.nodes[0].config.model, 'new-model');
  assert.equal(state.tokens[0].inputRef, originalInputRef);
  const changedCapacity = structuredClone(selected); changedCapacity.nodes[0].concurrency = 2;
  await assert.rejects(store.updateRunDefinition(state.runId, changedCapacity), { code: 'run_definition_contract_changed' });
  const changedPrompt = structuredClone(selected); changedPrompt.nodes[0].config.prompt = 'different task';
  await assert.rejects(store.updateRunDefinition(state.runId, changedPrompt), { code: 'run_definition_contract_changed' });
  await run(state, { agent: async ({ node, input }) => {
    assert.equal(node.config.model, 'new-model'); assert.equal(node.config.models[0].reasoningEffort, 'custom-effort');
    assert.equal(input.id, 'queued-before-model-choice'); return { output: input };
  } }, { io, checkpoint: snapshot => store.saveRun(snapshot) });
  state.execution = { active: true }; await store.saveRun(state);
  await assert.rejects(store.updateRunDefinition(state.runId, selected), { code: 'run_active' });
});

test('store rejects traversal, oversize artifacts, and execution of legacy flat files without changing them', async t => {
  const { state, io, store } = await fixture(t, graph([{ id: 'worker', type: 'agent' }]), {}, { maxArtifactBytes: 64 });
  await assert.rejects(io.put('x'.repeat(100)), /Persist large data/);
  await assert.rejects(store.readArtifact(state.runId, '../other'), /safe identifier/);
  assert.throws(() => store.createIO('../other'), /safe identifier/);
  await mkdir(store.runsDir, { recursive: true }); const legacy = path.join(store.runsDir, 'old-run.json');
  const contents = '{"version":2,"runId":"old-run","tokens":[]}'; await writeFile(legacy, contents);
  await assert.rejects(store.loadRun('old-run'), /Legacy flat/); assert.equal(await readFile(legacy, 'utf8'), contents);
  await assert.rejects(run({ version: 2 }, {}, { io }), /Only version:3/);
});
