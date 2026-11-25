/** Deterministic GitHub feedback decisions: no prose NLP, no stale heads. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { commentDecision, reviewDecision, mergeIntent, evaluateFeedback } from '../docs/examples/development/pr-feedback.mjs';

const head = 'a'.repeat(40);
const windowStart = '2026-01-02T00:00:00.000Z';
const recent = '2026-01-02T00:01:00.000Z';
const stale = '2026-01-01T00:00:00.000Z';
const comment = (body, extra = {}) => ({ id: 1, body, user: { login: 'maintainer' }, author_association: 'OWNER', created_at: recent, ...extra });

test('only authorized collaborators produce verdicts; workflow prose never decides', () => {
  assert.equal(commentDecision(comment('[verdict=pass]'), { head, windowStart })?.verdict, 'pass');
  assert.equal(commentDecision(comment('[verdict=revise]', { author_association: 'NONE' }), { head, windowStart }), null);
  assert.equal(commentDecision(comment('[verdict=revise]', { author_association: 'CONTRIBUTOR' }), { head, windowStart }), null);
  assert.equal(commentDecision(comment('[role=workflow] [verdict=revise]'), { head, windowStart }), null);
  assert.equal(commentDecision(comment('Looks good to me'), { head, windowStart }), null);
});

test('comments bind to the current head or the current feedback window', () => {
  assert.equal(commentDecision(comment(`[verdict=pass] [head=${head}]`), { head, windowStart })?.verdict, 'pass');
  assert.equal(commentDecision(comment(`[verdict=pass] [head=${'b'.repeat(12)}]`), { head, windowStart }), null);
  assert.equal(commentDecision(comment('[verdict=pass]', { created_at: stale }), { head, windowStart }), null);
});

test('formal reviews bind to commit_id and need an authorized author', () => {
  const review = { id: 7, state: 'APPROVED', body: '', user: { login: 'maintainer' }, commit_id: head, submitted_at: recent };
  assert.equal(reviewDecision(review, { head, authorized: true })?.verdict, 'pass');
  assert.equal(reviewDecision(review, { head, authorized: false }), null);
  assert.equal(reviewDecision({ ...review, commit_id: 'c'.repeat(40) }, { head, authorized: true }), null);
  assert.equal(reviewDecision({ ...review, state: 'COMMENTED' }, { head, authorized: true }), null);
});

test('the newest explicit decision wins, unresolved threads always block, reviewDecision is a fallback', () => {
  const comments = [comment('[verdict=pass]', { id: 1, created_at: '2026-01-02T00:01:00.000Z' }), comment('[verdict=revise]', { id: 2, created_at: '2026-01-02T00:02:00.000Z' })];
  assert.equal(evaluateFeedback({ head, windowStart, comments }).verdict, 'revise');
  assert.equal(evaluateFeedback({ head, windowStart, comments, unresolved: 1 }).verdict, 'revise');
  assert.equal(evaluateFeedback({ head, windowStart, reviewDecision: 'APPROVED' }).verdict, 'pass');
  assert.equal(evaluateFeedback({ head, windowStart, reviewDecision: 'CHANGES_REQUESTED' }).verdict, 'revise');
});

test('merge intent must be authorized, inside the window and on the current head', () => {
  const comments = [
    comment('@workflow merge', { id: 3 }),
    comment('@workflow merge', { id: 4, author_association: 'NONE' }),
    comment('@workflow merge', { id: 5, created_at: stale }),
    comment(`@workflow merge [head=${'d'.repeat(12)}]`, { id: 6 }),
  ];
  assert.equal(mergeIntent(comments, { head, windowStart })?.id, 3);
  assert.equal(mergeIntent([comments[1]], { head, windowStart }), null);
  assert.equal(mergeIntent([comments[2]], { head, windowStart }), null);
  assert.equal(mergeIntent([comments[3]], { head, windowStart }), null);
  assert.equal(mergeIntent([comment('@workflow stop')], { head, windowStart }), null);
});

test('an explicit authorized merge intent is the pass decision when no verdict exists', () => {
  const merge = evaluateFeedback({ head, windowStart, comments: [comment('@workflow merge')], mergePolicy: 'comment' });
  assert.equal(merge.verdict, 'pass');
  assert.equal(merge.mergeSatisfied, true);
  const override = evaluateFeedback({
    head, windowStart, mergePolicy: 'comment',
    mergeIntentOverride: { id: 9, actor: 'maintainer', at: recent, head },
  });
  assert.equal(override.verdict, 'pass');
  // Label/auto policies still require their own gate; a comment cannot replace it.
  assert.equal(evaluateFeedback({ head, windowStart, comments: [comment('@workflow merge')], mergePolicy: 'label' }).verdict, null);
  assert.equal(evaluateFeedback({ head, windowStart, comments: [comment('@workflow merge')], mergePolicy: 'label' }).mergeSatisfied, false);
});

test('merge policies gate the merge intent without hiding blocking feedback', () => {
  const pass = [comment('[verdict=pass]')];
  assert.equal(evaluateFeedback({ head, windowStart, comments: pass, mergePolicy: 'comment' }).mergeSatisfied, false);
  assert.equal(evaluateFeedback({ head, windowStart, comments: [...pass, comment('@workflow merge', { id: 2 })], mergePolicy: 'comment' }).mergeSatisfied, true);
  assert.equal(evaluateFeedback({ head, windowStart, comments: pass, mergePolicy: 'auto' }).mergeSatisfied, true);
  assert.equal(evaluateFeedback({ head, windowStart, comments: pass, mergePolicy: 'label', labels: [] }).mergeSatisfied, false);
  assert.equal(evaluateFeedback({ head, windowStart, comments: pass, mergePolicy: 'label', labels: ['workflow:merge'] }).mergeSatisfied, true);
  assert.equal(evaluateFeedback({ head, windowStart, comments: [...pass, comment('[verdict=revise]', { id: 2 })], mergePolicy: 'auto' }).mergeSatisfied, false);
  assert.equal(evaluateFeedback({ head, windowStart, comments: [...pass, comment('[verdict=revise]', { id: 2 })], mergePolicy: 'label', labels: ['workflow:merge'] }).mergeSatisfied, false);
});
