/** Install the disposable fake `gh` for one test and restore the environment
 * afterwards. The state file is shared by the fake PR and issue surfaces. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fakeGh = fileURLToPath(new URL('../fixtures/fake-gh.mjs', import.meta.url));
const keys = ['DSH_GH_BIN', 'DSH_GH_SCRIPT', 'DSH_FAKE_PR_STATE', 'DSH_FAKE_READY_MERGES', 'DSH_FAKE_NO_PROTECTION'];

export function useFakeGh(t, root, { readyMerges = true, noProtection = false } = {}) {
  const state = path.join(root, 'fake-pr-state.json');
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.DSH_GH_BIN = process.execPath;
  process.env.DSH_GH_SCRIPT = fakeGh;
  process.env.DSH_FAKE_PR_STATE = state;
  process.env.DSH_FAKE_READY_MERGES = readyMerges ? '1' : '0';
  if (noProtection) process.env.DSH_FAKE_NO_PROTECTION = '1';
  else delete process.env.DSH_FAKE_NO_PROTECTION;
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  return { state, fakeGh };
}
