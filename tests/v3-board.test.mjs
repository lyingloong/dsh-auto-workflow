import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../src/board.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const SECRET = 'private-board-secret';
const PREFIX = '/plugins/dsh-auto-workflow';

function element() {
  const classes = new Set();
  return {
    innerHTML: '', textContent: '', disabled: false, checked: false, hidden: false,
    style: {}, dataset: {}, listeners: new Map(), notes: [], clientWidth: 1000, clientHeight: 600,
    classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) },
    addEventListener(type, listener) { this.listeners.set(type, listener); },
    querySelector(selector) {
      if (selector === '.graph-tools') return this.tools ?? null;
      if (selector === 'svg' && this.innerHTML.includes('<svg')) return this.svg ??= { style: {} };
      return null;
    },
    querySelectorAll(selector) { return selector === '[data-note]' ? this.notes : []; },
    append(child) { this.tools = child; },
    scrollIntoView() {},
    getBoundingClientRect() { return { width: 1000, height: 600, left: 0, top: 0 }; },
    setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture() { return false; },
  };
}

function board(fetcher = async () => ({ ok: true, json: async () => ({}) })) {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  get('graph').tools = element();
  const document = { getElementById: get, activeElement: null, hidden: false, querySelectorAll: () => get('humanTodo').notes };
  const calls = [];
  const context = vm.createContext({
    document, location: { pathname: `${PREFIX}/board`, search: `?session=session-a&token=${SECRET}` },
    window: { addEventListener() {} }, URLSearchParams, URL, structuredClone,
    setTimeout: () => 1, clearTimeout() {}, setInterval() {}, console,
    fetch: async (url, options) => { calls.push({ url: String(url), options }); return fetcher(url, options); },
  });
  // Expose the real page closure only inside this test. No production test hook or preview server.
  const startup = script.lastIndexOf('  if (!SESSION) {');
  assert.ok(startup > 0);
  const exports = `
    globalThis.boardTest = {
      setState: value => { state = value; }, getState: () => state,
      setSelected: value => { selected = value; },
      render, renderRun, renderGraph, renderHuman, renderHumanDetail, renderQueue, renderDetail,
      openHumanDetail, setGraphMode: value => { graphMode = value; renderGraph(); },
      nodeStat, modelDraft, renderModelPicker, reasoningOptions, selectNode,
      applyState, loadHistory, loadArtifact, saveNodeModels, decide, setControl, load, postJson, action,
      safeText, esc, fitView, zoomAt, getView: () => ({ ...view }),
      modelDrafts, noteDrafts, nodeHistory, artifacts,
    };
  })();`;
  vm.runInContext(script.slice(0, startup) + exports, context);
  return { api: context.boardTest, elements, get, calls, document };
}

function fixture() {
  return {
    defined: true,
    definition: { name: 'Generic pipeline', concurrency: 4, nodes: [
      { id: 'worker', title: 'Worker', type: 'agent', concurrency: 3, config: { models: [{ provider: 'p', model: 'a', reasoningEffort: 'deep' }] } },
      { id: 'human', title: 'Decision', type: 'human', config: { outcomes: ['approve', 'reject'] } },
      { id: 'other', title: 'Other packet', type: 'command', config: { command: 'node task.mjs' } },
    ], edges: [{ from: 'worker', to: 'human', on: 'complete' }] },
    permissions: { command: { mode: 'deny' }, http: { mode: 'deny' } },
    control: { continuous: true, nodes: {} },
    models: { providers: [{ id: 'p', name: 'Provider', models: [
      { id: 'a', name: 'Model A', reasoningEfforts: [{ id: 'brief', label: 'Brief' }, { id: 'deep', label: 'Deep' }] },
      { id: 'b', name: 'Model B', reasoningEfforts: [] }, { id: 'c', name: 'Model C' },
    ] }] },
    run: {
      version: 3, runId: 'run-a', cwd: 'C:/bound/repository', status: 'running', updatedAt: '2026-11-05T12:00:00Z',
      execution: { active: true, jobId: 'native-job-7' },
      counts: { active: 2, running: 2, queued: 4, waiting: 1, completed: 37, failed: 2, interrupted: 1 },
      nodeStats: {
        worker: { status: 'running', active: 1, capacity: 3, queued: 4, waiting: 0 },
        human: { status: 'idle', active: 0, capacity: 1, queued: 0, waiting: 1 },
        other: { status: 'running', active: 1, capacity: 1, queued: 0, waiting: 0 },
      },
      packets: [{ id: 'packet-a', inputRef: 'original-a', lastRef: 'last-a', status: 'running' }],
      waiting: [{ tokenId: 'human-token', packetId: 'packet-a', nodeId: 'human', inputRef: 'input-human', outcomes: ['approve', 'reject'] }],
      tokens: [
        { id: 'worker-token', packetId: 'packet-a', nodeId: 'worker', status: 'running', inputRef: 'input-a', activity: { childId: 'child-9', message: 'Working' } },
        { id: 'human-token', packetId: 'packet-a', nodeId: 'human', status: 'waiting', inputRef: 'input-human' },
        { id: 'other-token', packetId: 'packet-b', nodeId: 'other', status: 'running', inputRef: 'input-b' },
      ],
    },
  };
}

function target(selector, properties = {}) {
  const result = { ...properties };
  result.closest = value => value === selector ? result : null;
  return result;
}

const json = value => ({ ok: true, json: async () => value });

test('board and client scripts compile and expose only the final package identity', () => {
  assert.doesNotThrow(() => new vm.Script(script));
  assert.doesNotThrow(() => new vm.Script(client));
  assert.match(html, /Human 节点待处理/);
  assert.match(html, /dsh-auto-workflow/);
  assert.match(html, /\/plugins\/dsh-auto-workflow\/api/);
  assert.doesNotMatch(html + client, /dsh-agent-team-workflow|dsh-durable-workflow|team_workflow_/);
  assert.doesNotMatch(html, /需求队列|seedsReady|state\.queue|run\?\.context|token\?\.input\b|token\?\.output\b|\/public\//);
  assert.match(html, /auto_workflow_define/);
  assert.match(html, /auto_workflow_start/);
});

test('node badges describe services and capacity, not the most recent completed or waiting token', () => {
  const { api, get } = board(), state = fixture();
  state.run.tokens.push({ id: 'old', nodeId: 'worker', status: 'completed' });
  api.setState(state); api.renderGraph();
  const markup = get('graph').innerHTML;
  assert.match(markup, /运行中 · 活跃 1\/3 · 排队 4 · 等待 0/);
  assert.match(markup, /等待 · 活跃 0\/1 · 排队 0 · 等待 1/);
  assert.doesNotMatch(markup, /已完成|node-box done|node-box wait(?![a-z])/);
  state.control.nodes.worker = false;
  api.renderGraph();
  assert.match(get('graph').innerHTML, /已关闭 · 活跃 1\/3/);
  assert.equal(api.nodeStat(state.definition.nodes[2]).status, 'running');
  state.run.nodeStats.worker.status = 'disabled';
  state.control.nodes.worker = true;
  assert.equal(api.nodeStat(state.definition.nodes[0]).status, 'running', 'an explicit enable is reflected before the next scheduler checkpoint');
});

test('run summary uses lifetime aggregates and displays immutable cwd, native job, and actionable errors', () => {
  const { api, get } = board(), state = fixture();
  state.run.tokens = [];
  state.run.error = 'invalid_command_cwd: missing package.json';
  api.setState(state); api.renderRun();
  assert.match(get('runSummary').innerHTML, /累计处理 37 · 失败 2 · 中断 1/);
  assert.match(get('runSummary').innerHTML, /C:\/bound\/repository/);
  assert.match(get('runSummary').innerHTML, /native-job-7/);
  assert.match(get('runSummary').innerHTML, /invalid_command_cwd/);
  assert.equal(get('runBtn').disabled, true);
  assert.equal(get('stopBtn').disabled, false);
  state.run.execution.active = false; api.renderRun();
  assert.equal(get('runBtn').disabled, false);
  state.run.status = 'interrupted'; api.renderRun();
  assert.equal(get('runBtn').disabled, true, 'uncertain interrupted work is not automatically replayed');
});

test('a mounted but idle native job remains stoppable and does not need redispatch', () => {
  const { api, get } = board(), state = fixture();
  state.run.execution = { active: false, mounted: true, jobId: 'idle-live' };
  state.run.status = 'waiting'; api.setState(state); api.renderRun();
  assert.equal(get('stopBtn').disabled, false);
  assert.equal(get('runBtn').disabled, true);
});

test('simplified graph mode hides only busy retry gates', () => {
  const { api, get } = board(), state = fixture();
  state.definition.nodes.push({ id: 'busy-human', type: 'gate', config: { delayMs: 1000 } });
  state.definition.edges.push({ from: 'human', to: 'busy-human', on: 'busy' }, { from: 'busy-human', to: 'human', on: 'complete' });
  api.setState(state);
  api.setGraphMode('simple');
  const markup = get('graph').innerHTML;
  assert.doesNotMatch(markup, /data-node="busy-human"/);
  assert.match(markup, /data-node="worker"/);
  assert.match(markup, /data-node="human"/);
  assert.match(html, /id="graphMode"[^>]*>简化</);
});

test('node queue renders every node as a status-colored square tile', () => {
  assert.match(html, /\.queue-grid \{[\s\S]*?grid-template-columns/);
  assert.match(html, /\.queue-grid \{[\s\S]*?max-height: clamp\(200px, 34vh, 390px\)[\s\S]*?overflow-y: auto/);
  assert.match(html, /id="queueList"[^>]*role="list"[^>]*aria-label="节点队列（方块）"/);
  assert.doesNotMatch(html, /queue-item|queue-list/);
  const { api, get } = board(), state = fixture();
  state.run.tokens.push({ id: 'bad-worker', nodeId: 'worker', status: 'failed' });
  api.setState(state); api.renderQueue();
  const markup = get('queueList').innerHTML;
  assert.equal((markup.match(/class="queue-tile /g) || []).length, 3);
  assert.match(markup, /queue-tile error/);
  assert.match(markup, /queue-tile waiting/);
  assert.match(markup, /data-select-node="other"/);
  assert.match(get('queueHint').textContent, /3 节点.*方块颜色=状态.*滚动/);
});

test('all nodes remain reachable as tiles without a sliding queue window', () => {
  const { api, get } = board(), state = fixture();
  state.definition.nodes = Array.from({ length: 51 }, (_, index) => ({ id: `node-${index}`, type: 'command', config: {} }));
  api.setState(state); api.renderQueue();
  const markup = get('queueList').innerHTML;
  assert.equal((markup.match(/class="queue-tile /g) || []).length, 51);
  assert.match(markup, /data-select-node="node-50"/);
  assert.match(get('queueHint').textContent, /51 节点/);
});

test('Human pending has a dedicated detail view with input and outcomes', async () => {
  const { api, get } = board(async () => ({ ok: true, json: async () => ({ value: { request: 'Approve this exact artifact?', commit: 'abc123' } }) }));
  api.setState(fixture()); api.renderHuman();
  assert.match(get('humanTodo').innerHTML, /data-human-detail="human-token"/);
  await api.openHumanDetail('human-token');
  assert.equal(get('humanDetailCard').classList.contains('hide'), false);
  assert.match(get('humanDetailBody').innerHTML, /Human 输入内容/);
  assert.match(get('humanDetailBody').innerHTML, /Approve this exact artifact/);
  assert.match(get('humanDetailBody').innerHTML, /input-human/);
  assert.match(get('humanDetailBody').innerHTML, /data-outcome="approve"/);
});

test('Human detail renders a structured brief before raw input', async () => {
  const brief = {
    kind: 'merge-brief',
    requirement: { id: 'req-brief', title: 'Fix the thing', description: 'Actual requirement', risk: 'mid', revision: 2 },
    change: { summary: 'Changed exactly one module', verification: 'npm test passed', commit: 'abc123' },
    review: { decision: 'pass', summary: 'No blocking findings', verification: 'reviewed diff', reviewer: 'reviewer-1' },
    risks: ['Edge case remains untested'],
    pr: { number: 7, url: 'https://example.invalid/pull/7' },
  };
  const { api, get } = board(async () => ({ ok: true, json: async () => ({ value: { brief } }) }));
  api.setState(fixture()); api.renderHuman();
  await api.openHumanDetail('human-token');
  const markup = get('humanDetailBody').innerHTML;
  assert.match(markup, /做了什么/);
  assert.match(markup, /审查结论/);
  assert.match(markup, /Edge case remains untested/);
  assert.match(markup, /查看原始输入/);
  assert.match(markup, /https:\/\/example.invalid\/pull\/7/);
});

test('generic queue remains per node and does not couple Human waits to unrelated packets', () => {
  const { api, get } = board(), state = fixture();
  api.setState(state); api.renderQueue(); api.renderHuman();
  assert.match(get('queueList').innerHTML, /Other packet/);
  assert.match(get('queueList').innerHTML, /活跃 1\/3/);
  assert.match(get('queueList').innerHTML, /排队 4/);
  assert.match(get('humanTodo').innerHTML, /packet-a/);
  assert.doesNotMatch(get('humanTodo').innerHTML, /整个工作流|工作流停在/);
  state.run.waiting = []; api.renderHuman();
  assert.match(get('humanTodo').innerHTML, /其他数据包仍可流转/);
});

test('reasoning dropdowns use only each candidate actual catalogue and preserve order', () => {
  const { api } = board(), state = fixture();
  state.run.execution.active = false;
  const node = state.definition.nodes[0];
  node.config.models.push({ provider: 'p', model: 'b' }, { provider: 'p', model: 'c' });
  api.setState(state);
  const markup = api.renderModelPicker(node);
  assert.ok(markup.indexOf('p / a') < markup.indexOf('p / b'));
  assert.equal((markup.match(/data-model-effort\b/g) || []).length, 3);
  const selectors = [...markup.matchAll(/<select[^>]*data-model-effort[^>]*>(.*?)<\/select>/g)].map(match => match[1]);
  assert.match(selectors[0], /value="brief"/);
  assert.match(selectors[0], /value="deep" selected/);
  assert.equal((selectors[1].match(/<option/g) || []).length, 1);
  assert.equal((selectors[2].match(/<option/g) || []).length, 1);
  assert.doesNotMatch(markup, /value="medium"|value="high"|value="low"/);
  assert.equal((markup.match(/type="checkbox"/g) || []).length, 3);
});

test('reasoning changes and checkbox order remain unsaved drafts across polling', () => {
  const { api, get } = board(), state = fixture();
  state.run.execution.active = false;
  api.setState(state); api.setSelected('worker');
  get('detailBody').listeners.get('change')({ target: target('[data-model-effort]', { dataset: { modelIndex: '0' }, value: 'brief' }) });
  const draft = api.modelDraft(state.definition.nodes[0]);
  assert.equal(draft.models[0].reasoningEffort, 'brief');
  assert.equal(draft.dirty, true);
  get('detailBody').listeners.get('change')({ target: target('[data-model-check]', { dataset: { provider: 'p', model: 'b' }, checked: true }) });
  const next = fixture(); next.definition.nodes[0].config.models = [];
  api.applyState(next);
  assert.equal(api.modelDraft(next.definition.nodes[0]), draft);
  assert.deepEqual(JSON.parse(JSON.stringify(draft.models)), [{ provider: 'p', model: 'a', reasoningEffort: 'brief' }, { provider: 'p', model: 'b' }]);
});

test('missing catalogue never invents reasoning choices or silently drops saved values', () => {
  const { api } = board(), state = fixture();
  state.models = { providers: [] }; state.run.execution.active = false;
  api.setState(state);
  const markup = api.renderModelPicker(state.definition.nodes[0]);
  assert.match(markup, /已保存 deep/);
  assert.match(markup, /data-model-action="default-effort"/);
  assert.equal((markup.match(/<option/g) || []).length, 1);
  assert.equal(api.modelDraft(state.definition.nodes[0]).models[0].reasoningEffort, 'deep');
});

test('active native execution locks all model editing and max eight selection is enforced', () => {
  const { api, get } = board(), state = fixture();
  api.setState(state); api.setSelected('worker');
  assert.match(api.renderModelPicker(state.definition.nodes[0]), /data-model-effort[^>]* disabled/);
  get('detailBody').listeners.get('change')({ target: target('[data-model-effort]', { dataset: { modelIndex: '0' }, value: 'brief' }) });
  assert.equal(api.modelDraft(state.definition.nodes[0]).models[0].reasoningEffort, 'deep');
  state.run.execution.active = false;
  const draft = api.modelDraft(state.definition.nodes[0]);
  draft.models = Array.from({ length: 8 }, (_, index) => ({ provider: 'p', model: String(index) }));
  const checkbox = target('[data-model-check]', { dataset: { provider: 'p', model: 'b' }, checked: true });
  get('detailBody').listeners.get('change')({ target: checkbox });
  assert.equal(draft.models.length, 8);
  assert.equal(checkbox.checked, false);
});

test('model saving sends ordered candidates and per-candidate reasoningEffort unchanged', async () => {
  const { api, calls } = board(async () => json(fixture())), state = fixture();
  state.run.execution.active = false; api.setState(state); api.setSelected('worker');
  const candidates = [{ provider: 'p', model: 'b' }, { provider: 'p', model: 'a', reasoningEffort: 'brief' }];
  await api.saveNodeModels(candidates);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url, 'http://loopback').pathname, `${PREFIX}/api/node-model`);
  assert.deepEqual(JSON.parse(calls[0].options.body), { session: 'session-a', nodeId: 'worker', models: candidates });
});

test('selecting a node renders only refs and metadata; history and artifact payloads are lazy', async () => {
  const { api, get, calls } = board(async url => String(url).includes('/history?')
    ? json({ items: [{ id: 'archived', nodeId: 'worker', packetId: 'packet-c', status: 'completed', inputRef: 'old-in', outputRef: 'old-out' }] })
    : json({ ref: 'old-out', value: { answer: '<img src=x onerror=alert(1)>' }, bytes: 50, truncated: false }));
  api.setState(fixture()); api.selectNode('worker', false);
  assert.equal(calls.length, 0);
  assert.match(get('detailBody').innerHTML, /data-ref="input-a"/);
  assert.match(get('detailBody').innerHTML, /data-ref="original-a"/);
  assert.doesNotMatch(get('detailBody').innerHTML, /运行上下文|answer|dataRef/);
  await api.loadHistory('worker');
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url, 'http://loopback').searchParams.get('limit'), '30');
  assert.match(get('detailBody').innerHTML, /data-ref="old-out"/);
  await api.loadArtifact('old-out');
  assert.equal(calls.length, 2);
  assert.match(get('detailBody').innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(get('detailBody').innerHTML, /<img/);
  await api.loadArtifact('old-out');
  assert.equal(calls.length, 2, 'previously requested ref is reused rather than eagerly reloaded');
  assert.ok(calls.every(call => new URL(call.url, 'http://loopback').searchParams.get('token') === SECRET));
});

test('artifact cache is bounded and scope changes discard prior run refs', async () => {
  const { api } = board(async url => json({ ref: new URL(url, 'http://loopback').searchParams.get('ref'), value: { small: true }, bytes: 14, truncated: false }));
  api.setState(fixture()); api.setSelected('worker');
  for (let index = 0; index < 15; index += 1) await api.loadArtifact(`ref-${index}`);
  assert.equal(api.artifacts.size, 12);
  const next = fixture(); next.run.runId = 'run-b'; api.applyState(next);
  assert.equal(api.artifacts.size, 0);
  assert.equal(api.nodeHistory.size, 0);
});

test('human notes survive refresh and failed decision without an extra run request', async () => {
  const { api, get, calls } = board(async () => ({ ok: false, status: 409, json: async () => ({ error: { message: `Busy token=${SECRET}` } }) }));
  const state = fixture(); api.setState(state);
  get('humanTodo').notes = [{ dataset: { note: 'human-token' }, value: 'Please revise <script>', selectionStart: 2, selectionEnd: 4 }];
  api.renderHuman(); api.applyState(fixture()); api.renderHuman();
  assert.match(get('humanTodo').innerHTML, /Please revise &lt;script&gt;/);
  await api.decide('human-token', 'reject');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/decide\?/);
  assert.deepEqual(JSON.parse(calls[0].options.body).output, { note: 'Please revise <script>' });
  assert.equal(api.noteDrafts.get('human-token'), 'Please revise <script>');
  assert.doesNotMatch(get('toast').textContent, new RegExp(SECRET));
});

test('successful decisions and independent node control never explicitly redispatch the whole run', async () => {
  const { api, calls } = board(async () => json(fixture()));
  api.setState(fixture());
  await api.decide('human-token', 'approve');
  await api.setControl({ nodeId: 'worker', enabled: false });
  await api.setControl({ continuous: false });
  assert.deepEqual(calls.map(call => new URL(call.url, 'http://loopback').pathname), [`${PREFIX}/api/decide`, `${PREFIX}/api/control`, `${PREFIX}/api/control`]);
  assert.deepEqual(JSON.parse(calls[1].options.body), { session: 'session-a', nodeId: 'worker', enabled: false });
  assert.deepEqual(JSON.parse(calls[2].options.body), { session: 'session-a', continuous: false });
});

test('slow refresh cannot overwrite a later mutation or its unsaved draft', async () => {
  let resolveState;
  const stale = fixture(); stale.definition.name = 'stale';
  const current = fixture(); current.definition.name = 'current';
  const { api } = board(async url => String(url).includes('/state?')
    ? new Promise(resolve => { resolveState = resolve; }) : json(current));
  api.setState(current);
  const draft = api.modelDraft(current.definition.nodes[0]); draft.dirty = true;
  const polling = api.load();
  await api.setControl({ continuous: false });
  resolveState(json(stale)); await polling;
  assert.equal(api.getState().definition.name, 'current');
  assert.equal(api.modelDraft(current.definition.nodes[0]), draft);
});

test('all displayed metadata, errors, catalogue labels and ref payloads are escaped and bearer-redacted', () => {
  const { api, get } = board(), state = fixture();
  state.definition.nodes[0].title = '<script>alert(1)</script>';
  state.run.error = `http://localhost/api?token=${SECRET}&x=1 Bearer abc123 <img onerror=evil>`;
  state.models.providers[0].models[0].reasoningEfforts[0].label = '<img onerror=evil>';
  api.setState(state); api.setSelected('worker'); api.render();
  const markup = get('graph').innerHTML + get('runSummary').innerHTML + get('detailBody').innerHTML;
  assert.doesNotMatch(markup, /<script>|<img|Bearer abc123/);
  assert.doesNotMatch(markup, new RegExp(SECRET));
  assert.match(markup, /&lt;script&gt;/);
  assert.match(markup, /\[redacted\]/);
});

test('a failed initial API load stays visible and the manual refresh action can recover', async () => {
  let fail = true;
  const { api, get, calls } = board(async url => {
    if (fail) throw new Error(`offline ${SECRET} <script>`);
    return json(String(url).includes('/models?') ? fixture().models : fixture());
  });
  await api.load();
  assert.match(get('graph').innerHTML, /无法读取工作流/);
  assert.doesNotMatch(get('graph').innerHTML, new RegExp(SECRET));
  assert.doesNotMatch(get('graph').innerHTML, /<script>/);
  fail = false;
  await api.action('refresh');
  assert.equal(api.getState().defined, true);
  assert.equal(calls.length, 3);
  assert.match(get('graph').innerHTML, /<svg/);
});

test('graph pan and pointer-centered zoom remain available after empty state', () => {
  const { api, get } = board();
  api.setState({ defined: false }); api.render();
  api.setState(fixture()); api.render();
  assert.ok(get('graph').tools);
  for (const event of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'wheel', 'keydown']) assert.ok(get('graph').listeners.has(event));
  api.fitView('one'); const before = api.getView(); api.zoomAt(1.2, 100, 100);
  const after = api.getView(); assert.equal(after.scale, 1.2);
  assert.equal(after.tx, 100 - (100 - before.tx) * 1.2);
  const graph = get('graph');
  graph.listeners.get('pointerdown')({ button: 0, clientX: 20, clientY: 30, target: { closest: () => null } });
  graph.listeners.get('pointermove')({ clientX: 40, clientY: 60, pointerId: 1 });
  assert.equal(api.getView().tx, after.tx + 20);
  graph.listeners.get('pointerup')({ pointerId: 1 });
});

function clientFace(fetcher, warn = () => {}) {
  let entry;
  const assignments = [], opened = [], registrations = [];
  const context = {
    window: { __ModuleLoader__: { load: value => { entry = value; } }, location: { assign: value => assignments.push(value) } },
    fetch: fetcher, URL, console: { warn },
  };
  vm.runInNewContext(client, context);
  const face = entry.factory(name => { assert.equal(name, 'react'); return { createElement: (type, props, label) => ({ type, props, label }) }; });
  face.apply({
    effect: callback => callback(),
    sidebarRightTabs: { get: type => type === 'browser' ? { type } : undefined },
    get: name => name === 'sidebarRight' ? { openTab: (...args) => opened.push(args) } : undefined,
    slots: { inject: (_name, callback) => callback(), register: (definition, component) => registrations.push({ definition, component }) },
  });
  return { entry, face, assignments, opened, registrations };
}

test('one 工作流 header button obtains a private URL then opens the native Browser', async () => {
  const requests = [];
  const url = `http://127.0.0.1:43210${PREFIX}/board?session=s&token=${SECRET}`;
  const { entry, registrations, opened, assignments } = clientFace(async target => { requests.push(target); return json({ url }); });
  assert.equal(entry.id, 'dsh-auto-workflow');
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].definition.name, 'conversation.session.header.actions');
  assert.equal(registrations[0].definition.id, 'auto-workflow-open');
  const button = registrations[0].component({ sessionId: 's&x=1' });
  assert.equal(button.label, '工作流');
  const currentTarget = { disabled: false };
  await button.props.onClick({ currentTarget });
  assert.equal(requests[0], `${PREFIX}/api/board-url?session=s%26x%3D1`);
  assert.equal(opened.length, 1);
  assert.equal(opened[0][0], 'browser');
  assert.equal(opened[0][1].params.url, url);
  assert.equal(assignments.length, 0);
  assert.equal(currentTarget.disabled, false);
});

test('native entry refuses non-loopback/incorrect-root URLs and never logs secret-bearing errors', async () => {
  for (const url of ['javascript:alert(1)', `http://example.com${PREFIX}/board`, 'http://127.0.0.1:1/plugins/old/board']) {
    const warnings = [];
    const { registrations, opened, assignments } = clientFace(async () => json({ url }), (...args) => warnings.push(args));
    await registrations[0].component({ sessionId: 's' }).props.onClick({ currentTarget: {} });
    assert.equal(opened.length + assignments.length, 0);
    assert.ok(warnings.length);
  }
  const warnings = [];
  const { registrations } = clientFace(async () => { throw new Error(`Bearer ${SECRET}`); }, (...args) => warnings.push(args));
  await registrations[0].component({ sessionId: 's' }).props.onClick({ currentTarget: {} });
  assert.doesNotMatch(JSON.stringify(warnings), new RegExp(SECRET));
});
