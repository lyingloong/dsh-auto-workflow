/** GitHub pull-request execution plane. The driver owns the workflow; this
 * module only pushes the requirement branch, opens/updates its one draft PR,
 * polls that exact PR, and verifies an external merge. It never merges. */
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { git, checkedWorktree, targetReady, checkApproval, ancestor, commitId, clean } from './worktrees.mjs';

const execute = promisify(execFile);
const PR_FIELDS = 'number,url,state,isDraft,headRefOid,mergeCommit,mergedAt,closed,reviewDecision,body,statusCheckRollup,comments,reviews';
const STAGES = new Set(['implementing', 'verifying', 'reviewing', 'repairing', 'merge-ready', 'blocked']);
const MERGE_LABEL = 'workflow:merge-ready';
const TEMPLATE_PATH = '.github/pull_request_template.md';

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
    body: typeof value.body === 'string' ? value.body : '',
    checks: Array.isArray(value.statusCheckRollup) ? value.statusCheckRollup : [],
    comments: Array.isArray(value.comments) ? value.comments : [],
    reviews: Array.isArray(value.reviews) ? value.reviews : [],
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

function roleHeader(item, role) {
  return `[role=${role}] [task=${item.id}] [head=${String(item.implementation?.commit ?? '').slice(0, 12)}]`;
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

function validateRoleComments(item, head, comments = [], reviews = []) {
  const errors = [];
  const header = /\[role=(captain|engineer|verifier|reviewer|codex|workflow)\]\s*\[task=([^\]]+)\]\s*\[head=([0-9a-f]{12,64})\]/i;
  const topLevel = /^\s*\[(verify|review|repair|merge-gate)\]/m;
  for (const entry of [...comments, ...reviews]) {
    const body = String(entry?.body ?? '');
    if (!topLevel.test(body)) continue;
    const match = body.match(header);
    if (!match) { errors.push('top-level comment is missing a role/task/head header'); continue; }
    if (match[2] !== item.id) errors.push(`comment task ${match[2]} does not match ${item.id}`);
    if (!String(head).startsWith(match[3].toLowerCase())) errors.push(`comment head ${match[3]} does not match ${String(head).slice(0, 12)}`);
  }
  return [...new Set(errors)];
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
    '> Workflow-managed PR. Merge-ready is granted only after the state block, CI and review-thread gate pass.',
  ].join('\n');
}

function prBody(item, state = protocolFor(item)) {
  return protocolBody(item.brief?.markdown || basicBody(item), state);
}

async function repoCoordinates(store) {
  const value = await ghJson(store.config.repoRoot, ['repo', 'view', '--json', 'nameWithOwner']);
  const [owner, name] = String(value.nameWithOwner ?? '').split('/');
  if (!owner || !name) throw new Error('Cannot resolve GitHub repository owner/name');
  return { owner, name };
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
  const markdown = item.brief?.markdown || stripProtocol(pr.body) || basicBody(item);
  const body = protocolBody(markdown, state);
  await gh(store.config.repoRoot, 'pr', 'edit', String(pr.number), '--body', body);
  item.pr = { ...item.pr, ...pr, protocol: state, body };
  return item.pr;
}

async function evaluateGate(store, item, pr) {
  const previous = item.pr?.protocol ?? protocolFor(item);
  const head = pr.headRefOid ?? previous.head;
  const base = store.config.baseBranch;
  const ci = checkState(pr.checks);
  const unresolved = await unresolvedThreads(store, pr.number);
  const commentErrors = validateRoleComments(item, head, pr.comments, pr.reviews);
  const latestReview = item.reviews?.at(-1);
  const reviewed = latestReview?.decision === 'pass' && latestReview.commit === head;
  let protocol = { ...previous, task: item.id, head, base, ci };
  if (previous.head && previous.head !== head) {
    protocol.stage = 'reviewing';
    protocol.next = 'review';
    protocol.order = '';
  }
  if (!reviewed) {
    protocol.stage = 'reviewing';
    protocol.next = 'review';
  } else if (commentErrors.length) {
    protocol.stage = 'blocked';
    protocol.next = 'fix-comment-headers';
  } else if (ci === 'fail' || unresolved > 0) {
    protocol.stage = 'blocked';
    protocol.next = 'repair';
  } else if (ci === 'pending') {
    protocol.stage = 'verifying';
    protocol.next = 'check';
  } else {
    protocol.stage = 'merge-ready';
    protocol.next = 'codex-merge';
    if (!protocol.order) protocol.order = String(await store.nextOrder()).padStart(4, '0');
  }
  await writeProtocol(store, item, pr, protocol);
  await setMergeLabel(store, pr.number, protocol.stage === 'merge-ready');
  item.pr.protocol = protocol;
  return { protocol, ci, unresolved, commentErrors };
}

async function updatePr(store, item, { create = false, state } = {}) {
  const branch = item.branch;
  if (!branch) throw new Error('Requirement has no branch for PR');
  const title = prTitle(item);
  const protocol = state ?? protocolFor(item);
  const body = prBody(item, protocol);
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
    item.pr = { ...item.pr, protocol: state };
    await updatePr(store, item, { state });
    await setMergeLabel(store, item.pr.number, false);
    item.pr.readyAt = new Date().toISOString();
    item.pr.protocol = state;
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
      await setMergeLabel(store, pr.number, false);
      await verifyExternalMerge(store, item);
      return { item, outcome: 'merged', pr: item.pr };
    }
    if (pr.state === 'CLOSED') {
      item.status = 'engineering-ready';
      item.approval = null;
      item.integration = { state: 'pr-closed', pr: item.pr, checkedAt: new Date().toISOString() };
      item.feedback.push({ scope: 'integration', artifactRef: item.implementation?.artifactRef, note: 'PR was closed without merge; return to engineering. Reopen or update the same PR after new commits.' });
      await setMergeLabel(store, pr.number, false);
      return { item, outcome: 'closed', pr: item.pr };
    }
    // External reviewers may merge the ready PR at any time. Only after the
    // gate passes and the grace period expires do we request self-merge approval.
    const { protocol } = await evaluateGate(store, item, pr);
    const readyAt = Date.parse(item.pr.readyAt ?? '');
    if (protocol.stage === 'merge-ready' && Number.isFinite(readyAt) && Date.now() - readyAt >= store.config.selfMergeAfterMs) {
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
    if (item.pr.protocol?.stage !== 'merge-ready') throw new Error('Self-merge requires a merge-ready PR');
    let pr = normalisePr(await viewPr(store, item.pr.number));
    if (!pr.labels.includes(MERGE_LABEL)) throw new Error(`Self-merge requires the ${MERGE_LABEL} label`);
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
    await setMergeLabel(store, pr.number, false);
    await verifyExternalMerge(store, item);
    return { item, outcome: 'merged', pr: item.pr };
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
    '## Summary',
    '',
    '## Verification',
    '',
  ].join('\n');
}

export async function initPr(store, { apply = false } = {}) {
  const repo = store.config.repoRoot;
  const base = store.config.baseBranch || 'main';
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok: Boolean(ok), detail });
  let auth = false;
  try { await gh(repo, 'auth', 'status'); auth = true; } catch (error) { auth = false; }
  add('github-auth', auth, auth ? 'gh authentication available' : 'run gh auth login or set GH_TOKEN');

  let repoInfo = null;
  try { repoInfo = await ghJson(repo, ['api', `repos/${(await repoCoordinates(store)).owner}/${(await repoCoordinates(store)).name}`]); }
  catch (error) { add('repo-access', false, String(error.message).slice(0, 500)); }
  if (repoInfo) {
    add('repo-access', true, repoInfo.full_name);
    add('merge-commit', repoInfo.allow_merge_commit === true, `allow_merge_commit=${repoInfo.allow_merge_commit}`);
    add('no-squash', repoInfo.allow_squash_merge === false, `allow_squash_merge=${repoInfo.allow_squash_merge}`);
    add('no-rebase', repoInfo.allow_rebase_merge === false, `allow_rebase_merge=${repoInfo.allow_rebase_merge}`);
  }

  let protection = null;
  try {
    const { owner, name } = await repoCoordinates(store);
    protection = await ghJson(repo, ['api', `repos/${owner}/${name}/branches/${encodeURIComponent(base)}/protection`]);
  } catch (error) {
    add('branch-protection', false, 'branch protection not readable; configure it manually');
  }
  if (protection) {
    add('branch-protection', true, `protection on ${base}`);
    add('required-conversation-resolution', protection.required_conversation_resolution?.enabled === true, 'required conversation resolution');
    const contexts = protection.required_status_checks?.contexts;
    add('required-checks', Array.isArray(contexts) && contexts.length > 0, Array.isArray(contexts) && contexts.length ? `${contexts.length} required checks` : 'no required checks configured');
  }

  let label = false;
  try {
    const { owner, name } = await repoCoordinates(store);
    await ghJson(repo, ['api', `repos/${owner}/${name}/labels/${encodeURIComponent(MERGE_LABEL)}`]);
    label = true;
  } catch { label = false; }
  add('merge-label', label, label ? MERGE_LABEL : `run with apply=true to create ${MERGE_LABEL}`);

  const templatePath = path.join(repo, TEMPLATE_PATH);
  let template = '';
  try { template = await readFile(templatePath, 'utf8'); } catch { template = ''; }
  let hasBlock = /^<!-- workflow\r?\n[\s\S]*?\r?\n-->/.test(template);
  add('pr-template', hasBlock, hasBlock ? TEMPLATE_PATH : `missing state block in ${TEMPLATE_PATH}`);

  if (apply) {
    if (!label) {
      await gh(repo, 'label', 'create', MERGE_LABEL, '--color', '0E8A16', '--description', 'Verified by dsh-auto-workflow', '--force');
      const item = checks.find(check => check.id === 'merge-label');
      if (item) { item.ok = true; item.detail = `created ${MERGE_LABEL}`; }
      add('apply-merge-label', true, `created ${MERGE_LABEL}`);
    }
    if (!hasBlock) {
      const current = await readFile(templatePath, 'utf8').catch(() => null);
      if (current === null) {
        await mkdir(path.dirname(templatePath), { recursive: true });
        await writeFile(templatePath, templateBody(), 'utf8');
        hasBlock = true;
        const item = checks.find(check => check.id === 'pr-template');
        if (item) { item.ok = true; item.detail = `created ${TEMPLATE_PATH}`; }
        add('apply-pr-template', true, `created ${TEMPLATE_PATH}`);
      } else {
        add('apply-pr-template', false, `existing ${TEMPLATE_PATH} has no workflow block; leaving it untouched`);
      }
    }
  }

  const required = ['github-auth', 'repo-access', 'merge-commit', 'branch-protection', 'required-conversation-resolution', 'merge-label', 'pr-template'];
  return { ready: required.every(id => checks.some(check => check.id === id && check.ok)), checks, apply };
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
