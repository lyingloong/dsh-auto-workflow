/** Local Git execution plane: one requirement branch and one attached worktree.
 * Remote publication and PR polling live in pr.mjs. */
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdir, lstat, realpath } from 'node:fs/promises';
import { atomicJSON, readJSON, inside, text } from './store.mjs';

const execute = promisify(execFile);
export async function git(cwd, ...args) {
  const result = await execute('git', ['-C', cwd, ...args], { windowsHide: true, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_MERGE_AUTOEDIT: 'no' } });
  return args.includes('-z') ? result.stdout : result.stdout.trim();
}
async function ignoredFiles(cwd) { return (await git(cwd, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z')).split('\0').filter(Boolean); }
async function protectIgnoredTarget(cwd, commit) {
  const ignored = await ignoredFiles(cwd);
  if (!ignored.length) return;
  const folded = process.platform === 'win32' || await git(cwd, 'config', '--get', 'core.ignorecase').catch(() => '') === 'true';
  const normalize = value => { const clean = value.replace(/\/$/, ''); return folded ? clean.toLowerCase() : clean; };
  const tracked = (await git(cwd, 'ls-tree', '-r', '--name-only', '-z', commit)).split('\0').filter(Boolean).map(normalize);
  const collisions = ignored.filter(file => { const candidate = normalize(file); return tracked.some(target => candidate === target || candidate.startsWith(`${target}/`) || target.startsWith(`${candidate}/`)); });
  if (collisions.length) throw new Error(`Merge would overwrite ignored local data (${collisions.length} path(s)); preserve/move it manually before retrying: ${JSON.stringify(collisions.slice(0, 10))}`);
}
async function exists(file) { try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function clean(cwd) { if (await git(cwd, 'status', '--porcelain')) throw new Error('Git working tree is dirty; preserve and inspect before recovery'); }
async function noMerge(cwd) {
  const mergeHead = await git(cwd, 'rev-parse', '--git-path', 'MERGE_HEAD');
  if (await exists(path.resolve(cwd, mergeHead))) throw new Error('Integration merge is pending; preserve conflicts and resolve manually');
}
async function targetReady(store) {
  const { repoRoot, baseBranch } = store.config;
  if (await git(repoRoot, 'symbolic-ref', '--short', 'HEAD') !== baseBranch) throw new Error('Integration repository must have the configured base branch checked out');
  await noMerge(repoRoot); await clean(repoRoot);
}
async function ancestor(cwd, commit, head = 'HEAD') {
  try { await git(cwd, 'merge-base', '--is-ancestor', commit, head); return true; }
  catch (error) { if (error.code === 1) return false; throw error; }
}
function commitId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40,64}$/.test(value)) throw new Error('Invalid immutable commit');
  return value;
}
export function branchFor(id) {
  if (typeof id !== 'string' || !/^req-[A-Za-z0-9._-]+$/.test(id)) throw new Error('Invalid requirement id for branch');
  return `auto/req-${id.slice(4)}`;
}
async function checkedWorktree(store, item) {
  const expected = path.join(store.root, 'worktrees', item.id);
  if (item.worktreePath !== expected) throw new Error('Unexpected worktree path; refusing Git operation');
  inside(store.root, expected);
  if ((await lstat(expected)).isSymbolicLink() || path.resolve(await realpath(expected)) !== expected) throw new Error('Worktree must not be a symlink');
  if (typeof item.branch !== 'string' || !item.branch) throw new Error('Requirement worktree has no recorded branch');
  const head = await git(expected, 'symbolic-ref', '--short', 'HEAD');
  if (head !== item.branch) throw new Error(`Requirement worktree must be checked out on ${item.branch}; found ${head}`);
  const common = path.resolve(expected, await git(expected, 'rev-parse', '--git-common-dir'));
  const rootCommon = path.resolve(store.config.repoRoot, await git(store.config.repoRoot, 'rev-parse', '--git-common-dir'));
  if (path.resolve(await realpath(common)) !== path.resolve(await realpath(rootCommon))) throw new Error('Worktree belongs to a different repository');
  return expected;
}
export async function prepare(store, id, claimId) {
  return store.mutate(id, claimId, async item => {
    if (item.status !== 'ready' || item.requirementApproval?.decision !== 'approve' || item.requirementApproval.revision !== item.revision) throw new Error('Requirement approval is missing/stale');
    if (item.worktreePath) {
      await checkedWorktree(store, item); item.status = 'engineering-ready'; return item;
    }
    const cwd = path.join(store.root, 'worktrees', item.id);
    const branch = branchFor(id);
    await git(store.config.repoRoot, 'check-ref-format', '--branch', store.config.baseBranch);
    await git(store.config.repoRoot, 'check-ref-format', '--branch', branch);
    const baseRevision = commitId(await git(store.config.repoRoot, 'rev-parse', `refs/heads/${store.config.baseBranch}`));
    if (await exists(cwd)) throw new Error('Unrecorded worktree exists; preserve and inspect rather than overwrite');
    try { await git(store.config.repoRoot, 'rev-parse', '--verify', `refs/heads/${branch}`); throw new Error(`Requirement branch already exists: ${branch}`); }
    catch (error) { if (!/Needed a single revision|unknown revision|invalid object name|bad revision/i.test(String(error.stderr ?? error.message))) throw error; }
    // Record intent BEFORE Git. A crash cannot make the worktree invisible to business recovery.
    item.worktreePath = cwd; item.baseRevision = baseRevision; item.branch = branch; item.status = 'preparing';
    await store.save(item);
    // One requirement owns one branch and one retained worktree checked out on
    // that branch. PRs are opened from this branch; no detached requirement.
    await git(store.config.repoRoot, 'worktree', 'add', '-b', branch, cwd, baseRevision);
    item.status = 'engineering-ready'; return item;
  });
}
export async function snapshot(store, id, claimId, { verification, summary, expectedRevision, engineeringEpoch }) {
  return store.mutate(id, claimId, async item => {
    if (item.pendingSnapshot) throw new Error('Snapshot is uncertain; inspect then explicitly reconcile-snapshot, never replay it');
    if (item.status !== 'engineering' || expectedRevision !== item.revision || engineeringEpoch !== item.engineeringEpoch) throw new Error('Stale/unrequested engineering snapshot');
    const cwd = await checkedWorktree(store, item);
    await clean(cwd); await noMerge(cwd);
    const before = commitId(await git(cwd, 'rev-parse', 'HEAD'));
    if (!await ancestor(cwd, item.baseRevision, before)) throw new Error('Implementation no longer contains its recorded base');
    if (before === item.baseRevision) throw new Error('Requirement branch has no implementation changes to snapshot');
    text(verification, 'verification evidence'); text(summary, 'implementation summary');
    // A PR owns exactly one commit. Squash every working/rework change back to
    // the recorded base; the branch is force-pushed and the same PR is updated.
    await git(cwd, 'reset', '--soft', item.baseRevision);
    await git(cwd, 'commit', '-m', `${id} r${item.revision}: ${String(summary).split('\n')[0].slice(0, 120)}`);
    await clean(cwd); await noMerge(cwd);
    const commit = commitId(await git(cwd, 'rev-parse', 'HEAD'));
    if (!await ancestor(cwd, item.baseRevision, commit)) throw new Error('Squashed implementation no longer contains its recorded base');
    const artifactRevision = (item.implementation?.artifactRevision ?? 0) + 1;
    const folder = path.join(store.root, 'artifacts', item.id);
    await store.checkedFile(folder); await mkdir(folder, { recursive: true });
    const artifactRef = path.join(folder, `r${String(artifactRevision).padStart(6, '0')}.json`);
    const artifact = { requirementId: id, requirementRevision: item.revision, engineeringEpoch, artifactRevision, commit, tree: await git(cwd, 'rev-parse', 'HEAD^{tree}'), baseRevision: item.baseRevision, summary, verification, createdAt: new Date().toISOString() };
    item.pendingSnapshot = { artifactRef, artifact }; item.status = 'snapshot-pending';
    await store.save(item); // Reserve the immutable revision BEFORE publishing the artifact.
    await atomicJSON(await store.checkedFile(artifactRef), artifact, { immutable: true });
    return finishSnapshot(item);
  });
}
function finishSnapshot(item) {
  const { artifactRef, artifact } = item.pendingSnapshot;
  const { artifactRevision, commit, requirementRevision, engineeringEpoch } = artifact;
  item.implementation = { artifactRef, artifactRevision, commit, requirementRevision, engineeringEpoch };
  item.pendingSnapshot = null; item.status = 'reviewing'; item.approval = null;
  return { item, artifactRef, artifactRevision, commit };
}
/** Explicit operator reconciliation, not an automatic retry or artifact overwrite. */
export async function reconcileSnapshot(store, id, claimId, { decision, note, expectedRevision, engineeringEpoch }) {
  return store.mutate(id, claimId, async item => {
    if (decision !== 'finalize' || item.status !== 'snapshot-pending' || !item.pendingSnapshot || expectedRevision !== item.revision || engineeringEpoch !== item.engineeringEpoch) throw new Error('No matching uncertain snapshot to reconcile');
    text(note, 'operator reconciliation note');
    const { artifactRef, artifact } = item.pendingSnapshot;
    const expected = path.join(store.root, 'artifacts', id, `r${String((item.implementation?.artifactRevision ?? 0) + 1).padStart(6, '0')}.json`);
    if (artifactRef !== expected || artifact.requirementId !== id || artifact.requirementRevision !== item.revision || artifact.engineeringEpoch !== engineeringEpoch || artifact.baseRevision !== item.baseRevision) throw new Error('Snapshot intent does not match current requirement');
    const cwd = await checkedWorktree(store, item); await clean(cwd); await noMerge(cwd);
    if (await git(cwd, 'rev-parse', 'HEAD') !== artifact.commit || await git(cwd, 'rev-parse', 'HEAD^{tree}') !== artifact.tree) throw new Error('Worktree changed since snapshot intent; preserve and inspect');
    await store.checkedFile(artifactRef);
    if (await exists(artifactRef)) {
      if (JSON.stringify(await readJSON(artifactRef)) !== JSON.stringify(artifact)) throw new Error('Immutable artifact differs from reserved snapshot; never overwrite it');
    } else await atomicJSON(artifactRef, artifact, { immutable: true });
    item.snapshotReconciliations = [...(item.snapshotReconciliations ?? []), { artifactRef, note, at: new Date().toISOString() }];
    return finishSnapshot(item);
  });
}
export async function recordReview(store, id, claimId, { artifactRef, commit, decision, summary, verification, reviewer }) {
  return store.mutate(id, claimId, async item => {
    if (item.status !== 'reviewing' || !['pass', 'revise'].includes(decision) || item.implementation?.artifactRef !== artifactRef || item.implementation.commit !== commit) throw new Error('Review does not match current immutable implementation');
    const artifact = await readJSON(await store.checkedFile(artifactRef));
    if (artifact.requirementId !== id || artifact.requirementRevision !== item.revision || artifact.commit !== commit) throw new Error('Stale artifact revision');
    const cwd = await checkedWorktree(store, item); await clean(cwd);
    if (await git(cwd, 'rev-parse', 'HEAD') !== commit) throw new Error('Worktree changed during review');
    text(summary, 'review summary'); text(verification, 'review evidence'); text(reviewer, 'reviewer', 200);
    const reviewRevision = item.reviews.length + 1;
    const folder = path.join(store.root, 'reviews', item.id);
    await store.checkedFile(folder); await mkdir(folder, { recursive: true });
    const reviewRef = path.join(folder, `r${String(reviewRevision).padStart(6, '0')}.json`);
    await atomicJSON(await store.checkedFile(reviewRef), { requirementId: id, requirementRevision: item.revision, artifactRef, artifactRevision: artifact.artifactRevision, commit, reviewRevision, decision, summary, verification, reviewer, createdAt: new Date().toISOString() }, { immutable: true });
    item.reviews.push({ reviewRef, reviewRevision, artifactRef, commit, decision });
    item.status = decision === 'pass' ? 'human-pending' : 'engineering-ready';
    if (decision !== 'pass') item.feedback.push({ scope: 'review', artifactRef, note: summary });
    return { item, reviewRef, artifactRef, commit, outcome: decision };
  });
}
async function checkApproval(store, item) {
  const approval = item.approval, implementation = item.implementation;
  if (approval?.decision !== 'approve' || approval.revision !== item.revision || approval.artifactRef !== implementation?.artifactRef || approval.commit !== implementation.commit) throw new Error('Human approval must match the immutable artifact');
  const artifact = await readJSON(await store.checkedFile(approval.artifactRef));
  if (artifact.commit !== approval.commit || artifact.requirementRevision !== item.revision) throw new Error('Approved artifact changed');
  const latest = item.reviews.at(-1);
  if (latest?.decision !== 'pass' || latest.artifactRef !== approval.artifactRef) throw new Error('Current artifact needs a passing review');
  const cwd = await checkedWorktree(store, item); await clean(cwd);
  if (await git(cwd, 'rev-parse', 'HEAD') !== approval.commit) throw new Error('Approved worktree changed; review again');
  return approval;
}
export async function mergeBrief(store, id, claimId) {
  return store.mutate(id, claimId, async item => {
    if (item.status !== 'human-pending') throw new Error('Merge brief requires a passing review');
    const latest = item.reviews.at(-1);
    if (!latest || latest.decision !== 'pass' || latest.artifactRef !== item.implementation?.artifactRef) throw new Error('No passing review matches this implementation');
    const artifact = await readJSON(await store.checkedFile(latest.artifactRef));
    const review = await readJSON(await store.checkedFile(latest.reviewRef));
    const brief = {
      kind: 'merge-brief',
      requirement: { id: item.id, title: item.title, description: item.description, risk: item.risk, revision: item.revision },
      change: { summary: artifact.summary, verification: artifact.verification, commit: artifact.commit, artifactRef: latest.artifactRef },
      review: { decision: review.decision, summary: review.summary, verification: review.verification, reviewer: review.reviewer },
      risks: [review.summary].filter(Boolean),
      pr: item.pr ?? null,
      markdown: [
        '## Requirement', `**${item.title}**`, '', item.description, '', `- risk: \`${item.risk}\``, `- requirement: \`${item.id}\` r${item.revision}`, '',
        '## Implementation', artifact.summary, '', `- commit: \`${artifact.commit}\``, '',
        '## Verification', artifact.verification, '',
        '## Review', `${review.decision} — ${review.summary}`, '', `- reviewer: \`${review.reviewer}\``, `- review evidence: ${review.verification}`, '',
        '## Risks / open questions', review.summary, '',
        '## Decision', 'Approve to mark this PR ready, then merge it in GitHub. The workflow will only verify and clean up; it will not merge.',
      ].join('\n'),
    };
    item.brief = brief;
    return item;
  });
}
export async function integrate(store, id, claimId) {
  return store.locked(() => store.mutate(id, claimId, async item => {
    if (item.status !== 'approved') throw new Error('Implementation not approved for merge');
    const approval = await checkApproval(store, item);
    await targetReady(store);
    await protectIgnoredTarget(store.config.repoRoot, approval.commit);
    const preMergeHead = commitId(await git(store.config.repoRoot, 'rev-parse', 'HEAD'));
    item.status = 'integrating';
    item.integration = { state: 'integrating', preMergeHead, commit: approval.commit, artifactRef: approval.artifactRef };
    await store.save(item);
    try { await git(store.config.repoRoot, 'merge', '--no-ff', '--no-edit', approval.commit); }
    catch (error) {
      // Conflict is a normal rework edge, not a Human decision. Persist the
      // evidence, restore the shared target, then return the same item.
      item.status = 'conflict'; item.integration.state = 'conflict';
      item.integration.conflictFiles = (await git(store.config.repoRoot, 'diff', '--name-only', '--diff-filter=U')).split('\n').filter(Boolean);
      item.integration.error = String(error.stderr ?? error.message).slice(0, 2000);
      await store.save(item);
      try { await git(store.config.repoRoot, 'merge', '--abort'); }
      catch (abortError) { throw new Error(`Merge conflict preserved but automatic abort failed: ${String(abortError.stderr ?? abortError.message).slice(0, 1000)}`); }
      await targetReady(store);
      item.status = 'engineering-ready'; item.approval = null;
      item.integration = { ...item.integration, state: 'aborted', abortedAt: new Date().toISOString() };
      item.feedback.push({ scope: 'integration', artifactRef: approval.artifactRef, note: `Merge conflict auto-aborted; rework against the current ${store.config.baseBranch}` });
      return { item, outcome: 'revise' };
    }
    await verifyMerged(store, item);
    return { item, outcome: 'merged' };
  }), 'integration');
}
async function verifyMerged(store, item) {
  await targetReady(store);
  const commit = item.approval?.commit ?? item.implementation?.commit;
  if (!commit || !await ancestor(store.config.repoRoot, commitId(commit))) throw new Error('Reviewed/approved commit is not in integration branch; no cleanup permitted');
  item.status = 'merged';
  item.integration = { ...item.integration, state: 'verified', mergeCommit: commitId(await git(store.config.repoRoot, 'rev-parse', 'HEAD')), verifiedAt: new Date().toISOString() };
}
export async function recoverIntegration(store, id, claimId, { decision, note }) {
  return store.locked(() => store.mutate(id, claimId, async item => {
    if (!['integrating', 'conflict'].includes(item.status)) throw new Error('No uncertain integration to recover');
    text(note, 'recovery note');
    await targetReady(store); // Operator must resolve/commit OR explicitly abort outside this script.
    if (decision === 'resolved') {
      await checkApproval(store, item); await verifyMerged(store, item);
      item.integration.recoveryNote = note; return { item, outcome: 'merged' };
    }
    if (decision !== 'aborted' || await ancestor(store.config.repoRoot, item.approval.commit)) throw new Error('Abort recovery requires a clean target without the approved commit');
    item.feedback.push({ scope: 'integration', artifactRef: item.implementation.artifactRef, note });
    item.approval = null; item.status = 'engineering-ready'; item.integration.state = 'aborted';
    return { item, outcome: 'revise' };
  }), 'integration');
}
export async function cleanup(store, id, claimId, { cleanup: explicitly = false } = {}) {
  return store.locked(() => store.mutate(id, claimId, async item => {
    if (!explicitly && store.config.cleanupPolicy === 'retain') return { item, outcome: 'retained' };
    if (item.status !== 'merged' || !['verified', 'external-verified'].includes(item.integration?.state)) throw new Error('Cleanup requires a verified merge');
    await verifyMerged(store, item);
    if (!item.worktreePath) return { item, outcome: 'cleaned' };
    const cwd = await checkedWorktree(store, item);
    const mergedCommit = item.approval?.commit ?? item.implementation?.commit;
    if (!mergedCommit || await git(cwd, 'rev-parse', 'HEAD') !== mergedCommit) throw new Error('Worktree changed since review; preserve it');
    // The merge is already verified on the integration branch. --force also
    // removes ignored/untracked development leftovers, as requested; the
    // approved commit and immutable artifacts/reviews remain outside the worktree.
    await git(store.config.repoRoot, 'worktree', 'remove', '--force', cwd);
    if (item.branch) {
      try { await git(store.config.repoRoot, 'branch', '-D', item.branch); }
      catch (error) { if (!/not found|unknown revision/i.test(String(error.stderr ?? error.message))) throw error; }
    }
    item.cleanupRetention = null;
    item.cleanedWorktreePath = cwd; item.cleanedBranch = item.branch ?? null; item.worktreePath = null; item.cleanedAt = new Date().toISOString();
    return { item, outcome: 'cleaned' };
  }), 'integration');
}
export { checkedWorktree, targetReady, checkApproval, ancestor, commitId, clean, noMerge };
