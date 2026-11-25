/** GitHub failure classification and bounded backoff for the example. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyGitHubError, githubBackoff, GitHubError } from '../docs/examples/development/github.mjs';

const error = (stderr, message = 'GitHub command failed') => new GitHubError(message, { stderr });

test('network errors, timeouts, 5xx and rate limits are transient', () => {
  for (const value of [
    'HTTP 503 Service Unavailable', 'HTTP 502 Bad Gateway', 'HTTP 504 Gateway Timeout',
    'HTTP 429 Too Many Requests', 'API rate limit exceeded', 'secondary rate limit',
    'dial tcp 140.82.112.3:443: connectex: A connection attempt failed',
    'wsarecv: An existing connection was forcibly closed', 'i/o timeout',
    'net/http: request canceled while waiting for connection', 'unexpected EOF',
  ]) assert.equal(classifyGitHubError(error(value)), 'transient', value);
});

test('auth, scope, 404, validation and merge-state errors are permanent', () => {
  for (const value of [
    'HTTP 401 Bad credentials', 'HTTP 403 forbidden: missing required scopes: workflow',
    'HTTP 404 Not Found', 'HTTP 422 Validation Failed', 'merge conflict',
    'protected branch hook declined', 'required status check is expected',
    'Pull request is already merged', 'Pull request is closed',
  ]) assert.equal(classifyGitHubError(error(value)), 'permanent', value);
  assert.equal(classifyGitHubError(new Error('something unexpected')), 'permanent');
  assert.equal(classifyGitHubError(new GitHubError('HTTP 403 rate limit exceeded', { stderr: '' })), 'transient');
});

test('backoff grows, stays bounded and adds jitter', () => {
  const noJitter = { jitter: 0 };
  assert.equal(githubBackoff(1, noJitter), 30_000);
  assert.equal(githubBackoff(2, noJitter), 60_000);
  assert.equal(githubBackoff(3, noJitter), 120_000);
  assert.equal(githubBackoff(99, noJitter), 15 * 60_000);
  const low = githubBackoff(2, { random: () => 0 });
  const high = githubBackoff(2, { random: () => 1 });
  assert.ok(low < 60_000 && high > 60_000);
  assert.ok(githubBackoff(1, { baseMs: 0 }) >= 1_000);
});
