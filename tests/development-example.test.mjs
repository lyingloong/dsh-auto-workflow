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
import { publish, ready, check, selfMerge, updateBody } from '../docs/examples/development/pr.mjs';
import { stage } from '../docs/examples/development/driver.mjs';
import { normalizeDefinition } from '../src/definition.mjs';
import { newRunState, enqueue, run, decide, waitingHumanTokens } from '../src/runtime.mjs';

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
  const fakeGh = fileURLToPath(new URL('./fixtures/fake-gh.mjs', import.meta.url));
  const state = path.join(root, 'fake-pr-state.json');
  const previous = { DSH_GH_BIN: process.env.DSH_GH_BIN, DSH_GH_SCRIPT: process.env.DSH_GH_SCRIPT, DSH_FAKE_PR_STATE: process.env.DSH_FAKE_PR_STATE, DSH_FAKE_READY_MERGES: process.env.DSH_FAKE_READY_MERGES };
  process.env.DSH_GH_BIN = process.execPath;
  process.env.DSH_GH_SCRIPT = fakeGh;
  process.env.DSH_FAKE_PR_STATE = state;
  process.env.DSH_FAKE_READY_MERGES = readyMerges ? '1' : '0';
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  return { remote, state };
}
const user = (id, extra = {}) => ({ id, source: 'user', title: id, description: `Implement ${id}`, risk: 'high', ...extra });
const mined = (id, value = 'mid', extra = {}) => ({ id, source: 'mined', seedId: `seed-${id.slice(4)}`, title: id, description: `Mined ${id}`, risk: value, ...extra });
async function prepared(store, id = 'req-one', spec = user(id)) {
  await store.upsertRequirement(spec);
  const [envelope] = await store.claimBatch(1);
  assert.equal(envelope.dataRef, store.ref(id));
  const routed = await store.route(id, envelope.claimId);
  if (routed.outcome === 'needs_approval') await store.requirementDecision(id, envelope.claimId, { decision: 'approve', actor: 'test-human', expectedRevision: routed.item.revision });
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

test('development graph is generic: continuous detached producer, root 6, one three-slot engineering/review pool', async () => {
  const graph = normalizeDefinition(JSON.parse(await readFile(graphFile, 'utf8')));
  assert.equal(graph.apiVersion, 2); assert.equal(graph.concurrency, 6);
  const engineer = graph.nodes.find(node => node.id === 'engineer');
  const reviewer = graph.nodes.find(node => node.id === 'reviewer');
  assert.equal(engineer.concurrency, 3); assert.equal(reviewer.concurrency, 3);
  assert.equal(engineer.config.cwd, '$input.cwd'); assert.equal(reviewer.config.cwd, '$input.cwd');
  assert.equal(graph.nodes.filter(node => node.role === 'reviewer').length, 1, 'a pool, not three reviews per item');
  assert.equal(graph.nodes.find(node => node.id === 'check-pr').concurrency, 1);
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
  assert.ok(graph.edges.some(edge => edge.from === 'check-pr' && edge.to === 'begin-engineering' && edge.on === 'closed'));
  assert.ok(graph.nodes.find(node => node.id === 'pr-gate').type === 'gate');
  assert.ok(graph.edges.some(edge => edge.from === 'check-pr' && edge.to === 'pr-gate' && edge.on === 'waiting'));
  assert.ok(graph.edges.some(edge => edge.from === 'check-pr' && edge.to === 'self-merge-human' && edge.on === 'approval-needed'));
  assert.ok(graph.edges.some(edge => edge.from === 'self-merge-human' && edge.to === 'approve-self' && edge.on === 'approve'));
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
    await assert.rejects(store.requirementDecision(id, envelope.claimId, { decision: 'reject', expectedRevision: 1 }), /feedback/);
    await store.requirementDecision(id, envelope.claimId, { decision: 'reject', note: 'Bound the scope; preserve identity', expectedRevision: 1 });
    await store.reviseRequirement(id, envelope.claimId, { expectedRevision: 1, title: 'Bounded scope', description: 'Narrow and testable', risk: 'mid' });
    const item = await store.get(id);
    assert.equal(item.id, id); assert.equal(item.revision, 2); assert.equal(item.claimId, envelope.claimId);
    assert.equal(item.feedback[0].note, 'Bound the scope; preserve identity');
    assert.equal((await store.route(id, envelope.claimId)).outcome, 'needs_approval');
    await store.requirementDecision(id, envelope.claimId, { decision: 'approve', expectedRevision: 2 });
    assert.equal((await store.get(id)).requirementApproval.revision, 2);
  }
});

test('driver init seeds the baseline discovery directions exactly once', async t => {
  const { root, repo } = await fixture(t);
  const dataRoot = path.join(root, 'baseline-data');
  const result = await cli('init', { dataRoot, repoRoot: repo });
  assert.equal(result.outcome, 'complete');
  assert.equal(result.output.baselineSeeds, 14);
  const store = await DevelopmentStore.open(dataRoot);
  const seeds = await store.claimSeeds(100);
  assert.equal(seeds.length, 14);
  assert.ok(seeds.every(seed => seed.origin === 'baseline' && seed.seedId.startsWith('seed-baseline-')));
});

test('seed ids differ from requirement ids; explicit no-proposal idle and safe data refs', async t => {
  const { store } = await fixture(t);
  await store.upsertSeed({ id: 'seed-one', title: 'Useful evidence', evidence: 'Local source evidence' });
  await store.upsertSeed({ id: 'seed-empty', title: 'Not actionable', evidence: 'Needs more evidence' });
  const seeds = await store.claimSeeds(3);
  const proposed = await store.proposeSeed({ seedId: seeds[0].seedId, claimId: seeds[0].claimId, proposal: { title: 'Concrete fix', description: 'Concrete expected behavior', risk: 'low', priority: 2 } });
  assert.equal(proposed.id, 'req-one'); assert.equal(proposed.seedId, 'seed-one'); assert.notEqual(proposed.id, proposed.seedId);
  assert.equal(await store.proposeSeed({ seedId: seeds[1].seedId, claimId: seeds[1].claimId, proposal: null }), null);
  assert.equal((await store.list()).length, 1);
  assert.deepEqual(await store.claimSeeds(3), []);
  await assert.rejects(store.proposeSeed({ seedId: seeds[0].seedId, claimId: seeds[0].claimId, proposal: null }), /Stale/);
  for (const id of ['../outside', 'req-../../oops', 'req-a/b', 'req-a.json', 'req-a:stream', 'req-UPPER']) assert.throws(() => store.ref(id), /Unsafe/);
  await assert.rejects(DevelopmentStore.fromRef(path.join(store.root, 'config.json')));
  await assert.rejects(DevelopmentStore.fromRef(path.join(store.root, 'requirements', 'req-one.json.extra')));
  await assert.rejects(DevelopmentStore.create({ dataRoot: path.join(store.root, 'other'), repoRoot: store.config.repoRoot, baseBranch: 'main..evil' }), /Unsafe/);
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

test('one requirement branch + one worktree + one PR survives review, external merge and cleanup', async t => {
  const base = await fixture(t, { integrationMode: 'pull-request' });
  const { state: prState } = await withPullRequestFixture(t, base);
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
  const brief = await mergeBrief(store, item.id, item.claimId);
  assert.match(brief.brief.markdown, /## Requirement/);
  assert.match(brief.brief.markdown, /req-branch/);
  await updateBody(store, brief);
  const prFile = JSON.parse(await readFile(prState, 'utf8'));
  assert.match(prFile.prs[0].body, /Pinned commit reviewed/);
  assert.equal((await ready(store, item.id, item.claimId)).outcome, 'complete');
  const merged = await check(store, item.id, item.claimId);
  assert.equal(merged.outcome, 'merged');
  assert.equal((await store.get(item.id)).integration.mechanism, 'external-pr');
  assert.equal((await cleanup(store, item.id, item.claimId)).outcome, 'cleaned');
  assert.equal(await git(repo, 'branch', '--list', 'auto/req-branch'), '');
  await assert.rejects(lstat(item.cwd), { code: 'ENOENT' });
});

test('after Human approval the workflow self-merges its PR when external merge does not happen', async t => {
  const base = await fixture(t, { integrationMode: 'pull-request', selfMergeAfterMs: 0 });
  await withPullRequestFixture(t, base, { readyMerges: false });
  const { store, repo } = base;
  const item = await prepared(store, 'req-self');
  const artifact = await implement(store, item);
  await publish(store, item.id, item.claimId);
  await pass(store, item, artifact);
  await mergeBrief(store, item.id, item.claimId);
  assert.equal((await ready(store, item.id, item.claimId)).outcome, 'complete');
  const waiting = await check(store, item.id, item.claimId);
  assert.equal(waiting.outcome, 'approval-needed');
  await store.mergeDecision(item.id, item.claimId, { artifactRef: artifact.artifactRef, decision: 'approve', actor: 'test-human' });
  const merged = await selfMerge(store, item.id, item.claimId);
  assert.equal(merged.outcome, 'merged');
  assert.equal((await store.get(item.id)).integration.mechanism, 'self-merge');
  assert.equal((await cleanup(store, item.id, item.claimId)).outcome, 'cleaned');
  assert.equal(await git(repo, 'branch', '--list', 'auto/req-self'), '');
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
      return { outcome: 'proposal', output: { proposal: { title: 'Live proposal', description: 'Narrow local change', risk: 'low', priority: 2 } } };
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
