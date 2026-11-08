import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { apply } from '../src/plugin.mjs';
import { ROUTE_PREFIX } from '../src/web-api.mjs';
import { fakeJobs } from './helpers/jobs.mjs';

const GRAPH = {
  apiVersion: 2,
  name: 'api board',
  entry: 'work',
  concurrency: 4,
  nodes: [
    { id: 'work', type: 'agent', concurrency: 2, config: { models: [{ provider: 'p', model: 'a', reasoningEffort: 'high' }], outcomes: ['ready', 'idle'] } },
    { id: 'approve', type: 'human', config: { outcomes: ['approve', 'reject'] } },
  ],
  edges: [{ from: 'work', to: 'approve', on: 'ready' }],
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label = 'condition') {
  for (let index = 0; index < 2000; index += 1) {
    if (await predicate()) return;
    await sleep(5);
  }
  assert.fail(`${label} did not become true`);
}

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aw-api-'));
  const repo = path.join(root, 'repo');
  await mkdir(repo);
  const jobs = fakeJobs();
  const tools = new Map();
  const agent = { id: 'session-api', session: { header: { cwd: repo } } };
  const subagents = {
    async startActivation() {
      return {
        childId: 'child-1',
        result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: JSON.stringify({ outcome: 'ready', output: { reached: 'human' } }) }] }),
        dispose: async () => {},
      };
    },
  };
  const registered = [];
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    systemPrompt: { section() {} },
    effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); },
    on() {},
    get(name) {
      if (name === 'subagents') return subagents;
      if (name === 'jobs') return jobs;
      if (name === 'agents') return { get: id => id === agent.id ? agent : undefined };
      if (name === 'workingDirectory') return { ensure: async () => repo };
      if (name === 'llm') {
        return {
          async listProviders() { return [{ id: 'p', name: 'Provider P' }]; },
          async listModels() { return [{ id: 'a', name: 'Model A' }, { id: 'b', name: 'Model B' }]; },
          async resolveModelInfo(_provider, model) {
            return { provider: 'p', id: model, name: model, reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } };
          },
        };
      }
      if (name === 'webServer') return { register(route) { registered.push(route); }, getOrigin() { return 'http://127.0.0.1:1'; } };
      return undefined;
    },
  };
  const cleanups = [];
  const mounted = apply(ctx, { dataDir: path.join(root, '.data'), boardPort: 0 });
  const exec = { agent, signal: new AbortController().signal };
  const call = (name, args = {}) => tools.get(name).execute(args, exec);
  await call('auto_workflow_define', { definition: GRAPH });
  t.after(async () => {
    await mounted.runner.dispose();
    for (const cleanup of cleanups.reverse()) { try { await cleanup(); } catch { /* closed */ } }
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  });
  return { root, mounted, call, registered };
}

async function openBoard(t, mounted) {
  await until(() => mounted.webApi.boardUrl('session-api') !== null, 'board server ready');
  const board = new URL(mounted.webApi.boardUrl('session-api'));
  const token = board.searchParams.get('token');
  const session = board.searchParams.get('session');
  const api = origin => `${origin}${ROUTE_PREFIX}/api`;
  return { board, token, session, api: api(board.origin) };
}

test('the native board URL uses the exact private root and requires its token', async t => {
  const { mounted } = await setup(t);
  const { board, api } = await openBoard(t, mounted);
  assert.equal(board.pathname, `${ROUTE_PREFIX}/board`);
  assert.ok(['127.0.0.1', 'localhost'].includes(board.hostname));
  assert.ok(board.searchParams.get('session'));
  assert.ok(board.searchParams.get('token'));

  const page = await fetch(board);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /dsh-auto-workflow/);
  assert.match(html, /Human 节点待处理/);
  assert.doesNotMatch(html, /dsh-agent-team-workflow|team_workflow_|需求队列/);

  const denied = await fetch(`${api}/state?session=session-api`);
  assert.equal(denied.status, 401);
  const wrongRoot = await fetch(`${board.origin}/plugins/dsh-agent-team-workflow/board?session=session-api&token=${board.searchParams.get('token')}`);
  assert.equal(wrongRoot.status, 404);
});

test('state, catalog, model edits, decisions and lazy refs work over the private origin', async t => {
  const { mounted, call, registered } = await setup(t);
  const { api, token, session } = await openBoard(t, mounted);
  assert.ok(registered.some(route => route.path === `${ROUTE_PREFIX}/api/state`));

  await call('auto_workflow_start', { input: { id: 'packet-0' } });
  await call('auto_workflow_run', {});
  await call('auto_workflow_enqueue', { input: { id: 'packet-1' } });
  await until(async () => (await call('auto_workflow_status', {})).run.counts.waiting === 2, 'two humans');
  await until(async () => (await call('auto_workflow_status', {})).run.execution.active === false, 'parked');

  const state = await (await fetch(`${api}/state?session=${session}&token=${token}`)).json();
  assert.equal(state.defined, true);
  assert.equal(state.run.counts.waiting, 2);
  assert.equal(state.control.continuous, true);
  assert.equal(state.definition.nodes.length, 2);

  const models = await (await fetch(`${api}/models?session=${session}&token=${token}`)).json();
  assert.deepEqual(models.providers[0].models[0].reasoningEfforts, [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }]);

  const edited = await fetch(`${api}/node-model?token=${token}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session, nodeId: 'work', models: [{ provider: 'p', model: 'b', reasoningEffort: 'low' }] }),
  });
  const editedBody = await edited.json();
  assert.equal(edited.status, 200);
  assert.deepEqual(editedBody.definition.nodes[0].config.models, [{ provider: 'p', model: 'b', reasoningEffort: 'low' }]);
  assert.deepEqual(editedBody.models.providers[0].models[0].reasoningEfforts, [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }]);

  const runId = state.run.runId;
  const history = await (await fetch(`${api}/history?` + new URLSearchParams({ session, runId, nodeId: 'work', limit: '5', token }))).json();
  assert.ok(history.items.length >= 2);
  assert.ok(history.items.every(record => record.nodeId === 'work' && record.inputRef));

  const inputRef = state.run.packets[0].inputRef;
  const artifact = await (await fetch(`${api}/artifact?` + new URLSearchParams({ session, runId, ref: inputRef, token }))).json();
  assert.equal(artifact.ref, inputRef);
  assert.equal(artifact.truncated, false);
  assert.deepEqual(artifact.value, { id: 'packet-0' });

  const target = state.run.waiting[0];
  const decided = await fetch(`${api}/decide?token=${token}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session, runId, tokenId: target.tokenId, outcome: 'approve', output: { note: 'api decision' } }),
  });
  const decidedText = await decided.text();
  const afterDecision = JSON.parse(decidedText);
  assert.equal(decided.status, 200, decidedText);
  assert.equal(afterDecision.run.counts.waiting, 1);
  assert.equal(afterDecision.run.counts.packetsCompleted, 1);

  const control = await fetch(`${api}/control?token=${token}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session, nodeId: 'work', enabled: false }),
  });
  const controlled = await control.json();
  assert.equal(control.status, 200, JSON.stringify(controlled));
  assert.equal(controlled.control.nodes.work, false);
  assert.equal(controlled.run.nodeStats.work.status, 'disabled');

  const stopped = await fetch(`${api}/stop?token=${token}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session, runId }),
  });
  assert.equal(stopped.status, 202, await stopped.clone().text());
  await until(() => mounted.runner.active.has('session-api') === false, 'job stopped');
});

test('the safe no-run state still renders a defined graph and an empty board', async t => {
  const { mounted, call } = await setup(t);
  const { api, token, session } = await openBoard(t, mounted);
  const state = await (await fetch(`${api}/state?session=${session}&token=${token}`)).json();
  assert.equal(state.defined, true);
  assert.equal(state.run, null);
  assert.equal(state.definition.name, 'api board');
  const status = await call('auto_workflow_status', {});
  assert.equal(status.run.status, 'none');
  assert.equal(status.nodes.length, 2);
  assert.match(status.boardUrl, /\/plugins\/dsh-auto-workflow\/board\?/);
});
