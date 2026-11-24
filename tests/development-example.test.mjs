import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath, lstat } from 'node:fs/promises';
import { DevelopmentStore, atomicJSON } from '../docs/examples/development/store.mjs';
import { git, prepare, snapshot, recordReview, integrate, cleanup, mergeBrief } from '../docs/examples/development/worktrees.mjs';
import { publish, ready, watch, merge, requestChanges, updateBody } from '../docs/examples/development/pr.mjs';
import { stage } from '../docs/examples/development/driver.mjs';
import { normalizeDefinition } from '../src/definition.mjs';
import { newRunState, enqueue, run, decide, waitingHumanTokens } from '../src/runtime.mjs';
import { useFakeGh } from './helpers/fake-gh-env.mjs';

const execute = promisify(execFile);
const driver = fileURLToPath(new URL('../docs/examples/development/driver.mjs', import.meta.url));
const graphFile = new URL('../docs/examples/development/workflow.json', import.meta.url);
async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'development-example-')));
  const repo = path.join(root, 'repo'); await mkdir(repo);
  t.after(async () => { assert.ok(path.basename(root).startsWith('development-example-')); await rm(root, { recursive: true, force: true }); });
  await git(repo, 'init', '--initial-branch=main');
  for (const [key, value] of Object.entries({ 'user.name': 'Example Test', 'user.email': 'example-test@invalid.local', 'core.autocrlf': 'false', 'core.hooksPath': path.join(root, 'no-hooks'), 'commit.gpgsign': 'false' })) await git(repo, 'config', key, value);
  await writeFile(path.join(repo, 'shared.txt'), 'base\n');
  await git(repo, 'add', '--all'); await git(repo, 'commit', '-m', 'temporary test base');
  const store = await DevelopmentStore.create({ dataRoot: path.join(root, 'data'), repoRoot: repo, integrationMode: 'local', ...options });
  return { root, repo, store };
}
async function withPullRequestFixture(t, { root, repo }, { readyMerges = true } = {}) {
  const remote = path.join(root, 'remote.git');
  await git(root, 'init', '--bare', remote);
  await git(repo, 'remote', 'add', 'origin', remote);
  await git(repo, 'push', '-u', 'origin', 'main');
  return { remote, ...useFakeGh(t, root, { readyMerges }) };
}
const user = (id, extra = {}) => ({ id, source: 'user', title: id, summary: `Implement ${id}`, evidence: `Implement ${id}`, why: [], acceptance: [], risk: 'high', ...extra });
const mined = (id, value = 'mid', extra = {}) => ({ id, source: 'mined', seedId: `seed-${id.slice(4)}`, title: id, summary: `Mined ${id}`, evidence: `Mined ${id}`, why: [], acceptance: [], risk: value, ...extra });
async function prepared(store, id = 'req-one', spec = user(id)) {
  await store.upsertRequirement(spec);
  const [envelope] = await store.claimBatch(1);
  assert.equal(envelope.dataRef, store.ref(id));
  const routed = await store.route(id, envelope.claimId);
  if (routed.outcome === 'needs_approval') await decideRequirement(store, id, envelope.claimId, 'approve');
  const ready = await prepare(store, id, envelope.claimId);
  const item = await store.beginEngineering(id, envelope.claimId, { expectedRevision: ready.revision, expectedEpoch: ready.engineeringEpoch });
  return { id, claimId: envelope.claimId, cwd: item.worktreePath, revision: item.revision, engineeringEpoch: item.engineeringEpoch };
}
async function implement(store, item, { file = `${item.id}.txt`, contents = 'implemented\n' } = {}) {
  let current = await store.get(item.id);
  if (current.status === 'engineering-ready') current = await store.beginEngineering(item.id, item.claimId, { expectedRevision: current.revision, expectedEpoch: current.engineeringEpoch });
  await writeFile(path.join(item.cwd, file), contents);
  await git(item.cwd, 'add', '--all'); await git(item.cwd, 'commit', '-m', `temporary implementation ${item.id}`);
  return snapshot(store, item.id, item.claimId, { expectedRevision: current.revision, engineeringEpoch: current.engineeringEpoch, summary: `Implemented ${item.id}`, verification: 'git status --porcelain: clean; isolated fixture assertion' });
}
async function pass(store, item, artifact) {
  return recordReview(store, item.id, item.claimId, { artifactRef: artifact.artifactRef, commit: artifact.commit, decision: 'pass', summary: 'Pinned commit reviewed', verification: 'Read pinned diff and fixture assertions', reviewer: 'test-reviewer' });
}
async function approve(store, item, artifact) {
  await pass(store, item, artifact);
  return store.mergeDecision(item.id, item.claimId, { artifactRef: artifact.artifactRef, decision: 'approve', actor: 'test-human' });
}
async function cli(name, input) {
  const { stdout, stderr } = await execute(process.execPath, [driver, name], { env: { ...process.env, DSH_WORKFLOW_INPUT: JSON.stringify(input) }, windowsHide: true });
  assert.equal(stderr, ''); assert.equal(stdout.trim().split('\n').length, 1);
  return JSON.parse(stdout);
}
/** Record a requirement decision without GitHub by attaching a synthetic issue. */
async function decideRequirement(store, id, claimId, decision, note) {
  const item = await store.get(id);
  if (!item.github) await store.attachIssue(id, claimId, { number: 1, url: 'https://example.invalid/issues/1', revision: item.revision, commentFloor: 0 });
  return store.githubRequirementDecision(id, claimId, { decision, note, actor: 'test-human', expectedRevision: item.revision });
}
/** A mined mid-risk requirement parked in GitHub requirement review. */
async function pendingReview(store) {
  await store.upsertSeed({ id: 'seed-review', title: 'Review direction', evidence: 'Concrete local evidence' });
  const [seed] = await store.claimSeeds(1);
  const requirement = await store.proposeSeed({
    seedId: 'seed-review', claimId: seed.claimId,
    proposal: { title: 'Review me', summary: 'Read C:\\Users\\private\\project and mail owner@example.com with ghp_abcdefghijklmnopqrstuvwxyz', evidence: 'Read C:\\Users\\private\\project and mail owner@example.com with ghp_abcdefghijklmnopqrstuvwxyz', risk: 'mid', priority: 2 },
  });
  const [claimed] = await store.claimBatch(1);
  const routed = await store.route(requirement.id, claimed.claimId);
  assert.equal(routed.outcome, 'needs_approval');
  return { item: routed.item, envelope: store.envelope(routed.item) };
}
async function issueComment(statePath, number, body, association = 'OWNER') {
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const issue = state.issues.find(value => value.number === number);
  assert.ok(issue, `review issue ${number}`);
  issue.comments = issue.comments ?? [];
  issue.comments.push({ id: state.nextComment++, body, user: { login: 'maintainer' }, author_association: association });
  await writeFile(statePath, JSON.stringify(state));
}

async function mutatePrState(statePath, mutate) {
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  mutate(state.prs[0], state);
  await writeFile(statePath, JSON.stringify(state));
  return state.prs[0];
}
async function addPrComment(statePath, { body, login = 'maintainer', association = 'OWNER', created = new Date().toISOString() }) {
  return mutatePrState(statePath, (pr, state) => {
    pr.comments = pr.comments ?? [];
    pr.comments.push({ id: state.nextComment++, body, user: { login }, author_association: association, created_at: created });
  });
}

test('development graph is generic: continuous detached producer, root 6, one three-slot engineering/review pool', async () => {
  const graph = normalizeDefinition(JSON.parse(await readFile(graphFile, 'utf8')));
  assert.equal(graph.apiVersion, 2); assert.equal(graph.concurrency, 6);
  const engineer = graph.nodes.find(node => node.id === 'engineer');
  const reviewer = graph.nodes.find(node => node.id === 'reviewer');
  assert.equal(engineer.concurrency, 3); assert.equal(reviewer.concurrency, 3);
  assert.equal(engineer.config.cwd, '$input.cwd'); assert.equal(reviewer.config.cwd, '$input.cwd');
  assert.equal(graph.nodes.filter(node => node.role === 'reviewer').length, 1, 'a pool, not three reviews per item');
  assert.equal(graph.nodes.find(node => node.id === 'pr-watch').concurrency, 1);
  assert.equal(graph.nodes.find(node => node.id === 'pr-merge').concurrency, 1);
  assert.equal(graph.nodes.find(node => node.id === 'publish-pr').concurrency, 1);
  assert.ok(graph.nodes.find(node => node.id === 'brief'));
  assert.ok(!('timeoutMs' in engineer.config)); assert.ok(!('timeoutMs' in reviewer.config));
  assert.ok(graph.nodes.find(node => node.id === 'mine-gate').config.delayMs >= 1000);
  assert.ok(graph.nodes.find(node => node.id === 'queue-check'));
  assert.ok(!graph.nodes.some(node => node.id === 'conflict-human'));
  assert.ok(graph.edges.some(edge => edge.from === 'queue-check' && edge.to === 'seed-batch' && edge.on === 'mine'));
  assert.ok(graph.edges.some(edge => edge.from === 'snapshot' && edge.to === 'publish-pr' && edge.on === 'complete'));
  assert.ok(graph.edges.some(edge => edge.from === 'record-review' && edge.to === 'brief' && edge.on === 'pass'));
  assert.ok(graph.edges.some(edge => edge.from === 'brief' && edge.to === 'integration-route' && edge.on === 'complete'));
  assert.ok(graph.edges.some(edge => edge.from === 'integration-route' && edge.to === 'merge-human' && edge.on === 'local'));
  assert.ok(graph.edges.some(edge => edge.from === 'integration-route' && edge.to === 'ready-pr' && edge.on === 'pr'));
  assert.ok(graph.edges.some(edge => edge.from === 'pr-watch' && edge.to === 'pr-request-changes' && edge.on === 'closed'));
  assert.ok(graph.nodes.find(node => node.id === 'pr-gate').type === 'gate');
  assert.equal(graph.nodes.find(node => node.id === 'publish-requirement-issue').concurrency, 1);
  assert.equal(graph.nodes.find(node => node.id === 'check-requirement-issue').concurrency, 1);
  assert.equal(graph.nodes.find(node => node.id === 'requirement-gate').config.delayMs, 1_800_000);
  assert.ok(!graph.nodes.some(node => node.id === 'requirement-human'));
  assert.ok(graph.edges.some(edge => edge.from === 'route' && edge.to === 'publish-requirement-issue' && edge.on === 'needs_approval'));
  assert.ok(graph.edges.some(edge => edge.from === 'check-requirement-issue' && edge.to === 'prepare' && edge.on === 'approved'));
  assert.ok(graph.edges.some(edge => edge.from === 'check-requirement-issue' && edge.to === 'analyst-revise' && edge.on === 'rejected'));
  assert.ok(graph.edges.some(edge => edge.from === 'check-requirement-issue' && edge.to === 'requirement-gate' && edge.on === 'waiting'));
  assert.ok(graph.nodes.find(node => node.id === 'intake-record'));
  assert.equal(graph.nodes.find(node => node.id === 'intake-plan').config.reasoningEffort, 'low');
  assert.deepEqual(graph.nodes.find(node => node.id === 'intake-plan').config.outcomes, ['planned', 'unclear']);
  assert.ok(graph.edges.some(edge => edge.from === 'intake-record' && edge.to === 'intake-plan' && edge.on === 'complete'));
  assert.ok(graph.edges.some(edge => edge.from === 'intake-plan' && edge.to === 'intake-apply' && edge.on === 'planned'));
  assert.ok(graph.edges.some(edge => edge.from === 'intake-plan' && edge.to === 'intake-apply' && edge.on === 'unclear'));
  assert.ok(graph.edges.some(edge => edge.from === 'intake-apply' && edge.to === 'dispatch' && edge.on === 'complete'));
  assert.ok(graph.edges.some(edge => edge.from === 'pr-watch' && edge.to === 'pr-gate' && edge.on === 'waiting'));
  assert.ok(graph.edges.some(edge => edge.from === 'pr-watch' && edge.to === 'pr-merge' && edge.on === 'pass'));
  assert.ok(graph.edges.some(edge => edge.from === 'pr-merge' && edge.to === 'cleanup' && edge.on === 'merged'));
  assert.ok(graph.nodes.find(node => node.id === 'seed-fanout').config.detached);
  assert.ok(graph.nodes.find(node => node.id === 'producer-work').config.detached);
  assert.ok(graph.edges.some(edge => edge.from === 'producer-work' && edge.to === 'mine-gate'));
  assert.ok(graph.nodes.find(node => node.id === 'merge-human').type === 'human');
  for (const node of graph.nodes.filter(node => node.type === 'command')) {
    assert.equal(node.config.json, true);
    assert.match(node.config.command, /^node docs\/examples\/development\/driver\.mjs [a-z-]+$/);
    assert.equal(node.config.cwd, undefined, 'static command runs from bound repository root');
  }
  assert.ok(!graph.nodes.some(node => node.type === 'http'));
});

test('same-id upsert and deterministic user-first priority/FIFO; concurrent claims never duplicate', async t => {
  const { store } = await fixture(t);
  const original = await store.upsertRequirement(mined('req-old', 'low', { priority: 1 }));
  const updated = await store.upsertRequirement(mined('req-old', 'low', { priority: 1, title: 'Updated', expectedRevision: 1 }));
  assert.equal(updated.id, original.id); assert.equal(updated.order, original.order); assert.equal(updated.revision, 2);
  await assert.rejects(store.upsertRequirement(mined('req-old', 'low', { expectedRevision: 1 })), /Stale/);
  await store.upsertRequirement(mined('req-late', 'low', { priority: 1 }));
  await store.upsertRequirement(mined('req-low-priority', 'low', { priority: 9 }));
  await store.upsertRequirement(user('req-user-a', { priority: 9 }));
  await store.upsertRequirement(user('req-user-b'));
  const queue = await store.claimBatch(100);
  assert.deepEqual(queue.map(item => path.basename(item.dataRef, '.json')), ['req-user-a', 'req-user-b', 'req-old', 'req-late', 'req-low-priority']);
  assert.equal((await store.get('req-user-a')).priority, 0);
  await assert.rejects(store.upsertRequirement(user('req-user-a', { expectedRevision: 1 })), /active/);
  for (let index = 0; index < 8; index++) await store.upsertRequirement(user(`req-parallel-${index}`));
  const claimed = (await Promise.all(Array.from({ length: 8 }, () => store.claimBatch(1)))).flat();
  assert.equal(new Set(claimed.map(item => item.dataRef)).size, 8);
  assert.equal(new Set(claimed.map(item => item.claimId)).size, 8);
  assert.deepEqual(await store.claimBatch(1), []);
});

test('user priority0 and low-risk mined bypass; mid/high human feedback revises SAME requirement', async t => {
  const { store } = await fixture(t);
  await store.upsertRequirement(user('req-user'));
  for (const value of ['low', 'mid', 'high']) await store.upsertRequirement(mined(`req-${value}`, value));
  const items = await store.claimBatch(10);
  for (const envelope of items) {
    const id = path.basename(envelope.dataRef, '.json');
    const routed = await store.route(id, envelope.claimId);
    if (id === 'req-user' || id === 'req-low') { assert.equal(routed.outcome, 'ready'); continue; }
    assert.equal(routed.outcome, 'needs_approval');
    await assert.rejects(decideRequirement(store, id, envelope.claimId, 'reject'), /feedback/);
    await decideRequirement(store, id, envelope.claimId, 'reject', 'Bound the scope; preserve identity');
    await store.reviseRequirement(id, envelope.claimId, { expectedRevision: 1, title: 'Bounded scope', summary: 'Narrow and testable', evidence: 'Narrow and testable', risk: 'mid' });
    const item = await store.get(id);
    assert.equal(item.id, id); assert.equal(item.revision, 2); assert.equal(item.claimId, envelope.claimId);
    assert.equal(item.feedback[0].note, 'Bound the scope; preserve identity');
    assert.equal((await store.route(id, envelope.claimId)).outcome, 'needs_approval');
    await decideRequirement(store, id, envelope.claimId, 'approve');
    assert.equal((await store.get(id)).requirementApproval.revision, 2);
  }
});

test('driver init seeds the baseline discovery directions exactly once', async t => {
  const { root, repo } = await fixture(t);
  const dataRoot = path.join(root, 'baseline-data');
  const result = await cli('init', { dataRoot, repoRoot: repo });
  assert.equal(result.outcome, 'complete');
  assert.equal(result.output.baselineSeeds, 14);
  assert.equal(result.output.version, 4);
  assert.equal(result.output.maxMiningSeeds, 3);
  const store = await DevelopmentStore.open(dataRoot);
  const seeds = await store.claimSeeds(100, { maxMining: 100 });
  assert.equal(seeds.length, 14);
  assert.ok(seeds.every(seed => seed.origin === 'baseline' && seed.seedId.startsWith('seed-baseline-')));
  assert.ok(seeds.every(seed => seed.rotationRound === 1 && seed.claimId));
  // Every direction is mining now, so one batch cannot claim the same seed twice.
  assert.deepEqual(await store.claimSeeds(100, { maxMining: 100 }), []);
});

test('seed ids differ from requirement ids; no-proposal returns the seed to the rotation', async t => {
  const { store } = await fixture(t);
  await store.upsertSeed({ id: 'seed-one', title: 'Useful evidence', evidence: 'Local source evidence' });
  await store.upsertSeed({ id: 'seed-empty', title: 'Not actionable', evidence: 'Needs more evidence' });
  const seeds = await store.claimSeeds(3);
  const proposed = await store.proposeSeed({ seedId: seeds[0].seedId, claimId: seeds[0].claimId, proposal: { title: 'Concrete fix', summary: 'Concrete expected behavior', evidence: 'Concrete expected behavior', risk: 'low', priority: 2 } });
  assert.equal(proposed.id, 'req-one'); assert.equal(proposed.seedId, 'seed-one'); assert.notEqual(proposed.id, proposed.seedId);
  assert.equal(await store.proposeSeed({ seedId: seeds[1].seedId, claimId: seeds[1].claimId, proposal: null, reason: 'already covered by req-one' }), null);
  assert.equal((await store.list()).length, 1);
  const idle = (await store.readSeeds()).find(seed => seed.id === 'seed-empty');
  assert.equal(idle.status, 'queued');
  assert.equal(idle.claimId, null);
  assert.equal(idle.attempts, 1);
  assert.equal(idle.lastOutcome, 'no-proposal');
  assert.equal(idle.lastReason, 'already covered by req-one');
  // A no-proposal direction is retried in a later round, never one-shot.
  const reclaimed = await store.claimSeeds(1);
  assert.deepEqual(reclaimed.map(seed => seed.seedId), ['seed-empty']);
  assert.equal(reclaimed[0].rotationRound, 2);
  assert.equal((await store.readSeeds()).find(seed => seed.id === 'seed-empty').attempts, 2);
  await assert.rejects(store.proposeSeed({ seedId: seeds[0].seedId, claimId: seeds[0].claimId, proposal: null }), /Stale/);
  for (const id of ['../outside', 'req-../../oops', 'req-a/b', 'req-a.json', 'req-a:stream', 'req-UPPER']) assert.throws(() => store.ref(id), /Unsafe/);
  await assert.rejects(DevelopmentStore.fromRef(path.join(store.root, 'config.json')));
  await assert.rejects(DevelopmentStore.fromRef(path.join(store.root, 'requirements', 'req-one.json.extra')));
  await assert.rejects(DevelopmentStore.create({ dataRoot: path.join(store.root, 'other'), repoRoot: store.config.repoRoot, baseBranch: 'main..evil' }), /Unsafe/);
});

test('seed claims rotate: never-mined directions first, then the least recently mined', async t => {
  const { store } = await fixture(t);
  for (const id of ['seed-a', 'seed-b', 'seed-c']) await store.upsertSeed({ id, title: `Direction ${id}`, evidence: `${id} evidence` });
  const first = await store.claimSeeds(1, { maxMining: 100 });
  assert.deepEqual(first.map(seed => seed.seedId), ['seed-a']);
  assert.equal(first[0].rotationRound, 1);
  assert.equal(await store.proposeSeed({ seedId: 'seed-a', claimId: first[0].claimId, proposal: null, reason: 'no gap found' }), null);
  assert.deepEqual((await store.claimSeeds(1, { maxMining: 100 })).map(seed => seed.seedId), ['seed-b']);
  assert.deepEqual((await store.claimSeeds(1, { maxMining: 100 })).map(seed => seed.seedId), ['seed-c']);
  // seed-a was mined in round 1, so it is the next direction in the rotation.
  const again = await store.claimSeeds(1, { maxMining: 100 });
  assert.deepEqual(again.map(seed => seed.seedId), ['seed-a']);
  assert.equal(again[0].rotationRound, 4);
  assert.equal((await store.readSeeds()).find(seed => seed.id === 'seed-a').attempts, 2);
});

test('the store caps concurrent mining claims even when a batch asks for more', async t => {
  const { store } = await fixture(t);
  await store.ensureBaselineSeeds();
  assert.equal((await store.claimSeeds(100)).length, 3);
  assert.equal((await store.claimSeeds(100)).length, 0);
  const counts = await store.seedCounts();
  assert.equal(counts.mining, 3);
  assert.equal(counts.queued, 11);
});

test('stale mining claims are released only by an explicit recovery command', async t => {
  const { store } = await fixture(t);
  await store.upsertSeed({ id: 'seed-stuck', title: 'Stuck direction', evidence: 'Evidence' });
  const [claimed] = await store.claimSeeds(1);
  assert.equal(claimed.seedId, 'seed-stuck');
  assert.deepEqual((await store.seedCounts()).stale, []);
  assert.deepEqual((await store.recoverSeeds({ olderThanMs: 60_000 })).recovered, []);
  // Age the claim past the recovery threshold: an interrupted run looks like this.
  const file = store.seedRef('seed-stuck'), seed = JSON.parse(await readFile(file, 'utf8'));
  seed.claimedAt = new Date(Date.now() - 3_600_000).toISOString();
  await atomicJSON(file, seed);
  const dry = await store.recoverSeeds({ dryRun: true });
  assert.equal(dry.stale.length, 1);
  assert.deepEqual(dry.recovered, []);
  const recovered = await store.recoverSeeds();
  assert.deepEqual(recovered.recovered, ['seed-stuck']);
  const released = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(released.status, 'queued');
  assert.equal(released.claimId, null);
  assert.equal(released.claimedAt, null);
  assert.equal(released.attempts, 1);
  assert.equal(released.lastOutcome, 'recovered-stale-claim');
  assert.deepEqual((await store.seedCounts()).stale, []);
  // A released direction is claimable again.
  assert.deepEqual((await store.claimSeeds(1)).map(envelope => envelope.seedId), ['seed-stuck']);
});

test('queue-check counts in-flight miners and seed-batch claims only the headroom', async t => {
  // The store policy cap (default 3) is raised so this test isolates the
  // producer headroom: maxPending is the graph-level ceiling, maxMiningSeeds the
  // store-level backstop.
  const { store } = await fixture(t, { maxMiningSeeds: 5 });
  await store.ensureBaselineSeeds();
  const first = await cli('seed-batch', { dataRoot: store.root, maxPending: 3 });
  assert.equal(first.outcome, 'ready');
  assert.equal(first.output.items.length, 3);
  assert.equal(first.output.mining, 3);
  const blocked = await cli('queue-check', { dataRoot: store.root, maxPending: 3 });
  assert.equal(blocked.outcome, 'skip');
  assert.equal(blocked.output.backlog, 3);
  assert.equal(blocked.output.headroom, 0);
  const second = await cli('seed-batch', { dataRoot: store.root, maxPending: 3 });
  assert.equal(second.outcome, 'idle');
  assert.equal(second.output.reason, 'backlog-full');
  // Waiting requirements share the same ceiling as in-flight miners.
  await store.upsertRequirement(user('req-watermark'));
  const pendingOnly = await cli('queue-check', { dataRoot: store.root, maxPending: 3 });
  assert.equal(pendingOnly.outcome, 'skip');
  assert.equal(pendingOnly.output.backlog, 4);
  const roomy = await cli('seed-batch', { dataRoot: store.root, maxPending: 6 });
  assert.equal(roomy.outcome, 'ready');
  assert.equal(roomy.output.items.length, 2);
  assert.equal(roomy.output.mining, 5);
});

test('the store mining cap also bounds the reported producer headroom', async t => {
  const { store } = await fixture(t, { maxMiningSeeds: 2 });
  await store.ensureBaselineSeeds();
  const claimed = await cli('seed-batch', { dataRoot: store.root, maxPending: 6 });
  assert.equal(claimed.outcome, 'ready');
  assert.equal(claimed.output.items.length, 2);
  const blocked = await cli('queue-check', { dataRoot: store.root, maxPending: 6 });
  assert.equal(blocked.outcome, 'skip');
  assert.equal(blocked.output.reason, 'mining-cap');
  assert.equal(blocked.output.headroom, 0);
  const batch = await cli('seed-batch', { dataRoot: store.root, maxPending: 6 });
  assert.equal(batch.outcome, 'idle');
  assert.equal(batch.output.reason, 'mining-cap');
});

test('a settled mined requirement returns its seed to the back of the rotation', async t => {
  const { store } = await fixture(t);
  await store.upsertSeed({ id: 'seed-settle', title: 'Settle me', evidence: 'Evidence' });
  await store.upsertSeed({ id: 'seed-later', title: 'Later direction', evidence: 'Evidence' });
  const [first] = await store.claimSeeds(1);
  const proposed = await store.proposeSeed({
    seedId: first.seedId,
    claimId: first.claimId,
    proposal: { title: 'Mined settle', summary: 'Concrete change', evidence: 'Concrete change', risk: 'low', priority: 2 },
  });
  assert.equal(proposed.id, 'req-settle');
  assert.equal((await store.readSeeds()).find(seed => seed.id === 'seed-settle').status, 'proposed');
  const item = await prepared(store, 'req-settle', mined('req-settle', 'mid', { expectedRevision: proposed.revision }));
  const artifact = await implement(store, item);
  await pass(store, item, artifact);
  assert.deepEqual((await store.claimSeeds(1)).map(envelope => envelope.seedId), ['seed-later']);
  await store.mergeDecision(item.id, item.claimId, { artifactRef: artifact.artifactRef, decision: 'reject', note: 'Not wanted' });
  const settled = (await store.readSeeds()).find(seed => seed.id === 'seed-settle');
  assert.equal(settled.status, 'queued');
  assert.equal(settled.lastOutcome, 'requirement-rejected');
  assert.equal(settled.rotationRound, 3, 'the settled direction takes the newest rotation position');
  // Release the seed-later claim and confirm the settled direction waits behind it.
  assert.deepEqual((await store.recoverSeeds({ olderThanMs: 0 })).recovered, ['seed-later']);
  assert.deepEqual((await store.claimSeeds(1)).map(envelope => envelope.seedId), ['seed-later']);
});

test('retired seeds leave the rotation and re-arm to the back when restored', async t => {
  const { store } = await fixture(t);
  for (const id of ['seed-x', 'seed-y']) await store.upsertSeed({ id, title: id, evidence: `${id} evidence` });
  const retired = await cli('retire-seed', { dataRoot: store.root, seedId: 'seed-x', reason: 'direction is permanent' });
  assert.equal(retired.outcome, 'complete');
  assert.equal(retired.output.status, 'retired');
  assert.deepEqual((await store.claimSeeds(1)).map(envelope => envelope.seedId), ['seed-y']);
  await assert.rejects(store.rearmSeed('seed-y'), /Only a retired seed/);
  await assert.rejects(store.retireSeed('seed-y', 'cannot retire a mining direction'), /Recover the stale claim/);
  const rearmed = await cli('rearm-seed', { dataRoot: store.root, seedId: 'seed-x' });
  assert.equal(rearmed.outcome, 'queued');
  assert.equal(rearmed.output.status, 'queued');
  const seed = (await store.readSeeds()).find(value => value.id === 'seed-x');
  assert.equal(seed.retiredReason, null);
  assert.equal(seed.lastOutcome, 're-armed');
  assert.equal(seed.rotationRound, 2);
});

test('a merged mined requirement re-arms its seed, and re-mining creates a suffixed requirement', async t => {
  const { store } = await fixture(t);
  await store.upsertSeed({ id: 'seed-mine', title: 'Mine me', evidence: 'Evidence' });
  const [first] = await store.claimSeeds(1);
  assert.equal(first.seedId, 'seed-mine');
  const proposed = await store.proposeSeed({
    seedId: 'seed-mine',
    claimId: first.claimId,
    proposal: { title: 'First mined change', summary: 'Concrete change', evidence: 'Concrete change', risk: 'low', priority: 2 },
  });
  assert.equal(proposed.id, 'req-mine');
  const item = await prepared(store, 'req-mine', mined('req-mine', 'low', { expectedRevision: proposed.revision }));
  const artifact = await implement(store, item);
  await approve(store, item, artifact);
  assert.equal((await integrate(store, item.id, item.claimId)).outcome, 'merged');
  const settled = (await store.readSeeds()).find(seed => seed.id === 'seed-mine');
  assert.equal(settled.status, 'queued');
  assert.equal(settled.lastOutcome, 'requirement-merged');
  // Re-mining the same evergreen direction must create new work, not collide
  // with the terminal requirement it already produced.
  const [second] = await store.claimSeeds(1);
  assert.equal(second.seedId, 'seed-mine');
  const next = await store.proposeSeed({
    seedId: 'seed-mine',
    claimId: second.claimId,
    proposal: { title: 'Second mined change', summary: 'Another concrete change', evidence: 'Another concrete change', risk: 'low', priority: 2 },
  });
  assert.equal(next.id, 'req-mine-r2');
  assert.equal(next.seedId, 'seed-mine');
  assert.notEqual(next.id, proposed.id);
  assert.equal((await store.readSeeds()).find(seed => seed.id === 'seed-mine').status, 'proposed');
});

test('a model-supplied reason cannot fail a valid no-proposal outcome', async t => {
  const { store } = await fixture(t);
  await store.upsertSeed({ id: 'seed-quiet', title: 'Quiet direction', evidence: 'Evidence' });
  const [claimed] = await store.claimSeeds(1);
  assert.equal(await store.proposeSeed({ seedId: 'seed-quiet', claimId: claimed.claimId, proposal: null, reason: { unexpected: true } }), null);
  let seed = (await store.readSeeds()).find(value => value.id === 'seed-quiet');
  assert.equal(seed.status, 'queued');
  assert.equal(seed.lastReason, null);
  const [again] = await store.claimSeeds(1);
  await store.proposeSeed({ seedId: 'seed-quiet', claimId: again.claimId, proposal: null, reason: 'x'.repeat(900) });
  seed = (await store.readSeeds()).find(value => value.id === 'seed-quiet');
  assert.equal(seed.lastReason.length, 500);
});

test('retiring a direction whose requirement is still active keeps it retired', async t => {
  const { store } = await fixture(t);
  await store.upsertSeed({ id: 'seed-busy', title: 'Busy direction', evidence: 'Evidence' });
  const [claimed] = await store.claimSeeds(1);
  const requirement = await store.proposeSeed({
    seedId: 'seed-busy',
    claimId: claimed.claimId,
    proposal: { title: 'Busy change', summary: 'Concrete change', evidence: 'Concrete change', risk: 'low', priority: 2 },
  });
  await store.retireSeed('seed-busy', 'direction no longer wanted');
  assert.equal((await store.readSeeds()).find(seed => seed.id === 'seed-busy').status, 'retired');
  await assert.rejects(store.rearmSeed('seed-busy'), /active requirement/);
  // Settlement must not resurrect a retired direction.
  await store.settleSeedForRequirementUnlocked({ id: requirement.id, seedId: 'seed-busy', status: 'merged' });
  assert.equal((await store.readSeeds()).find(seed => seed.id === 'seed-busy').status, 'retired');
  // Once the requirement is terminal the direction can be restored explicitly.
  const item = await store.get(requirement.id);
  item.status = 'rejected';
  await store.save(item);
  await store.rearmSeed('seed-busy');
  assert.equal((await store.readSeeds()).find(seed => seed.id === 'seed-busy').status, 'queued');
});

test('pr-init manual gate treats branch protection as a warning, not a hard gate', async t => {
  const base = await fixture(t);
  await withPullRequestFixture(t, base);
  process.env.DSH_FAKE_NO_PROTECTION = '1';
  t.after(() => { delete process.env.DSH_FAKE_NO_PROTECTION; });
  const strict = await stage('pr-init', { repoRoot: base.repo, baseBranch: 'main', apply: true });
  assert.equal(strict.outcome, 'blocked');
  const strictProtection = strict.output.checks.find(check => check.id === 'branch-protection');
  assert.equal(strictProtection.required, true);
  assert.equal(strictProtection.ok, false);
  const manual = await stage('pr-init', { repoRoot: base.repo, baseBranch: 'main', apply: true, manualGate: true });
  assert.equal(manual.outcome, 'complete');
  assert.equal(manual.output.manualGate, true);
  const protection = manual.output.checks.find(check => check.id === 'branch-protection');
  assert.equal(protection.ok, false);
  assert.equal(protection.required, false);
  assert.deepEqual(manual.output.warnings.map(check => check.id).sort(), ['branch-protection', 'required-checks', 'required-conversation-resolution']);
  // Auth, repo access and merge commits stay hard requirements in both modes.
  const mergeCommit = manual.output.checks.find(check => check.id === 'merge-commit');
  assert.equal(mergeCommit.required, true);
  assert.equal(mergeCommit.ok, true);
});

test('intake records raw text, applies one plan, and dedupes derived seeds', async t => {
  const { store } = await fixture(t);
  const recorded = await cli('intake-record', { dataRoot: store.root, text: 'Add a dashboard page with docs updates' });
  assert.equal(recorded.outcome, 'complete');
  assert.equal(recorded.output.needsPlanning, true);
  const intakeId = path.basename(recorded.output.dataRef, '.json');
  assert.equal((await store.get(intakeId)).status, 'planning');
  assert.equal((await store.get(intakeId)).needsPlanning, true);
  // A raw intake is not claimable until its plan is applied.
  assert.deepEqual(await store.claimBatch(3), []);
  const applied = await cli('intake-apply', {
    dataRef: recorded.output.dataRef,
    claimId: recorded.output.claimId,
    requirement: { title: 'Dashboard page', summary: 'Ship a dashboard page with a loading state', evidence: 'Ship a dashboard page with a loading state', risk: 'mid', tags: ['page'] },
    seeds: [
      { title: 'Document the dashboard', evidence: 'README lacks a dashboard section', tags: ['docs'] },
      { title: 'Dashboard empty states', evidence: 'No empty/error states exist', tags: ['ux'] },
    ],
    reason: 'split from a broad request',
  });
  assert.equal(applied.outcome, 'complete');
  assert.equal(applied.output.seeds.length, 2);
  const item = await store.get(intakeId);
  assert.equal(item.status, 'queued');
  assert.equal(item.claimId, null);
  assert.equal(item.needsPlanning, false);
  assert.equal(item.title, 'Dashboard page');
  const seeds = await store.readSeeds();
  assert.ok(seeds.every(seed => seed.origin === 'user' && seed.relatedRequirementId === intakeId));
  // A later intake proposing an existing direction skips it with a reason.
  const second = await cli('intake-record', { dataRoot: store.root, text: 'Another broad request' });
  const reused = await cli('intake-apply', {
    dataRef: second.output.dataRef,
    claimId: second.output.claimId,
    requirement: { title: 'Another request', summary: 'Different bounded work', evidence: 'Different bounded work', risk: 'low' },
    seeds: [{ title: 'Document the dashboard', evidence: 'duplicate direction' }],
  });
  assert.equal(reused.output.seeds.length, 0);
  assert.equal(reused.output.skipped.length, 1);
  assert.match(reused.output.skipped[0].reason, /same direction/);
});

test('an unclear intake keeps and queues the raw request', async t => {
  const { store } = await fixture(t);
  const recorded = await cli('intake-record', { dataRoot: store.root, text: 'maybe improve things a bit' });
  const applied = await cli('intake-apply', {
    dataRef: recorded.output.dataRef,
    claimId: recorded.output.claimId,
    requirement: null,
    seeds: [],
    reason: 'too vague to split safely',
  });
  assert.equal(applied.outcome, 'complete');
  const item = await store.get(path.basename(recorded.output.dataRef, '.json'));
  assert.equal(item.status, 'queued');
  assert.equal(item.needsPlanning, false);
  assert.match(item.evidence, /maybe improve things a bit/);
  assert.equal(item.intakeReason, 'too vague to split safely');
  assert.equal((await store.readSeeds()).length, 0);
});

test('the intake graph plans a broad request before dispatch claims it', async t => {
  const { store, repo } = await fixture(t);
  const raw = JSON.parse(await readFile(graphFile, 'utf8'));
  for (const node of raw.nodes.filter(node => node.type === 'gate')) node.config.delayMs = 0;
  raw.entry = 'intake-record';
  const definition = normalizeDefinition(raw);
  const artifacts = new Map(); let next = 0;
  const io = { put: async value => { const ref = `ref-${++next}`; artifacts.set(ref, structuredClone(value)); return ref; }, get: async ref => structuredClone(artifacts.get(ref)), archive: async () => {} };
  const state = await newRunState({ definition, cwd: repo, permissions: { command: { mode: 'allowlist', allow: ['node docs/examples/development/driver.mjs'] } }, input: { dataRoot: store.root, text: 'Add a dashboard page' } }, io);
  let plannerCalls = 0;
  const executors = {
    command: async ({ node, input }) => stage(node.config.command.split(' ').at(-1), input),
    agent: async ({ node, input }) => {
      assert.equal(node.id, 'intake-plan');
      plannerCalls += 1;
      assert.equal(node.config.reasoningEffort, 'low');
      assert.match(input.text, /dashboard/);
      return { outcome: 'planned', output: { requirement: { title: 'Dashboard page', summary: 'Ship the first dashboard view', evidence: 'Ship the first dashboard view', risk: 'low' }, seeds: [{ title: 'Docs for the dashboard', evidence: 'README lacks dashboard documentation' }] } };
    },
  };
  // Keep the newly queued requirement at the claim boundary so the test does not
  // create worktrees for the whole engineering flow.
  await run(state, executors, { io, maxSteps: 30, control: () => ({ nodes: { route: false } }) });
  assert.equal(plannerCalls, 1);
  const items = await store.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Dashboard page');
  assert.equal(items[0].needsPlanning, false);
  assert.ok(['intake', 'ready'].includes(items[0].status));
  assert.ok((await store.readSeeds()).some(seed => seed.title === 'Docs for the dashboard' && seed.origin === 'user'));
});

test('a v3 business store is rejected until the explicit migrate stage upgrades it', async t => {
  const { store } = await fixture(t);
  const legacy = path.join(store.root, '..', 'legacy-store');
  await mkdir(legacy);
  for (const name of ['requirements', 'seeds', 'artifacts', 'reviews', 'worktrees', 'locks']) await mkdir(path.join(legacy, name));
  const config = { version: 3, dataRoot: legacy, repoRoot: store.config.repoRoot, baseBranch: 'main', cleanupPolicy: 'after-verified-merge', integrationMode: 'local', prRemote: 'origin', maxMiningSeeds: 3, staleClaimMs: 1_800_000 };
  await writeFile(path.join(legacy, 'config.json'), JSON.stringify(config));
  await writeFile(path.join(legacy, 'requirements', 'req-legacy.json'), JSON.stringify({
    id: 'req-legacy', source: 'user', seedId: null, title: 'Legacy change', description: 'Old full description', tags: [],
    priority: 0, risk: 'mid', revision: 1, order: 1, createdAt: '2026-01-01T00:00:00.000Z', status: 'merged', worktreePath: null,
    baseRevision: null, implementation: null, reviews: [], feedback: [], github: null, requirementApproval: null, approval: null,
    claimId: null, engineeringEpoch: 0, pendingSnapshot: null,
  }));
  await assert.rejects(DevelopmentStore.open(legacy), /Unsupported business store version 3/);
  const dry = await cli('migrate', { dataRoot: legacy });
  assert.equal(dry.outcome, 'complete'); assert.equal(dry.output.applied, false); assert.equal(dry.output.migrated, 1);
  assert.equal(JSON.parse(await readFile(path.join(legacy, 'config.json'), 'utf8')).version, 3, 'dry-run never writes');
  const applied = await cli('migrate', { dataRoot: legacy, apply: true });
  assert.equal(applied.output.applied, true);
  const migrated = JSON.parse(await readFile(path.join(legacy, 'requirements', 'req-legacy.json'), 'utf8'));
  assert.equal(migrated.description, undefined); assert.equal(migrated.evidence, 'Old full description');
  assert.equal(migrated.summary, 'Old full description'); assert.deepEqual(migrated.why, []); assert.deepEqual(migrated.acceptance, []);
  assert.equal(migrated.status, 'merged', 'terminal audit state is preserved');
  const opened = await DevelopmentStore.open(legacy);
  assert.equal(opened.config.mergePolicy, 'comment');
  const again = await cli('migrate', { dataRoot: legacy });
  assert.equal(again.output.migrated, 0);
  assert.equal(again.output.applied, false);
});
test('decision-first requirement fields are bounded', async t => {
  const { store } = await fixture(t);
  await assert.rejects(store.upsertRequirement({ ...user('req-long'), summary: 'x'.repeat(1001) }), /Invalid summary/);
  await assert.rejects(store.upsertRequirement({ ...user('req-many'), acceptance: Array.from({ length: 9 }, () => 'testable') }), /Invalid acceptance/);
  await assert.rejects(store.upsertRequirement({ ...user('req-long-evidence'), evidence: 'x'.repeat(12_001) }), /Invalid evidence/);
});

test('CLI protocol is JSON-only and filesystem claim lock works across processes', async t => {
  const { store } = await fixture(t);
  for (let index = 0; index < 3; index++) await cli('requirement', { dataRoot: store.root, requirement: user(`req-process-${index}`) });
  const outputs = await Promise.all(Array.from({ length: 3 }, () => cli('claim', { dataRoot: store.root, batchSize: 1 })));
  assert.equal(new Set(outputs.map(value => value.output.items[0].dataRef)).size, 3);
  for (const response of outputs) {
    assert.equal(response.outcome, 'ready');
    assert.ok(path.isAbsolute(response.output.dataRef));
    const envelope = response.output.items[0];
    const routed = await cli('route', envelope);
    assert.equal(routed.outcome, 'ready'); assert.equal(routed.output.dataRef, envelope.dataRef);
  }
  const status = await cli('status', { dataRoot: store.root });
  assert.equal(status.output.counts.ready, 3);
  try { await cli('not-a-stage', { dataRef: store.ref('req-process-0') }); assert.fail('invalid stage must fail'); }
  catch (error) { assert.equal(error.code, 1); assert.equal(JSON.parse(error.stdout).outcome, 'fail'); assert.equal(error.stderr, ''); }
  const { stdout } = await execute(process.execPath, [driver, 'status'], { env: { ...process.env, DSH_WORKFLOW_INPUT: '{' } }).catch(error => error);
  assert.equal(JSON.parse(stdout).outcome, 'fail');
});

test('one requirement branch + one worktree + one PR survives review, GitHub feedback and external merge', async t => {
  const base = await fixture(t, { integrationMode: 'pull-request' });
  const { state: prState, fakeGh } = await withPullRequestFixture(t, base, { readyMerges: false });
  const { store, repo } = base;
  const item = await prepared(store, 'req-branch');
  assert.equal((await store.get(item.id)).branch, 'auto/req-branch');
  assert.equal(await git(item.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), 'auto/req-branch');
  const artifact = await implement(store, item);
  const baseRevision = (await store.get(item.id)).baseRevision;
  assert.equal(await git(item.cwd, 'rev-list', '--count', `${baseRevision}..HEAD`), '1', 'snapshot squashes the PR to one commit');
  const published = await publish(store, item.id, item.claimId);
  assert.equal(published.outcome, 'complete');
  assert.equal((await store.get(item.id)).pr.number, 1);
  await pass(store, item, artifact);
  const briefed = await mergeBrief(store, item.id, item.claimId);
  const markdown = briefed.brief.markdown;
  assert.match(markdown, /## Change/);
  assert.match(markdown, /## Verification/);
  assert.match(markdown, /## Review verdict/);
  assert.match(markdown, /## Merge decision/);
  assert.match(markdown, /@workflow merge/);
  assert.match(markdown, /<details>/);
  assert.doesNotMatch(markdown, /## Requirement/);
  await updateBody(store, briefed);
  let prFile = JSON.parse(await readFile(prState, 'utf8'));
  assert.match(prFile.prs[0].body, /Pinned commit reviewed/);
  assert.match(prFile.prs[0].body, /^<!-- workflow/);
  assert.match(prFile.prs[0].body, /stage=reviewing/);
  assert.equal((await ready(store, item.id, item.claimId)).outcome, 'complete');
  prFile = JSON.parse(await readFile(prState, 'utf8'));
  assert.match(prFile.prs[0].body, /stage=verifying/);
  assert.equal((prFile.prs[0].labels ?? []).includes('workflow:merge-ready'), false);
  assert.equal((await watch(store, item.id, item.claimId)).outcome, 'waiting');
  await execute(process.execPath, [fakeGh, 'pr', 'merge', '1'], { cwd: base.repo, env: { ...process.env } });
  const merged = await watch(store, item.id, item.claimId);
  assert.equal(merged.outcome, 'merged');
  assert.equal((await store.get(item.id)).integration.mechanism, 'external-pr');
  assert.equal((await cleanup(store, item.id, item.claimId)).outcome, 'cleaned');
  assert.equal(await git(repo, 'branch', '--list', 'auto/req-branch'), '');
  await assert.rejects(lstat(item.cwd), { code: 'ENOENT' });
});

test('an authorized verdict plus @workflow merge merges with a merge commit and settles the seed', async t => {
  const base = await fixture(t, { integrationMode: 'pull-request' });
  const { state: prState } = await withPullRequestFixture(t, base, { readyMerges: false });
  const { store } = base;
  await store.upsertSeed({ id: 'seed-merge', title: 'Merge direction', evidence: 'Evidence' });
  const [seed] = await store.claimSeeds(1);
  const proposed = await store.proposeSeed({ seedId: 'seed-merge', claimId: seed.claimId, proposal: { title: 'Merge change', summary: 'Concrete change', evidence: 'Concrete change', risk: 'low', priority: 2 } });
  const item = await prepared(store, 'req-merge', mined('req-merge', 'low', { expectedRevision: proposed.revision }));
  const artifact = await implement(store, item);
  await publish(store, item.id, item.claimId);
  await pass(store, item, artifact);
  await mergeBrief(store, item.id, item.claimId);
  await ready(store, item.id, item.claimId);
  // Unauthorized and workflow-authored comments never decide.
  await addPrComment(prState, { body: '[verdict=revise]', login: 'outsider', association: 'NONE' });
  await addPrComment(prState, { body: '[role=workflow] [verdict=revise]', login: 'maintainer', association: 'OWNER' });
  assert.equal((await watch(store, item.id, item.claimId)).outcome, 'waiting');
  await addPrComment(prState, { body: '@workflow merge', login: 'maintainer', association: 'OWNER' });
  await addPrComment(prState, { body: '[verdict=pass]', login: 'maintainer', association: 'OWNER' });
  const passed = await watch(store, item.id, item.claimId);
  assert.equal(passed.outcome, 'pass');
  const gated = JSON.parse(await readFile(prState, 'utf8'));
  assert.match(gated.prs[0].body, /stage=merge-ready/);
  assert.ok(gated.prs[0].labels.includes('workflow:merge-ready'));
  const merged = await merge(store, item.id, item.claimId);
  assert.equal(merged.outcome, 'merged');
  const after = await store.get(item.id);
  assert.equal(after.status, 'merged');
  assert.equal(after.integration.mechanism, 'workflow-merge');
  assert.ok(after.pr.mergeDecision.mergeCommit);
  assert.equal(after.pr.mergeDecision.decision.kind, 'comment');
  const settled = (await store.readSeeds()).find(entry => entry.id === 'seed-merge');
  assert.equal(settled.status, 'queued');
  assert.equal(settled.lastOutcome, 'requirement-merged');
});

test('blocking GitHub feedback reworks the same branch and a stale verdict cannot block the new head', async t => {
  const base = await fixture(t, { integrationMode: 'pull-request' });
  const { state: prState } = await withPullRequestFixture(t, base, { readyMerges: false });
  const { store } = base;
  const item = await prepared(store, 'req-revise');
  const artifact = await implement(store, item);
  await publish(store, item.id, item.claimId);
  await pass(store, item, artifact);
  await mergeBrief(store, item.id, item.claimId);
  await ready(store, item.id, item.claimId);
  await addPrComment(prState, { body: '[verdict=revise]', login: 'maintainer', association: 'OWNER' });
  const revised = await watch(store, item.id, item.claimId);
  assert.equal(revised.outcome, 'revise');
  const blocked = JSON.parse(await readFile(prState, 'utf8'));
  assert.match(blocked.prs[0].body, /stage=blocked/);
  assert.equal((blocked.prs[0].labels ?? []).includes('workflow:merge-ready'), false);
  const applied = await requestChanges(store, item.id, item.claimId, { feedback: revised.feedback });
  assert.equal(applied.outcome, 'complete');
  const reworked = await store.get(item.id);
  assert.equal(reworked.status, 'engineering-ready');
  assert.equal(reworked.approval, null);
  assert.equal(reworked.branch, 'auto/req-revise');
  assert.equal(reworked.feedback.at(-1).key, `comment:${revised.feedback.decision.id}`);
  const before = reworked.feedback.length;
  await requestChanges(store, item.id, item.claimId, { feedback: revised.feedback });
  assert.equal((await store.get(item.id)).feedback.length, before, 'the same GitHub decision is applied once');
  // Rework on the same branch/worktree, publish the new head, and require a
  // fresh verdict: the old markerless revise comment predates the new window.
  const next = await implement(store, { ...reworked, cwd: reworked.worktreePath }, { contents: 'reworked after feedback\n' });
  await publish(store, item.id, item.claimId);
  await pass(store, item, next);
  await mergeBrief(store, item.id, item.claimId);
  await ready(store, item.id, item.claimId);
  await addPrComment(prState, { body: '@workflow merge', login: 'maintainer', association: 'OWNER' });
  await addPrComment(prState, { body: '[verdict=pass]', login: 'maintainer', association: 'OWNER' });
  assert.equal((await watch(store, item.id, item.claimId)).outcome, 'pass');
  assert.equal((await merge(store, item.id, item.claimId)).outcome, 'merged');
});

test('PR merge gate waits for green CI and resolved threads, then honours the label policy', async t => {
  const base = await fixture(t, { integrationMode: 'pull-request', mergePolicy: 'label' });
  const { state: prState } = await withPullRequestFixture(t, base, { readyMerges: false });
  const { store } = base;
  const item = await prepared(store, 'req-gate');
  const artifact = await implement(store, item);
  await publish(store, item.id, item.claimId);
  await pass(store, item, artifact);
  await mergeBrief(store, item.id, item.claimId);
  await ready(store, item.id, item.claimId);
  await mutatePrState(prState, pr => { pr.checks = [{ conclusion: 'FAILURE' }]; pr.threads = [{ isResolved: false }]; });
  await addPrComment(prState, { body: '[verdict=pass]', login: 'maintainer', association: 'OWNER' });
  assert.equal((await watch(store, item.id, item.claimId)).outcome, 'revise', 'an unresolved thread is blocking feedback');
  let gated = JSON.parse(await readFile(prState, 'utf8'));
  assert.match(gated.prs[0].body, /stage=blocked/);
  assert.equal((gated.prs[0].labels ?? []).includes('workflow:merge-ready'), false);
  await mutatePrState(prState, pr => { pr.checks = [{ conclusion: 'SUCCESS' }]; pr.threads = [{ isResolved: true }]; });
  assert.equal((await watch(store, item.id, item.claimId)).outcome, 'waiting', 'the label policy still needs workflow:merge');
  await mutatePrState(prState, pr => { pr.labels = [...(pr.labels ?? []), 'workflow:merge']; });
  assert.equal((await watch(store, item.id, item.claimId)).outcome, 'pass');
  assert.equal((await merge(store, item.id, item.claimId)).outcome, 'merged');
});

test('merge policy auto merges a fresh pass without a comment', async t => {
  const base = await fixture(t, { integrationMode: 'pull-request', mergePolicy: 'auto' });
  const { state: prState } = await withPullRequestFixture(t, base, { readyMerges: false });
  const { store } = base;
  const item = await prepared(store, 'req-auto');
  const artifact = await implement(store, item);
  await publish(store, item.id, item.claimId);
  await pass(store, item, artifact);
  await mergeBrief(store, item.id, item.claimId);
  await ready(store, item.id, item.claimId);
  await addPrComment(prState, { body: '[verdict=pass]', login: 'maintainer', association: 'OWNER' });
  assert.equal((await watch(store, item.id, item.claimId)).outcome, 'pass');
  assert.equal((await merge(store, item.id, item.claimId)).outcome, 'merged');
});

test('a closed PR returns to engineering on the same requirement', async t => {
  const base = await fixture(t, { integrationMode: 'pull-request' });
  const { state: prState } = await withPullRequestFixture(t, base, { readyMerges: false });
  const { store } = base;
  const item = await prepared(store, 'req-closed');
  const artifact = await implement(store, item);
  await publish(store, item.id, item.claimId);
  await pass(store, item, artifact);
  await mergeBrief(store, item.id, item.claimId);
  await ready(store, item.id, item.claimId);
  await mutatePrState(prState, pr => { pr.state = 'CLOSED'; });
  const closed = await watch(store, item.id, item.claimId);
  assert.equal(closed.outcome, 'closed');
  assert.equal((await requestChanges(store, item.id, item.claimId, { reason: closed.reason })).outcome, 'complete');
  const reworked = await store.get(item.id);
  assert.equal(reworked.status, 'engineering-ready');
  assert.equal(reworked.feedback.at(-1).scope, 'pr');
});
test('pr-init checks and safely creates the labels and PR template', async t => {
  const base = await fixture(t);
  const { state } = await withPullRequestFixture(t, base);
  const before = await stage('pr-init', { repoRoot: base.repo, baseBranch: 'main' });
  assert.equal(before.outcome, 'blocked');
  assert.equal(before.output.checks.find(check => check.id === 'pr-template').ok, false);
  assert.equal(before.output.checks.find(check => check.id === 'requirement-labels').ok, false);
  const applied = await stage('pr-init', { repoRoot: base.repo, baseBranch: 'main', apply: true });
  assert.equal(applied.outcome, 'complete');
  assert.equal(applied.output.checks.find(check => check.id === 'requirement-labels').ok, true);
  const fake = JSON.parse(await readFile(state, 'utf8'));
  for (const label of ['workflow:merge-ready', 'workflow:requirement-review', 'workflow:requirement-approved', 'workflow:requirement-rejected']) assert.ok(fake.labels.includes(label), label);
  const template = await readFile(path.join(base.repo, '.github', 'pull_request_template.md'), 'utf8');
  assert.match(template, /^<!-- workflow/);
  assert.match(template, /stage=implementing/);
});

test('requirement review publishes one redacted issue and applies an authorized approval', async t => {
  const base = await fixture(t);
  const { state } = useFakeGh(t, base.root);
  const { item, envelope } = await pendingReview(base.store);
  const published = await cli('publish-requirement-issue', envelope);
  assert.equal(published.outcome, 'complete');
  const number = published.output.github.number;
  let fake = JSON.parse(await readFile(state, 'utf8'));
  assert.equal(fake.issues.length, 1);
  const issue = fake.issues[0];
  assert.match(issue.title, /Review me/);
  assert.match(issue.body, /workflow-requirement/);
  assert.match(issue.body, /## What/);
  assert.match(issue.body, /## Acceptance/);
  assert.match(issue.body, /## Decision/);
  assert.match(issue.body, /<details>/);
  assert.ok(issue.body.indexOf('## What') < issue.body.indexOf('<details>'), 'the decision view comes before full evidence');
  assert.doesNotMatch(issue.body, /C:\\Users/);
  assert.doesNotMatch(issue.body, /owner@example\.com/);
  assert.doesNotMatch(issue.body, /ghp_/);
  assert.deepEqual(issue.labels, ['workflow:requirement-review']);
  // Republishing the same revision updates that issue instead of opening another.
  await cli('publish-requirement-issue', envelope);
  assert.equal(JSON.parse(await readFile(state, 'utf8')).issues.length, 1);
  // Unauthorized or unparsable comments never decide.
  await issueComment(state, number, '@workflow approve', 'NONE');
  assert.equal((await cli('check-requirement-issue', envelope)).outcome, 'waiting');
  await issueComment(state, number, '@workflow maybe');
  assert.equal((await cli('check-requirement-issue', envelope)).outcome, 'waiting');
  assert.equal((await base.store.get(item.id)).status, 'requirement-pending');
  // An authorized approval applies to the stamped revision.
  await issueComment(state, number, '@workflow approve');
  const approved = await cli('check-requirement-issue', envelope);
  assert.equal(approved.outcome, 'approved');
  assert.equal((await base.store.get(item.id)).status, 'ready');
  fake = JSON.parse(await readFile(state, 'utf8'));
  assert.equal(fake.issues[0].state, 'CLOSED');
  assert.ok(fake.issues[0].labels.includes('workflow:requirement-approved'));
  assert.ok(!fake.issues[0].labels.includes('workflow:requirement-review'));
});

test('requirement review rejects with a reason and reopens the same issue for a new revision', async t => {
  const base = await fixture(t);
  const { state } = useFakeGh(t, base.root);
  const { item, envelope } = await pendingReview(base.store);
  const published = await cli('publish-requirement-issue', envelope);
  const number = published.output.github.number;
  // A reject without a reason is refused and asks for one.
  await issueComment(state, number, '@workflow reject');
  const nagged = await cli('check-requirement-issue', envelope);
  assert.equal(nagged.outcome, 'waiting');
  assert.equal(nagged.output.reason, 'missing-rejection-reason');
  assert.match(JSON.parse(await readFile(state, 'utf8')).issues[0].comments.at(-1).body, /需要一句理由/);
  assert.equal((await base.store.get(item.id)).status, 'requirement-pending');
  // A reasoned reject returns the requirement for revision.
  await issueComment(state, number, '@workflow reject 与已有需求重复', 'MEMBER');
  const rejected = await cli('check-requirement-issue', envelope);
  assert.equal(rejected.outcome, 'rejected');
  let current = await base.store.get(item.id);
  assert.equal(current.status, 'requirement-revision');
  assert.equal(current.requirementApproval.decision, 'reject');
  assert.equal(current.requirementApproval.actor, 'github:maintainer');
  // The analyst revises the same id; its route republishes revision 2 on the same issue.
  await base.store.reviseRequirement(item.id, item.claimId, { expectedRevision: current.revision, title: 'Review me v2', summary: 'Narrowed change', evidence: 'Narrowed change', risk: 'mid', tags: ['user'] });
  const rerouted = await base.store.route(item.id, item.claimId);
  assert.equal(rerouted.outcome, 'needs_approval');
  const republished = await cli('publish-requirement-issue', base.store.envelope(rerouted.item));
  assert.equal(republished.output.github.number, number);
  const fake = JSON.parse(await readFile(state, 'utf8'));
  assert.equal(fake.issues[0].state, 'OPEN');
  assert.ok(fake.issues[0].labels.includes('workflow:requirement-review'));
  assert.ok(!fake.issues[0].labels.includes('workflow:requirement-rejected'));
  // The earlier reject comment is below the refreshed comment floor.
  assert.equal((await cli('check-requirement-issue', base.store.envelope(rerouted.item))).outcome, 'waiting');
  // A fresh approval for revision 2 is accepted.
  await issueComment(state, number, '@workflow approve');
  const approved = await cli('check-requirement-issue', base.store.envelope(rerouted.item));
  assert.equal(approved.outcome, 'approved');
  const merged = await base.store.get(item.id);
  assert.equal(merged.revision, 2);
  assert.equal(merged.status, 'ready');
});

test('real worktree survives review feedback/rejection; implementation and reviews pin immutable revisions', async t => {
  const { store } = await fixture(t);
  const item = await prepared(store);
  const first = await implement(store, item);
  const originalArtifact = await readFile(first.artifactRef, 'utf8');
  await assert.rejects(atomicJSON(first.artifactRef, {}, { immutable: true }), /Immutable/);
  await assert.rejects(integrate(store, item.id, item.claimId), /not approved/);
  await assert.rejects(cleanup(store, item.id, item.claimId, { cleanup: true }), /verified/);
  await assert.rejects(recordReview(store, item.id, item.claimId, { artifactRef: first.artifactRef, commit: '0'.repeat(40), decision: 'pass' }), /immutable/);
  const review = await pass(store, item, first);
  const originalReview = await readFile(review.reviewRef, 'utf8');
  await store.mergeDecision(item.id, item.claimId, { artifactRef: first.artifactRef, decision: 'revise', note: 'Add a second case' });
  assert.equal((await store.get(item.id)).worktreePath, item.cwd);
  const second = await implement(store, item, { contents: 'implemented with second case\n' });
  assert.equal(second.artifactRevision, 2); assert.notEqual(second.commit, first.commit);
  assert.equal(await readFile(first.artifactRef, 'utf8'), originalArtifact);
  assert.equal(await readFile(review.reviewRef, 'utf8'), originalReview);
  await assert.rejects(recordReview(store, item.id, item.claimId, { artifactRef: first.artifactRef, commit: first.commit, decision: 'pass' }), /immutable/);
  await pass(store, item, second);
  const current = await store.get(item.id);
  assert.equal(current.id, item.id); assert.equal(current.revision, 1); assert.equal(current.reviews.length, 2);
  await store.mergeDecision(item.id, item.claimId, { artifactRef: second.artifactRef, decision: 'reject', note: 'Do not merge this yet' });
  assert.equal((await store.get(item.id)).status, 'rejected');
  assert.ok((await lstat(item.cwd)).isDirectory());
  await assert.rejects(cleanup(store, item.id, item.claimId, { cleanup: true }), /verified/);
  assert.ok((await lstat(item.cwd)).isDirectory());
});

test('a reviewer that changes the pinned worktree cannot record a passing review or trigger cleanup', async t => {
  const { store } = await fixture(t);
  const item = await prepared(store); const artifact = await implement(store, item);
  await writeFile(path.join(item.cwd, 'unreviewed.txt'), 'unexpected reviewer write\n');
  await assert.rejects(pass(store, item, artifact), /dirty/);
  assert.equal((await store.get(item.id)).reviews.length, 0);
  assert.equal((await store.get(item.id)).status, 'reviewing');
  await assert.rejects(cleanup(store, item.id, item.claimId, { cleanup: true }), /verified/);
  assert.ok((await lstat(item.cwd)).isDirectory());
  assert.equal(await git(item.cwd, 'rev-parse', 'HEAD'), artifact.commit);
});

test('clean local merge is human-approved, verified, serialized and auto-removed after merge', async t => {
  const { store, repo } = await fixture(t);
  const one = await prepared(store, 'req-one'); const first = await implement(store, one); await approve(store, one, first);
  const two = await prepared(store, 'req-two'); const second = await implement(store, two); await approve(store, two, second);
  const outcomes = await Promise.all([integrate(store, one.id, one.claimId), integrate(store, two.id, two.claimId)]);
  assert.deepEqual(outcomes.map(value => value.outcome), ['merged', 'merged']);
  for (const [item, artifact] of [[one, first], [two, second]]) {
    await git(repo, 'merge-base', '--is-ancestor', artifact.commit, 'HEAD');
    assert.equal((await store.get(item.id)).integration.state, 'verified');
    assert.ok((await lstat(item.cwd)).isDirectory());
    assert.equal(await git(item.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), 'auto/req-' + item.id.slice(4), 'requirement worktree stays on its requirement branch');
    assert.equal((await cleanup(store, item.id, item.claimId)).outcome, 'cleaned');
    await assert.rejects(lstat(item.cwd), { code: 'ENOENT' });
    assert.equal((await store.get(item.id)).worktreePath, null);
    assert.equal((await store.get(item.id)).cleanedWorktreePath, item.cwd);
    assert.equal((await store.get(item.id)).cleanedBranch, 'auto/req-' + item.id.slice(4));
  }
  assert.equal(await git(repo, 'branch', '--list', 'auto/req-one'), '', 'cleanup deletes the requirement branch');
  assert.equal(await git(repo, 'branch', '--list', 'auto/req-two'), '', 'cleanup deletes the requirement branch');
});

test('real Git conflict auto-aborts target and returns the same id/worktree to engineering', async t => {
  const { store, repo } = await fixture(t);
  const item = await prepared(store);
  const artifact = await implement(store, item, { file: 'shared.txt', contents: 'requirement change\n' });
  await approve(store, item, artifact);
  await writeFile(path.join(repo, 'shared.txt'), 'different target change\n');
  await git(repo, 'add', '--all'); await git(repo, 'commit', '-m', 'temporary conflicting target change');
  const conflict = await integrate(store, item.id, item.claimId);
  assert.equal(conflict.outcome, 'revise');
  assert.ok(conflict.item.integration.conflictFiles.includes('shared.txt'));
  assert.equal(conflict.item.status, 'engineering-ready');
  assert.equal(conflict.item.approval, null);
  assert.equal(conflict.item.worktreePath, item.cwd);
  assert.ok((await lstat(item.cwd)).isDirectory());
  await assert.rejects(git(repo, 'rev-parse', '--verify', 'MERGE_HEAD'), 'target merge was aborted');
  await assert.rejects(cleanup(store, item.id, item.claimId, { cleanup: true }), /verified/);
  const ready = await store.get(item.id);
  const next = await store.beginEngineering(item.id, item.claimId, { expectedRevision: ready.revision, expectedEpoch: ready.engineeringEpoch });
  assert.equal(next.status, 'engineering');
  assert.equal(next.engineeringEpoch, ready.engineeringEpoch + 1);
});

test('queue-check gates mining by pending implementation backlog and baseline seeds are explicit', async t => {
  const { store } = await fixture(t);
  const queued = await cli('queue-check', { dataRoot: store.root, maxPending: 3 });
  assert.equal(queued.outcome, 'mine');
  await prepared(store, 'req-engineering-counted');
  for (let index = 0; index < 3; index++) await store.upsertRequirement(user(`req-gate-${index}`));
  const full = await cli('queue-check', { dataRoot: store.root, maxPending: 3 });
  assert.equal(full.outcome, 'skip');
  assert.equal(full.output.pending, 4);
  assert.equal((await store.get('req-engineering-counted')).status, 'engineering');
  await store.upsertSeed({ id: 'seed-extra', title: 'Extra evidence', evidence: 'Concrete local observation' });
  const seedResult = await store.ensureBaselineSeeds();
  assert.ok(seedResult.length > 0);
  const seeds = await store.claimSeeds(100);
  assert.ok(seeds.some(seed => seed.seedId === 'seed-baseline-docs' && seed.origin === 'baseline'));
  assert.ok(seeds.some(seed => seed.seedId === 'seed-extra' && seed.origin === 'explicit'));
});

test('producer cycles independently of disabled workers, claims each seed once and skips model churn when empty', async t => {
  const { store, repo } = await fixture(t);
  await store.upsertSeed({ id: 'seed-live', title: 'Live evidence', evidence: 'A real local observation' });
  const raw = JSON.parse(await readFile(graphFile, 'utf8'));
  raw.entry = 'mine-gate'; raw.nodes.find(node => node.id === 'mine-gate').config.delayMs = 0;
  const definition = normalizeDefinition(raw);
  const artifacts = new Map(); let next = 0, minerCalls = 0;
  const io = { put: async value => { const ref = `ref-${++next}`; artifacts.set(ref, structuredClone(value)); return ref; }, get: async ref => structuredClone(artifacts.get(ref)), archive: async () => {} };
  const state = await newRunState({ definition, cwd: repo, permissions: { command: { mode: 'allowlist', allow: ['node docs/examples/development/driver.mjs'] } }, input: { dataRoot: store.root } }, io);
  const executors = {
    command: async ({ node, input }) => stage(node.config.command.split(' ').at(-1), input),
    agent: async ({ node, input }) => {
      assert.equal(node.id, 'miner'); minerCalls++; assert.equal(input.seedId, 'seed-live');
      return { outcome: 'proposal', output: { proposal: { title: 'Live proposal', summary: 'Narrow local change', evidence: 'Narrow local change', risk: 'low', priority: 2 } } };
    },
  };
  for (let slice = 0; slice < 3; slice++) await run(state, executors, { io, control: { continuous: true, nodes: { route: false } }, maxSteps: 20 });
  assert.equal(minerCalls, 1);
  assert.equal((await store.list()).length, 1);
  assert.equal((await store.get('req-live')).status, 'intake');
  assert.equal(state.tokens.filter(token => token.nodeId === 'route').length, 1, 'atomic admission prevents duplicate processing packets');
  assert.ok(state.counts.completed > 30, 'producer continues while route is disabled');
  assert.equal(state.counts.packetsFailed, 0, JSON.stringify(state.tokens));
});

test('whole graph reaches both pool caps of three; one human wait never stalls other items or new arrivals', { timeout: 60_000 }, async t => {
  const base = await fixture(t);
  const { store, repo } = base;
  for (let index = 0; index < 6; index++) await store.upsertRequirement(user(`req-graph-${index}`));
  const graph = normalizeDefinition(JSON.parse(await readFile(graphFile, 'utf8')));
  const artifacts = new Map(); let next = 0;
  const io = {
    put: async value => { const ref = `artifact-${++next}`; artifacts.set(ref, structuredClone(value)); return ref; },
    get: async ref => structuredClone(artifacts.get(ref)), archive: async () => {},
  };
  const state = await newRunState({ definition: graph, cwd: repo, permissions: { command: { mode: 'allowlist', allow: ['node docs/examples/development/driver.mjs'] } }, input: { dataRoot: store.root } }, io);
  await enqueue(state, { input: { dataRoot: store.root } }, io);
  const active = { engineer: 0, reviewer: 0 }, peak = { engineer: 0, reviewer: 0 }, calls = { engineer: 0, reviewer: 0 };
  const barrier = () => { let group = []; return () => new Promise(resolve => { group.push(resolve); if (group.length === 3) { const released = group; group = []; released.forEach(done => done()); } }); };
  const engineering = barrier(), reviewing = barrier();
  const executors = {
    command: async ({ node, input }) => stage(node.config.command.split(' ').at(-1), input),
    agent: async ({ node, input }) => {
      const role = node.id;
      assert.ok(['engineer', 'reviewer'].includes(role));
      assert.equal(node.config.cwd, input.cwd, 'executor cwd must use the already resolved small node input');
      assert.ok(input.cwd.startsWith(path.join(store.root, 'worktrees')), 'never edit the integration checkout');
      active[role]++; calls[role]++; peak[role] = Math.max(peak[role], active[role]);
      assert.ok(active[role] <= 3);
      try {
        if (calls[role] <= 6) await (role === 'engineer' ? engineering() : reviewing());
        if (role === 'engineer') {
          const id = path.basename(input.dataRef, '.json');
          await writeFile(path.join(input.cwd, `${id}.txt`), 'graph implementation\n');
          await git(input.cwd, 'add', '--all'); await git(input.cwd, 'commit', '-m', `temporary graph ${id}`);
          return { outcome: 'complete', output: { summary: 'Isolated graph implementation', verification: 'Local fixture checks' } };
        }
        assert.equal(await git(input.cwd, 'rev-parse', 'HEAD'), input.commit);
        return { outcome: 'pass', output: { decision: 'pass', summary: 'Pinned graph artifact passed', verification: 'Pinned HEAD checked', reviewer: 'fixture-reviewer' } };
      } finally { active[role]--; }
    },
  };
  await run(state, executors, { io, maxSteps: 1000 });
  assert.equal(state.counts.packetsFailed, 0, JSON.stringify(state.tokens));
  assert.deepEqual(peak, { engineer: 3, reviewer: 3 });
  assert.equal(waitingHumanTokens(state).length, 6);
  const pending = waitingHumanTokens(state)[0];
  await decide(state, { tokenId: pending.id, outcome: 'approve', output: { note: 'Approve exact fixture artifact', actor: 'fixture-human' } }, io);
  await run(state, executors, { io, maxSteps: 1000 });
  assert.equal(waitingHumanTokens(state).length, 5);
  assert.equal((await store.list()).filter(item => item.status === 'merged').length, 1);
  await store.upsertRequirement(user('req-graph-arrival'));
  await enqueue(state, { input: { dataRoot: store.root } }, io);
  await run(state, executors, { io, maxSteps: 1000 });
  assert.equal((await store.get('req-graph-arrival')).status, 'human-pending');
  assert.equal(waitingHumanTokens(state).length, 6);
  assert.equal(state.counts.packetsFailed, 0, JSON.stringify(state.tokens));
  for (const item of await store.list()) {
    if (item.status === 'merged') {
      assert.equal(item.worktreePath, null);
      assert.ok(item.cleanedWorktreePath);
      await assert.rejects(lstat(item.cleanedWorktreePath), { code: 'ENOENT' });
    } else assert.ok((await lstat(item.worktreePath)).isDirectory());
  }
});

test('explicit cleanup policy may remove only an already verified merged worktree', async t => {
  const { store } = await fixture(t, { cleanupPolicy: 'after-verified-merge' });
  const item = await prepared(store); const artifact = await implement(store, item);
  await assert.rejects(cleanup(store, item.id, item.claimId), /verified/);
  await approve(store, item, artifact); await integrate(store, item.id, item.claimId);
  assert.equal((await cleanup(store, item.id, item.claimId)).outcome, 'cleaned');
  assert.ok((await readdir(path.join(store.root, 'requirements'))).includes('req-one.json'));
});
