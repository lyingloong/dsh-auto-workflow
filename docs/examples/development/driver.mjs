#!/usr/bin/env node
/** Command-node protocol: one JSON input in env, exactly one JSON result on stdout. */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DevelopmentStore, BusinessBusy, absolute, seedId } from './store.mjs';
import * as worktrees from './worktrees.mjs';
import * as pullRequests from './pr.mjs';

export async function stage(name, input) {
  try { return await executeStage(name, input); }
  catch (error) {
    // Only lock admission (before protected work) is safe to requeue. Preserve
    // this exact resolved command input across the graph's busy delay gate.
    if (error instanceof BusinessBusy) return result('busy', structuredClone(input));
    throw error;
  }
}
async function executeStage(name, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('DSH_WORKFLOW_INPUT must be a JSON object');
  if (name === 'init') {
    const store = await DevelopmentStore.create(input);
    const created = await store.ensureBaselineSeeds();
    return result('complete', { ...rootEnvelope(store), baselineSeeds: created.length });
  }
  if (['requirement', 'seed', 'claim', 'seed-batch', 'queue-check', 'status'].includes(name)) {
    const store = await DevelopmentStore.open(absolute(input.dataRoot, 'dataRoot'));
    if (name === 'requirement') return result('queued', store.envelope(await store.upsertRequirement(input.requirement)));
    if (name === 'seed') {
      const seed = await store.upsertSeed(input.seed);
      return result('queued', { dataRef: store.seedRef(seed.id), cwd: store.config.repoRoot, label: seed.title, seedId: seed.id, dataRoot: store.root });
    }
    if (name === 'queue-check') {
      const maxPending = input.maxPending ?? 3;
      if (!Number.isInteger(maxPending) || maxPending < 1 || maxPending > 100) throw new Error('maxPending must be 1..100');
      const pending = await store.pendingCount();
      return result(pending <= maxPending ? 'mine' : 'skip', { ...rootEnvelope(store), pending, maxPending, reason: pending <= maxPending ? 'backlog-below-watermark' : 'backlog-full' });
    }
    if (name === 'claim' || name === 'seed-batch') {
      const items = await (name === 'claim' ? store.claimBatch(input.batchSize ?? 3) : store.claimSeeds(input.batchSize ?? 3));
      return result(items.length ? 'ready' : 'idle', { ...rootEnvelope(store), items });
    }
    const items = await store.list();
    return result('complete', { ...rootEnvelope(store), counts: items.reduce((counts, item) => { counts[item.status] = (counts[item.status] ?? 0) + 1; return counts; }, {}), pending: await store.pendingCount() });
  }
  if (name === 'record-proposal') {
    const ref = absolute(input.dataRef, 'seed dataRef');
    const store = await DevelopmentStore.open(path.dirname(path.dirname(ref)));
    if (store.seedRef(seedId(input.seedId)) !== ref) throw new Error('Seed ref/id mismatch');
    const item = await store.proposeSeed({ seedId: input.seedId, claimId: input.claimId, proposal: input.proposal });
    return item ? result('queued', store.envelope(item)) : result('idle', { dataRef: ref, cwd: store.config.repoRoot, label: 'No proposal; seed retained as idle' });
  }
  const store = await DevelopmentStore.fromRef(input.dataRef);
  const id = path.basename(input.dataRef, '.json'), claimId = input.claimId;
  if (name === 'route') {
    const routed = await store.route(id, claimId);
    return result(routed.outcome, store.envelope(routed.item));
  }
  if (name === 'requirement-decision') {
    const item = await store.requirementDecision(id, claimId, input);
    return result(input.decision === 'approve' ? 'ready' : 'revise', store.envelope(item));
  }
  if (name === 'revise-proposal') return result('complete', store.envelope(await store.reviseRequirement(id, claimId, input.proposal)));
  if (name === 'prepare') return result('complete', store.envelope(await worktrees.prepare(store, id, claimId)));
  if (name === 'begin-engineering') return result('complete', store.envelope(await store.beginEngineering(id, claimId, { expectedRevision: input.revision, expectedEpoch: input.engineeringEpoch })));
  if (name === 'snapshot' || name === 'reconcile-snapshot') {
    const action = name === 'snapshot' ? worktrees.snapshot : worktrees.reconcileSnapshot;
    const saved = await action(store, id, claimId, input);
    return result('complete', store.envelope(saved.item, { artifactRef: saved.artifactRef, artifactRevision: saved.artifactRevision, commit: saved.commit }));
  }
  if (name === 'integration-route') {
    const item = await store.get(id);
    return result(store.config.integrationMode === 'pull-request' ? 'pr' : 'local', store.envelope(item));
  }
  if (name === 'publish-pr' || name === 'ready-pr' || name === 'check-pr') {
    const action = name === 'publish-pr' ? pullRequests.publish : name === 'ready-pr' ? pullRequests.ready : pullRequests.check;
    const changed = await action(store, id, claimId);
    return result(changed.outcome, store.envelope(changed.item, { ...(changed.item.implementation ?? {}), pr: changed.item.pr ?? null, integration: changed.item.integration ?? null }));
  }
  if (name === 'brief') {
    const item = await worktrees.mergeBrief(store, id, claimId);
    await pullRequests.updateBody(store, item);
    return result('complete', store.envelope(item, { brief: item.brief ?? null, pr: item.pr ?? null }));
  }
  if (name === 'review-input') {
    const item = await store.mutate(id, claimId, item => {
      if (item.status !== 'reviewing' || item.implementation?.artifactRef !== input.artifactRef || item.implementation.commit !== input.commit) throw new Error('Review input must match current immutable implementation');
    });
    return result('complete', store.envelope(item, { ...item.implementation }));
  }
  if (name === 'record-review') {
    const review = await worktrees.recordReview(store, id, claimId, input);
    return result(review.outcome, store.envelope(review.item, { artifactRef: review.artifactRef, commit: review.commit, reviewRef: review.reviewRef }));
  }
  if (name === 'merge-decision') {
    const item = await store.mergeDecision(id, claimId, input);
    return result(input.decision, store.envelope(item, { artifactRef: item.implementation.artifactRef }));
  }
  if (name === 'integrate' || name === 'recover-integration' || name === 'cleanup') {
    const action = name === 'integrate' ? worktrees.integrate : name === 'cleanup' ? worktrees.cleanup : worktrees.recoverIntegration;
    const integrated = await action(store, id, claimId, input);
    return result(integrated.outcome, store.envelope(integrated.item, { integration: integrated.item.integration ?? null, cleanupRetention: integrated.item.cleanupRetention ?? null }));
  }
  if (name === 'inspect') {
    const item = await store.get(id);
    return result('complete', store.envelope(item, { status: item.status, artifactRef: item.implementation?.artifactRef ?? null }));
  }
  throw new Error(`Unknown example stage: ${name}`);
}
function rootEnvelope(store) { return { dataRef: path.join(store.root, 'config.json'), cwd: store.config.repoRoot, label: 'Development queues', dataRoot: store.root }; }
function result(outcome, output) { return { outcome, output }; }

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let input;
  try {
    input = JSON.parse(process.env.DSH_WORKFLOW_INPUT ?? '{}');
    process.stdout.write(`${JSON.stringify(await stage(process.argv[2], input))}\n`);
  } catch (error) {
    // Errors are business fail outcomes, not shell diagnostics mixed with valid JSON.
    const output = { error: { message: String(error.message).slice(0, 2000) } };
    if (typeof input?.dataRef === 'string' && path.isAbsolute(input.dataRef)) output.dataRef = input.dataRef;
    process.stdout.write(`${JSON.stringify(result('fail', output))}\n`);
    process.exitCode = 1;
  }
}
