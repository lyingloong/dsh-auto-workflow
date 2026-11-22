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
    return result('complete', { ...rootEnvelope(store), version: store.config.version, baselineSeeds: created.length, maxMiningSeeds: store.config.maxMiningSeeds, staleClaimMs: store.config.staleClaimMs });
  }
  if (['requirement', 'seed', 'claim', 'seed-batch', 'queue-check', 'status', 'recover-seeds', 'retire-seed', 'rearm-seed'].includes(name)) {
    const store = await DevelopmentStore.open(absolute(input.dataRoot, 'dataRoot'));
    if (name === 'requirement') return result('queued', store.envelope(await store.upsertRequirement(input.requirement)));
    if (name === 'seed') {
      const seed = await store.upsertSeed(input.seed);
      return result('queued', { dataRef: store.seedRef(seed.id), cwd: store.config.repoRoot, label: seed.title, seedId: seed.id, dataRoot: store.root });
    }
    if (name === 'queue-check') {
      const maxPending = positiveInteger(input.maxPending, 3, 'maxPending');
      const pending = await store.pendingCount();
      const seeds = await store.seedCounts();
      // Mining seeds are in-flight miners: they count against the same ceiling
      // as requirements waiting for implementation, so the producer cannot
      // claim the whole seed pool before the first requirement exists. The
      // reported headroom is what seed-batch can actually claim: the smaller of
      // the backlog ceiling and the store's mining cap.
      const backlogHeadroom = Math.max(0, maxPending - pending - seeds.mining);
      const miningHeadroom = Math.max(0, store.config.maxMiningSeeds - seeds.mining);
      const headroom = Math.min(backlogHeadroom, miningHeadroom);
      return result(headroom > 0 ? 'mine' : 'skip', {
        ...rootEnvelope(store), pending, mining: seeds.mining, backlog: pending + seeds.mining, maxPending, maxMiningSeeds: store.config.maxMiningSeeds, headroom,
        staleClaims: seeds.stale, staleClaimMs: store.config.staleClaimMs,
        reason: headroom > 0 ? 'backlog-below-watermark' : backlogHeadroom === 0 ? 'backlog-full' : 'mining-cap',
      });
    }
    if (name === 'seed-batch') {
      const maxPending = positiveInteger(input.maxPending, 3, 'maxPending');
      const batchSize = positiveInteger(input.batchSize, 3, 'batchSize');
      const pending = await store.pendingCount();
      const seeds = await store.seedCounts();
      const backlogHeadroom = Math.max(0, maxPending - pending - seeds.mining);
      const headroom = Math.min(backlogHeadroom, Math.max(0, store.config.maxMiningSeeds - seeds.mining));
      const items = headroom > 0 ? await store.claimSeeds(Math.min(batchSize, headroom)) : [];
      const after = items.length ? await store.seedCounts() : seeds;
      return result(items.length ? 'ready' : 'idle', {
        ...rootEnvelope(store), items, pending, mining: after.mining, maxPending, maxMiningSeeds: store.config.maxMiningSeeds, headroom,
        reason: items.length ? 'claimed' : headroom === 0 ? (backlogHeadroom === 0 ? 'backlog-full' : 'mining-cap') : 'no-queued-seed',
      });
    }
    if (name === 'recover-seeds') {
      const recovered = await store.recoverSeeds({ olderThanMs: input.olderThanMs, dryRun: Boolean(input.dryRun) });
      return result(recovered.stale.length > 0 ? 'complete' : 'idle', { ...rootEnvelope(store), ...recovered, staleClaimMs: store.config.staleClaimMs });
    }
    if (name === 'retire-seed') {
      const seed = await store.retireSeed(input.seedId, input.reason);
      return result('complete', { ...rootEnvelope(store), seedId: seed.id, status: seed.status, retiredAt: seed.retiredAt, retiredReason: seed.retiredReason });
    }
    if (name === 'rearm-seed') {
      const seed = await store.rearmSeed(input.seedId);
      return result('queued', { ...rootEnvelope(store), seedId: seed.id, status: seed.status, rotationRound: seed.rotationRound, lastOutcome: seed.lastOutcome });
    }
    if (name === 'claim') {
      const items = await store.claimBatch(positiveInteger(input.batchSize, 3, 'batchSize'));
      return result(items.length ? 'ready' : 'idle', { ...rootEnvelope(store), items });
    }
    const items = await store.list();
    const seeds = await store.seedCounts();
    return result('complete', { ...rootEnvelope(store), counts: items.reduce((counts, item) => { counts[item.status] = (counts[item.status] ?? 0) + 1; return counts; }, {}), pending: await store.pendingCount(), seeds, staleClaimMs: store.config.staleClaimMs });
  }
  if (name === 'record-proposal') {
    const ref = absolute(input.dataRef, 'seed dataRef');
    const store = await DevelopmentStore.open(path.dirname(path.dirname(ref)));
    if (store.seedRef(seedId(input.seedId)) !== ref) throw new Error('Seed ref/id mismatch');
    const item = await store.proposeSeed({ seedId: input.seedId, claimId: input.claimId, proposal: input.proposal, reason: input.reason });
    return item ? result('queued', store.envelope(item)) : result('idle', { dataRef: ref, cwd: store.config.repoRoot, label: 'No proposal; seed returned to the rotation', reason: input.reason ?? null });
  }
  if (name === 'pr-init') {
    const baseBranch = input.baseBranch ?? 'main';
    const repoRoot = input.dataRoot
      ? (await DevelopmentStore.open(absolute(input.dataRoot, 'dataRoot'))).config.repoRoot
      : absolute(input.repoRoot, 'repoRoot');
    const initialized = await pullRequests.initPr({ config: { repoRoot, baseBranch } }, { apply: Boolean(input.apply) });
    return result(initialized.ready ? 'complete' : 'blocked', initialized);
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
  if (name === 'publish-pr' || name === 'ready-pr' || name === 'check-pr' || name === 'self-merge-pr') {
    const action = name === 'publish-pr' ? pullRequests.publish : name === 'ready-pr' ? pullRequests.ready : name === 'self-merge-pr' ? pullRequests.selfMerge : pullRequests.check;
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
function positiveInteger(value, fallback, name) {
  const number = value ?? fallback;
  if (!Number.isInteger(number) || number < 1 || number > 100) throw new Error(`${name} must be 1..100`);
  return number;
}
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
