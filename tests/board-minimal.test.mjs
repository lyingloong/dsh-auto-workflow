/** Board UI modes: the minimal graph keeps agents and key gates only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../src/board.html', import.meta.url), 'utf8');

/** Extract one inline function by balancing braces (quotes aware enough for this file). */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} is present`);
  let depth = 0, quote = null, escaped = false;
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    const ch = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index);
      index = newline < 0 ? source.length : newline;
      continue;
    }
    if (ch === '/' && source[index + 1] === '*') {
      const close = source.indexOf('*/', index + 2);
      index = close < 0 ? source.length : close + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

test('minimal mode keeps agents and key gates, compresses hidden paths and fan-out targets', () => {
  const source = extractFunction(html, 'minimalDefinition');
  const minimalDefinition = new Function(`${source}; return minimalDefinition;`)();
  const definition = {
    nodes: [
      { id: 'plan', type: 'agent' }, { id: 'key-gate', type: 'gate' }, { id: 'busy-gate', type: 'gate' },
      { id: 'step', type: 'command' }, { id: 'fan', type: 'fanout', config: { target: 'worker' } },
      { id: 'worker', type: 'agent' }, { id: 'human', type: 'human' },
    ],
    edges: [
      { from: 'plan', to: 'step', on: 'complete' }, { from: 'step', to: 'worker', on: 'ready' },
      { from: 'key-gate', to: 'fan', on: 'complete' }, { from: 'busy-gate', to: 'plan', on: 'busy' },
      { from: 'worker', to: 'human', on: 'complete' }, { from: 'human', to: 'key-gate', on: 'approve' },
    ],
  };
  const minimal = minimalDefinition(definition);
  assert.deepEqual(minimal.nodes.map(node => node.id), ['plan', 'key-gate', 'worker']);
  assert.ok(minimal.edges.some(edge => edge.from === 'plan' && edge.to === 'worker'), 'hidden command path is compressed');
  assert.ok(minimal.edges.some(edge => edge.from === 'key-gate' && edge.to === 'worker'), 'fan-out target is an implied edge');
  assert.ok(minimal.edges.some(edge => edge.from === 'worker' && edge.to === 'key-gate'), 'paths through human nodes are compressed');
  assert.ok(!minimal.nodes.some(node => node.id === 'busy-gate'), 'busy retry gates stay infrastructure');
});

test('the board cycles full -> simplified -> minimal', () => {
  assert.match(html, /const GRAPH_MODES = \["full", "simple", "minimal"\]/);
  assert.match(html, /minimal: "极简/);
  assert.match(html, /cycleGraphMode\(\)/);
  assert.match(html, /graphMode === "minimal" \? null/);
});
