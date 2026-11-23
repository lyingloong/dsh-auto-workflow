import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { apply } from '../src/plugin.mjs';
import { fakeJobs } from './helpers/jobs.mjs';

const AGENT = {
  apiVersion: 2,
  name: 'pooled',
  entry: 'work',
  concurrency: 4,
  nodes: [
    { id: 'work', type: 'agent', concurrency: 3, config: { models: [{ provider: 'p', model: 'a', reasoningEffort: 'high' }], outcomes: ['ready', 'idle'] } },
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

/** Mirror the host's native tool-output validation so schema drift fails in tests. */
function validate(value, schema, path = '$') {
  if (schema.type === 'string') assert.equal(typeof value, 'string', `${path} must be a string`);
  else if (schema.type === 'boolean') assert.equal(typeof value, 'boolean', `${path} must be a boolean`);
  else if (schema.type === 'integer') assert.equal(Number.isInteger(value), true, `${path} must be an integer`);
  else if (schema.type === 'array') {
    assert.equal(Array.isArray(value), true, `${path} must be an array`);
    value.forEach((item, index) => validate(item, schema.items ?? {}, `${path}[${index}]`));
  } else if (schema.type === 'object') {
    assert.equal(value !== null && typeof value === 'object' && !Array.isArray(value), true, `${path} must be an object`);
    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) assert.ok(Object.hasOwn(properties, key), `${path}.${key} is not declared`);
    }
    for (const required of schema.required ?? []) assert.ok(Object.hasOwn(value, required), `${path}.${required} is required`);
    for (const [key, child] of Object.entries(properties)) {
      if (value[key] !== undefined) validate(value[key], child, `${path}.${key}`);
    }
  }
}
function assertToolOutput(tool, value) {
  validate(value, tool.output.schema, tool.name);
}

async function setup(t, { definition = AGENT, subagents = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aw-plugin-'));
  const repo = path.join(root, 'repo');
  await mkdir(repo);
  const jobs = fakeJobs();
  const tools = new Map();
  const sections = [];
  const agent = { id: 'session-a', session: { header: { cwd: repo } } };
  const harness = subagents ?? defaultSubagents();
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    systemPrompt: { section(section) { sections.push(section); } },
    effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); },
    on() {},
    get(name) {
      if (name === 'subagents') return harness.service;
      if (name === 'jobs') return jobs;
      if (name === 'agents') return { get: id => id === agent.id ? agent : undefined };
      if (name === 'workingDirectory') return { ensure: async () => repo };
      if (name === 'llm') return catalogue();
      return undefined;
    },
  };
  const cleanups = [];
  const mounted = apply(ctx, { dataDir: path.join(root, '.data'), boardPort: 0 });
  const exec = { agent, signal: new AbortController().signal };
  const call = (name, args = {}) => tools.get(name).execute(args, exec);
  const define = () => call('auto_workflow_define', { definition });
  const defined = await define();
  t.after(async () => {
    await mounted.runner.dispose();
    for (const cleanup of cleanups.reverse()) { try { await cleanup(); } catch { /* already closed */ } }
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  });
  return { root, repo, jobs, tools, sections, agent, exec, mounted, call, define, defined, harness, ctx };
}

function defaultSubagents() {
  const service = {
    calls: [],
    async startActivation(spec) {
      service.calls.push(spec);
      return {
        childId: `child-${service.calls.length}`,
        result: Promise.resolve({
          stopReason: 'completed',
          output: [{ type: 'text', text: JSON.stringify({ outcome: 'ready', output: { seen: spec.prompt?.[0]?.text?.length ?? 0 } }) }],
        }),
        dispose: async () => {},
      };
    },
  };
  return { service };
}

function catalogue() {
  return {
    async listProviders() { return [{ id: 'p', name: 'Provider P' }]; },
    async listModels() { return [{ id: 'a', name: 'Model A' }, { id: 'b', name: 'Model B' }]; },
    async resolveModelInfo(_provider, model) {
      return { provider: 'p', id: model, name: model, reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } };
    },
  };
}

test('registers the final tool surface and one usage section, with no legacy names', async t => {
  const { tools, sections, defined } = await setup(t);
  assertToolOutput(tools.get('auto_workflow_define'), defined);
  assert.deepEqual([...tools.keys()].sort(), [
    'auto_workflow_control',
    'auto_workflow_decide',
    'auto_workflow_define',
    'auto_workflow_enqueue',
    'auto_workflow_run',
    'auto_workflow_start',
    'auto_workflow_status',
  ]);
  assert.equal(sections.length, 1);
  assert.match(sections[0].text, /auto_workflow_enqueue/);
  assert.match(sections[0].text, /DSH_WORKFLOW_INPUT/);
  assert.doesNotMatch(sections[0].text, /team_workflow_|dsh-agent-team-workflow/);
});

test('a persistent run accepts packets while one already waits for Human decisions', async t => {
  const { call, mounted, tools } = await setup(t);
  const started = await call('auto_workflow_start', { input: { id: 'p0' } });
  assert.equal(started.status, 'running');
  assertToolOutput(tools.get('auto_workflow_start'), started);
  const run = await call('auto_workflow_run', {});
  assert.equal(run.status, 'running');
  assert.ok(run.jobId);
  assertToolOutput(tools.get('auto_workflow_run'), run);
  const enqueued = await call('auto_workflow_enqueue', { input: { id: 'p1' } });
  assertToolOutput(tools.get('auto_workflow_enqueue'), enqueued);
  await call('auto_workflow_enqueue', { input: { id: 'p2' } });
  await until(async () => {
    const status = await call('auto_workflow_status', {});
    return status.run.counts.waiting === 3;
  }, 'three independent Human waits');
  const status = await call('auto_workflow_status', {});
  assertToolOutput(tools.get('auto_workflow_status'), status);
  assert.equal(status.run.counts.running, 0);
  assert.equal(status.run.counts.queued, 0);
  assert.equal(status.nodes.find(node => node.id === 'approve').waiting, 3);
  assert.equal(status.nodes.find(node => node.id === 'work').status, 'idle');
  assert.equal(status.nodes.find(node => node.id === 'approve').status, 'idle');
  assert.equal(mounted.runner.active.has('session-a'), true);

  const first = status.waiting[0];
  const decided = await call('auto_workflow_decide', { tokenId: first.tokenId, outcome: 'approve', output: { note: 'one item only' } });
  assertToolOutput(tools.get('auto_workflow_decide'), decided);
  await until(async () => (await call('auto_workflow_status', {})).run.counts.waiting === 2, 'one decision only');
  const after = await call('auto_workflow_status', {});
  assert.equal(after.run.counts.packetsCompleted, 1);
  assert.equal(after.run.counts.waiting, 2);
});

test('idle-run model edits persist ordered candidates and per-candidate reasoning effort', async t => {
  const { call, mounted, root } = await setup(t);
  await call('auto_workflow_start', { input: { id: 'p0' } });
  await call('auto_workflow_run', {});
  await until(async () => (await call('auto_workflow_status', {})).run.counts.waiting === 1, 'human wait');
  await until(async () => (await call('auto_workflow_status', {})).run.execution.active === false, 'job parked');
  const models = [{ provider: 'p', model: 'b', reasoningEffort: 'low' }, { provider: 'p', model: 'a' }];
  const result = await mounted.runner.updateModels('session-a', { nodeId: 'work', models });
  assert.deepEqual(result.state.definition.nodes[0].config.models, models);
  const savedDefinition = JSON.parse(await readFile(path.join(root, '.data', 'sessions', 'session-a', 'workflow.json'), 'utf8'));
  assert.deepEqual(savedDefinition.definition.nodes[0].config.models, models);
  const runDefinition = JSON.parse(await readFile(path.join(root, '.data', 'sessions', 'session-a', 'runs', result.state.runId, 'definition.json'), 'utf8'));
  assert.deepEqual(runDefinition.nodes[0].config.models, models);
});

test('model edits are rejected while packets execute', async t => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const service = {
    async startActivation() {
      return {
        childId: 'held-child',
        result: blocked.then(() => ({ stopReason: 'completed', output: [{ type: 'text', text: JSON.stringify({ outcome: 'ready', output: {} }) }] })),
        dispose: async () => {},
      };
    },
  };
  const { call, mounted } = await setup(t, { subagents: { service } });
  await call('auto_workflow_start', { input: { id: 'p0' } });
  await call('auto_workflow_run', {});
  await until(async () => (await call('auto_workflow_status', {})).run.counts.running === 1, 'running packet');
  await assert.rejects(
    () => mounted.runner.updateModels('session-a', { nodeId: 'work', models: [{ provider: 'p', model: 'b' }] }),
    error => error.code === 'run_active',
  );
  release();
  await until(async () => (await call('auto_workflow_status', {})).run.counts.waiting === 1, 'human wait after release');
});

test('one disabled node parks only its queue and an explicit enable wakes it', async t => {
  const { call, mounted, tools } = await setup(t);
  const switched = await call('auto_workflow_control', { nodeId: 'work', enabled: false });
  assertToolOutput(tools.get('auto_workflow_control'), switched);
  await call('auto_workflow_start', { input: { id: 'p0' } });
  await call('auto_workflow_control', { nodeId: 'work', enabled: false });
  await call('auto_workflow_enqueue', { input: { id: 'p1' } });
  await call('auto_workflow_enqueue', { input: { id: 'p2' } });
  await until(async () => {
    const status = await call('auto_workflow_status', {});
    return status.nodes.find(node => node.id === 'work').queued === 3 && status.nodes.find(node => node.id === 'work').status === 'disabled';
  }, 'queued at disabled node');
  // The cold start mounts the job, but the persisted switch still parks its queue.
  assert.equal(mounted.runner.active.has('session-a'), true);
  await call('auto_workflow_control', { nodeId: 'work', enabled: true });
  await until(async () => (await call('auto_workflow_status', {})).run.counts.waiting === 3, 'enabled work drains');
});

test('stop interrupts uncertain execution, keeps evidence, and a new run can start after inspection', async t => {
  const { call, mounted } = await setup(t);
  const started = await call('auto_workflow_start', { input: { id: 'p0' } });
  await call('auto_workflow_run', {});
  await until(async () => (await call('auto_workflow_status', {})).run.counts.waiting === 1, 'human wait');
  const stopped = await call('auto_workflow_control', { stop: true });
  assert.equal(stopped.requested, true);
  await until(() => mounted.runner.active.has('session-a') === false, 'job settled');
  const status = await call('auto_workflow_status', {});
  assert.equal(status.run.status, 'interrupted');
  await assert.rejects(() => mounted.runner.dispatch('session-a', started.runId, { agent: mounted.runner.agents.get('session-a').agent }), error => error.code === 'run_not_replayable');
  await sleep(5);
  const replacement = await call('auto_workflow_start', { input: { id: 'fresh' } });
  assert.notEqual(replacement.runId, started.runId);
  assert.equal(replacement.status, 'running');
});

test('control recover clears a stale pause on the live run and requires a mounted run', async t => {
  const definition = { apiVersion: 2, name: 'waiting', entry: 'wait', nodes: [{ id: 'wait', type: 'human', config: { outcomes: ['approve'] } }], edges: [] };
  const { call, mounted, tools } = await setup(t, { definition });
  await assert.rejects(() => call('auto_workflow_control', { recover: true }), /No live run/);
  await call('auto_workflow_start', { input: { id: 'p0' } });
  await call('auto_workflow_run', {});
  await until(async () => (await call('auto_workflow_status', {})).run.counts.waiting === 1, 'human wait');
  const entry = mounted.runner.active.get('session-a');
  assert.ok(entry, 'live entry');
  entry.state.pauseReason = 'nodes_disabled';
  entry.state.lastError = 'stale historical failure';
  const recovered = await call('auto_workflow_control', { recover: true });
  assertToolOutput(tools.get('auto_workflow_control'), recovered);
  assert.equal(recovered.requested, true);
  assert.equal(entry.state.pauseReason, null);
  assert.equal(entry.state.lastError, null);
});