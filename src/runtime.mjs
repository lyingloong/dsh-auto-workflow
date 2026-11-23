/** Host-free concurrent packet scheduler. Persisted documents contain references, not payloads. */
import { randomUUID } from 'node:crypto';
import { requireCommand, requireHttp } from './permissions.mjs';

// Only control-plane commits serialize per packet; executors still run concurrently.
const packetWrites = new WeakMap();
const liveDecisions = new WeakSet();
async function packetCommit(packet, operation) {
  const previous = packetWrites.get(packet) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  packetWrites.set(packet, next);
  try { return await next; }
  finally { if (packetWrites.get(packet) === next) packetWrites.delete(packet); }
}
async function artifactScope(io, operation) {
  const retained = new Map();
  const retain = ref => {
    if (ref && !retained.has(ref)) retained.set(ref, io.retain?.(ref));
  };
  const scoped = { ...io,
    get(ref) { retain(ref); return io.get(ref); },
    async put(value) {
      const release = io.hold?.();
      try { const ref = await io.put(value); retain(ref); return ref; }
      finally { release?.(); }
    },
  };
  try { return await operation(scoped); }
  finally { for (const release of retained.values()) release?.(); }
}

export class RuntimeError extends Error {
  constructor(code, message) { super(message); this.name = 'RuntimeError'; this.code = code; }
}
export { PermissionError } from './permissions.mjs';
export const DEFAULT_PERMISSIONS = { command: { mode: 'deny', allow: [] }, http: { mode: 'deny', allow: [] } };
export function normalizePermissions(raw) {
  const section = key => ({ mode: ['full', 'allowlist', 'deny'].includes(raw?.[key]?.mode) ? raw[key].mode : 'deny', allow: Array.isArray(raw?.[key]?.allow) ? raw[key].allow.filter(value => typeof value === 'string') : [] });
  return { command: section('command'), http: section('http') };
}
const clock = () => new Date().toISOString();
const id = prefix => `${prefix}-${randomUUID()}`;
const own = (value, key) => value != null && Object.hasOwn(value, key) ? value[key] : undefined;
function statsOf(state, nodeId) {
  if (!Object.hasOwn(state.nodeStats, nodeId)) state.nodeStats[nodeId] = {};
  return state.nodeStats[nodeId];
}
function requireIO(io) {
  if (!io || !['put', 'get', 'archive'].every(key => typeof io[key] === 'function')) throw new RuntimeError('artifact_io_required', 'Supply io.put/get/archive; payloads are not embedded in run state.');
}
function assertState(state) {
  if (state?.version !== 3) throw new RuntimeError('unsupported_run_version', 'Only version:3 packet runs execute. Preserve older run documents and start a new run.');
}
function nodeOf(state, nodeId) {
  const node = state.definition.nodes.find(candidate => candidate.id === nodeId);
  if (!node) throw new RuntimeError('unknown_node', `Unknown node ${nodeId}`);
  return node;
}
function wake(io, notify) { io.notify?.(); notify?.(); }

export async function newRunState({ definition, permissions, input = {}, cwd = null, now = clock(), runId }, io) {
  requireIO(io);
  const state = { version: 3, runId: runId ?? io.runId ?? id('run'), definition: structuredClone(definition), permissions: normalizePermissions(permissions), cwd, status: 'idle', createdAt: now, updatedAt: now, packets: {}, tokens: [], recent: [], counts: { completed: 0, failed: 0, interrupted: 0, packetsCreated: 0, packetsCompleted: 0, packetsFailed: 0 }, nodeStats: {} };
  io.historyLimit = definition.historyLimit ?? 100;
  await enqueue(state, { input, now }, io);
  return state;
}

export async function enqueue(state, { input = {}, nodeId = state.definition.entry, now = clock() } = {}, io) {
  return addPacket(state, { input, nodeId, now }, io);
}
async function addPacket(state, options, io) {
  return artifactScope(io, scoped => addPacketScoped(state, options, scoped));
}
async function addPacketScoped(state, { input, nodeId, now, branch, admit }, io) {
  assertState(state); requireIO(io); nodeOf(state, nodeId);
  const inputRef = await io.put(input);
  const packet = { id: id('packet'), inputRef, lastRef: inputRef, results: {}, failures: {}, status: 'active', createdAt: now, updatedAt: now };
  if (branch) { packet.index = branch.index; packet.itemRef = inputRef; packet.parent = branch.parent; }
  // Publish packet and entry together after every asynchronous input snapshot is complete.
  const token = await queueToken(state, packet, nodeId, inputRef, io, now, { publish: false });
  if (admit && !admit()) return null;
  state.packets[packet.id] = packet; state.tokens.push(token);
  state.counts.packetsCreated += 1;
  state.updatedAt = now;
  refresh(state); wake(io);
  return packet;
}

/** A scheduler slice limits admissions, never the duration of an admitted task. */
export async function run(state, executors, { io, checkpoint = async () => {}, signal, control = null, maxSteps = 40, maxFailures = 3, now = clock, notify } = {}) {
  assertState(state); requireIO(io);
  if (state.status === 'interrupted') return state;
  io.historyLimit = state.definition.historyLimit ?? 100;
  const active = new Map();
  let writes = Promise.resolve();
  const save = () => {
    state.updatedAt = now(); refresh(state);
    // Snapshot at delivery, not before waiting behind an older checkpoint.
    // External enqueue/decide writes may have committed in that interval.
    writes = writes.then(() => checkpoint(structuredClone(state)));
    return writes;
  };
  const orphans = state.tokens.filter(token => token.status === 'running' && !liveDecisions.has(token));
  if (orphans.length) {
    for (const token of orphans) {
      token.status = 'interrupted'; token.error = { code: 'execution_unknown', message: 'Previous execution has no terminal checkpoint; inspect side effects before retrying.' };
      token.updatedAt = now();
      const packet = state.packets[token.packetId]; if (packet) packet.status = 'interrupted';
    }
    state.status = 'interrupted'; state.lastError = orphans[0].error.message; await save(); return state;
  }
  let steps = 0, currentControl = null, fatal;
  state.pauseReason = null; state.yieldReason = null;
  try {
    while (true) {
      // A ready/waiting token whose packet is gone or no longer active can never
      // run; keeping it would report a queued run that parks forever. Archive it
      // as evidence instead of wedging the slice. Failed/interrupted tokens stay
      // as hot evidence and are not schedulable anyway.
      const stale = state.tokens.filter(token => ['ready', 'waiting'].includes(token.status) && state.packets[token.packetId]?.status !== 'active');
      if (stale.length) await reconcileTokens(state, stale, io, now);
      const observed = io.version?.();
      currentControl = typeof control === 'function' ? await control() : control;
      updateNodeStats(state, currentControl);
      if (!signal?.aborted && currentControl?.continuous !== false && steps < maxSteps) {
        const rootLimit = state.definition.concurrency ?? 4;
        for (const token of [...state.tokens]) {
          if (active.size >= rootLimit || steps >= maxSteps) break;
          if (token.status !== 'ready' || state.packets[token.packetId]?.status !== 'active') continue;
          if (currentControl?.nodes?.[token.nodeId] === false) continue;
          if (token.availableAt && Date.parse(token.availableAt) > Date.now()) continue;
          const node = nodeOf(state, token.nodeId);
          if ([...active.values()].filter(item => item.nodeId === node.id).length >= (node.concurrency ?? 1)) continue;
          steps += 1;
          token.status = 'running'; token.attempt += 1; token.updatedAt = now();
          // executeToken awaits the running checkpoint before invoking any executor.
          const promise = executeToken(state, token, node, executors, { io, save, signal, maxFailures, now, notify }).catch(error => {
            fatal ??= error;
            token.status = 'interrupted'; token.error = { code: 'checkpoint_failed', message: short(error?.message ?? error) };
            state.status = 'interrupted';
          }).finally(() => active.delete(token.id));
          active.set(token.id, { nodeId: node.id, promise });
        }
      }
      refresh(state); updateNodeStats(state, currentControl);
      if (!active.size) {
        if (signal?.aborted || fatal) break;
        if (currentControl?.continuous === false) { state.status = 'paused'; state.pauseReason = 'control_off'; break; }
        const ready = state.tokens.filter(token => token.status === 'ready' && state.packets[token.packetId]?.status === 'active');
        if (steps >= maxSteps && ready.length) { state.status = 'paused'; state.pauseReason = 'step_budget'; state.yieldReason = 'step_budget'; break; }
        const enabled = ready.filter(token => currentControl?.nodes?.[token.nodeId] !== false);
        if (!enabled.length) {
          if (ready.length) { state.status = 'paused'; state.pauseReason = 'nodes_disabled'; }
          break;
        }
        // Only delayed gates remain. Wait for their schedule, a control notification or cancellation.
        if (!enabled.some(token => !token.availableAt || Date.parse(token.availableAt) <= Date.now())) {
          await waitForActivity(active, io, signal, enabled, observed); continue;
        }
        continue;
      }
      await waitForActivity(active, io, signal, state.tokens.filter(token => token.status === 'ready' && currentControl?.nodes?.[token.nodeId] !== false), observed);
    }
  } catch (error) { fatal = error; }
  // Never abandon live executor promises, even when cancellation or persistence fails.
  await Promise.allSettled([...active.values()].map(item => item.promise));
  if (signal?.aborted || fatal) {
    state.status = 'interrupted'; state.lastError = short(fatal?.message ?? signal?.reason?.message ?? 'Execution cancelled; inspect uncertain side effects before retrying.');
    for (const packet of Object.values(state.packets)) if (packet.status === 'active') packet.status = 'interrupted';
  }
  updateNodeStats(state, currentControl);
  await save();
  await io.prune?.(state);
  if (fatal) throw fatal;
  return state;
}

async function waitForActivity(active, io, signal, queued, since) {
  if (signal?.aborted) { await Promise.allSettled([...active.values()].map(item => item.promise)); return; }
  let timer, abort;
  const controller = new AbortController();
  const events = [...active.values()].map(item => item.promise);
  if (io.waitForChange) events.push(Promise.resolve(io.waitForChange({ signal: controller.signal, since })).catch(() => {}));
  const future = queued.map(token => Date.parse(token.availableAt)).filter(time => Number.isFinite(time) && time > Date.now());
  if (future.length) events.push(new Promise(resolve => { timer = setTimeout(resolve, Math.max(1, Math.min(...future) - Date.now())); }));
  if (signal) events.push(new Promise(resolve => { abort = resolve; signal.addEventListener('abort', abort, { once: true }); }));
  try { if (events.length) await Promise.race(events); }
  finally { clearTimeout(timer); if (abort) signal.removeEventListener('abort', abort); controller.abort(); }
}

async function executeToken(state, token, node, executors, options) {
  return artifactScope(options.io, io => executeTokenScoped(state, token, node, executors, { ...options, io }));
}
async function executeTokenScoped(state, token, node, executors, { io, save, signal, maxFailures, now, notify }) {
  const packet = state.packets[token.packetId];
  try {
    await save();
    signal?.throwIfAborted();
    if (packet.status !== 'active') { await archiveToken(state, token, 'cancelled', io, now); await save(); return; }
    if (node.type === 'human') {
      token.status = 'waiting'; token.reason = 'human'; token.updatedAt = now(); await save(); return;
    }
    if (node.type === 'fanout') {
      const items = await io.get(token.itemsRef);
      const canPublish = () => packet.status === 'active' && state.tokens.includes(token) && !signal?.aborted;
      if (!canPublish()) { await archiveToken(state, token, 'cancelled', io, now); await save(); return; }
      if (!Array.isArray(items)) throw new RuntimeError('invalid_fanout', `Fanout ${node.id} did not resolve an array`);
      const joinNode = node.config.join ? nodeOf(state, node.config.join) : null;
      let joinToken;
      if (joinNode) {
        joinToken = await queueToken(state, { ...packet, results: token.results }, joinNode.id, token.inputRef, io, now(), { publish: false });
        if (!canPublish()) { await archiveToken(state, token, 'cancelled', io, now); await save(); return; }
        joinToken.status = 'waiting'; joinToken.reason = 'join';
        joinToken.results = { ...token.results, [node.id]: { outcome: 'complete', outputRef: token.inputRef } };
        const threshold = joinNode.config.mode === 'any' ? 1 : joinNode.config.mode === 'quorum' ? joinNode.config.count : items.length;
        joinToken.join = { expected: items.length, threshold: Math.min(threshold, items.length), arrived: 0, failed: 0, outputs: [], sealed: false };
        state.tokens.push(joinToken);
      }
      for (const [index, item] of items.entries()) {
        if (!canPublish()) break;
        await addPacket(state, { input: item, nodeId: node.config.target, now: now(), admit: canPublish, branch: { index, parent: joinToken ? { packetId: packet.id, tokenId: joinToken.id, nodeId: joinNode.id, index } : null } }, io);
      }
      // A joined parent advances only through its join, never directly on first child arrival.
      await finish(state, token, { outcome: 'complete', outputRef: token.inputRef }, io, now, { follow: !joinToken, joinToken });
      await save(); wake(io, notify); return;
    }
    if (node.type === 'subworkflow') {
      validateSerialChild(node.config.definition);
      // Nested histories share the physical root ring; never widen its bound or prune siblings.
      const nestedIO = { ...io, prune: undefined };
      if (!token.childRun) {
        const input = await io.get(token.inputRef);
        if (packet.status !== 'active') { await archiveToken(state, token, 'cancelled', io, now); await save(); return; }
        token.childRun = await newRunState({ definition: node.config.definition, permissions: state.permissions, input, cwd: state.cwd, now: now(), runId: id('nested') }, nestedIO);
      }
      if (packet.status !== 'active') { await archiveToken(state, token, 'cancelled', io, now); await save(); return; }
      await save();
      do {
        await run(token.childRun, executors, { io: nestedIO, checkpoint: save, signal, control: () => ({ continuous: packet.status === 'active' }), maxSteps: 40, maxFailures, now });
      } while (packet.status === 'active' && token.childRun.pauseReason === 'step_budget' && !signal?.aborted);
      if (packet.status !== 'active') { await archiveToken(state, token, 'cancelled', io, now); await save(); return; }
      if (token.childRun.status === 'interrupted') throw new RuntimeError('execution_aborted', token.childRun.lastError ?? 'Nested execution interrupted');
      if (Object.values(token.childRun.packets).some(child => child.status === 'failed')) throw new RuntimeError('subworkflow_failed', `Subworkflow ${node.id} failed; inspect its childRun evidence`);
      if (token.childRun.status !== 'idle') throw new RuntimeError('subworkflow_not_done', `Subworkflow ${node.id} is ${token.childRun.status}`);
      await finish(state, token, { outcome: 'complete', outputRef: token.childRun.outputRef ?? token.inputRef }, io, now);
      await save(); wake(io, notify); return;
    }
    let result;
    if (node.type === 'gate' || node.type === 'join') result = { outcome: 'complete', outputRef: token.inputRef };
    else {
      const effectiveNode = token.config ? { ...node, config: { ...node.config, ...token.config } } : node;
      if (node.type === 'command') requireCommand(state.permissions.command, effectiveNode.config.command);
      if (node.type === 'http') requireHttp(state.permissions.http, effectiveNode.config.url);
      const executor = executors[node.type];
      if (!executor) throw new RuntimeError('no_executor', `No ${node.type} executor is mounted`);
      const input = await io.get(token.inputRef); // Recorded input is never resolved again.
      if (packet.status !== 'active') { await archiveToken(state, token, 'cancelled', io, now); await save(); return; }
      result = await executor({ node: effectiveNode, input, token, definition: state.definition, permissions: state.permissions, packet: { ...structuredClone(packet), results: structuredClone(token.results) }, context: { packetId: packet.id, results: structuredClone(token.results) }, signal });
    }
    signal?.throwIfAborted();
    if (packet.status !== 'active') {
      await archiveToken(state, token, 'cancelled', io, now); await save(); return;
    }
    const outcome = typeof result?.outcome === 'string' && result.outcome ? result.outcome : node.type === 'agent' ? (node.config.outcome ?? 'complete') : 'complete';
    const outputRef = result?.outputRef ?? await io.put(result?.output ?? null);
    const negative = ['fail', 'needs_revision'].includes(outcome);
    packet.failures[node.id] = negative ? (Object.hasOwn(packet.failures, node.id) ? packet.failures[node.id] : 0) + 1 : 0;
    token.outcome = outcome; token.outputRef = outputRef;
    if (result?.model) token.model = result.model;
    const limit = node.config.maxFailures ?? maxFailures;
    if (negative && packet.failures[node.id] >= limit) throw new RuntimeError('failure_budget_exhausted', `Node ${node.id} returned ${outcome} ${limit} times in packet ${packet.id}; inspect evidence before retrying.`);
    if (negative && !state.definition.edges.some(edge => edge.from === node.id && edge.on === outcome)) throw new RuntimeError('unhandled_failure', `Node ${node.id} returned ${outcome} without a matching edge`);
    await finish(state, token, { outcome, outputRef }, io, now);
    await save(); wake(io, notify);
  } catch (error) {
    await packetCommit(packet, async () => {
      const interrupted = signal?.aborted || error?.name === 'AbortError' || error?.code === 'execution_aborted';
      token.status = interrupted ? 'interrupted' : 'failed'; token.updatedAt = now();
      token.error = { code: error?.code ?? 'execution_failed', message: short(error?.message ?? error) };
      const previousPacketStatus = packet.status;
      packet.status = interrupted ? 'interrupted' : 'failed'; packet.updatedAt = now();
      state.counts[interrupted ? 'interrupted' : 'failed'] += 1;
      if (!interrupted && previousPacketStatus !== 'failed') state.counts.packetsFailed += 1;
      const stats = statsOf(state, node.id); stats[interrupted ? 'interrupted' : 'failed'] = (stats[interrupted ? 'interrupted' : 'failed'] ?? 0) + 1;
      // Retain uncertain/failed attempts as evidence; never automatically replay.
      for (const sibling of [...state.tokens]) if (sibling.packetId === packet.id && sibling.id !== token.id && ['ready', 'waiting'].includes(sibling.status)) await archiveToken(state, sibling, 'cancelled', io, now);
      await archiveRecord(state, { type: 'token', id: token.id, packetId: token.packetId, nodeId: token.nodeId, status: token.status, attempt: token.attempt, outcome: token.outcome ?? null, inputRef: token.inputRef, outputRef: token.outputRef ?? null, error: token.error.message, createdAt: token.createdAt, updatedAt: token.updatedAt }, io);
      // The live token stays as hot evidence, but it no longer defines the run
      // error: a bounded lastFailure records the most recent attempt.
      state.lastFailure = { tokenId: token.id, packetId: token.packetId, nodeId: token.nodeId, status: token.status, code: token.error.code, message: token.error.message, at: now() };
      await registerArrival(state, packet, io, now, true);
    });
    await save(); wake(io, notify);
  }
}

export async function decide(state, options, io) {
  return artifactScope(io, scoped => decideScoped(state, options, scoped));
}
async function decideScoped(state, { tokenId, outcome, output = null, now = clock() }, io) {
  assertState(state); requireIO(io);
  const token = state.tokens.find(candidate => candidate.id === tokenId);
  if (!token || token.status !== 'waiting') throw new RuntimeError('not_waiting', `Token ${tokenId} is not waiting`);
  const node = nodeOf(state, token.nodeId);
  if (node.type !== 'human') throw new RuntimeError('not_decidable', `Token ${tokenId} is an internal ${node.type} wait, not a human decision`);
  if (!humanOutcomes(node).includes(outcome)) throw new RuntimeError('unknown_outcome', `Expected ${humanOutcomes(node).join(', ')}`);
  const outputRef = await io.put(output);
  liveDecisions.add(token);
  try { await finish(state, token, { outcome, outputRef }, io, () => now, { decision: true }); }
  finally { liveDecisions.delete(token); }
  state.updatedAt = now; refresh(state); wake(io);
  return state;
}
export function humanOutcomes(node) { return node?.config?.outcomes?.length ? [...node.config.outcomes] : ['approve', 'reject']; }
export function waitingTokens(state) { return state.tokens.filter(token => token.status === 'waiting').map(token => structuredClone(token)); }
export function waitingHumanTokens(state) { return waitingTokens(state).filter(token => nodeOf(state, token.nodeId).type === 'human'); }

async function queueToken(state, packet, nodeId, previousRef, io, now, { publish = true } = {}) {
  const node = nodeOf(state, nodeId);
  packet = { ...packet, results: structuredClone(packet.results) };
  const token = { id: id('token'), packetId: packet.id, nodeId, status: 'ready', results: packet.results, inputRef: await snapshotInput(state, packet, node, previousRef, io), attempt: 0, createdAt: now, updatedAt: now };
  const resolve = value => resolveMapped(value, packet, previousRef, io);
  if (node.type === 'fanout') token.itemsRef = await io.put(await resolve(node.config.items));
  for (const key of ['cwd', 'url']) if (typeof node.config[key] === 'string' && node.config[key].startsWith('$')) {
    // Execution configuration sees the recorded node input; node.inputs mappings above
    // still use the packet's immutable original $input namespace.
    token.config ??= {}; token.config[key] = await resolveMapped(node.config[key], { ...packet, inputRef: token.inputRef }, previousRef, io);
  }
  if (node.type === 'gate' && node.config.delayMs > 0) token.availableAt = new Date(Date.now() + node.config.delayMs).toISOString();
  if (publish) state.tokens.push(token); return token;
}
async function snapshotInput(state, packet, node, previousRef, io) {
  if (node.inputs === undefined) return previousRef ?? packet.inputRef;
  return io.put(await resolveMapped(node.inputs, packet, previousRef, io));
}
async function resolveMapped(value, packet, previousRef, io) {
  const cache = new Map();
  const load = ref => {
    if (!ref) return Promise.resolve(undefined);
    if (!cache.has(ref)) cache.set(ref, Promise.resolve(io.get(ref)));
    return cache.get(ref);
  };
  const walk = async value => {
    if (typeof value === 'string' && value.startsWith('$')) {
      const parts = value.slice(1).split('.');
      let current;
      const root = parts.shift();
      if (root === 'input') current = await load(packet.inputRef);
      else if (root === 'prev') current = await load(previousRef);
      else if (root === 'item') current = await load(packet.itemRef ?? packet.inputRef);
      else if (root === 'index') current = packet.index;
      else if (root === 'packet') current = { id: packet.id };
      else if (root === 'nodes') {
        const nodeId = parts.shift(), field = parts.shift();
        const result = own(packet.results, nodeId);
        current = field === 'output' ? await load(own(result, 'outputRef')) : own(result, field);
      }
      for (const key of parts) current = own(current, key);
      return current;
    }
    if (Array.isArray(value)) return Promise.all(value.map(walk));
    if (value && typeof value === 'object') {
      const entries = await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await walk(item)]));
      return Object.fromEntries(entries);
    }
    return value;
  };
  return walk(value);
}
/** Pure resolver retained for executor configuration and callers with an explicit scope. */
export function resolveValue(value, scope) {
  if (typeof value === 'string' && value.startsWith('$')) return value.slice(1).split('.').reduce((current, key) => own(current, key), scope);
  if (Array.isArray(value)) return value.map(item => resolveValue(item, scope));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveValue(item, scope)]));
  return value;
}
async function finish(state, token, result, io, now, options = {}) {
  const packet = state.packets[token.packetId];
  if (!packet) throw new RuntimeError('not_waiting', `Token ${token.id} is no longer live`);
  return packetCommit(packet, async () => {
    const live = state.tokens.includes(token) && ['running', 'waiting'].includes(token.status);
    if (!live || packet.status !== 'active') {
      if (options.decision) throw new RuntimeError('not_waiting', `Token ${token.id} was cancelled or already decided`);
      if (state.tokens.includes(token) && !['failed', 'interrupted'].includes(token.status)) await archiveToken(state, token, 'cancelled', io, now);
      return false;
    }
    if (options.decision && token.status !== 'waiting') throw new RuntimeError('not_waiting', `Token ${token.id} is not waiting`);
    // A concurrent checkpoint must treat an unfinished commit as uncertain,
    // including a Human decision that is no longer available to another caller.
    token.status = 'running';
    const { outcome, outputRef } = result;
    token.outcome = outcome; token.outputRef = outputRef; token.updatedAt = now();
    packet.lastRef = outputRef; packet.results[token.nodeId] = { outcome, outputRef }; packet.updatedAt = now();
    const scope = { ...packet, results: { ...token.results, [token.nodeId]: { outcome, outputRef } } };
    const successors = [];
    if (options.follow !== false) for (const edge of state.definition.edges.filter(edge => edge.from === token.nodeId && edge.on === outcome)) {
      // The boundary survives archival of an early any/quorum parent join.
      if (packet.parent?.nodeId === edge.to) continue;
      successors.push(await queueToken(state, scope, edge.to, outputRef, io, now(), { publish: false }));
    }
    const terminal = !successors.length && !state.tokens.some(candidate => candidate !== token && candidate.packetId === packet.id);
    await archiveRecord(state, { type: 'token', id: token.id, packetId: packet.id, nodeId: token.nodeId, status: 'completed', attempt: token.attempt, outcome, inputRef: token.inputRef, outputRef, model: token.model ?? null, createdAt: token.createdAt, updatedAt: token.updatedAt }, io);
    if (terminal) {
      await registerArrival(state, packet, io, now, false);
      await archiveRecord(state, { type: 'packet', id: packet.id, packetId: packet.id, status: 'completed', inputRef: packet.inputRef, outputRef: packet.lastRef, createdAt: packet.createdAt, updatedAt: now() }, io);
    }
    if (options.joinToken && state.tokens.includes(options.joinToken) && options.joinToken.status === 'waiting') {
      options.joinToken.join.sealed = true;
      await advanceJoin(state, packet, options.joinToken, io, now);
    }
    // No await between removing the running source and publishing the full
    // successor set. A checkpoint sees either uncertain source or committed work.
    token.status = 'completed';
    state.tokens = state.tokens.filter(candidate => candidate !== token);
    state.tokens.push(...successors);
    state.counts.completed += 1;
    const stats = statsOf(state, token.nodeId); stats.completed = (stats.completed ?? 0) + 1;
    if (terminal) {
      packet.status = 'completed'; state.outputRef = packet.lastRef;
      state.counts.packetsCompleted += 1; delete state.packets[packet.id];
    }
    refresh(state); return true;
  });
}
async function registerArrival(state, packet, io, now, failed) {
  if (!packet.parent || packet.parent.arrived) return;
  packet.parent.arrived = true;
  const parent = state.packets[packet.parent.packetId];
  if (!parent) return;
  await packetCommit(parent, async () => {
    const token = state.tokens.find(candidate => candidate.id === packet.parent.tokenId);
    if (parent.status !== 'active' || !token || token.status !== 'waiting' || !token.join) return;
    const join = token.join;
    join.arrived += 1; if (failed) join.failed += 1;
    join.outputs.push({ packetId: packet.id, index: packet.parent.index, status: failed ? 'failed' : 'completed', outputRef: packet.lastRef });
    await advanceJoin(state, parent, token, io, now);
  });
}
// Caller holds the parent packet commit lock. Children may arrive while the
// producer is publishing, but cannot overtake its terminal state transition.
async function advanceJoin(state, parent, token, io, now) {
  const join = token.join;
  if (!join.sealed) return;
  const successful = join.arrived - join.failed;
  if (successful >= join.threshold) {
    token.inputRef = await io.put(join.outputs); token.status = 'ready'; token.reason = null; token.updatedAt = now();
  } else if (join.arrived === join.expected) {
    token.status = 'failed'; token.updatedAt = now();
    token.error = { code: 'join_failed', message: 'Not enough child packets completed successfully to satisfy join threshold' };
    parent.status = 'failed'; parent.updatedAt = now();
    state.counts.failed += 1; state.counts.packetsFailed += 1;
    const stats = statsOf(state, token.nodeId); stats.failed = (stats.failed ?? 0) + 1;
    for (const sibling of [...state.tokens]) if (sibling.packetId === parent.id && sibling !== token && ['ready', 'waiting'].includes(sibling.status)) await archiveToken(state, sibling, 'cancelled', io, now);
    await archiveRecord(state, { type: 'token', id: token.id, packetId: parent.id, nodeId: token.nodeId, status: 'failed', inputRef: token.inputRef, error: token.error.message, createdAt: token.createdAt, updatedAt: token.updatedAt }, io);
    state.lastFailure = { tokenId: token.id, packetId: parent.id, nodeId: token.nodeId, status: 'failed', code: token.error.code, message: token.error.message, at: now() };
    await registerArrival(state, parent, io, now, true);
  }
}
async function archiveToken(state, token, status, io, now) {
  token.status = status; token.updatedAt = now();
  await archiveRecord(state, { type: 'token', id: token.id, packetId: token.packetId, nodeId: token.nodeId, status, attempt: token.attempt, outcome: token.outcome ?? null, inputRef: token.inputRef, outputRef: token.outputRef ?? null, model: token.model ?? null, createdAt: token.createdAt, updatedAt: token.updatedAt }, io);
  state.tokens = state.tokens.filter(candidate => candidate.id !== token.id);
  if (status === 'completed') {
    state.counts.completed += 1;
    const stats = statsOf(state, token.nodeId); stats.completed = (stats.completed ?? 0) + 1;
  }
}
/** Archive tokens that can never execute because their packet is not active. */
async function reconcileTokens(state, tokens, io, now) {
  for (const token of tokens) {
    await archiveRecord(state, {
      type: 'token', id: token.id, packetId: token.packetId, nodeId: token.nodeId,
      status: 'cancelled', attempt: token.attempt, outcome: token.outcome ?? null,
      inputRef: token.inputRef, outputRef: token.outputRef ?? null, model: token.model ?? null,
      reason: 'packet_not_active', createdAt: token.createdAt, updatedAt: now(),
    }, io);
    state.tokens = state.tokens.filter(candidate => candidate !== token);
  }
  return tokens.length;
}
async function archiveRecord(state, record, io) {
  await io.archive(record);
  const limit = state.definition.historyLimit ?? 100;
  if (limit) state.recent = [...state.recent, record].slice(-limit); else state.recent = [];
}
function short(value) { return String(value).slice(0, 1000); }
function refresh(state) {
  updateNodeStats(state);
  const current = { queued: 0, running: 0, waiting: 0, failedActive: 0, interruptedActive: 0, packetsActive: Object.values(state.packets).filter(packet => packet.status === 'active').length };
  for (const token of state.tokens) {
    const key = { ready: 'queued', running: 'running', waiting: 'waiting', failed: 'failedActive', interrupted: 'interruptedActive' }[token.status];
    if (key) current[key] += 1;
  }
  Object.assign(state.counts, current);
  if (state.status === 'interrupted' || (state.status === 'paused' && state.pauseReason)) return;
  state.status = current.running || current.queued ? 'running' : current.waiting ? 'waiting' : 'idle';
}
function updateNodeStats(state, control) {
  for (const node of state.definition.nodes) {
    const previous = own(state.nodeStats, node.id) ?? {};
    const tokens = state.tokens.filter(token => token.nodeId === node.id);
    const running = tokens.filter(token => token.status === 'running').length;
    state.nodeStats[node.id] = { ...previous, capacity: node.concurrency ?? 1, queued: tokens.filter(token => token.status === 'ready').length, running, active: running, waiting: tokens.filter(token => token.status === 'waiting').length, status: control?.nodes?.[node.id] === false ? 'disabled' : control === undefined && previous.status === 'disabled' ? 'disabled' : running ? 'running' : 'idle' };
  }
}
function validateSerialChild(definition) {
  if ((definition.concurrency ?? 1) !== 1 || definition.nodes.some(node => (node.concurrency ?? 1) !== 1 || ['human', 'fanout'].includes(node.type))) throw new RuntimeError('unsupported_subworkflow', 'Nested workflows must be serial (root/node concurrency1) and cannot contain human or fanout nodes. Inline such graphs at the root.');
}
