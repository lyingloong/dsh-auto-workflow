/**
 * Host wire shape for `ctx.subagents.startActivation`.
 *
 * DSH 0.2.2-rc.2 moved the task fields of `SubagentActivationSpec` to the top
 * level (`prompt`, `parent`, `cwd`, `agentOptions`) and removed the nested
 * `request` object. Published `@deepseek-ai/dsh-subagent` packages confirm the
 * boundary: 0.2.1-rc.5 and 0.2.2-rc.1 read `spec.request.*`, 0.2.2-rc.2 and
 * later read `spec.*`. The installed host is 0.2.2-rc.5, so it reads `spec`.
 * Sending the old nested shape leaves `spec.parent` undefined and fails inside
 * `startActivation` with `Cannot read properties of undefined (reading 'id')`
 * (issue #23).
 *
 * `node --test` cannot mount the real service, so this file pins the wire shape
 * with a stub that reads the spec exactly as the host does. The other suite
 * fakes only assert the fields they happen to use; this file also guards the
 * declared DSH floor so a nested-API host is never claimed again.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';

import { createExecutors } from '../src/executors.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aw-host-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// Mirrors the installed host service: the first thing it reads from the spec is
// `parent.id`, so a nested `request` payload fails before anything else runs.
function hostSubagents(specs) {
  return {
    async startActivation(spec) {
      const parentId = spec.parent.id;
      if (!Array.isArray(spec.prompt) || spec.prompt.length === 0) {
        throw new TypeError('SubagentActivationSpec.prompt must be a non-empty ContentBlock array');
      }
      specs.push({ ...spec, parentId });
      return {
        childId: `child-${specs.length}`,
        result: Promise.resolve({
          stopReason: 'completed',
          output: [{ type: 'text', text: JSON.stringify({ outcome: 'complete', output: { ok: true } }) }],
        }),
        dispose: async () => {},
      };
    },
  };
}

function agentNode(config) {
  return { id: 'engineer', type: 'agent', role: 'engineer', config: { outcomes: ['complete'], ...config } };
}

function agentInput() {
  return {
    node: agentNode({}),
    input: { id: 'r1' },
    context: { packetId: 'packet-1', results: {} },
    definition: { name: 'host-contract', providers: [] },
    token: { id: 'token-1' },
  };
}

test('agent nodes send the top-level activation spec the installed host reads', async t => {
  const directory = await fixture(t);
  await mkdir(path.join(directory, 'nested', 'dir'), { recursive: true });
  const specs = [];
  const exec = { agent: { id: 'owner' }, signal: new AbortController().signal };
  const executors = createExecutors({
    ctx: { get: name => name === 'subagents' ? hostSubagents(specs) : undefined },
    exec,
    cwd: directory,
  });
  const result = await executors.agent({
    ...agentInput(),
    node: agentNode({ cwd: 'nested/dir', models: [{ provider: 'p', model: 'm', reasoningEffort: 'high' }] }),
  });

  assert.equal(result.outcome, 'complete');
  assert.equal(specs.length, 1);
  const [spec] = specs;
  // The exact live parent object, not a re-created id holder.
  assert.equal(spec.parent, exec.agent);
  assert.equal(spec.parentId, 'owner');
  assert.deepEqual(spec.prompt.map(block => block.type), ['text']);
  assert.match(spec.prompt[0].text, /You are executing node "engineer" of workflow "host-contract"\./);
  assert.equal(spec.cwd, path.join(directory, 'nested', 'dir'));
  assert.deepEqual(spec.agentOptions, { provider: 'p', model: 'm', reasoningEffort: 'high' });
  assert.equal(spec.provider, 'spawn');
  assert.equal(spec.label, 'workflow:engineer');
  assert.equal(spec.delivery, 'caller');
  assert.ok(spec.signal instanceof AbortSignal);
  // The removed nested object must not come back as a compatibility carrier.
  assert.equal('request' in spec, false);
});

test('an agent node without a configured model leaves agentOptions to the host', async t => {
  const directory = await fixture(t);
  const specs = [];
  const executors = createExecutors({
    ctx: { get: name => name === 'subagents' ? hostSubagents(specs) : undefined },
    exec: { agent: { id: 'owner' }, signal: new AbortController().signal },
    cwd: directory,
  });
  await executors.agent(agentInput());

  assert.equal(specs.length, 1);
  assert.equal('agentOptions' in specs[0], false);
  assert.equal(specs[0].cwd, directory);
});

test('the host stub rejects the removed nested request shape', async () => {
  const specs = [];
  const service = hostSubagents(specs);
  await assert.rejects(
    () => service.startActivation({
      provider: 'spawn',
      label: 'workflow:engineer',
      request: { prompt: [{ type: 'text', text: 'ignored' }], parent: { id: 'owner' }, cwd: '.' },
      signal: new AbortController().signal,
      delivery: 'caller',
    }),
    error => error instanceof TypeError && /reading 'id'/.test(error.message),
  );
  assert.deepEqual(specs, []);
});

test('the declared DSH floor excludes hosts that read the nested request spec', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  // 0.2.1-rc.5 through 0.2.2-rc.1 call startActivation with spec.request; the
  // flat SubagentActivationSpec starts at 0.2.2-rc.2. A floor inside the nested
  // range would install this plugin on a host whose agent nodes then fail.
  assert.match(pkg.engines.dsh, /^>=/, 'engines.dsh must be a lower bound');
  assert.doesNotMatch(pkg.engines.dsh, /^>=(?:0\.2\.0|0\.2\.1-|0\.2\.2-rc\.1$)/,
    'engines.dsh must not admit DSH hosts that read the nested spec.request');
});
