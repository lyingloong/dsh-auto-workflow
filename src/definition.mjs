/** Pure, generic graph definitions. Host permission grants are never part of a graph. */
export const API_VERSION = 2;
export const NODE_TYPES = ['agent', 'command', 'http', 'human', 'fanout', 'join', 'gate', 'subworkflow'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export class DefinitionError extends Error {
  constructor(errors) {
    super(`Invalid workflow definition:\n${errors.map(error => `  ${error.path}: ${error.message}`).join('\n')}`);
    this.name = 'DefinitionError'; this.code = 'invalid_definition'; this.errors = errors;
  }
}
export function normalizeDefinition(raw, { nested = false, depth = 0 } = {}) {
  if (depth > 8) throw new DefinitionError([{ path: '$', message: 'subworkflow nesting exceeds 8 levels' }]);
  const errors = [];
  const fail = (path, message) => errors.push({ path, message });
  const keys = (value, allowed, path) => {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${path}.${key}`, 'is not a known field');
  };
  const text = (value, path, max = 4000) => {
    if (typeof value !== 'string' || !value.trim() || value.length > max) fail(path, `must be non-empty text of at most ${max} characters`);
    return value;
  };
  const integer = (value, path, min, max) => {
    if (!Number.isInteger(value) || value < min || value > max) fail(path, `must be an integer between ${min} and ${max}`);
    return value;
  };
  if (!object(raw)) throw new DefinitionError([{ path: '$', message: 'must be an object' }]);
  keys(raw, ['apiVersion', 'name', 'description', 'entry', 'providers', 'nodes', 'edges', 'concurrency', 'historyLimit'], '$');
  if (raw.apiVersion !== API_VERSION) fail('$.apiVersion', 'must be 2');
  const name = text(raw.name, '$.name', 120);
  const description = raw.description == null || raw.description === '' ? '' : text(raw.description, '$.description', 2000);
  const concurrency = integer(raw.concurrency ?? (nested ? 1 : 4), '$.concurrency', 1, 32);
  if (nested && concurrency !== 1) fail('$.concurrency', 'nested workflows must be serial (concurrency1)');
  const historyLimit = integer(raw.historyLimit ?? 100, '$.historyLimit', 0, 1000);
  if (raw.providers !== undefined && !Array.isArray(raw.providers)) fail('$.providers', 'must be an array');
  const providers = (Array.isArray(raw.providers) ? raw.providers : []).map((value, i) => {
    const path = `$.providers[${i}]`;
    if (!object(value)) { fail(path, 'must be an object'); return {}; }
    keys(value, ['id', 'adapter', 'model', 'reasoningEffort', 'maxTokens'], path);
    text(value.id, `${path}.id`, 80);
    for (const key of ['adapter', 'model', 'reasoningEffort']) if (value[key] != null) text(value[key], `${path}.${key}`, 200);
    if (value.maxTokens != null) integer(value.maxTokens, `${path}.maxTokens`, 1, 1_000_000);
    return structuredClone(value);
  });
  if (!Array.isArray(raw.nodes) || !raw.nodes.length) fail('$.nodes', 'must be a non-empty array');
  const ids = new Set();
  const nodes = (Array.isArray(raw.nodes) ? raw.nodes : []).map((value, i) => {
    const path = `$.nodes[${i}]`;
    if (!object(value)) { fail(path, 'must be an object'); return {}; }
    keys(value, ['id', 'type', 'title', 'role', 'inputs', 'config', 'concurrency'], path);
    const id = text(value.id, `${path}.id`, 80);
    if (typeof id === 'string' && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) fail(`${path}.id`, 'must be a safe graph identifier');
    if (ids.has(id)) fail(`${path}.id`, 'duplicate node id');
    ids.add(id);
    if (!NODE_TYPES.includes(value.type)) fail(`${path}.type`, `must be one of ${NODE_TYPES.join(', ')}`);
    if (value.inputs !== undefined && !object(value.inputs)) fail(`${path}.inputs`, 'must be an object');
    if (value.config !== undefined && !object(value.config)) fail(`${path}.config`, 'must be an object');
    for (const key of ['title', 'role']) if (value[key] != null) text(value[key], `${path}.${key}`, 200);
    const config = object(value.config) ? structuredClone(value.config) : {};
    const node = { id, type: value.type, title: value.title ?? null, role: value.role ?? null, concurrency: integer(value.concurrency ?? 1, `${path}.concurrency`, 1, 32), config };
    // Omission inherits the previous envelope; an explicit {} really maps to {}.
    if (value.inputs !== undefined) node.inputs = structuredClone(value.inputs);
    if (config.maxFailures !== undefined) integer(config.maxFailures, `${path}.config.maxFailures`, 1, 20);
    if (config.timeoutMs !== undefined) integer(config.timeoutMs, `${path}.config.timeoutMs`, 0, 3_600_000);
    if (config.cwd !== undefined) text(config.cwd, `${path}.config.cwd`);
    if (node.type === 'agent') {
      for (const key of ['prompt', 'lane', 'provider', 'model', 'reasoningEffort', 'outcome']) if (config[key] !== undefined) text(config[key], `${path}.config.${key}`, key === 'prompt' ? 20_000 : 200);
      if (config.models !== undefined) {
        if (!Array.isArray(config.models) || config.models.length > 8) fail(`${path}.config.models`, 'must be an array of at most 8 candidates');
        else config.models.forEach((candidate, index) => {
          const p = `${path}.config.models[${index}]`;
          if (!object(candidate)) { fail(p, 'must be an object'); return; }
          keys(candidate, ['provider', 'model', 'reasoningEffort'], p);
          text(candidate.provider, `${p}.provider`, 120); text(candidate.model, `${p}.model`, 200);
          if (candidate.reasoningEffort !== undefined) text(candidate.reasoningEffort, `${p}.reasoningEffort`, 80);
        });
      }
    }
    if (node.type === 'command') {
      text(config.command, `${path}.config.command`);
      if (config.json !== undefined && typeof config.json !== 'boolean') fail(`${path}.config.json`, 'must be boolean');
    }
    if (node.type === 'http') text(config.url, `${path}.config.url`);
    if (['agent', 'human'].includes(node.type) && config.outcomes !== undefined && (!Array.isArray(config.outcomes) || !config.outcomes.length || config.outcomes.some(item => typeof item !== 'string' || !item))) fail(`${path}.config.outcomes`, 'must be a non-empty array of outcome strings');
    if (node.type === 'agent' && config.fallbackOutcome !== undefined) {
      if (typeof config.fallbackOutcome !== 'string' || !config.fallbackOutcome) fail(`${path}.config.fallbackOutcome`, 'must be a non-empty outcome string');
      const allowed = Array.isArray(config.outcomes) && config.outcomes.length ? config.outcomes : config.outcome ? [config.outcome] : ['complete'];
      if (!allowed.includes(config.fallbackOutcome)) fail(`${path}.config.fallbackOutcome`, 'must be one of the node outcomes');
    }
    if (node.type === 'fanout') {
      text(config.items, `${path}.config.items`); text(config.target, `${path}.config.target`, 80);
      if (config.join !== undefined) text(config.join, `${path}.config.join`, 80);
      if (config.detached !== undefined && typeof config.detached !== 'boolean') fail(`${path}.config.detached`, 'must be boolean');
      if (config.detached && config.join) fail(`${path}.config`, 'detached fanout cannot also join');
    }
    if (node.type === 'join') {
      if (!['all', 'any', 'quorum'].includes(config.mode ?? 'all')) fail(`${path}.config.mode`, 'must be all, any or quorum');
      if (config.mode === 'quorum' || config.count !== undefined) integer(config.count, `${path}.config.count`, 1, 10_000);
    }
    if (node.type === 'gate') {
      if (config.delayMs !== undefined) integer(config.delayMs, `${path}.config.delayMs`, 0, 86_400_000);
      if (config.newCycle !== undefined || config.consumeInput !== undefined) fail(`${path}.config`, 'cycle mutation is not supported; use independent packets');
    }
    if (nested && (node.concurrency !== 1 || ['human', 'fanout'].includes(node.type))) fail(path, 'nested workflows require serial nodes and cannot contain human/fanout; inline these graphs at the root');
    if (node.type === 'subworkflow') {
      if (!object(config.definition)) fail(`${path}.config.definition`, 'must be a graph definition');
      else {
        try { config.definition = normalizeDefinition(config.definition, { nested: true, depth: depth + 1 }); }
        catch (error) { if (!(error instanceof DefinitionError)) throw error; for (const item of error.errors) fail(`${path}.config.definition${item.path.slice(1)}`, item.message); }
      }
    }
    return node;
  });
  const entry = raw.entry ?? nodes[0]?.id;
  if (!ids.has(entry)) fail('$.entry', 'must reference a node');
  if (raw.edges !== undefined && !Array.isArray(raw.edges)) fail('$.edges', 'must be an array');
  const edges = (Array.isArray(raw.edges) ? raw.edges : []).map((value, i) => {
    const path = `$.edges[${i}]`;
    if (!object(value)) { fail(path, 'must be an object'); return {}; }
    keys(value, ['from', 'to', 'on'], path);
    if (!ids.has(value.from)) fail(`${path}.from`, 'unknown node');
    if (!ids.has(value.to)) fail(`${path}.to`, 'unknown node');
    const on = value.on ?? 'complete'; text(on, `${path}.on`, 80);
    return { from: value.from, to: value.to, on };
  });
  for (const node of nodes) if (node.type === 'fanout') {
    if (!ids.has(node.config.target)) fail(`$.nodes.${node.id}.config.target`, 'unknown target');
    if (node.config.join && !nodes.some(candidate => candidate.id === node.config.join && candidate.type === 'join')) fail(`$.nodes.${node.id}.config.join`, 'must reference a join node');
  }
  if (errors.length) throw new DefinitionError(errors);
  return { apiVersion: API_VERSION, name, description, entry, concurrency, historyLimit, providers, nodes, edges };
}
export function describeDefinition(definition) {
  return [`${definition.name} (v2 graph / packet execution)`, `entry: ${definition.entry}; capacity: ${definition.concurrency}; history: ${definition.historyLimit}`, ...definition.nodes.map(node => `  ${node.id} [${node.type}] capacity=${node.concurrency}${node.title ? ` ${node.title}` : ''}`)].join('\n');
}
