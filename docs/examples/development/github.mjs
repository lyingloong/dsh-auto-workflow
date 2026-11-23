/** Shared GitHub CLI access for the development example. `DSH_GH_BIN` and
 * `DSH_GH_SCRIPT` let the test suite substitute a disposable fake `gh`. */
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const execute = promisify(execFile);

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
    throw new Error(`GitHub command failed: gh ${args.join(' ')}: ${String(error.stderr ?? error.message).slice(0, 1500)}`);
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
