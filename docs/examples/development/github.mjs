/** Shared GitHub CLI access for the development example. `DSH_GH_BIN` and
 * `DSH_GH_SCRIPT` let the test suite substitute a disposable fake `gh`.
 *
 * Transient failures are classified, not guessed: command nodes that poll (the
 * PR watcher and merge gate) can persist a bounded backoff instead of failing a
 * packet, while auth/scope/validation/merge-state errors stay terminal. */
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const execute = promisify(execFile);

export class GitHubError extends Error {
  constructor(message, { args = [], stderr = '', exitCode = null } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.args = [...args];
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

export const GITHUB_RETRY_LIMIT = 6;

const TRANSIENT = [
  /\bHTTP 5\d\d\b/,
  /\bHTTP 429\b/,
  /\bHTTP 408\b/,
  /rate limit/i,
  /secondary rate limit/i,
  /abuse detection/i,
  /connection (?:reset|refused|closed|aborted)/i,
  /\bdial tcp\b/i,
  /\bconnectex\b/i,
  /\bwsarecv\b/i,
  /i\/o timeout/i,
  /timed? out/i,
  /TLS handshake timeout/i,
  /unexpected EOF/i,
  /\bEOF\b/,
  /net\/http: request canceled/i,
  /no such host/i,
  /temporary failure in name resolution/i,
];

const PERMANENT = [
  /\bHTTP 401\b/,
  /\bHTTP 403\b/,
  /\bHTTP 404\b/,
  /\bHTTP 422\b/,
  /missing (?:required )?scopes?/i,
  /workflow scope/i,
  /bad credentials/i,
  /\bnot found\b/i,
  /validation failed/i,
  /merge conflict/i,
  /protected branch/i,
  /required status check/i,
  /already merged/i,
  /pull request is closed/i,
];

/** Rate limits and network/5xx errors are retryable; everything else is explicit. */
export function classifyGitHubError(error) {
  const text = `${error?.stderr ?? ''} ${error?.message ?? error}`;
  if (/rate limit/i.test(text) || /\bHTTP (?:429|408)\b/.test(text)) return 'transient';
  if (PERMANENT.some(pattern => pattern.test(text))) return 'permanent';
  if (TRANSIENT.some(pattern => pattern.test(text))) return 'transient';
  return 'permanent';
}

/** Bounded exponential backoff with symmetric jitter. */
export function githubBackoff(failures, { baseMs = 30_000, maxMs = 15 * 60_000, jitter = 0.2, random = Math.random } = {}) {
  const raw = Math.min(maxMs, baseMs * 2 ** Math.max(0, Number(failures) - 1));
  const factor = 1 + (random() * 2 - 1) * jitter;
  return Math.max(1_000, Math.round(raw * factor));
}

export async function gh(cwd, ...args) {
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
    const stderr = String(error.stderr ?? error.message).slice(0, 1500);
    throw new GitHubError(`GitHub command failed: gh ${args.join(' ')}: ${stderr}`, {
      args,
      stderr,
      exitCode: typeof error.code === 'number' ? error.code : null,
    });
  }
}

export async function ghJson(cwd, args) {
  const output = await gh(cwd, ...args);
  try { return JSON.parse(output); }
  catch { throw new Error(`GitHub command returned non-JSON for gh ${args.join(' ')}`); }
}

export async function repoCoordinates(store) {
  const value = await ghJson(store.config.repoRoot, ['repo', 'view', '--json', 'nameWithOwner']);
  const [owner, name] = String(value.nameWithOwner ?? '').split('/');
  if (!owner || !name) throw new Error('Cannot resolve GitHub repository owner/name');
  return { owner, name };
}
