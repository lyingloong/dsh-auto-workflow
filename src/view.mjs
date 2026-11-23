/** Generic bounded service/packet projections. Fetch artifact/history endpoints for details. */
import { describeDefinition } from './definition.mjs';
import { humanOutcomes, waitingHumanTokens } from './runtime.mjs';

export function summarizeRun(state) {
  const current = state.tokens.find(token => token.status === 'running') ?? state.tokens.at(-1);
  const nodes = new Map(state.definition.nodes.map(node => [node.id, node]));
  const liveCounts = { running: 0, queued: 0, waiting: 0 };
  for (const token of state.tokens) {
    const key = token.status === 'ready' ? 'queued' : token.status;
    if (Object.hasOwn(liveCounts, key)) liveCounts[key]++;
  }
  const nodeStats = Object.fromEntries(state.definition.nodes.map(node => {
    const tokens = state.tokens.filter(token => token.nodeId === node.id);
    const active = tokens.filter(token => token.status === 'running').length;
    const previous = Object.hasOwn(state.nodeStats, node.id) ? state.nodeStats[node.id] : {};
    return [node.id, { ...previous, capacity: node.concurrency ?? 1, active, running: active, queued: tokens.filter(token => token.status === 'ready').length, waiting: tokens.filter(token => token.status === 'waiting').length, status: previous.status === 'disabled' ? 'disabled' : active ? 'running' : 'idle' }];
  }));
  return {
    version: state.version, runId: state.runId, status: state.status, cwd: state.cwd ?? '',
    jobId: state.execution?.jobId ?? '', execution: state.execution ?? { active: false },
    updatedAt: state.updatedAt, pauseReason: state.pauseReason ?? '', capacity: state.definition.concurrency ?? 4,
    current: current ? { tokenId: current.id, packetId: current.packetId, nodeId: current.nodeId, status: current.status, activity: current.activity ?? null, updatedAt: current.updatedAt } : {},
    counts: { ...structuredClone(state.counts), ...liveCounts }, nodeStats,
    waiting: waitingHumanTokens(state).map(token => ({ tokenId: token.id, packetId: token.packetId, nodeId: token.nodeId, inputRef: token.inputRef, title: nodes.get(token.nodeId)?.title ?? token.nodeId, outcomes: humanOutcomes(nodes.get(token.nodeId)) })),
    error: state.lastError ?? '',
    lastFailure: state.lastFailure ?? null,
  };
}
export function publicRun(state) {
  return {
    ...summarizeRun(state), createdAt: state.createdAt, outputRef: state.outputRef ?? null,
    packets: Object.values(state.packets).map(packet => ({ id: packet.id, status: packet.status, inputRef: packet.inputRef, lastRef: packet.lastRef, results: structuredClone(packet.results), parent: packet.parent ?? null, createdAt: packet.createdAt, updatedAt: packet.updatedAt })),
    tokens: state.tokens.map(token => ({
      id: token.id, packetId: token.packetId, nodeId: token.nodeId, status: token.status, attempt: token.attempt,
      outcome: token.outcome ?? null, inputRef: token.inputRef, outputRef: token.outputRef ?? null,
      model: token.model ?? null, error: token.error ?? null, reason: token.reason ?? null,
      availableAt: token.availableAt ?? null, activity: token.activity ?? null,
      join: token.join ? { expected: token.join.expected, arrived: token.join.arrived, threshold: token.join.threshold, failed: token.join.failed } : null,
      child: token.childRun ? summarizeRun(token.childRun) : null, createdAt: token.createdAt, updatedAt: token.updatedAt,
    })),
    recent: structuredClone(state.recent ?? []),
  };
}
export function panelState(stored, state) {
  return { defined: stored !== null, summary: stored ? describeDefinition(stored.definition) : 'no workflow defined', definition: state?.definition ?? stored?.definition ?? null, permissions: state?.permissions ?? stored?.permissions ?? null, run: state ? publicRun(state) : null };
}
