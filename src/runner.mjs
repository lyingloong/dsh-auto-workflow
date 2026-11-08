/**
 * One persistent execution owner shared by model tools and both board transports.
 *
 * A run is a long-lived packet workflow: the native job stays mounted while the
 * graph is idle or waiting for a Human decision, and new packets can arrive at
 * any time. The job is only ended by an explicit stop, disposal, a fatal
 * persistence failure, or an execution whose owner disappeared.
 */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';

import { createExecutors } from './executors.mjs';
import { normalizeDefinition } from './definition.mjs';
import { RuntimeError, decide as decideToken, enqueue as enqueuePacket, newRunState, run } from './runtime.mjs';
import { summarizeRun } from './view.mjs';

function failure(code, message) {
  return Object.assign(new RuntimeError(code, message), { status: 409 });
}

function stamp() {
  return new Date().toISOString();
}

function hasWork(state) {
  return state.tokens.some(token => token.status === 'running' || token.status === 'ready');
}

function short(value) {
  return String(value ?? '').slice(0, 1000);
}

export async function executionCwd(ctx, exec, requested, bound) {
  let value = requested ?? bound;
  if (value !== undefined && value !== null) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) {
      throw failure('invalid_cwd', 'cwd must be an explicit absolute repository path');
    }
  } else {
    const service = ctx.get?.('workingDirectory');
    // header.cwd is the original directory, not the current committed one.
    if (service?.ensure) value = await service.ensure(exec.agent, exec.signal);
    else if (service?.get && exec?.agent?.session) value = service.get(exec.agent.session);
    else value = exec?.agent?.session?.header?.cwd;
  }
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw failure('cwd_required', 'No effective repository directory is available. Supply cwd when starting the run.');
  }
  const resolved = await realpath(value);
  if (!(await stat(resolved)).isDirectory()) throw failure('invalid_cwd', `Not a directory: ${value}`);
  return resolved;
}

/**
 * Validate static targets without invoking tools or changing any repository.
 * Values starting with "$" resolve per packet at execution time and are not
 * treated as static directories here.
 */
export async function preflightRun(state) {
  if (!state.cwd) throw failure('run_cwd_unbound', 'This run has no bound cwd. Preserve its history and start a new run with an explicit repository directory.');
  await executionCwd({}, {}, state.cwd);
  for (const node of state.definition.nodes) {
    if (!['agent', 'command'].includes(node.type)) continue;
    if (node.config.cwd?.startsWith('$')) continue;
    const cwd = node.config.cwd ? path.resolve(state.cwd, node.config.cwd) : state.cwd;
    if (!(await stat(cwd)).isDirectory()) throw failure('invalid_cwd', `${node.id}: directory unavailable: ${cwd}`);
    if (node.type === 'command' && typeof node.config.command === 'string') {
      await preflightCommand(node.id, node.config.command, cwd);
    }
  }
}

async function preflightCommand(nodeId, command, cwd) {
  const directNpmScript = /^\s*(?:npm(?:\.cmd|\.exe)?|["']npm(?:\.cmd|\.exe)?["'])\s+(?:test|t|run|run-script)(?:\s|$)/i.test(command);
  if (!directNpmScript || /(?:^|\s)--prefix(?:\s|=)/.test(command)) return;
  const file = path.join(cwd, 'package.json');
  let pkg;
  try {
    pkg = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw failure('invalid_command_cwd', `${nodeId}: ${command} cannot run in ${cwd}: ${file} is missing or invalid (${error.code ?? error.message}). Fix cwd/verification, not application code.`);
  }
  if (/^\s*npm(?:\.cmd)?\s+test(?:\s|$)/i.test(command) && !pkg.scripts?.test) {
    throw failure('invalid_verify_command', `${nodeId}: package.json in ${cwd} has no scripts.test. Configure the repository's actual verification command.`);
  }
}

function applyControl(state, control) {
  for (const node of state.definition.nodes) {
    const stats = state.nodeStats[node.id] ??= { capacity: node.concurrency ?? 1, active: 0, queued: 0, waiting: 0 };
    stats.capacity = node.concurrency ?? 1;
    if (control.nodes?.[node.id] === false) stats.status = 'disabled';
    else if (stats.status === 'disabled') stats.status = stats.active ? 'running' : 'idle';
  }
  if (control.continuous === false && !state.tokens.some(token => token.status === 'running')) {
    state.status = 'paused';
    state.pauseReason = 'control_off';
  } else if (control.continuous !== false && state.pauseReason === 'control_off') {
    state.pauseReason = null;
    state.status = state.tokens.some(token => token.status === 'running')
      ? 'running'
      : state.tokens.some(token => token.status === 'waiting') ? 'waiting' : 'idle';
  }
}

function applyModels(config, models) {
  const next = { ...config };
  delete next.provider;
  delete next.model;
  delete next.models;
  delete next.lane;
  delete next.reasoningEffort;
  if (Array.isArray(models) && models.length > 0) next.models = models;
  return next;
}

function interruptPending(state, reason) {
  for (const packet of Object.values(state.packets)) if (packet.status === 'active') packet.status = 'interrupted';
  for (const token of state.tokens) if (['ready','waiting'].includes(token.status)) {
    token.status = 'interrupted'; token.updatedAt = stamp();
    token.error = { code:'execution_stopped', message:reason };
    state.counts.interrupted += 1;
  }
  Object.assign(state.counts, { queued:0, waiting:0, packetsActive:0, interruptedActive:state.tokens.filter(t=>t.status==='interrupted').length });
}

function resumable(state) {
  if (['interrupted', 'failed'].includes(state.status)) throw failure('run_not_replayable', 'Inspect interrupted/failed evidence and start a new run; automatic replay is disabled.');
  if (state.tokens.some(token => ['ready','running','waiting'].includes(token.status) && (!token.results || typeof token.results !== 'object' || Array.isArray(token.results)))) {
    throw failure('unsupported_run_state', 'This older pending run has no causal input snapshots. Preserve its evidence, stop it, and start a new run; no migration is performed.');
  }
}


export class WorkflowRunner {
  constructor({ ctx, storeFor, agents = new Map(), settings = {}, logger = console }) {
    this.ctx = ctx;
    this.storeFor = storeFor;
    this.agents = agents;
    this.settings = settings;
    this.logger = logger;
    this.active = new Map();
    this.locks = new Map();
    this.closed = false;
  }

  async locked(session, operation) {
    const prior = this.locks.get(session) ?? Promise.resolve();
    let release;
    const next = new Promise(resolve => { release = resolve; });
    this.locks.set(session, next);
    await prior;
    try { return await operation(); }
    finally {
      release();
      if (this.locks.get(session) === next) this.locks.delete(session);
    }
  }

  /** Serialize schema/model/control edits; reject while packets are actually executing. */
  async mutate(session, operation) {
    return this.locked(session, async () => {
      if (this.closed) throw failure('runner_closed', 'Workflow runner is shutting down.');
      const entry = this.active.get(session);
      if (entry && hasWork(entry.state)) {
        throw failure('run_active', 'Packets are running or queued. Stop the job or wait for it to drain before changing its definition.');
      }
      return operation();
    });
  }

  async load(session, runId) {
    const store = this.storeFor(session);
    return runId ? store.loadRun(runId) : store.latestRun();
  }

  assertNoForeignOwner(session, state) {
    if (!state?.execution?.jobId || this.active.get(session)?.state === state) return;
    const jobs = this.ctx.get?.('jobs');
    if (!jobs?.list) throw failure('execution_owner_unknown', 'Cannot verify the persisted native owner.');
    const owner = jobs.list(session).find(job => job.id === state.execution.jobId);
    if (owner && !['completed','failed','killed'].includes(owner.status)) throw failure('run_active', 'A live native job owns this run; mutations must use its runner.');
  }

  async loadRequired(session, runId) {
    const state = await this.load(session, runId);
    if (!state) throw failure('no_run', 'No run exists; create one with a bound repository cwd.');
    return state;
  }

  parent(session, exec) {
    const registry = this.ctx.get?.('agents');
    const cached = exec?.agent ?? this.agents.get(session)?.agent;
    const agent = registry?.get ? registry.get(session) : cached;
    if (!agent || (exec?.agent && agent !== exec.agent)) {
      throw failure('no_session_agent', 'The owning Agent is no longer live. Reconnect from the assistant session before running.');
    }
    return agent;
  }

  async startRun(session, { input = {}, cwd, exec } = {}) {
    return this.locked(session, async () => {
      if (this.closed) throw failure('runner_closed', 'Workflow runner is shutting down.');
      if (this.active.get(session)) {
        throw failure('run_active', 'This session already owns a live workflow job. Stop it before starting another run.');
      }
      const store = this.storeFor(session);
      const stored = await store.loadDefinition();
      if (!stored) throw failure('no_workflow', 'No workflow is defined; call auto_workflow_define first.');
      const latest = await store.latestRun();
      this.assertNoForeignOwner(session, latest);
      if (latest && !['interrupted', 'failed'].includes(latest.status) && latest.tokens?.some(token => ['ready', 'running', 'waiting'].includes(token.status))) {
        throw failure('run_waiting', 'The latest run still has unfinished packets. Continue or stop it before starting another run.');
      }
      const resolved = await executionCwd(this.ctx, exec, cwd);
      // Preflight before creating the run directory/artifacts.
      await preflightRun({ cwd: resolved, definition: stored.definition });
      const runId = `run-${randomUUID()}`;
      const io = store.createIO(runId);
      const state = await newRunState({
        definition: stored.definition,
        permissions: stored.permissions ?? undefined,
        input: input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {},
        cwd: resolved,
        runId,
      }, io);
      state.execution = { jobId: '', active: false };
      await store.saveRun(state);
      return state;
    });
  }

  async startEntry(session, state, exec) {
    resumable(state);
    if (this.closed) throw failure('runner_closed', 'Workflow runner is shutting down.');
    const agent = this.parent(session, exec);
    const jobs = this.ctx.get?.('jobs');
    if (!jobs?.start) throw failure('jobs_unavailable', 'Workflow execution requires the DSH managed jobs service; no work was started.');
    if (state.execution?.jobId) {
      if (typeof jobs.list !== 'function') throw failure('execution_owner_unknown', 'Cannot verify the persisted native owner.');
      const owner = jobs.list(session).find(job => job.id === state.execution.jobId);
      if (owner && !['completed', 'failed', 'killed'].includes(owner.status)) throw failure('run_active', 'A native job already owns this run. Collect or stop it before continuing.');
    }
    const store = this.storeFor(session);
    const io = store.createIO(state.runId);
    const controller = new AbortController();
    const entry = { state, io, store, controller, jobs, jobId: null, done: null, writes: Promise.resolve(), scheduling: false, ended: false, wakePending: false, lastProgress: '' };
    // Snapshot at the shared writer's admission, NOT from the runtime's older
    // private queue. External enqueue/decide cannot be overwritten by stale copies.
    entry.persist = () => {
      state.execution = { ...(state.execution ?? {}), jobId: entry.jobId ?? '',
        mounted: !entry.ended, active: !entry.ended && !['interrupted','failed'].includes(state.status) && (entry.scheduling || hasWork(state)) };
      const copy = structuredClone(state);
      entry.writes = entry.writes.catch(() => {}).then(() => store.saveRun(copy));
      return entry.writes;
    };
    entry.progress = async job => {
      const view = summarizeRun(state);
      const line = `${view.status} · running ${view.counts.running ?? 0}/${view.capacity} · queued ${view.counts.queued ?? 0} · waiting ${view.counts.waiting ?? 0} · completed ${view.counts.completed ?? 0}`;
      if (entry.lastProgress === line) return;
      entry.lastProgress = line;
      try { job?.updateProgress?.(line); job?.append?.(line + '\n'); } catch { /* progress is advisory */ }
    };
    let release, refuse;
    const admitted = new Promise((resolve, reject) => { release = resolve; refuse = reject; });
    admitted.catch(() => {});
    let jobId;
    try {
      jobId = jobs.start({
        kind: 'auto-workflow',
        label: `workflow:${state.definition.name}`,
        owner: session,
        run: job => {
          entry.jobId = job.id;
          state.execution = { ...(state.execution ?? {}), jobId: job.id, active: hasWork(state), startedAt: state.execution?.startedAt ?? stamp() };
          entry.done = admitted
            .then(() => this.execute(entry, agent, job))
            .catch(error => ({ status: 'failed', detail: short(error?.message ?? error) }))
            .finally(() => { if (this.active.get(session) === entry) this.active.delete(session); });
          return {
            cancel: reason => controller.abort(Object.assign(new Error(reason || 'Workflow job cancelled'), { code: 'execution_aborted' })),
            done: entry.done,
          };
        },
      });
    } catch (error) {
      controller.abort(error);
      throw error;
    }
    this.active.set(session, entry);
    entry.jobId = jobId;
    state.execution = { ...(state.execution ?? {}), jobId, active: hasWork(state), startedAt: state.execution?.startedAt ?? stamp() };
    try {
      await entry.persist();
      release();
      return entry;
    } catch (error) {
      entry.ended = true;
      controller.abort(error);
      refuse(error);
      if (entry.done) await entry.done;
      if (this.active.get(session) === entry) this.active.delete(session);
      throw error;
    }
  }

  /** Mount a cold job when possible; a stored packet/decision survives a missing live owner. */
  async startIfPossible(session, state, exec) {
    try {
      await this.startEntry(session, state, exec);
      return true;
    } catch (error) {
      if (['no_session_agent', 'jobs_unavailable'].includes(error.code)) {
        this.logger.warn?.(`dsh-auto-workflow: job not started (${error.code}): ${error.message}`);
        return false;
      }
      throw error;
    }
  }

  async dispatch(session, runId, exec) {
    return this.locked(session, async () => {
      if (this.closed) throw failure('runner_closed', 'Workflow runner is shutting down.');
      const existing = this.active.get(session);
      if (existing) {
        if (runId && runId !== existing.state.runId) throw failure('run_active', 'Another run already owns this session; stop it first.');
        return structuredClone(existing.state);
      }
      const store = this.storeFor(session);
      const state = await this.loadRequired(session, runId);
      if (state.status === 'interrupted' || state.status === 'failed') {
        throw failure('run_not_replayable', 'This run is interrupted or failed. Inspect its evidence and start a new run; automatic replay is disabled.');
      }
      exec?.signal?.throwIfAborted();
      await preflightRun(state);
      if (this.closed) throw failure('runner_closed', 'Workflow runner was disposed during preflight.');
      await this.startEntry(session, state, exec);
      return structuredClone(state);
    });
  }

  async enqueue(session, { input = {}, nodeId, runId, exec } = {}) {
    return this.locked(session, async () => {
      if (this.closed) throw failure('runner_closed', 'Workflow runner is shutting down.');
      const store = this.storeFor(session);
      const entry = this.active.get(session);
      let state;
      let live = false;
      if (entry) {
        if (runId && runId !== entry.state.runId) throw failure('run_active', 'Another run already owns this session.');
        state = entry.state;
        live = true;
      } else {
        state = await this.loadRequired(session, runId);
        if (state.status === 'interrupted' || state.status === 'failed') {
          throw failure('run_not_replayable', 'This run is interrupted or failed; start a new run instead of appending to uncertain state.');
        }
        await preflightRun(state);
      }
      resumable(state);
      this.assertNoForeignOwner(session, state);
      if (!live && state.tokens.some(token => token.status === 'running')) throw failure('execution_owner_unknown', 'Orphan execution must be inspected before mutating packets.');
      if (entry?.controller.signal.aborted) throw failure('run_stopping', 'The job is stopping.');
      const io = live ? entry.io : store.createIO(state.runId);
      await enqueuePacket(state, { input, ...(nodeId ? { nodeId } : {}) }, io);
      if (live) {
        entry.wakePending = true;
        await entry.persist();
        io.notify();
      } else {
        await store.saveRun(state);
        const control = await store.loadControl();
        if (control.continuous !== false) await this.startIfPossible(session, state, exec);
      }
      return state;
    });
  }

  async decide(session, { runId, tokenId, outcome, output = null, exec } = {}) {
    return this.locked(session, async () => {
      if (this.closed) throw failure('runner_closed', 'Workflow runner is shutting down.');
      const store = this.storeFor(session);
      const entry = this.active.get(session);
      let state;
      let live = false;
      if (entry) {
        if (runId && runId !== entry.state.runId) throw failure('run_active', 'Another run already owns this session.');
        state = entry.state;
        live = true;
      } else {
        state = await this.loadRequired(session, runId);
      }
      resumable(state);
      this.assertNoForeignOwner(session, state);
      if (!live && state.tokens.some(token => token.status === 'running')) throw failure('execution_owner_unknown', 'Orphan execution must be inspected before mutating packets.');
      if (entry?.controller.signal.aborted) throw failure('run_stopping', 'The job is stopping.');
      const io = live ? entry.io : store.createIO(state.runId);
      await decideToken(state, { tokenId, outcome, output }, io);
      if (live) {
        entry.wakePending = true;
        await entry.persist();
        io.notify();
      } else {
        await store.saveRun(state);
        const control = await store.loadControl();
        if (control.continuous !== false && hasWork(state)) await this.startIfPossible(session, state, exec);
      }
      return state;
    });
  }

  async control(session, update = {}, { exec } = {}) {
    return this.locked(session, async () => {
      if (this.closed) throw failure('runner_closed', 'Workflow runner is shutting down.');
      const store = this.storeFor(session);
      if (update.continuous !== undefined && typeof update.continuous !== 'boolean') throw failure('invalid_argument', 'continuous must be boolean');
      const current = await store.loadControl();
      const nodes = { ...current.nodes };
      if (update.nodeId !== undefined) {
        const nodeId = typeof update.nodeId === 'string' ? update.nodeId.trim() : '';
        if (nodeId === '') throw failure('invalid_argument', 'nodeId must be a non-empty string');
        const definition = this.active.get(session)?.state.definition ?? (await store.loadDefinition())?.definition;
        if (!definition?.nodes.some(node => node.id === nodeId)) throw failure('unknown_node', 'Unknown node: ' + nodeId);
        if (update.enabled !== undefined && typeof update.enabled !== 'boolean') throw failure('invalid_argument', 'enabled must be boolean');
        nodes[nodeId] = update.enabled !== false;
      }
      const control = await store.saveControl({
        continuous: update.continuous === undefined ? current.continuous : update.continuous !== false,
        nodes,
      });
      const entry = this.active.get(session);
      if (entry) {
        if (!['interrupted','failed'].includes(entry.state.status)) applyControl(entry.state, control);
        entry.wakePending = true;
        await entry.persist();
        entry.io.notify();
        return { control, state: structuredClone(entry.state) };
      }
      const latest = await store.latestRun();
      if (latest && !['interrupted','failed'].includes(latest.status) && control.continuous !== false && hasWork(latest)) {
        await this.startIfPossible(session, latest, exec);
        return { control, state: structuredClone(latest) };
      }
      return { control, state: latest };
    });
  }

  async updateModels(session, { nodeId, models } = {}) {
    return this.locked(session, async () => {
      if (this.closed) throw failure('runner_closed', 'Workflow runner is shutting down.');
      const store = this.storeFor(session);
      const stored = await store.loadDefinition();
      if (!stored) throw failure('no_workflow', 'No workflow is defined.');
      const id = typeof nodeId === 'string' ? nodeId.trim() : '';
      const node = stored.definition.nodes.find(candidate => candidate.id === id);
      if (!node) throw failure('no_node', `Unknown node ${id}`);
      if (node.type !== 'agent') throw failure('not_model_node', `Node ${id} does not use a model`);
      if (!Array.isArray(models)) throw failure('invalid_model', 'models must be an array');
      const normalized = normalizeDefinition({
        ...stored.definition,
        nodes: stored.definition.nodes.map(candidate => candidate.id === id
          ? { ...candidate, config: applyModels(candidate.config, models) }
          : candidate),
      });
      const entry = this.active.get(session);
      if (entry && (entry.scheduling || hasWork(entry.state))) throw failure('run_active', 'Packets are running or queued; pause/drain them before changing models.');
      const run = entry?.state ?? await store.latestRun();
      this.assertNoForeignOwner(session, run);
      if (run) { await store.updateRunDefinition(run.runId, normalized); run.definition = normalized; }
      await store.saveDefinition({ definition: normalized, permissions: stored.permissions });
      if (entry) {
        entry.state.definition = normalized;
        await entry.persist();
      }
      return { definition: normalized, state: entry?.state ?? run };
    });
  }

  async stop(session, reason = 'Stopped from the dsh-auto-workflow board') {
    return this.locked(session, async () => {
      const entry = this.active.get(session);
      if (entry) {
        entry.jobs.kill(entry.jobId, session, reason);
        entry.controller.abort(Object.assign(new Error(reason), { code: 'execution_aborted' }));
        return { requested: true, jobId: entry.jobId };
      }
      const state = await this.load(session);
      if (!state || ['interrupted','failed'].includes(state.status)) return { requested: false };
      const jobs = this.ctx.get?.('jobs');
      const job = state.execution?.jobId && jobs?.list?.(session).find(item => item.id === state.execution.jobId);
      if (job && !['completed','failed','killed'].includes(job.status)) {
        jobs.kill(job.id, session, reason); return { requested:true, jobId:job.id };
      }
      state.status = 'interrupted'; state.lastError = reason;
      state.execution = { ...state.execution, active:false, mounted:false, finishedAt:stamp() };
      interruptPending(state, reason);
      await this.storeFor(session).saveRun(state);
      return { requested:true, jobId:state.execution.jobId ?? '' };
    });
  }

  async execute(entry, agent, job) {
    const { state, io, store, controller } = entry;
    const executors = createExecutors({
      ctx: this.ctx,
      exec: { agent, signal: controller.signal },
      settings: this.settings,
      cwd: state.cwd,
      onActivity: async (token, activity) => {
        token.activity = { ...activity, startedAt: stamp() };
        await entry.persist();
      },
    });
    try {
      await entry.progress(job);
      while (!controller.signal.aborted) {
        let since;
        await this.locked(agent.id, async () => { entry.scheduling = true; entry.wakePending = false; });
        try {
          await run(state, executors, {
            io,
            checkpoint: () => entry.persist(),
            control: () => store.loadControl(),
            signal: controller.signal,
            maxSteps: this.settings.maxSteps ?? 40,
            maxFailures: this.settings.maxFailures ?? 3,
            notify: () => io.notify(),
          });
        } catch (error) {
          if (controller.signal.aborted) break;
          state.status = 'interrupted';
          state.lastError = short(error?.message ?? error);
          break;
        }
        await this.locked(agent.id, async () => {
          entry.scheduling = false;
          // Capture after the slice, under the mutation lock. Earlier internal
          // completion wakes are consumed; a later external mutation changes
          // generation (or wakePending), so the park cannot lose it.
          since = io.version?.();
          await entry.persist();
        });
        await entry.progress(job);
        if (controller.signal.aborted) break;
        if (state.status === 'interrupted' || state.status === 'failed') break;
        if (state.pauseReason === 'step_budget') {
          await new Promise(resolve => setImmediate(resolve));
          continue;
        }
        // Idle, waiting for a Human decision, or paused by control: stay mounted.
        // A decided Human node, a new packet, a control change or stop wakes this.
        if (!entry.wakePending) await io.waitForChange({ signal: controller.signal, since });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        state.status = 'failed';
        state.lastError = short(error?.message ?? error);
      }
    } finally {
      if (controller.signal.aborted && state.status !== 'interrupted') {
        state.status = 'interrupted';
        state.lastError = short(controller.signal.reason?.message ?? 'Execution cancelled; inspect uncertain side effects before retrying.');
      }
      if (state.status === 'interrupted' || controller.signal.aborted) interruptPending(state, state.lastError ?? 'Execution stopped');
      entry.ended = true; entry.scheduling = false;
      state.execution = { ...(state.execution ?? {}), active: false, mounted: false, finishedAt: stamp() };
      try { await entry.persist(); } catch { /* preserve the original failure */ }
      await entry.progress(job);
    }
    return {
      status: state.status === 'interrupted' ? 'killed' : state.status === 'failed' ? 'failed' : 'completed',
      detail: state.lastError ?? state.pauseReason ?? state.status,
      result: JSON.stringify(summarizeRun(state)),
    };
  }

  async dispose() {
    this.closed = true;
    const entries = [...this.active.values()];
    for (const entry of entries) {
      entry.controller.abort(Object.assign(new Error('Workflow plugin disposed'), { code: 'execution_aborted' }));
    }
    await Promise.allSettled(entries.map(entry => entry.done));
  }
}
