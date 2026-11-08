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
const valuesAfter = flag => args.reduce((out, value, index) => value === flag && index + 1 < args.length ? [...out, args[index + 1]] : out, []);
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
  body: pr.body ?? '', statusCheckRollup: pr.checks ?? [], labels: pr.labels ?? [],
  comments: pr.comments ?? [], reviews: pr.reviews ?? [],
});
const mergePr = pr => {
  execFileSync('git', ['-C', cwd, 'merge', '--no-ff', `refs/heads/${pr.branch}`, '-m', 'External PR merge'], { encoding: 'utf8' });
  const mergeCommit = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', cwd, 'push', 'origin', pr.base], { encoding: 'utf8' });
  pr.state = 'MERGED'; pr.isDraft = false; pr.mergedAt = new Date().toISOString(); pr.mergeCommit = mergeCommit;
  write(state);
};
const fail = message => { process.stderr.write(message + '\n'); process.exit(1); };
if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write('Logged in to github.com as fake-test\n');
  process.exit(0);
}
if (args[0] === 'repo' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({ nameWithOwner: 'example/repo' }));
  process.exit(0);
}
if (args[0] === 'api' && args[1] === 'graphql') {
  const numberIndex = args.findIndex(value => value === '-F' || value === '-f');
  const numberArg = args.find(value => value.startsWith('number='));
  const number = Number(String(numberArg ?? valueAfter('-F')).split('=').at(-1));
  const state = read();
  const pr = find(state, number);
  const nodes = (pr?.threads ?? []).map(thread => ({ isResolved: Boolean(thread.isResolved) }));
  process.stdout.write(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes } } } } }));
  process.exit(0);
}
if (args[0] === 'label') {
  process.stdout.write('');
  process.exit(0);
}
if (args[0] === 'api' && /\/labels\/workflow%3Amerge-ready$/.test(args[1] ?? '')) {
  process.stdout.write(JSON.stringify({ name: 'workflow:merge-ready' }));
  process.exit(0);
}
if (args[0] === 'api' && /\/protection$/.test(args[1] ?? '')) {
  process.stdout.write(JSON.stringify({ required_conversation_resolution: { enabled: true }, required_status_checks: { contexts: ['test'] } }));
  process.exit(0);
}
if (args[0] === 'api' && /repos\/example\/repo$/.test(args[1] ?? '')) {
  process.stdout.write(JSON.stringify({ full_name: 'example/repo', allow_merge_commit: true, allow_squash_merge: false, allow_rebase_merge: false }));
  process.exit(0);
}
if (args[0] !== 'pr') fail(`unsupported command: ${args.join(' ')}`);
const command = args[1];
const state = read();
if (command === 'list') {
  const branch = valueAfter('--head');
  process.stdout.write(JSON.stringify(state.prs.filter(pr => pr.branch === branch).slice(-1).map(publicPr)));
} else if (command === 'create') {
  const branch = valueAfter('--head');
  const headRefOid = execFileSync('git', ['-C', cwd, 'rev-parse', `refs/heads/${branch}`], { encoding: 'utf8' }).trim();
  const pr = { number: state.next, url: `https://example.invalid/pull/${state.next}`, state: 'OPEN', isDraft: true, headRefOid, branch, base: valueAfter('--base'), title: valueAfter('--title'), body: valueAfter('--body'), labels: [], checks: [], threads: [] };
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
  pr.labels = pr.labels ?? [];
  for (const label of valuesAfter('--add-label')) if (!pr.labels.includes(label)) pr.labels.push(label);
  for (const label of valuesAfter('--remove-label')) pr.labels = pr.labels.filter(value => value !== label);
  write(state);
} else if (command === 'ready') {
  const pr = find(state, args[2]);
  if (!pr) fail('no fake PR');
  pr.isDraft = false;
  write(state);
  if (process.env.DSH_FAKE_READY_MERGES !== '0') mergePr(pr);
} else if (command === 'merge') {
  const pr = find(state, args[2]);
  if (!pr) fail('no fake PR');
  if (pr.state !== 'MERGED') mergePr(pr);
} else if (command === 'reopen') {
  const pr = find(state, args[2]);
  if (!pr) fail('no fake PR');
  pr.state = 'OPEN'; pr.closed = false; write(state);
} else {
  fail(`unsupported PR command: ${command}`);
}
