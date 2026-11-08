/** GitHub pull-request execution plane. The driver owns the workflow; this
 * module only pushes the requirement branch, opens/updates its one draft PR,
 * polls that exact PR, and verifies an external merge. It never merges. */
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { git, checkedWorktree, targetReady, checkApproval, ancestor, commitId, clean } from './worktrees.mjs';

const execute = promisify(execFile);
const PR_FIELDS = 'number,url,state,isDraft,headRefOid,mergeCommit,mergedAt,closed,reviewDecision';

async function gh(cwd, ...args) {
  const bin = process.env.DSH_GH_BIN || 'gh';
  const prefix = process.env.DSH_GH_SCRIPT ? [process.env.DSH_GH_SCRIPT] : [];
  try {
    const result = await execute(bin, [...prefix, ...args], {
      cwd,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' },
    });
    return result.stdout.trim();
  } catch (error) {
    throw new Error(`GitHub PR command failed: gh ${args.join(' ')}: ${String(error.stderr ?? error.message).slice(0, 1500)}`);
  }
}

async function ghJson(cwd, args) {
  const output = await gh(cwd, ...args);
  try { return JSON.parse(output); }
  catch { throw new Error(`GitHub PR command returned non-JSON for gh ${args.join(' ')}`); }
}

async function viewPr(store, number) {
  return ghJson(store.config.repoRoot, ['pr', 'view', String(number), '--json', PR_FIELDS]);
}

async function findPr(store, branch) {
  const rows = await ghJson(store.config.repoRoot, ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '1', '--json', PR_FIELDS]);
  return Array.isArray(rows) ? rows[0] ?? null : null;
}

function normalisePr(value) {
  return {
    number: value.number,
    url: value.url,
    state: value.state,
    isDraft: Boolean(value.isDraft),
    headRefOid: value.headRefOid ?? null,
    mergeCommit: typeof value.mergeCommit === 'string' ? value.mergeCommit : value.mergeCommit?.oid ?? null,
    mergedAt: value.mergedAt ?? null,
    closed: Boolean(value.closed),
    reviewDecision: value.reviewDecision ?? null,
    updatedAt: new Date().toISOString(),
  };
}

function prTitle(item) {
  return `${item.id}: ${item.title}`.slice(0, 240);
}

function basicBody(item) {
  const implementation = item.implementation || {};
  return [
    '## Requirement', item.title, '', item.description, '',
    '## Implementation', implementation.summary || 'Implementation summary is not available yet.', '',
    '## Verification', implementation.verification || 'No verification evidence recorded yet.', '',
    '## Immutable binding', `- requirement: \`${item.id}\``, `- commit: \`${implementation.commit || 'not snapshotted'}\``, `- artifact: \`${implementation.artifactRef || 'not snapshotted'}\``, '',
    '## Review', item.reviews?.length ? 'Internal review has not passed yet; this is a draft PR.' : 'No review recorded yet.', '',
    '> Workflow draft: it becomes ready only after the configured Human merge approval.',
  ].join('\n');
}

function prBody(item) {
  return item.brief?.markdown || basicBody(item);
}

async function updatePr(store, item, { create = false } = {}) {
  const branch = item.branch;
  if (!branch) throw new Error('Requirement has no branch for PR');
  const title = prTitle(item);
  const body = prBody(item);
  let pr = item.pr ? await viewPr(store, item.pr.number) : null;
  if (!pr) pr = await findPr(store, branch);
  if (!pr) {
    if (!create) throw new Error('No PR recorded for this requirement');
    const url = await gh(store.config.repoRoot, 'pr', 'create', '--draft', '--head', branch, '--base', store.config.baseBranch, '--title', title, '--body', body);
    pr = await ghJson(store.config.repoRoot, ['pr', 'view', url, '--json', PR_FIELDS]);
  } else {
    if (pr.state === 'CLOSED' && !pr.mergedAt) {
      await gh(store.config.repoRoot, 'pr', 'reopen', String(pr.number));
      pr = await viewPr(store, pr.number);
    }
    if (pr.state === 'MERGED') {
      item.pr = normalisePr(pr);
      throw new Error('The PR is already merged; do not publish or rework this requirement');
    }
    await gh(store.config.repoRoot, 'pr', 'edit', String(pr.number), '--title', title, '--body', body);
    pr = await viewPr(store, pr.number);
  }
  item.pr = normalisePr(pr);
  item.pr.publishedAt = item.pr.publishedAt ?? new Date().toISOString();
  return item.pr;
}

async function pushBranch(store, item) {
  const branch = item.branch;
  if (!branch) throw new Error('Requirement has no branch to push');
  const remote = store.config.prRemote || 'origin';
  const ref = `refs/heads/${branch}`;
  const old = item.pr?.headRefOid;
  if (old) await git(store.config.repoRoot, 'push', `--force-with-lease=${ref}:${old}`, remote, `${ref}:${ref}`);
  else await git(store.config.repoRoot, 'push', '--set-upstream', remote, branch);
}

export async function publish(store, id, claimId) {
  return store.locked(() => store.mutate(id, claimId, async item => {
    if (store.config.integrationMode !== 'pull-request') return { item, outcome: 'skipped' };
    if (item.status !== 'reviewing' && item.status !== 'human-pending' && item.status !== 'approved') throw new Error('PR can only be published from a snapshotted review state');
    if (!item.implementation?.commit) throw new Error('No immutable implementation to publish');
    const cwd = await checkedWorktree(store, item); await clean(cwd);
    if (await git(cwd, 'rev-parse', 'HEAD') !== item.implementation.commit) throw new Error('Worktree changed since snapshot; do not publish');
    await pushBranch(store, item);
    await updatePr(store, item, { create: true });
    return { item, outcome: 'complete', pr: item.pr };
  }), 'integration');
}

export async function ready(store, id, claimId) {
  return store.locked(() => store.mutate(id, claimId, async item => {
    if (!['human-pending', 'approved'].includes(item.status)) throw new Error('PR can only be marked ready after review/brief');
    if (!item.pr?.number) throw new Error('No PR recorded for this requirement');
    const before = normalisePr(await viewPr(store, item.pr.number));
    item.pr = { ...item.pr, ...before };
    if (before.state === 'MERGED') {
      await verifyExternalMerge(store, item);
      return { item, outcome: 'merged', pr: item.pr };
    }
    if (before.state === 'CLOSED') throw new Error('PR is closed; rework the requirement before marking ready');
    if (before.isDraft) await gh(store.config.repoRoot, 'pr', 'ready', String(before.number));
    item.pr = normalisePr(await viewPr(store, item.pr.number));
    item.pr.readyAt = new Date().toISOString();
    return { item, outcome: 'complete', pr: item.pr };
  }), 'integration');
}

async function syncBase(store) {
  await targetReady(store);
  await git(store.config.repoRoot, 'fetch', store.config.prRemote || 'origin', store.config.baseBranch);
  await git(store.config.repoRoot, 'merge', '--ff-only', `${store.config.prRemote || 'origin'}/${store.config.baseBranch}`);
  await targetReady(store);
}

async function verifyReviewedCommit(store, item) {
  const implementation = item.implementation;
  const latest = item.reviews?.at(-1);
  if (!implementation?.commit || latest?.decision !== 'pass' || latest.artifactRef !== implementation.artifactRef) {
    throw new Error('PR merge requires the current implementation to have a passing review');
  }
  const cwd = await checkedWorktree(store, item); await clean(cwd);
  if (await git(cwd, 'rev-parse', 'HEAD') !== implementation.commit) throw new Error('PR worktree changed since review; refusing merge verification');
  return implementation.commit;
}

async function verifyExternalMerge(store, item) {
  const commit = await verifyReviewedCommit(store, item);
  await syncBase(store);
  if (!await ancestor(store.config.repoRoot, commitId(commit))) {
    throw new Error('PR is marked merged but the approved commit is not in the base branch. The repository may use squash/rebase merges; this workflow requires a merge commit.');
  }
  item.status = 'merged';
  item.integration = {
    state: 'verified',
    mechanism: item.pr.selfMergedByWorkflow ? 'self-merge' : 'external-pr',
    pr: item.pr,
    mergeCommit: commitId(await git(store.config.repoRoot, 'rev-parse', 'HEAD')),
    verifiedAt: new Date().toISOString(),
  };
}

export async function check(store, id, claimId) {
  return store.locked(() => store.mutate(id, claimId, async item => {
    if (!item.pr?.number) throw new Error('No PR recorded for this requirement');
    const pr = normalisePr(await viewPr(store, item.pr.number));
    item.pr = { ...item.pr, ...pr };
    if (pr.state === 'MERGED') {
      await verifyExternalMerge(store, item);
      return { item, outcome: 'merged', pr: item.pr };
    }
    if (pr.state === 'CLOSED') {
      item.status = 'engineering-ready';
      item.approval = null;
      item.integration = { state: 'pr-closed', pr: item.pr, checkedAt: new Date().toISOString() };
      item.feedback.push({ scope: 'integration', artifactRef: item.implementation?.artifactRef, note: 'PR was closed without merge; return to engineering. Reopen or update the same PR after new commits.' });
      return { item, outcome: 'closed', pr: item.pr };
    }
    // External reviewers may merge the ready PR at any time. Only after the
    // grace period do we ask Human whether our workflow should self-merge.
    const readyAt = Date.parse(item.pr.readyAt ?? '');
    if (pr.state === 'OPEN' && Number.isFinite(readyAt) && Date.now() - readyAt >= store.config.selfMergeAfterMs) {
      return { item, outcome: 'approval-needed', pr: item.pr };
    }
    return { item, outcome: 'waiting', pr: item.pr };
  }), 'integration');
}

export async function selfMerge(store, id, claimId) {
  return store.locked(() => store.mutate(id, claimId, async item => {
    if (item.status !== 'approved') throw new Error('Self-merge requires an explicit Human approval');
    await checkApproval(store, item);
    if (!item.pr?.number) throw new Error('No PR recorded for this requirement');
    let pr = normalisePr(await viewPr(store, item.pr.number));
    if (pr.state === 'MERGED') {
      item.pr = { ...item.pr, ...pr };
      await verifyExternalMerge(store, item);
      return { item, outcome: 'merged', pr: item.pr };
    }
    if (pr.state === 'CLOSED') throw new Error('PR is closed; rework before self-merge');
    try { await gh(store.config.repoRoot, 'pr', 'merge', String(pr.number), '--merge'); }
    catch (error) {
      // An external merge can win this race; re-read before failing the packet.
      pr = normalisePr(await viewPr(store, item.pr.number));
      item.pr = { ...item.pr, ...pr };
      if (pr.state !== 'MERGED') throw error;
      await verifyExternalMerge(store, item);
      return { item, outcome: 'merged', pr: item.pr };
    }
    item.pr.selfMergedByWorkflow = true;
    item.pr.selfMergeAt = new Date().toISOString();
    pr = normalisePr(await viewPr(store, item.pr.number));
    item.pr = { ...item.pr, ...pr };
    if (pr.state !== 'MERGED') throw new Error('Self-merge command returned without a merged PR');
    await verifyExternalMerge(store, item);
    return { item, outcome: 'merged', pr: item.pr };
  }), 'integration');
}

export async function updateBody(store, item) {

  if (!item.pr?.number) return null;
  const current = normalisePr(await viewPr(store, item.pr.number));
  if (current.state === 'MERGED' || current.state === 'CLOSED') return current;
  await gh(store.config.repoRoot, 'pr', 'edit', String(item.pr.number), '--title', prTitle(item), '--body', prBody(item));
  item.pr = { ...item.pr, ...normalisePr(await viewPr(store, item.pr.number)) };
  return item.pr;
}
