/** GitHub pull-request execution plane. The driver owns the workflow; this
 * module pushes the requirement branch, opens/updates its one draft PR, watches
 * authorized GitHub feedback on the current head, and merges only after the
 * configured policy is satisfied. It never guesses a verdict from prose. */
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { git, checkedWorktree, targetReady, ancestor, commitId, clean } from './worktrees.mjs';
import { gh, ghJson, repoCoordinates } from './github.mjs';
import { redactForPublic, REVIEW_LABEL, APPROVED_LABEL, REJECTED_LABEL, REQUIREMENT_LABELS } from './requirement-review.mjs';
import { MERGE_LABEL, MERGE_INTENT_LABEL, evaluateFeedback } from './pr-feedback.mjs';

const PR_FIELDS = 'number,url,state,isDraft,headRefOid,mergeCommit,mergedAt,closed,reviewDecision,body,labels,statusCheckRollup';
const STAGES = new Set(['implementing', 'verifying', 'reviewing', 'repairing', 'merge-ready', 'blocked']);
const TEMPLATE_PATH = '.github/pull_request_template.md';

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
    body: typeof value.body === 'string' ? value.body : '',
    checks: Array.isArray(value.statusCheckRollup) ? value.statusCheckRollup : [],
    labels: Array.isArray(value.labels) ? value.labels.map(label => typeof label === 'string' ? label : label.name).filter(Boolean) : [],
    updatedAt: new Date().toISOString(),
  };
}

function protocolFor(item, overrides = {}) {
  const existing = item.pr?.protocol && typeof item.pr.protocol === 'object' ? item.pr.protocol : {};
  return {
    task: item.id,
    head: item.implementation?.commit ?? '',
    base: '',
    stage: 'reviewing',
    next: 'review',
    order: '',
    ci: 'pending',
    ...existing,
    ...overrides,
  };
}

function renderProtocol(state) {
  const stage = STAGES.has(state.stage) ? state.stage : 'blocked';
  return [
    '<!-- workflow',
    `task=${state.task}`,
    `head=${state.head}`,
    `base=${state.base}`,
    `stage=${stage}`,
    `next=${state.next}`,
    `order=${state.order}`,
    `ci=${state.ci}`,
    '-->',
  ].join('\n');
}

function parseProtocol(body) {
  const match = String(body ?? '').match(/^<!-- workflow\r?\n([\s\S]*?)\r?\n-->/);
  if (!match) return null;
  const values = {};
  for (const line of match[1].split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index > 0) values[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return values;
}

function stripProtocol(body) {
  return String(body ?? '').replace(/^<!-- workflow\r?\n[\s\S]*?\r?\n-->\s*/, '');
}

function protocolBody(markdown, state) {
  return `${renderProtocol(state)}\n\n${stripProtocol(markdown)}`;
}

function checkState(checks) {
  if (!Array.isArray(checks) || checks.length === 0) return 'none';
  let pending = false;
  for (const check of checks) {
    const conclusion = String(check.conclusion ?? check.state ?? '').toLowerCase();
    if (['failure', 'failed', 'error', 'timed_out', 'cancelled', 'action_required', 'startup_failure'].includes(conclusion)) return 'fail';
    if (!['success', 'neutral', 'skipped'].includes(conclusion)) pending = true;
  }
  return pending ? 'pending' : 'pass';
}

function prTitle(item) {
  return `${item.id}: ${item.title}`.slice(0, 240);
}

function mergeDecisionInstruction(policy) {
  if (policy === 'auto') return 'This PR merges automatically with a merge commit once verification passes; no board action is needed.';
  if (policy === 'label') return 'Add the `workflow:merge` label on GitHub to merge this PR with a merge commit; remove it to stop.';
  return 'Comment `@workflow merge` on this PR (authorized collaborators only) to merge it with a merge commit; `@workflow stop` cancels.';
}

function basicBody(item, policy) {
  const implementation = item.implementation || {};
  return [
    '## Change', '', redactForPublic(implementation.summary || 'Implementation summary is not available yet.'), '',
    '## Verification', '', '```', redactForPublic(implementation.verification || 'No verification evidence recorded yet.'), '```', '',
    '## Review verdict', '', 'Pending internal review; this is a draft PR.', '',
    '## Merge decision', '', mergeDecisionInstruction(policy), '',
    '<details>',
    `<summary>Requirement \`${item.id}\` r${item.revision}</summary>`,
    '',
    `**${item.title}**`,
    '',
    redactForPublic(item.summary),
    '',
    redactForPublic(item.evidence),
    '',
    '</details>',
  ].join('\n');
}

function prBody(item, state, policy) {
  return protocolBody(item.brief?.markdown || basicBody(item, policy), state);
}

async function unresolvedThreads(store, number) {
  const { owner, name } = await repoCoordinates(store);
  const query = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}}}}}';
  const result = await ghJson(store.config.repoRoot, ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`]);
  const nodes = result?.data?.repository?.pullRequest?.reviewThreads?.nodes;
  if (!Array.isArray(nodes)) throw new Error('GitHub GraphQL did not return reviewThreads');
  return nodes.filter(node => node && node.isResolved === false).length;
}

async function setMergeLabel(store, number, wanted) {
  const args = ['pr', 'edit', String(number), wanted ? '--add-label' : '--remove-label', MERGE_LABEL];
  try { await gh(store.config.repoRoot, ...args); }
  catch (error) {
    if (wanted) throw new Error(`Cannot add ${MERGE_LABEL}; run pr-init with apply=true first. ${error.message}`);
    // Removing a label that is already absent is not a failure.
    if (!/not found|does not have|no label/i.test(String(error.message))) throw error;
  }
}

async function writeProtocol(store, item, pr, state) {
  const markdown = item.brief?.markdown || stripProtocol(pr.body) || basicBody(item, store.config.mergePolicy);
  const body = protocolBody(markdown, state);
  await gh(store.config.repoRoot, 'pr', 'edit', String(pr.number), '--body', body);
  item.pr = { ...item.pr, ...pr, protocol: state, body };
  return item.pr;
}

async function restComments(store, number) {
  const { owner, name } = await repoCoordinates(store);
  return ghJson(store.config.repoRoot, ['api', `repos/${owner}/${name}/issues/${number}/comments?per_page=100`]);
}

async function restReviews(store, number) {
  const { owner, name } = await repoCoordinates(store);
  return ghJson(store.config.repoRoot, ['api', `repos/${owner}/${name}/pulls/${number}/reviews?per_page=100`]);
}

/** Review authors have no author_association field in the REST review shape. */
async function authorizedReviewers(store, reviews) {
  const { owner, name } = await repoCoordinates(store);
  const authorized = new Set();
  for (const review of reviews) {
    const login = review?.user?.login;
    if (!login || authorized.has(login)) continue;
    try {
      const value = await ghJson(store.config.repoRoot, ['api', `repos/${owner}/${name}/collaborators/${encodeURIComponent(login)}/permission`]);
      if (value?.permission && value.permission !== 'none') authorized.add(login);
    } catch {
      // An unreadable permission is not evidence of authority.
    }
  }
  return authorized;
}

async function feedbackFor(store, item, pr) {
  const [comments, reviews, unresolved] = await Promise.all([
    restComments(store, pr.number),
    restReviews(store, pr.number),
    unresolvedThreads(store, pr.number),
  ]);
  const reviewers = await authorizedReviewers(store, reviews);
  const windowStart = item.pr?.feedbackWindowStart ?? item.pr?.readyAt ?? new Date(0).toISOString();
  return evaluateFeedback({
    head: pr.headRefOid,
    windowStart,
    comments,
    reviews,
    authorizedReviewers: reviewers,
    reviewDecision: pr.reviewDecision,
    ci: checkState(pr.checks),
    unresolved,
    mergePolicy: store.config.mergePolicy,
    labels: pr.labels,
  });
}

function waitingReason(feedback) {
  if (feedback.verdict === 'revise') return 'Feedback requested changes';
  if (feedback.ci === 'pending') return 'CI is still pending';
  if (feedback.ci === 'fail') return 'CI failed';
  if (feedback.verdict === 'pass' && !feedback.mergeSatisfied) return 'Merge intent is not recorded yet';
  return 'No authorized verdict yet';
}

/** Persist the protocol block and merge-ready label for the current decision. */
async function syncProtocol(store, item, pr, feedback) {
  const previous = item.pr?.protocol ?? protocolFor(item);
  const head = pr.headRefOid ?? previous.head;
  const protocol = { ...previous, task: item.id, head, base: store.config.baseBranch, ci: feedback.ci };
  if (previous.head && previous.head !== head) {
    // A pushed head invalidates the old window: only feedback after it counts.
    item.pr.feedbackWindowStart = new Date().toISOString();
    protocol.stage = 'reviewing';
    protocol.next = 'review';
    protocol.order = '';
  } else if (feedback.verdict === 'revise' || feedback.unresolved > 0) {
    protocol.stage = 'blocked';
    protocol.next = 'repair';
  } else if (feedback.verdict === 'pass' && ['pass', 'none'].includes(feedback.ci) && feedback.mergeSatisfied) {
    protocol.stage = 'merge-ready';
    protocol.next = 'merge';
    if (!protocol.order) protocol.order = String(await store.nextOrder()).padStart(4, '0');
  } else if (feedback.ci === 'pending') {
    protocol.stage = 'verifying';
    protocol.next = 'check';
  } else if (feedback.verdict === 'pass') {
    protocol.stage = 'verifying';
    protocol.next = 'check';
  } else {
    protocol.stage = 'reviewing';
    protocol.next = 'review';
  }
  await writeProtocol(store, item, pr, protocol);
  await setMergeLabel(store, pr.number, protocol.stage === 'merge-ready');
  item.pr.protocol = protocol;
  return protocol;
}

async function updatePr(store, item, { create = false, state } = {}) {
  const branch = item.branch;
  if (!branch) throw new Error('Requirement has no branch for PR');
  const title = prTitle(item);
  const protocol = state ?? protocolFor(item);
  const body = prBody(item, protocol, store.config.mergePolicy);
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
  item.pr = { ...normalisePr(pr), protocol };
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
    const state = protocolFor(item, { head: item.implementation.commit, base: store.config.baseBranch, stage: 'reviewing', next: 'review', order: '', ci: 'pending' });
    await updatePr(store, item, { create: true, state });
    await setMergeLabel(store, item.pr.number, false);
    item.pr.protocol = state;
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
    if (item.pr.state === 'MERGED') {
      await verifyExternalMerge(store, item);
      return { item, outcome: 'merged', pr: item.pr };
    }
    const state = protocolFor(item, {
      head: item.pr.headRefOid ?? item.implementation.commit,
      base: store.config.baseBranch,
      stage: 'verifying',
      next: 'check',
      order: item.pr.protocol?.order ?? '',
      ci: 'pending',
    });
    item.pr = { ...item.pr, protocol: state, feedbackWindowStart: new Date().toISOString() };
    await updatePr(store, item, { state });
    await setMergeLabel(store, item.pr.number, false);
    item.pr.readyAt = new Date().toISOString();
    item.pr.feedbackWindowStart = item.pr.feedbackWindowStart ?? item.pr.readyAt;
    item.pr.protocol = state;
    return { item, outcome: 'complete', pr: item.pr };
  }), 'integration');
}

async function targetReadyForMerge(store) {
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
  await targetReadyForMerge(store);
  if (!await ancestor(store.config.repoRoot, commitId(commit))) {
    throw new Error('PR is marked merged but the approved commit is not in the base branch. The repository may use squash/rebase merges; this workflow requires a merge commit.');
  }
  item.status = 'merged';
  item.integration = {
    state: 'verified',
    mechanism: item.pr.mergeDecision ? 'workflow-merge' : 'external-pr',
    pr: item.pr,
    mergeCommit: item.pr.mergeDecision?.mergeCommit ?? commitId(await git(store.config.repoRoot, 'rev-parse', 'HEAD')),
    verifiedAt: new Date().toISOString(),
  };
  // A merged requirement is terminal: its seed returns to the rotation.
  await store.settleSeedForRequirementUnlocked(item);
}

/**
 * Poll the PR on GitHub. Returns `pass` only when the current head has an
 * authorized pass verdict, green CI, no unresolved threads and the configured
 * merge intent. Any blocking feedback returns `revise`; everything else waits.
 */
export async function watch(store, id, claimId) {
  return store.locked(() => store.mutate(id, claimId, async item => {
    if (!['human-pending', 'approved'].includes(item.status)) throw new Error('PR watch requires a reviewed requirement');
    if (!item.pr?.number) throw new Error('No PR recorded for this requirement');
    const pr = normalisePr(await viewPr(store, item.pr.number));
    item.pr = { ...item.pr, ...pr };
    if (pr.state === 'MERGED') {
      await setMergeLabel(store, pr.number, false);
      await verifyExternalMerge(store, item);
      return { item, outcome: 'merged', pr, feedback: null };
    }
    if (pr.state === 'CLOSED') {
      await setMergeLabel(store, pr.number, false);
      return { item, outcome: 'closed', pr, feedback: null, reason: 'PR was closed without merge' };
    }
    if (pr.isDraft) return { item, outcome: 'waiting', pr, feedback: null, reason: 'PR is still a draft' };
    const feedback = await feedbackFor(store, item, pr);
    item.pr.feedback = {
      head: feedback.head, verdict: feedback.verdict, decision: feedback.decision,
      mergeIntent: feedback.mergeIntent, mergeSatisfied: feedback.mergeSatisfied,
      ci: feedback.ci, unresolved: feedback.unresolved, checkedAt: new Date().toISOString(),
    };
    const protocol = await syncProtocol(store, item, pr, feedback);
    const outcome = feedback.verdict === 'revise' || feedback.unresolved > 0
      ? 'revise'
      : protocol.stage === 'merge-ready' ? 'pass' : 'waiting';
    return { item, outcome, pr, feedback, reason: outcome === 'waiting' ? waitingReason(feedback) : null };
  }), 'integration');
}

/**
 * Apply blocking GitHub feedback to the existing branch/worktree/PR. The packet
 * continues into engineering on the same claim.
 */
export async function requestChanges(store, id, claimId, { feedback = null, reason = null } = {}) {
  return store.locked(() => store.mutate(id, claimId, async item => {
    const decision = feedback?.decision ?? null;
    const key = decision ? `${decision.kind}:${decision.id}` : `closed:${item.pr?.number ?? item.id}`;
    if (item.feedback.some(entry => entry.key === key)) return { item, outcome: 'complete' };
    if (!['human-pending', 'approved'].includes(item.status)) throw new Error('PR feedback can only rework a reviewed requirement');
    const note = reason ?? (decision?.verdict === 'revise' ? `GitHub review requested changes (${key})` : 'GitHub feedback requires rework');
    item.feedback.push({ scope: 'pr', key, head: decision?.head ?? item.pr?.headRefOid ?? null, decision: decision?.verdict ?? 'revise', actor: decision?.actor ?? 'github', note, at: new Date().toISOString() });
    item.approval = null;
    item.status = 'engineering-ready';
    item.pr = { ...(item.pr ?? {}), feedback: { ...(item.pr?.feedback ?? {}), last: feedback ?? null, lastAt: new Date().toISOString() } };
    if (item.pr.number) await setMergeLabel(store, item.pr.number, false);
    return { item, outcome: 'complete', feedback };
  }), 'integration');
}

/**
 * Merge the current head when the policy is satisfied. The PR is re-read
 * immediately before merging; a lost race is re-classified instead of replayed.
 */
export async function merge(store, id, claimId) {
  return store.locked(() => store.mutate(id, claimId, async item => {
    if (!['human-pending', 'approved'].includes(item.status)) throw new Error('PR merge requires a reviewed requirement');
    if (!item.pr?.number) throw new Error('No PR recorded for this requirement');
    let pr = normalisePr(await viewPr(store, item.pr.number));
    item.pr = { ...item.pr, ...pr };
    if (pr.state === 'MERGED') {
      await setMergeLabel(store, pr.number, false);
      await verifyExternalMerge(store, item);
      return { item, outcome: 'merged', pr, feedback: null };
    }
    if (pr.state === 'CLOSED') return { item, outcome: 'revise', pr, feedback: null, reason: 'PR was closed before merge' };
    let feedback = await feedbackFor(store, item, pr);
    if (feedback.verdict === 'revise' || feedback.unresolved > 0) {
      await syncProtocol(store, item, pr, feedback);
      return { item, outcome: 'revise', pr, feedback };
    }
    if (feedback.verdict !== 'pass' || !['pass', 'none'].includes(feedback.ci) || !feedback.mergeSatisfied) {
      await syncProtocol(store, item, pr, feedback);
      return { item, outcome: 'waiting', pr, feedback, reason: waitingReason(feedback) };
    }
    await verifyReviewedCommit(store, item);
    // Re-read after the slow verification so a comment or push during it cannot
    // slip past the gate; the merge must still match this exact head.
    pr = normalisePr(await viewPr(store, item.pr.number));
    item.pr = { ...item.pr, ...pr };
    if (pr.state === 'MERGED') {
      await setMergeLabel(store, pr.number, false);
      await verifyExternalMerge(store, item);
      return { item, outcome: 'merged', pr, feedback };
    }
    if (pr.state === 'CLOSED') return { item, outcome: 'revise', pr, feedback, reason: 'PR was closed during merge verification' };
    feedback = await feedbackFor(store, item, pr);
    if (feedback.verdict === 'revise' || feedback.unresolved > 0) {
      await syncProtocol(store, item, pr, feedback);
      return { item, outcome: 'revise', pr, feedback };
    }
    if (feedback.verdict !== 'pass' || !['pass', 'none'].includes(feedback.ci) || !feedback.mergeSatisfied) {
      await syncProtocol(store, item, pr, feedback);
      return { item, outcome: 'waiting', pr, feedback, reason: waitingReason(feedback) };
    }
    try {
      await gh(store.config.repoRoot, 'pr', 'merge', String(pr.number), '--merge');
    } catch (error) {
      // An external merge can win the race; re-read before failing the packet.
      const after = normalisePr(await viewPr(store, item.pr.number));
      item.pr = { ...item.pr, ...after };
      if (after.state === 'MERGED') {
        await setMergeLabel(store, after.number, false);
        await verifyExternalMerge(store, item);
        return { item, outcome: 'merged', pr: after, feedback };
      }
      if (after.state === 'CLOSED') return { item, outcome: 'revise', pr: after, feedback, reason: 'PR was closed during merge' };
      throw error;
    }
    pr = normalisePr(await viewPr(store, item.pr.number));
    item.pr = { ...item.pr, ...pr };
    if (pr.state !== 'MERGED') return { item, outcome: 'waiting', pr, feedback, reason: 'GitHub did not report the PR as merged yet' };
    item.pr.mergeDecision = {
      policy: store.config.mergePolicy,
      verdict: feedback.verdict,
      decision: feedback.decision,
      mergeIntent: feedback.mergeIntent,
      head: feedback.head,
      mergedAt: new Date().toISOString(),
      mergeCommit: null,
    };
    await setMergeLabel(store, pr.number, false);
    await verifyExternalMerge(store, item);
    item.pr.mergeDecision.mergeCommit = item.integration?.mergeCommit ?? null;
    return { item, outcome: 'merged', pr, feedback };
  }), 'integration');
}

function templateBody() {
  return [
    '<!-- workflow',
    'task=',
    'head=',
    'base=',
    'stage=implementing',
    'next=',
    'order=',
    'ci=pending',
    '-->',
    '',
    '## Change',
    '',
    '## Verification',
    '',
    '## Merge decision',
    '',
  ].join('\n');
}

export async function initPr(store, { apply = false, manualGate = false } = {}) {
  const repo = store.config.repoRoot;
  const base = store.config.baseBranch || 'main';
  const checks = [];
  // `required` separates the workflow's hard contracts (auth, repo access,
  // merge commits, its own label and template) from repository hardening that a
  // manual merge gate can replace.
  const add = (id, ok, detail, required = true) => checks.push({ id, ok: Boolean(ok), required, detail });
  let auth = false;
  try { await gh(repo, 'auth', 'status'); auth = true; } catch (error) { auth = false; }
  add('github-auth', auth, auth ? 'gh authentication available' : 'run gh auth login or set GH_TOKEN');

  let repoInfo = null;
  try { repoInfo = await ghJson(repo, ['api', `repos/${(await repoCoordinates(store)).owner}/${(await repoCoordinates(store)).name}`]); }
  catch (error) { add('repo-access', false, String(error.message).slice(0, 500)); }
  if (repoInfo) {
    add('repo-access', true, repoInfo.full_name);
    add('merge-commit', repoInfo.allow_merge_commit === true, `allow_merge_commit=${repoInfo.allow_merge_commit}`);
    add('no-squash', repoInfo.allow_squash_merge === false, `allow_squash_merge=${repoInfo.allow_squash_merge}`, false);
    add('no-rebase', repoInfo.allow_rebase_merge === false, `allow_rebase_merge=${repoInfo.allow_rebase_merge}`, false);
  } else {
    add('merge-commit', false, 'repository metadata unavailable');
  }

  let protection = null;
  try {
    const { owner, name } = await repoCoordinates(store);
    protection = await ghJson(repo, ['api', `repos/${owner}/${name}/branches/${encodeURIComponent(base)}/protection`]);
  } catch (error) {
    protection = null;
  }
  if (protection) {
    add('branch-protection', true, `protection on ${base}`, !manualGate);
    add('required-conversation-resolution', protection.required_conversation_resolution?.enabled === true, 'required conversation resolution', !manualGate);
    const contexts = protection.required_status_checks?.contexts;
    add('required-checks', Array.isArray(contexts) && contexts.length > 0, Array.isArray(contexts) && contexts.length ? `${contexts.length} required checks` : 'no required checks configured', !manualGate);
  } else {
    add('branch-protection', false, manualGate ? 'no branch protection; the manual merge gate covers it' : 'branch protection not readable; configure it manually', !manualGate);
    add('required-conversation-resolution', false, 'branch protection not configured', !manualGate);
    add('required-checks', false, 'branch protection not configured', !manualGate);
  }

  const labels = [
    { name: MERGE_LABEL, color: '0E8A16', description: 'Verified by dsh-auto-workflow' },
    { name: MERGE_INTENT_LABEL, color: '1D76DB', description: 'Merge this PR with a merge commit (label policy)' },
    { name: REVIEW_LABEL, color: 'FBCA04', description: 'Requirement waiting for a maintainer decision' },
    { name: APPROVED_LABEL, color: '0E8A16', description: 'Requirement review approved' },
    { name: REJECTED_LABEL, color: 'B60205', description: 'Requirement review rejected' },
  ];
  let coordinates = null;
  try { coordinates = await repoCoordinates(store); } catch { coordinates = null; }
  const missing = [];
  if (coordinates) {
    for (const label of labels) {
      try { await ghJson(repo, ['api', `repos/${coordinates.owner}/${coordinates.name}/labels/${encodeURIComponent(label.name)}`]); }
      catch { missing.push(label); }
    }
  }
  const mergeMissing = missing.some(label => label.name === MERGE_LABEL || label.name === MERGE_INTENT_LABEL);
  const requirementMissing = missing.filter(label => REQUIREMENT_LABELS.includes(label.name));
  add('merge-label', Boolean(coordinates) && !mergeMissing, !coordinates ? 'repository coordinates unavailable' : mergeMissing ? `run with apply=true to create ${MERGE_LABEL} and ${MERGE_INTENT_LABEL}` : `${MERGE_LABEL}, ${MERGE_INTENT_LABEL}`);
  add('requirement-labels', Boolean(coordinates) && requirementMissing.length === 0, !coordinates ? 'repository coordinates unavailable' : requirementMissing.length ? `run with apply=true to create ${requirementMissing.map(label => label.name).join(', ')}` : REQUIREMENT_LABELS.join(', '));

  const templatePath = path.join(repo, TEMPLATE_PATH);
  let template = '';
  try { template = await readFile(templatePath, 'utf8'); } catch { template = ''; }
  let hasBlock = /^<!-- workflow\r?\n[\s\S]*?\r?\n-->/.test(template);
  add('pr-template', hasBlock, hasBlock ? TEMPLATE_PATH : `missing state block in ${TEMPLATE_PATH}`);

  if (apply) {
    if (missing.length > 0) {
      for (const label of missing) await gh(repo, 'label', 'create', label.name, '--color', label.color, '--description', label.description, '--force');
      for (const id of ['merge-label', 'requirement-labels']) {
        const item = checks.find(check => check.id === id);
        if (item) { item.ok = true; item.detail = 'labels created or verified'; }
      }
      for (const label of missing) add(`apply-label:${label.name}`, true, `created ${label.name}`, false);
    }
    if (!hasBlock) {
      const current = await readFile(templatePath, 'utf8').catch(() => null);
      if (current === null) {
        await mkdir(path.dirname(templatePath), { recursive: true });
        await writeFile(templatePath, templateBody(), 'utf8');
        hasBlock = true;
        const item = checks.find(check => check.id === 'pr-template');
        if (item) { item.ok = true; item.detail = `created ${TEMPLATE_PATH}`; }
        add('apply-pr-template', true, `created ${TEMPLATE_PATH}`, false);
      } else {
        add('apply-pr-template', false, `existing ${TEMPLATE_PATH} has no workflow block; leaving it untouched`, false);
      }
    }
  }

  const warnings = checks.filter(check => !check.required && !check.ok);
  return { ready: checks.filter(check => check.required).every(check => check.ok), manualGate, checks, warnings, apply };
}

export async function updateBody(store, item) {
  if (!item.pr?.number) return null;
  const current = normalisePr(await viewPr(store, item.pr.number));
  if (current.state === 'MERGED' || current.state === 'CLOSED') return current;
  const parsed = parseProtocol(current.body);
  const state = {
    ...protocolFor(item),
    ...(parsed ?? item.pr.protocol ?? {}),
    task: item.id,
    base: store.config.baseBranch,
  };
  item.pr = { ...item.pr, ...current, protocol: state };
  await writeProtocol(store, item, item.pr, state);
  await gh(store.config.repoRoot, 'pr', 'edit', String(item.pr.number), '--title', prTitle(item));
  return item.pr;
}
