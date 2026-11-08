// Test-only gh replacement. It deliberately simulates an external merge when
// `pr ready` is called so the graph can exercise the full PR lifecycle offline.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const statePath = process.env.DSH_FAKE_PR_STATE;
const cwd = process.cwd();
const empty = () => ({ next: 1, prs: [] });
const read = () => existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : empty();
const write = value => writeFileSync(statePath, JSON.stringify(value));
const valueAfter = flag => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; };
const find = (state, reference) => {
  if (/^\d+$/.test(String(reference))) return state.prs.find(pr => pr.number === Number(reference)) ?? null;
  const match = String(reference).match(/\/pull\/(\d+)/);
  if (match) return state.prs.find(pr => pr.number === Number(match[1])) ?? null;
  return state.prs.find(pr => pr.branch === reference) ?? null;
};
const publicPr = pr => ({
  number: pr.number, url: pr.url, state: pr.state, isDraft: pr.isDraft,
  headRefOid: pr.headRefOid, mergeCommit: pr.mergeCommit ?? null, mergedAt: pr.mergedAt ?? null,
  closed: pr.state === 'CLOSED', reviewDecision: null,
});
const fail = message => { process.stderr.write(message + '\n'); process.exit(1); };
if (args[0] !== 'pr') fail(`unsupported command: ${args.join(' ')}`);
const command = args[1];
const state = read();
if (command === 'list') {
  const branch = valueAfter('--head');
  process.stdout.write(JSON.stringify(state.prs.filter(pr => pr.branch === branch).slice(-1).map(publicPr)));
} else if (command === 'create') {
  const branch = valueAfter('--head');
  const headRefOid = execFileSync('git', ['-C', cwd, 'rev-parse', `refs/heads/${branch}`], { encoding: 'utf8' }).trim();
  const pr = { number: state.next, url: `https://example.invalid/pull/${state.next}`, state: 'OPEN', isDraft: true, headRefOid, branch, base: valueAfter('--base'), title: valueAfter('--title'), body: valueAfter('--body') };
  state.next++; state.prs.push(pr); write(state);
  process.stdout.write(pr.url);
} else if (command === 'view') {
  const pr = find(state, args[2]);
  if (!pr) fail('no fake PR');
  process.stdout.write(JSON.stringify(publicPr(pr)));
} else if (command === 'edit') {
  const pr = find(state, args[2]);
  if (!pr) fail('no fake PR');
  pr.title = valueAfter('--title') ?? pr.title;
  pr.body = valueAfter('--body') ?? pr.body;
  write(state);
} else if (command === 'ready') {
  const pr = find(state, args[2]);
  if (!pr) fail('no fake PR');
  if (pr.state === 'MERGED') process.exit(0);
  execFileSync('git', ['-C', cwd, 'merge', '--no-ff', `refs/heads/${pr.branch}`, '-m', 'External PR merge'], { encoding: 'utf8' });
  const mergeCommit = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', cwd, 'push', 'origin', pr.base], { encoding: 'utf8' });
  pr.state = 'MERGED'; pr.isDraft = false; pr.mergedAt = new Date().toISOString(); pr.mergeCommit = mergeCommit;
  write(state);
} else if (command === 'reopen') {
  const pr = find(state, args[2]);
  if (!pr) fail('no fake PR');
  pr.state = 'OPEN'; pr.closed = false; write(state);
} else {
  fail(`unsupported PR command: ${command}`);
}
