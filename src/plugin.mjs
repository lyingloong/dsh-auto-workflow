/**
 * dsh-auto-workflow DSH adapter.
 *
 * This is the only host-facing entry point: it mounts agent, command and HTTP
 * executors, resolves provider lanes, exposes the persistent packet runtime as
 * model tools, and serves the board through a private loopback origin.
 */
import path from 'node:path';
import os from 'node:os';

import { DefinitionError, describeDefinition, normalizeDefinition } from './definition.mjs';
import { normalizePermissions } from './runtime.mjs';
import { SessionStore } from './store.mjs';
import { WorkflowRunner } from './runner.mjs';
import { publicRun } from './view.mjs';
import { installWebApi } from './web-api.mjs';

export const name = 'dsh-auto-workflow';
export const inject = ['tools', 'systemPrompt'];

const DEFAULT_CONFIG = {
  dataDir: null,
  subagentProvider: 'spawn',
  promptSectionOrder: 118,
  maxSteps: 40,
  maxFailures: 3,
  agentTimeoutMs: 0,
};

const USAGE = `dsh-auto-workflow is a persistent, concurrent node-graph workflow engine.

A workflow is nodes plus edges (apiVersion 2). One run stays mounted while packets move through it; new packets can arrive at any time. Node types:
- agent: a model subagent. Config: prompt?, lane?, provider?, model?, models?, reasoningEffort?, cwd?, timeoutMs?, maxFailures?, outcomes?. "models" is an ordered fallback list (max 8); the next candidate is used only when a provider/model call fails. Each candidate may set its own reasoningEffort from the model catalogue. There is NO default task deadline; timeoutMs/agentTimeoutMs is opt-in and 0 disables it.
- command: a shell command. Config: command, cwd?, timeoutMs?, json?. With json:true the resolved node input is passed as JSON in DSH_WORKFLOW_INPUT and the script must print exactly one {"outcome":"...","output":...} object; a non-zero exit still keeps that JSON business result.
- http: an HTTP request. Config: url, method?, headers?, body?, timeoutMs?. Requires an HTTP grant.
- human: waits for one decision per packet. Config: title?, outcomes? (default approve/reject). Other packets continue.
- fanout: one branch per item. Config: items, target, detached? or join. Detached branches keep running after the parent advances.
- join: aggregates joined branches (mode all|any|quorum, count?); its wait is internal, not a Human decision.
- gate: scheduling boundary. Config: delayMs only delays admission; it is not a task timeout.
- subworkflow: inline serial nested graph (no Human/fanout inside).

Inputs map values from "$input" (the packet's original payload), "$prev" (previous output), "$nodes.<id>.output" (same-packet result), "$packet.id", "$item", "$index". Node config cwd/url may use "$input.*" against the recorded, already-resolved node input (not the original packet). Omitted inputs inherit the previous envelope. Root and node concurrency cap parallel work; a node's concurrency is its worker pool size.

Permissions are NOT part of the graph. Before defining a graph with command/http nodes, ask the user whether to grant full or allowlist access, then pass it to auto_workflow_define:
  {"command":{"mode":"allowlist","allow":["node","pnpm"]},"http":{"mode":"allowlist","allow":["api.github.com"]}}
The default is deny; an ungranted node fails with permission_denied. Never widen a grant without the user's approval.

Tools:
- auto_workflow_define: validate and store the graph plus the user-approved permission grant.
- auto_workflow_start: bind an immutable repository cwd and initial input, preflight, and create one persistent run. It does not execute nodes.
- auto_workflow_run: mount/continue the session-owned native job. Returns immediately; use auto_workflow_status or the board, not polling.
- auto_workflow_enqueue: add a new independent packet (optionally at a specific node) to the live run and wake the scheduler. Use this for incoming work instead of restarting the workflow.
- auto_workflow_decide: resolve one waiting Human packet with a declared outcome and optional note.
- auto_workflow_control: pause/resume the whole scheduler, switch one node's queue on/off, or stop the native job. A paused/disabled node does not discard its queue.
- auto_workflow_status: read persisted state, per-node service status, pending Human items, and the board URL. Reading never executes or replays work.

Interrupted/failed executions are retained as evidence and are never replayed automatically. Inspect their side effects, then start a new run. A business negative outcome (fail/needs_revision) follows its declared edge; it is not model fallback.

The worked example of our development workflow (3 engineers, 3 reviewers, stable requirement ids, retained per-requirement worktrees, human approval) lives in docs/examples/development/.`;

export function apply(ctx, config = {}) {
  const settings = resolveSettings(config);
  const stores = new Map();
  const agents = new Map();
  const sessionIdOf = exec => {
    const id = exec?.agent?.id;
    return typeof id === 'string' && id !== '' ? id : 'local';
  };
  const remember = exec => agents.set(sessionIdOf(exec), { agent: exec.agent });
  const storeForSession = sessionId => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(sessionId)) throw new Error('invalid session id');
    if (!stores.has(sessionId)) {
      const root = settings.dataDir ?? defaultDataDir();
      stores.set(sessionId, new SessionStore(path.join(root, 'sessions', sessionId)));
    }
    return stores.get(sessionId);
  };
  const storeFor = exec => storeForSession(sessionIdOf(exec));
  const runner = new WorkflowRunner({ ctx, storeFor: storeForSession, agents, settings });
  ctx.effect?.(() => () => runner.dispose(), 'dsh-auto-workflow: execution owner');

  const mount = tool => register(ctx, {
    ...tool,
    async execute(args, exec) {
      remember(exec);
      return tool.execute(args, exec);
    },
  }, 'dsh-auto-workflow: ' + tool.name);

  const webApi = installWebApi({
    ctx,
    dataRoot: settings.dataDir ?? defaultDataDir(),
    storeFor: storeForSession,
    agents,
    settings,
    runner,
    logger: console,
  });

  mount(toolDefine({ storeFor, sessionIdOf, runner }));
  mount(toolStart({ runner, sessionIdOf }));
  mount(toolRun({ runner, sessionIdOf }));
  mount(toolEnqueue({ runner, sessionIdOf }));
  mount(toolDecide({ runner, sessionIdOf }));
  mount(toolControl({ runner, storeFor, sessionIdOf }));
  mount(toolStatus({ storeFor, ctx, boardUrl: webApi.boardUrl }));

  if (ctx.systemPrompt && typeof ctx.systemPrompt.section === 'function') {
    ctx.systemPrompt.section({ name: 'dsh-auto-workflow:usage', order: settings.promptSectionOrder, text: USAGE });
  }

  return { settings, runner, webApi };
}

function register(ctx, tool, label) {
  const mount = () => ctx.tools.register(tool);
  if (typeof ctx.effect === 'function') ctx.effect(mount, label);
  else mount();
}

function toolDefine({ storeFor, sessionIdOf, runner }) {
  return {
    name: 'auto_workflow_define',
    description: 'Validate and store an apiVersion:2 node-graph workflow definition for this session, together with the permission grant the user approved. Ask the user before granting command/http access; the default is deny.',
    parameters: objectSchema({
      definition: freeObject('Definition: apiVersion, name, entry, nodes, edges, optional concurrency/historyLimit/providers.'),
      permissions: freeObject('Permission grant for command/http nodes. Omit for deny.'),
    }, ['definition']),
    output: {
      schema: objectSchema({
        ok: booleanSchema(),
        name: stringSchema(),
        entry: stringSchema(),
        nodes: integerSchema(),
        edges: integerSchema(),
        summary: stringSchema(),
        permissions: freeObject('Stored permission grant.'),
        errors: arraySchema(objectSchema({ path: stringSchema(), message: stringSchema() }, ['path', 'message'])),
      }, ['ok']),
      render: (_args, value) => [{ type: 'text', text: renderDefine(value) }],
    },
    async execute(args, exec) {
      let raw = args?.definition;
      if (typeof raw === 'string') {
        try {
          raw = JSON.parse(raw);
        } catch (error) {
          return { ok: false, errors: [{ path: '$.definition', message: `invalid JSON: ${error.message}` }] };
        }
      }
      let definition;
      try {
        definition = normalizeDefinition(raw);
      } catch (error) {
        if (error instanceof DefinitionError) return { ok: false, errors: error.errors };
        throw error;
      }
      const permissions = normalizePermissions(args?.permissions);
      const store = storeFor(exec);
      await runner.locked(sessionIdOf(exec), () => store.saveDefinition({ definition, permissions }));
      return {
        ok: true,
        name: definition.name,
        entry: definition.entry ?? '',
        nodes: definition.nodes.length,
        edges: definition.edges.length,
        summary: describeDefinition(definition),
        permissions,
        errors: [],
      };
    },
  };
}

function toolStart({ runner, sessionIdOf }) {
  return {
    name: 'auto_workflow_start',
    description: 'Create one persistent run with an immutable repository directory and initial input. Preflight static targets before any model work; does not execute nodes. Use auto_workflow_run or auto_workflow_enqueue next.',
    parameters: objectSchema({
      input: freeObject('Initial run input; available to nodes as $input.'),
      cwd: stringSchema('Absolute target repository path. Omit only to bind the current effective DSH working directory.'),
    }, []),
    output: {
      schema: objectSchema({ runId: stringSchema(), status: stringSchema(), cwd: stringSchema(), capacity: integerSchema() }, ['runId', 'status', 'cwd']),
      render: (_args, value) => [{ type: 'text', text: `Created ${value.runId} (${value.status})\ncwd: ${value.cwd}\ncapacity: ${value.capacity ?? 4}` }],
    },
    async execute(args, exec) {
      const state = await runner.startRun(sessionIdOf(exec), { input: args?.input, cwd: args?.cwd, exec });
      return { runId: state.runId, status: state.status, cwd: state.cwd, capacity: state.definition.concurrency ?? 4 };
    },
  };
}

function toolRun({ runner, sessionIdOf }) {
  return {
    name: 'auto_workflow_run',
    description: 'Mount or continue the session-owned persistent workflow job and return immediately. The job stays alive while the graph is idle or waiting for Human decisions. Failed/interrupted work is not replayed. Follow progress with auto_workflow_status or the board; do not poll.',
    parameters: objectSchema({ runId: stringSchema('Optional run id; defaults to the latest run.') }, []),
    output: {
      schema: runOutputSchema(),
      render: (_args, value) => [{ type: 'text', text: renderRun(value) }],
    },
    async execute(args, exec) {
      return runView(await runner.dispatch(sessionIdOf(exec), args?.runId, exec));
    },
  };
}

function toolEnqueue({ runner, sessionIdOf }) {
  return {
    name: 'auto_workflow_enqueue',
    description: 'Add a new independent packet (optionally entering at one node) to the persistent run and wake the scheduler. This is the normal way to feed incoming work; it never restarts or replays existing packets. Cold-starts the native job when the session has none and control is enabled.',
    parameters: objectSchema({
      input: freeObject('Packet payload; available to nodes as $input.'),
      nodeId: stringSchema('Optional entry node for this packet; defaults to the graph entry.'),
      runId: stringSchema('Optional run id; defaults to the live or latest run.'),
    }, ['input']),
    output: {
      schema: runOutputSchema(),
      render: (_args, value) => [{ type: 'text', text: renderRun(value) }],
    },
    async execute(args, exec) {
      const state = await runner.enqueue(sessionIdOf(exec), {
        input: args?.input !== null && typeof args?.input === 'object' ? args.input : {},
        ...(typeof args?.nodeId === 'string' && args.nodeId.trim() !== '' ? { nodeId: args.nodeId.trim() } : {}),
        ...(typeof args?.runId === 'string' && args.runId !== '' ? { runId: args.runId } : {}),
        exec,
      });
      return runView(state);
    },
  };
}

function toolDecide({ runner, sessionIdOf }) {
  return {
    name: 'auto_workflow_decide',
    description: 'Resolve one waiting Human packet with one of its declared outcomes and optional output/note. Other packets keep flowing; this is not a run-wide resume.',
    parameters: objectSchema({
      tokenId: stringSchema(),
      outcome: stringSchema(),
      output: freeObject('Optional decision payload, for example {"note":"..."}.'),
      runId: stringSchema('Optional run id; defaults to the live or latest run.'),
    }, ['tokenId', 'outcome']),
    output: {
      schema: runOutputSchema(),
      render: (_args, value) => [{ type: 'text', text: `Decision recorded on ${value.runId}: ${value.status}\n${renderWaiting(value)}` }],
    },
    async execute(args, exec) {
      const state = await runner.decide(sessionIdOf(exec), {
        tokenId: requireText(args?.tokenId, 'tokenId'),
        outcome: requireText(args?.outcome, 'outcome'),
        output: args?.output ?? null,
        ...(typeof args?.runId === 'string' && args.runId !== '' ? { runId: args.runId } : {}),
        exec,
      });
      return runView(state);
    },
  };
}

function toolControl({ runner, storeFor, sessionIdOf }) {
  return {
    name: 'auto_workflow_control',
    description: 'Change persistent scheduler control: pause/resume all work with continuous, enable/disable one node queue with nodeId+enabled, or stop the native job with stop:true. Disabling a node keeps its queued packets; disabling never cancels active work. Stop interrupts uncertain execution and never replays it.',
    parameters: objectSchema({
      continuous: booleanSchema('false pauses new admissions and drains active nodes; true resumes.'),
      nodeId: stringSchema('Node whose queue switch to change.'),
      enabled: booleanSchema('Whether that node queue is enabled; defaults true when nodeId is present.'),
      stop: booleanSchema('Stop the session-owned native job.'),
    }, []),
    output: {
      schema: objectSchema({
        requested: booleanSchema(),
        jobId: stringSchema(),
        control: freeObject('Stored scheduler control.'),
        runId: stringSchema(),
        status: stringSchema(),
      }, ['requested', 'control']),
      render: (_args, value) => [{ type: 'text', text: `control: continuous=${value.control?.continuous !== false}${value.jobId ? `\njob: ${value.jobId}` : ''}${value.runId ? `\nrun: ${value.runId} (${value.status})` : ''}` }],
    },
    async execute(args, exec) {
      const session = sessionIdOf(exec);
      if (args?.stop === true) {
        const stopped = await runner.stop(session);
        return { requested: stopped.requested, jobId: stopped.jobId ?? '', control: await storeFor(exec).loadControl() };
      }
      const update = {};
      if (args?.continuous !== undefined) update.continuous = args.continuous;
      if (args?.nodeId !== undefined) {
        update.nodeId = requireText(args.nodeId, 'nodeId');
        update.enabled = args.enabled !== false;
      }
      if (Object.keys(update).length === 0) throw new Error('set continuous, nodeId/enabled, or stop:true');
      const result = await runner.control(session, update, { exec });
      return {
        requested: true,
        jobId: '',
        control: result.control,
        runId: result.state?.runId ?? '',
        status: result.state?.status ?? '',
      };
    },
  };
}

function toolStatus({ storeFor, ctx, boardUrl }) {
  return {
    name: 'auto_workflow_status',
    description: 'Inspect the persisted workflow: bound cwd, native job, live packet counts, per-node running/idle/disabled service status, pending Human items and the board URL. Reading status never executes or retries work.',
    parameters: objectSchema({ runId: stringSchema('Optional run id; defaults to the latest run.') }, []),
    output: {
      schema: objectSchema({
        defined: booleanSchema(),
        summary: stringSchema(),
        run: freeObject('Public run view, or {status:"none"}.'),
        control: freeObject('Scheduler control.'),
        waiting: arraySchema(objectSchema({
          tokenId: stringSchema(),
          packetId: stringSchema(),
          nodeId: stringSchema(),
          inputRef: stringSchema(),
          title: stringSchema(),
          outcomes: arraySchema(stringSchema()),
        }, ['tokenId', 'nodeId', 'title', 'outcomes'])),
        nodes: arraySchema(objectSchema({
          id: stringSchema(),
          type: stringSchema(),
          title: stringSchema(),
          status: stringSchema(),
          active: integerSchema(),
          queued: integerSchema(),
          waiting: integerSchema(),
          capacity: integerSchema(),
        }, ['id', 'type', 'status', 'capacity'])),
        boardUrl: stringSchema(),
        error: stringSchema(),
      }, ['defined', 'summary', 'run', 'control', 'waiting', 'nodes', 'boardUrl']),
      render: (_args, value) => [{ type: 'text', text: renderStatus(value) }],
    },
    async execute(args, exec) {
      const store = storeFor(exec);
      const stored = await store.loadDefinition();
      let state = null;
      try { state = args?.runId ? await store.loadRun(args.runId) : await store.latestRun(); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const control = await store.loadControl();
      const session = exec?.agent?.id ?? 'local';
      const origin = ctx.get?.('webServer')?.getOrigin?.() ?? '';
      const fallback = origin ? `${String(origin).replace(/\/$/, '')}/plugins/dsh-auto-workflow/board?session=${encodeURIComponent(session)}` : '';
      const url = (typeof boardUrl === 'function' ? boardUrl(session) : null) || fallback;
      const run = state ? publicRun(state) : { status: 'none' };
      // The frozen run graph wins while a run exists; the stored definition is
      // for the next run after the current one is stopped.
      const definition = state?.definition ?? stored?.definition ?? null;
      const nodes = definition ? definition.nodes.map(node => {
        const stats = run.nodeStats?.[node.id] ?? {};
        const disabled = control.nodes?.[node.id] === false;
        return {
          id: node.id,
          type: node.type,
          title: node.title ?? node.id,
          status: disabled ? 'disabled' : stats.status ?? 'idle',
          active: stats.active ?? 0,
          queued: stats.queued ?? 0,
          waiting: stats.waiting ?? 0,
          capacity: stats.capacity ?? node.concurrency ?? 1,
        };
      }) : [];
      return {
        defined: stored !== null,
        summary: definition ? describeDefinition(definition) : 'no workflow defined',
        run,
        control,
        waiting: run.waiting ?? [],
        nodes,
        boardUrl: url,
        error: run.error ?? '',
      };
    },
  };
}

function runOutputSchema() {
  return objectSchema({
    runId: stringSchema(),
    status: stringSchema(),
    cwd: stringSchema(),
    capacity: integerSchema(),
    jobId: stringSchema(),
    execution: freeObject('Session-owned native job lifecycle.'),
    current: freeObject('Most recent active packet/token metadata.'),
    counts: freeObject('Live packet counts plus lifetime totals.'),
    nodeStats: freeObject('Per-node service status, active/queued/waiting and capacity.'),
    waiting: arraySchema(objectSchema({
      tokenId: stringSchema(),
      packetId: stringSchema(),
      nodeId: stringSchema(),
      inputRef: stringSchema(),
      title: stringSchema(),
      outcomes: arraySchema(stringSchema()),
    }, ['tokenId', 'nodeId', 'title', 'outcomes'])),
    packets: arraySchema(freeObject('Packet metadata and refs.')),
    updatedAt: stringSchema(),
    pauseReason: stringSchema(),
    error: stringSchema(),
  }, ['runId', 'status', 'waiting', 'error']);
}

/** Project the public run view onto the tool output contract (no nullable extras). */
function runView(state) {
  const view = publicRun(state);
  return {
    runId: view.runId,
    status: view.status,
    cwd: view.cwd,
    capacity: view.capacity,
    jobId: view.jobId,
    execution: view.execution,
    current: view.current,
    counts: view.counts,
    nodeStats: view.nodeStats,
    waiting: view.waiting,
    packets: view.packets,
    updatedAt: view.updatedAt,
    pauseReason: view.pauseReason ?? '',
    error: view.error ?? '',
  };
}

function renderDefine(value) {
  if (!value.ok) return `Definition rejected:\n${(value.errors ?? []).map(error => `- ${error.path}: ${error.message}`).join('\n')}`;
  return `Defined "${value.name}" (${value.nodes} nodes, ${value.edges} edges).\n\n${value.summary}\npermissions: command=${value.permissions?.command?.mode ?? 'deny'}, http=${value.permissions?.http?.mode ?? 'deny'}`;
}

function renderRun(value) {
  const waiting = renderWaiting(value);
  const current = value.current?.nodeId ? `\nnode: ${value.current.nodeId} (${value.current.status})` : '';
  return `${value.error ? `Error: ${value.error}\n` : ''}${value.runId}: ${value.status}\ncwd: ${value.cwd || 'UNBOUND'}${value.jobId ? `\njob: ${value.jobId}` : ''}${current}\ncounts: running ${value.counts?.running ?? 0} · queued ${value.counts?.queued ?? 0} · waiting ${value.counts?.waiting ?? 0} · completed ${value.counts?.completed ?? 0}${waiting ? `\nHuman nodes pending:\n${waiting}` : ''}`;
}

function renderWaiting(value) {
  return (value.waiting ?? []).map(token => `- ${token.nodeId} (${token.title}): ${token.outcomes.join(', ')} [${token.tokenId}]`).join('\n');
}

function renderStatus(value) {
  const header = `${value.summary}\nrun: ${value.run?.runId ?? 'none'} · ${value.run?.status ?? 'none'}${value.run?.cwd ? `\ncwd: ${value.run.cwd}` : ''}${value.run?.jobId ? `\njob: ${value.run.jobId}` : ''}`;
  const nodes = value.nodes.map(node => `  ${node.id} [${node.type}] ${node.status} · ${node.active}/${node.capacity} · queued ${node.queued} · waiting ${node.waiting}`).join('\n');
  const waiting = value.waiting.length ? `\nHuman nodes pending:\n${renderWaiting(value)}` : '';
  return `${header}${nodes ? `\n${nodes}` : ''}${waiting}${value.boardUrl ? `\nboard: ${value.boardUrl}` : ''}`;
}

function resolveSettings(config) {
  return {
    dataDir: typeof config.dataDir === 'string' && config.dataDir.trim() !== '' ? path.resolve(config.dataDir) : null,
    subagentProvider: typeof config.subagentProvider === 'string' && config.subagentProvider !== '' ? config.subagentProvider : DEFAULT_CONFIG.subagentProvider,
    promptSectionOrder: Number.isInteger(config.promptSectionOrder) ? config.promptSectionOrder : DEFAULT_CONFIG.promptSectionOrder,
    maxSteps: Number.isInteger(config.maxSteps) && config.maxSteps > 0 ? config.maxSteps : DEFAULT_CONFIG.maxSteps,
    maxFailures: Number.isInteger(config.maxFailures) && config.maxFailures > 0 ? config.maxFailures : DEFAULT_CONFIG.maxFailures,
    agentTimeoutMs: Number.isFinite(config.agentTimeoutMs) && config.agentTimeoutMs > 0 ? config.agentTimeoutMs : DEFAULT_CONFIG.agentTimeoutMs,
    boardToken: typeof config.boardToken === 'string' && config.boardToken !== '' ? config.boardToken : null,
    boardPort: Number.isInteger(config.boardPort) && config.boardPort >= 0 && config.boardPort <= 65535 ? config.boardPort : 0,
  };
}

function defaultDataDir() {
  if (process.env.AUTO_WORKFLOW_DATA) return path.resolve(process.env.AUTO_WORKFLOW_DATA);
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'dsh-auto-workflow');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'dsh-auto-workflow');
  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'dsh-auto-workflow');
}

function requireText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function objectSchema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

function freeObject(description = 'Arbitrary JSON object.') {
  return { type: 'object', description, additionalProperties: true };
}

function arraySchema(items) {
  return { type: 'array', items };
}

function stringSchema(description) {
  return { type: 'string', ...(description ? { description } : {}) };
}

function integerSchema() {
  return { type: 'integer' };
}

function booleanSchema(description) {
  return { type: 'boolean', ...(description ? { description } : {}) };
}
