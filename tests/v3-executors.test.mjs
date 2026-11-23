import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createExecutors, parseCommandResult } from '../src/executors.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aw-executors-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function executorsFor(directory, { subagents = null, settings = {} } = {}) {
  return createExecutors({
    ctx: { get: name => name === 'subagents' ? subagents : undefined },
    exec: { agent: { id: 'owner' }, signal: new AbortController().signal },
    settings,
    cwd: directory,
  });
}

const node = (config, id = 'node') => ({ id, type: 'command', config });

test('JSON command nodes exchange one JSON input and result through the documented protocol', async t => {
  const directory = await fixture(t);
  await writeFile(path.join(directory, 'echo.mjs'), `
    const input = JSON.parse(process.env.DSH_WORKFLOW_INPUT ?? 'null');
    console.log('diagnostic that must not be parsed');
    console.log(JSON.stringify({ outcome: 'ready', output: { received: input } }));
  `, 'utf8');
  const result = await executorsFor(directory).command({ node: node({ command: 'node echo.mjs', json: true }), input: { id: 'p1' } });
  assert.equal(result.outcome, 'ready');
  assert.deepEqual(result.output, { received: { id: 'p1' } });
});

test('a non-zero JSON command keeps its business outcome and exit evidence', async t => {
  const directory = await fixture(t);
  await writeFile(path.join(directory, 'fail.mjs'), `
    console.log(JSON.stringify({ outcome: 'fail', output: { error: { message: 'business rejection' }, code: 7 } }));
    process.exitCode = 1;
  `, 'utf8');
  const result = await executorsFor(directory).command({ node: node({ command: 'node fail.mjs', json: true }), input: {} });
  assert.equal(result.outcome, 'fail');
  assert.equal(result.output.error.message, 'business rejection');
});

test('malformed JSON command output is an execution error, not a business outcome', async t => {
  const directory = await fixture(t);
  await writeFile(path.join(directory, 'noise.mjs'), `console.log('not json');`, 'utf8');
  await assert.rejects(
    () => executorsFor(directory).command({ node: node({ command: 'node noise.mjs', json: true }), input: {} }),
    error => error.code === 'invalid_command_output',
  );
  assert.throws(() => parseCommandResult('{'), error => error.code === 'invalid_command_output');
  assert.throws(() => parseCommandResult('{"output":1}'), /outcome/);
});

test('plain command nodes still return raw stdout and status evidence', async t => {
  const directory = await fixture(t);
  const result = await executorsFor(directory).command({ node: node({ command: 'node -e "console.log(1)"' }), input: {} });
  assert.equal(result.outcome, 'complete');
  assert.equal(result.output.stdout.trim(), '1');
});

function agentHarness({ calls, results, capabilities = { outputSchema: true } }) {
  return {
    getProvider(name) {
      return { name, capabilities };
    },
    async startActivation(spec) {
      calls.push({ options: spec.agentOptions ?? null, label: spec.label, outputSchema: spec.outputSchema ?? null });
      const next = results.shift();
      if (!next) throw new Error('unexpected activation');
      if (next.reject) return { childId: `child-${calls.length}`, result: Promise.reject(new Error(next.reject)), dispose: async () => {} };
      const result = {
        stopReason: 'completed',
        output: [{ type: 'text', text: next.text ?? JSON.stringify({ outcome: next.outcome ?? 'complete', output: next.output ?? {} }) }],
      };
      if (next.structured !== undefined) result.structured = next.structured;
      return {
        childId: `child-${calls.length}`,
        result: Promise.resolve(result),
        dispose: async () => {},
      };
    },
  };
}

test('ordered model candidates fall back only on call errors and keep per-candidate reasoning effort', async t => {
  const directory = await fixture(t);
  const calls = [];
  const subagents = agentHarness({ calls, results: [{ reject: 'provider unavailable' }, { outcome: 'complete', output: { ok: true } }] });
  const executors = executorsFor(directory, { subagents, settings: { subagentProvider: 'spawn' } });
  const result = await executors.agent({
    node: {
      id: 'engineer', type: 'agent', role: 'engineer',
      config: { outcomes: ['complete'], models: [{ provider: 'p', model: 'a', reasoningEffort: 'high' }, { provider: 'p', model: 'b' }] },
    },
    input: { id: 'r1' },
    context: { packetId: 'packet-1', results: {} },
    definition: { name: 'fallback', providers: [] },
    token: { id: 'token-1' },
  });
  assert.equal(result.outcome, 'complete');
  assert.deepEqual(result.model, { provider: 'p', model: 'b' });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].options, { provider: 'p', model: 'a', reasoningEffort: 'high' });
  assert.deepEqual(calls[1].options, { provider: 'p', model: 'b' });
});

test('a valid negative outcome is returned once and never triggers model fallback', async t => {
  const directory = await fixture(t);
  const calls = [];
  const subagents = agentHarness({ calls, results: [{ outcome: 'needs_revision', output: { summary: 'fix it' } }] });
  const executors = executorsFor(directory, { subagents });
  const result = await executors.agent({
    node: { id: 'reviewer', type: 'agent', config: { outcomes: ['pass', 'needs_revision'], models: [{ provider: 'p', model: 'a' }, { provider: 'p', model: 'b' }] } },
    input: {},
    context: {},
    definition: { name: 'review', providers: [] },
    token: { id: 'token-1' },
  });
  assert.equal(result.outcome, 'needs_revision');
  assert.equal(calls.length, 1);
});

test('a hung model call is not cut by any default deadline', async t => {
  const directory = await fixture(t);
  const calls = [];
  const subagents = {
    async startActivation() {
      calls.push(Date.now());
      return {
        childId: 'slow-child',
        result: new Promise(resolve => setTimeout(() => resolve({
          stopReason: 'completed',
          output: [{ type: 'text', text: JSON.stringify({ outcome: 'complete', output: { slow: true } }) }],
        }), 120)),
        dispose: async () => {},
      };
    },
  };
  const result = await executorsFor(directory, { subagents, settings: { agentTimeoutMs: 0 } }).agent({
    node: { id: 'slow', type: 'agent', config: { outcomes: ['complete'] } },
    input: {}, context: {}, definition: { name: 'slow', providers: [] }, token: { id: 'token-slow' },
  });
  assert.equal(result.outcome, 'complete');
  assert.equal(calls.length, 1);
});

test('agent nodes request the host structured-output contract and prefer its captured value', async t => {
  const directory = await fixture(t);
  const calls = [];
  const subagents = agentHarness({ calls, results: [{ structured: { outcome: 'pass', output: { summary: 'looks good' } }, text: 'prose that would not parse' }] });
  const result = await executorsFor(directory, { subagents }).agent({
    node: { id: 'reviewer', type: 'agent', config: { outcomes: ['pass', 'needs_revision'] } },
    input: {}, context: {}, definition: { name: 'review', providers: [] }, token: { id: 'token-1' },
  });
  assert.equal(result.outcome, 'pass');
  assert.deepEqual(result.output, { summary: 'looks good' });
  assert.deepEqual(calls[0].outputSchema, {
    type: 'object',
    properties: { outcome: { type: 'string', enum: ['pass', 'needs_revision'] }, output: {} },
    required: ['outcome'],
    additionalProperties: true,
  });
});

test('a provider without structured-output capability keeps the text JSON contract', async t => {
  const directory = await fixture(t);
  const calls = [];
  const subagents = agentHarness({ calls, results: [{ outcome: 'complete', output: { ok: true } }], capabilities: { outputSchema: false } });
  const result = await executorsFor(directory, { subagents }).agent({
    node: { id: 'engineer', type: 'agent', config: { outcomes: ['complete'] } },
    input: {}, context: {}, definition: { name: 'work', providers: [] }, token: { id: 'token-1' },
  });
  assert.equal(calls[0].outputSchema, null);
  assert.equal(result.outcome, 'complete');
});

test('a structured result with an unknown outcome is rejected without model fallback', async t => {
  const directory = await fixture(t);
  const calls = [];
  const subagents = agentHarness({ calls, results: [{ structured: { outcome: 'weird' } }, { outcome: 'complete' }] });
  await assert.rejects(
    () => executorsFor(directory, { subagents }).agent({
      node: { id: 'reviewer', type: 'agent', config: { outcomes: ['complete'], models: [{ provider: 'p', model: 'a' }, { provider: 'p', model: 'b' }] } },
      input: {}, context: {}, definition: { name: 'review', providers: [] }, token: { id: 'token-1' },
    }),
    error => error.code === 'invalid_agent_output' && /unknown outcome/.test(error.message),
  );
  assert.equal(calls.length, 1);
});

test('prose-only agent output records a bounded final-text excerpt', async t => {
  const directory = await fixture(t);
  const calls = [];
  const subagents = agentHarness({ calls, results: [{ text: 'I reviewed the change and it looks fine to me.' }] });
  await assert.rejects(
    () => executorsFor(directory, { subagents }).agent({
      node: { id: 'reviewer', type: 'agent', config: { outcomes: ['pass', 'needs_revision'] } },
      input: {}, context: {}, definition: { name: 'review', providers: [] }, token: { id: 'token-1' },
    }),
    error => error.code === 'invalid_agent_output' && /final text: I reviewed the change/.test(error.message),
  );
  assert.equal(calls.length, 1);
});