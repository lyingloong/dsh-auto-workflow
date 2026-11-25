/**
 * Deterministic GitHub feedback decisions for the development example.
 *
 * The workflow never guesses a verdict from prose. A decision exists only when
 * an authorized collaborator provides a structured marker, a formal review
 * state, or a blocking review thread. Comments are bound to the current head by
 * their `[head=<sha>]` marker, or by being posted after the feedback window
 * opened (a new ready/rework cycle). Formal reviews are bound by `commit_id`.
 */
export const MERGE_LABEL = 'workflow:merge-ready';
export const MERGE_INTENT_LABEL = 'workflow:merge';
export const MERGE_POLICIES = ['comment', 'auto', 'label'];
export const AUTHORIZED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

const VERDICT = /\[verdict=(pass|revise)\]/i;
const HEAD_MARKER = /\[head=([0-9a-f]{7,64})\]/i;
const MERGE_INTENT = /@workflow\s+merge\b/i;
const STOP_INTENT = /@workflow\s+stop\b/i;
const WORKFLOW_ROLE = /\[role=workflow\]/i;

function bodyOf(entry) { return String(entry?.body ?? ''); }
function authorOf(entry) { return String(entry?.user?.login ?? entry?.author?.login ?? 'unknown'); }
function associationOf(entry) { return String(entry?.author_association ?? entry?.authorAssociation ?? '').toUpperCase(); }
function timeOf(entry) { return Date.parse(entry?.submitted_at ?? entry?.submittedAt ?? entry?.created_at ?? entry?.createdAt ?? '') || 0; }
function headMarker(entry) { return bodyOf(entry).match(HEAD_MARKER)?.[1]?.toLowerCase() ?? null; }
function authorizedComment(entry) { return AUTHORIZED_ASSOCIATIONS.has(associationOf(entry)) && !WORKFLOW_ROLE.test(bodyOf(entry)); }

/** One verdict comment, or null when it is unauthorized, unrelated or stale. */
export function commentDecision(comment, { head, windowStart }) {
  if (!authorizedComment(comment)) return null;
  const match = bodyOf(comment).match(VERDICT);
  if (!match) return null;
  const marker = headMarker(comment);
  if (marker && !String(head).startsWith(marker)) return null;
  if (!marker && !(timeOf(comment) >= Date.parse(windowStart))) return null;
  return { kind: 'comment', id: Number(comment.id), actor: authorOf(comment), at: comment.created_at ?? comment.createdAt ?? '', head: marker, verdict: match[1].toLowerCase() };
}

/** One formal review state bound to the current head, or null. */
export function reviewDecision(review, { head, authorized }) {
  if (!authorized || WORKFLOW_ROLE.test(bodyOf(review))) return null;
  const state = String(review?.state ?? '').toUpperCase();
  const verdict = state === 'APPROVED' ? 'pass' : state === 'CHANGES_REQUESTED' ? 'revise' : null;
  if (!verdict) return null;
  const commit = String(review?.commit_id ?? review?.commitId ?? '').toLowerCase();
  if (!commit || !String(head).startsWith(commit)) return null;
  return { kind: 'review', id: Number(review.id), actor: authorOf(review), at: review.submitted_at ?? review.submittedAt ?? '', head: commit, verdict };
}

/** The newest authorized `@workflow merge` comment inside the current window. */
export function mergeIntent(comments = [], { head, windowStart }) {
  const ordered = [...comments].sort((a, b) => timeOf(b) - timeOf(a));
  for (const comment of ordered) {
    if (!authorizedComment(comment)) continue;
    const body = bodyOf(comment);
    if (!MERGE_INTENT.test(body) || STOP_INTENT.test(body)) continue;
    const marker = headMarker(comment);
    if (marker && !String(head).startsWith(marker)) continue;
    if (timeOf(comment) < Date.parse(windowStart)) continue;
    return { id: Number(comment.id), actor: authorOf(comment), at: comment.created_at ?? comment.createdAt ?? '', head: marker };
  }
  return null;
}

/**
 * Combine comments, reviews, unresolved threads, CI and the merge policy into
 * one deterministic decision. The newest explicit decision wins; unresolved
 * threads always block; `reviewDecision` is only a fallback when no explicit
 * decision exists.
 */
export function evaluateFeedback({
  head, windowStart, comments = [], reviews = [], authorizedReviewers = new Set(),
  reviewDecision: aggregate = null, ci = 'none', unresolved = 0, mergePolicy = 'comment', labels = [], mergeIntentOverride = null,
} = {}) {
  const decisions = [
    ...comments.map(comment => commentDecision(comment, { head, windowStart })).filter(Boolean),
    ...reviews.map(review => reviewDecision(review, { head, authorized: authorizedReviewers.has(authorOf(review)) })).filter(Boolean),
  ].sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0) || a.id - b.id);
  const latest = decisions.at(-1) ?? null;
  const intent = mergeIntentOverride ?? mergeIntent(comments, { head, windowStart });
  let verdict = latest?.verdict ?? (aggregate === 'APPROVED' ? 'pass' : aggregate === 'CHANGES_REQUESTED' ? 'revise' : null);
  // An explicit authorized merge intent (a natural-language merge command or an
  // @workflow merge comment) is itself the operator's pass decision when no
  // other verdict exists; blocking feedback still wins.
  if (!verdict && mergePolicy === 'comment' && intent) verdict = 'pass';
  if (unresolved > 0) verdict = 'revise';
  const mergeSatisfied = verdict === 'pass' && (ci === 'pass' || ci === 'none') && unresolved === 0
    && (mergePolicy === 'auto' || (mergePolicy === 'label' ? labels.includes(MERGE_INTENT_LABEL) : Boolean(intent)));
  return { head, verdict, decision: latest, mergeIntent: intent, mergeSatisfied, ci, unresolved, mergePolicy };
}
