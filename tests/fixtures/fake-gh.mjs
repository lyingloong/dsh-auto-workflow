// Test-only gh replacement. It deliberately simulates an external merge when
// `pr ready` is called so the graph can exercise the full PR lifecycle offline.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const statePath = process.env.DSH_FAKE_PR_STATE;
const cwd = process.cwd();
const empty = () => ({ next: 1, prs: [], issues: [], labels: [], nextIssue: 1, nextComment: 1 });
const read = () => existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : empty();
const write = value => writeFileSync(statePath, JSON.stringify(value));
const valueAfter = flag => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; };
const valuesAfter = flag => args.reduce((out, value, index) => value === flag && index + 1 < args.length ? [...out, args[index + 1]] : out, []);
const bodyOf = () => {
  const file = valueAfter('--body-file');
  if (file) return readFileSync(file, 'utf8');
  return valueAfter('--body') ?? '';
};
const issueByNumber = (state, number) => state.issues.find(issue => issue.number === Number(number)) ?? null;
/** Test-only failure injection: { match, remaining, stderr } in the state file. */
function injectFailure() {
  if (!statePath || !existsSync(statePath)) return;
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const spec = state.fail;
  if (!spec) return;
  if (!args.join(' ').startsWith(spec.match ?? '')) return;
  if ((spec.remaining ?? 1) <= 0) return;
  spec.remaining = (spec.remaining ?? 1) - 1;
  if (spec.remaining <= 0) delete state.fail;
  writeFileSync(statePath, JSON.stringify(state));
  process.stderr.write(spec.stderr ?? 'HTTP 503 Service Unavailable');
  process.exit(1);
}
injectFailure();
const find = (state, reference) => {
  if (/^\d+$/.test(String(reference))) return state.prs.find(pr => pr.number === Number(reference)) ?? null;
  const match = String(reference).match(/\/pull\/(\d+)/);
  if (match) return state.prs.find(pr => pr.number === Number(match[1])) ?? null;
  return state.prs.find(pr => pr.branch === reference) ?? null;
};
const publicPr = pr => ({
  number: pr.number, url: pr.url, state: pr.state, isDraft: pr.isDraft,
  headRefOid: pr.headRefOid, mergeCommit: pr.mergeCommit ?? null, mergedAt: pr.mergedAt ?? null,
  closed: pr.state === 'CLOSED', reviewDecision: pr.reviewDecision ?? null,
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
if (args[0] === 'label' && args[1] === 'create') {
  const state = read();
  const name = args[2];
  state.labels = state.labels ?? [];
  if (!state.labels.includes(name)) state.labels.push(name);
  write(state);
  process.stdout.write(name);
  process.exit(0);
}
if (args[0] === 'api' && /\/labels\/[^/]+$/.test(args[1] ?? '')) {
  const state = read();
  const name = decodeURIComponent(String(args[1]).split('/').at(-1));
  if (!(state.labels ?? []).includes(name)) fail(`label not found: ${name}`);
  process.stdout.write(JSON.stringify({ name }));
  process.exit(0);
}
if (args[0] === 'api' && /\/issues\/\d+\/comments(\?.*)?$/.test(args[1] ?? '')) {
  const state = read();
  const number = Number(String(args[1]).match(/\/issues\/(\d+)\/comments/)[1]);
  // PR conversation comments share the issues endpoint; prefer the managed PR
  // when it exists, otherwise the requirement issue.
  const pr = state.prs.find(entry => entry.number === number);
  if (pr) {
    process.stdout.write(JSON.stringify(pr.comments ?? []));
    process.exit(0);
  }
  const issue = issueByNumber(state, number);
  if (!issue) fail('no fake issue');
  process.stdout.write(JSON.stringify(issue.comments ?? []));
  process.exit(0);
}
if (args[0] === 'api' && /\/pulls\/\d+\/reviews(\?.*)?$/.test(args[1] ?? '')) {
  const state = read();
  const number = Number(String(args[1]).match(/\/pulls\/(\d+)\/reviews/)[1]);
  const pr = state.prs.find(entry => entry.number === number);
  if (!pr) fail('no fake PR');
  process.stdout.write(JSON.stringify(pr.reviews ?? []));
  process.exit(0);
}
if (args[0] === 'api' && /\/collaborators\/[^/]+\/permission(\?.*)?$/.test(args[1] ?? '')) {
  const state = read();
  const login = decodeURIComponent(String(args[1]).match(/\/collaborators\/([^/]+)\/permission/)[1]);
  process.stdout.write(JSON.stringify({ permission: state.permissions?.[login] ?? 'write' }));
  process.exit(0);
}
if (args[0] === 'api' && /\/protection$/.test(args[1] ?? '')) {
  // Repositories that rely on a manual merge gate have no branch protection.
  if (process.env.DSH_FAKE_NO_PROTECTION === '1') fail('Branch not protected');
  process.stdout.write(JSON.stringify({ required_conversation_resolution: { enabled: true }, required_status_checks: { contexts: ['test'] } }));
  process.exit(0);
}
if (args[0] === 'api' && /repos\/example\/repo$/.test(args[1] ?? '')) {
  process.stdout.write(JSON.stringify({ full_name: 'example/repo', allow_merge_commit: true, allow_squash_merge: false, allow_rebase_merge: false }));
  process.exit(0);
}
if (args[0] === 'issue') {
  const state = read();
  const command = args[1];
  if (command === 'create') {
    const issue = {
      number: state.nextIssue, url: `https://example.invalid/issues/${state.nextIssue}`,
      title: valueAfter('--title') ?? '', body: bodyOf(), state: 'OPEN',
      labels: valuesAfter('--label'), comments: [],
    };
    state.nextIssue++; state.issues.push(issue); write(state);
    process.stdout.write(issue.url);
  } else if (command === 'view') {
    const issue = issueByNumber(state, args[2]);
    if (!issue) fail('no fake issue');
    process.stdout.write(JSON.stringify({ number: issue.number, url: issue.url, title: issue.title, body: issue.body, state: issue.state, labels: issue.labels.map(name => ({ name })) }));
  } else if (command === 'edit') {
    const issue = issueByNumber(state, args[2]);
    if (!issue) fail('no fake issue');
    if (valueAfter('--title') !== null) issue.title = valueAfter('--title');
    if (args.includes('--body-file') || args.includes('--body')) issue.body = bodyOf();
    issue.labels = issue.labels ?? [];
    for (const label of valuesAfter('--add-label')) if (!issue.labels.includes(label)) issue.labels.push(label);
    for (const label of valuesAfter('--remove-label')) issue.labels = issue.labels.filter(value => value !== label);
    write(state);
  } else if (command === 'close' || command === 'reopen') {
    const issue = issueByNumber(state, args[2]);
    if (!issue) fail('no fake issue');
    issue.state = command === 'close' ? 'CLOSED' : 'OPEN';
    write(state);
  } else if (command === 'comment') {
    const issue = issueByNumber(state, args[2]);
    if (!issue) fail('no fake issue');
    issue.comments = issue.comments ?? [];
    issue.comments.push({ id: state.nextComment, body: bodyOf(), user: { login: 'fake-workflow' }, author_association: 'OWNER', created_at: new Date().toISOString() });
    state.nextComment++; write(state);
  } else {
    fail(`unsupported issue command: ${args.join(' ')}`);
  }
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
  // Simulate a lost merge response: the merge landed, but the next read fails.
  const after = read();
  if (after.mergeThenFailView) {
    after.fail = { match: 'pr view', remaining: 1, stderr: 'HTTP 503 Service Unavailable' };
    after.mergeThenFailView = false;
    write(after);
  }
} else if (command === 'reopen') {
  const pr = find(state, args[2]);
  if (!pr) fail('no fake PR');
  pr.state = 'OPEN'; pr.closed = false; write(state);
} else {
  fail(`unsupported PR command: ${command}`);
}
