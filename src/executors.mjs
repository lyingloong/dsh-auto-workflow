/**
 * v2 execution plane: mount agent, command and HTTP executors.
 *
 * The runtime owns scheduling and permissions; these executors only perform one
 * node's work. Agent nodes use the host subagent service and the lane's
 * agentOptions; command nodes use a shell with a bounded buffer/timeout; HTTP
 * nodes use fetch with a timeout. Permission checks happen in the runtime
 * before any executor is called.
 */

import path from 'node:path';
import { executeCommand } from './command.mjs';
import { requireHttp } from './permissions.mjs';
import { stat } from 'node:fs/promises';



// Model/development work has no default wall-clock deadline.
// A positive explicit node/settings timeout is opt-in; 0 disables it.
const DEFAULT_AGENT_TIMEOUT_MS = 0;

export function createExecutors({ ctx, exec, settings = {}, cwd, onActivity }) {
  const subagents = ctx.get?.('subagents');
  return {
    async agent({ node, input, context, definition, token }) {
      if (!subagents || typeof subagents.startActivation !== 'function') {
        throw new Error('no subagent service is mounted');
      }
      const lane = (definition.providers ?? []).find(provider => provider.id === node.config.lane) ?? null;
      const agentCwd = node.config.cwd ? path.resolve(cwd, node.config.cwd) : cwd;
      const outcomes = Array.isArray(node.config.outcomes) && node.config.outcomes.length > 0
        ? node.config.outcomes
        : node.config.outcome ? [node.config.outcome] : ['complete'];
      const fallbackOutcome = typeof node.config.fallbackOutcome === 'string' && outcomes.includes(node.config.fallbackOutcome)
        ? node.config.fallbackOutcome
        : null;
      const prompt = agentPrompt({ definition, node, input, context, outcomes });
      const candidates = modelCandidates(node, lane);
      const providerName = settings.subagentProvider ?? 'spawn';
      // The host's structured output is a child-scoped `structured_output` tool
      // whose arguments are validated against this schema; its result arrives as
      // SubagentResult.structured. Providers that do not advertise the capability
      // keep the text JSON protocol.
      const outputSchema = providerSupportsOutputSchema(subagents, providerName) ? agentOutputSchema(outcomes) : null;
      const scope = executionScope(exec.signal, node.config.timeoutMs ?? settings.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS, `agent ${node.id}`);
      const failures = [];
      try {
        try {
          for (const candidate of candidates) {
          let activation;
          let failure;
          try {
            throwIfAborted(scope.signal);
            const options = agentOptionsFor(candidate, lane);
            const model = { provider: options?.provider ?? null, model: options?.model ?? null };
            // Startup receives the same deadline/cancellation signal. Drain its
            // admission before leaving, so a late handle cannot be orphaned.
            //
            // The host's SubagentActivationSpec carries the task fields at the
            // top level since DSH 0.2.2-rc.2; earlier hosts read the removed
            // nested `request` object. `label`/`signal` stay after the spread
            // so they take precedence.
            activation = await subagents.startActivation({
              provider: providerName,
              prompt: [{ type: 'text', text: prompt }],
              parent: exec.agent,
              cwd: agentCwd,
              ...(options ? { agentOptions: options } : {}),
              ...(outputSchema ? { outputSchema } : {}),
              label: `workflow:${node.id}`,
              signal: scope.signal,
              delivery: 'caller',
            });
            const resultPromise = Promise.resolve(activation.result);
            // A fast rejection must stay handled while the activity checkpoint
            // is pending, even if that checkpoint subsequently fails.
            resultPromise.catch(() => {});
            throwIfAborted(scope.signal);
            if (onActivity) {
              try {
                await onActivity(token, { childId: activation.childId, ...model });
              } catch (error) {
                throw executionError('activity_persistence_failed', `cannot record child for ${node.id}: ${error.message ?? error}`, error);
              }
            }
            const result = await waitWithSignal(resultPromise, scope.signal);
            if (result?.stopReason === 'aborted') {
              throw executionError('execution_aborted', result.diagnostic ?? `agent ${node.id} was aborted`);
            }
            if (result?.stopReason === 'error') throw new Error(result.diagnostic ?? 'Provider call failed');
            if (result?.stopReason !== 'completed') throw executionError('agent_incomplete', result?.diagnostic ?? ('Subagent stopped: ' + result?.stopReason));
            const structured = structuredAgentResult(result?.structured, outcomes);
            if (structured) return { ...structured, model };
            const text = textOf(result?.output);
            try {
              const parsed = parseAgentText(text, { outcomes, fallback: outcomes[0] });
              return { ...parsed, model };
            } catch (error) {
              if (error?.code !== 'invalid_agent_output') throw error;
              const excerpt = textExcerpt(text);
              throw executionError('invalid_agent_output', `${error.message}${excerpt ? ` (final text: ${excerpt})` : ''}`);
            }
          } catch (error) {
            failure = cancellationError(error, scope.signal);
            if (['execution_aborted', 'execution_timeout', 'invalid_agent_output', 'activity_persistence_failed', 'agent_incomplete'].includes(failure.code)) throw failure;
            failures.push(`${candidateLabel(candidate)}: ${failure?.message ?? String(failure)}`);
          } finally {
            if (activation && typeof activation.dispose === 'function') {
              try {
                await activation.dispose();
              } catch (error) {
                // Never start another model while a previous child's release
                // failed. Preserve cancellation instead of hiding it in cleanup.
                if (failure) throw failure;
                throw cancellationError(executionError('activation_disposal_failed', `cannot release child for ${node.id}: ${error.message ?? error}`, error), scope.signal);
              }
            }
            throwIfAborted(scope.signal);
          }
        }
        throw new Error(`all model candidates failed: ${failures.join('; ')}`);
        } catch (error) {
          const failure = cancellationError(error, scope.signal);
          // An opt-in business fallback lets a node such as an intent classifier
          // ask for clarification when the model is unavailable or malformed,
          // while cancellation and persistence failures stay terminal.
          if (fallbackOutcome && !['execution_aborted', 'execution_timeout', 'activity_persistence_failed', 'activation_disposal_failed'].includes(failure.code)) {
            return { outcome: fallbackOutcome, output: { error: String(failure.message ?? failure).slice(0, 1000), fallback: true }, model: null };
          }
          throw failure;
        }
      } finally {
        scope.dispose();
      }
    },
    async command({ node, input, token, context }) {
      const commandCwd = node.config.cwd ? path.resolve(cwd, node.config.cwd) : cwd;
      const command = node.config.command;
      const scope = executionScope(exec.signal, node.config.timeoutMs ?? 120_000, `command ${node.id}`);
      // JSON command nodes exchange exactly one small JSON value with the script:
      // input through DSH_WORKFLOW_INPUT and a {outcome, output} result on stdout.
      // Run/token metadata lets example locks record their owner for audit and
      // stale-lock diagnosis without the script reading host internals.
      const workflowEnv = {
        ...(context?.runId ? { DSH_WORKFLOW_RUN_ID: String(context.runId) } : {}),
        ...(token?.id ? { DSH_WORKFLOW_TOKEN_ID: String(token.id) } : {}),
        ...(token?.packetId ? { DSH_WORKFLOW_PACKET_ID: String(token.packetId) } : {}),
      };
      const environment = node.config.json === true
        ? { ...process.env, ...workflowEnv, DSH_WORKFLOW_INPUT: JSON.stringify(input ?? null) }
        : { ...process.env, ...workflowEnv };
      try {
        throwIfAborted(scope.signal);
        await preflightCommand(command, commandCwd);
        throwIfAborted(scope.signal);
        let stdout;
        let stderr;
        try {
          ({ stdout, stderr } = await executeCommand(command, {
            cwd: commandCwd,
            env: environment,
            signal: scope.signal,
            maxBuffer: 1_000_000,
          }));
        } catch (error) {
          const failure = cancellationError(error, scope.signal);
          if (['execution_aborted', 'execution_timeout'].includes(failure.code)) throw failure;
          const code = typeof error.code === 'number' ? error.code : 1;
          stdout = typeof error.stdout === 'string' ? error.stdout : '';
          stderr = typeof error.stderr === 'string' ? error.stderr : '';
          // A business failure still prints one valid JSON result; keep its
          // outcome instead of discarding evidence as a shell error.
          if (['command_output_limit', 'command_cleanup_failed'].includes(error.code)) throw error;
          if (node.config.json === true) {
            if (typeof error.code !== 'number') throw error;
            return parseCommandResult(stdout, { code, stderr, cwd: commandCwd, command });
          }
          return { outcome: 'fail', output: { stdout, stderr, code, cwd: commandCwd, command } };
        }
        throwIfAborted(scope.signal);
        if (node.config.json === true) return parseCommandResult(stdout, { code: 0, stderr, cwd: commandCwd, command });
        return { outcome: 'complete', output: { stdout, stderr, code: 0, cwd: commandCwd, command } };
      } finally {
        scope.dispose();
      }
    },
    async http({ node, permissions }) {
      const scope = executionScope(exec.signal, node.config.timeoutMs ?? 30_000, `http ${node.id}`);
      try {
        throwIfAborted(scope.signal);
        let method = (node.config.method ?? 'GET').toUpperCase();
        const headers = { ...(node.config.headers ?? {}) };
        let body;
        if (node.config.body !== undefined) {
          body = typeof node.config.body === 'string' ? node.config.body : JSON.stringify(node.config.body);
          if (!Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
        }
        let url = node.config.url, response;
        for (let hop = 0; ; hop++) {
          requireHttp(permissions?.http, url);
          response = await waitWithSignal(fetch(url, { method, headers, body, signal: scope.signal, redirect: 'manual' }), scope.signal);
          if (![301,302,303,307,308].includes(response.status) || !response.headers.has('location')) break;
          const target = new URL(response.headers.get('location'), url).href;
          await response.body?.cancel();
          if (hop >= 5) throw executionError('too_many_redirects', 'HTTP redirect limit exceeded');
          requireHttp(permissions?.http, target);
          if (new URL(target).origin !== new URL(url).origin) for (const key of Object.keys(headers)) {
            if (['authorization','cookie','proxy-authorization'].includes(key.toLowerCase())) delete headers[key];
          }
          if (response.status === 303 || ([301,302].includes(response.status) && method === 'POST')) { method = 'GET'; body = undefined; }
          url = target;
        }
        const { text, truncated } = await boundedBody(response, scope.signal);
        return { outcome: response.ok ? 'complete' : 'fail', output: { status: response.status, ok: response.ok, body: text, truncated } };
      } catch (error) {
        throw cancellationError(error, scope.signal);
      } finally {
        scope.dispose();
      }
    },
  };
}

async function boundedBody(response, signal) {
  const reader = response.body?.getReader(); if (!reader) return { text:'', truncated:false };
  const chunks = []; let size = 0, truncated = false;
  try {
    while (true) {
      const { done, value } = await waitWithSignal(reader.read(), signal); if (done) break;
      const remaining = 40_000 - size; chunks.push(value.subarray(0, Math.max(0, remaining))); size += value.length;
      if (size > 40_000) { truncated = true; await reader.cancel(); break; }
    }
    return { text:Buffer.concat(chunks).toString('utf8'), truncated };
  } finally { reader.releaseLock(); }
}

function executionError(code, message, cause) {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}

function executionScope(parentSignal, timeoutMs, label) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) {
    throw executionError('invalid_execution_timeout', `${label} timeoutMs must be 0 (disabled) or a positive integer no greater than 2147483647`);
  }
  const controller = new AbortController();
  const abort = () => controller.abort(executionError('execution_aborted', `${label} cancelled`, parentSignal?.reason));
  parentSignal?.addEventListener('abort', abort, { once: true });
  if (parentSignal?.aborted) abort();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(executionError('execution_timeout', `${label} exceeded ${timeoutMs}ms`)), timeoutMs) : null;
  return {
    signal: controller.signal,
    dispose() {
      if (timer !== null) clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abort);
    },
  };
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason;
}

function cancellationError(error, signal) {
  if (signal.aborted) return signal.reason;
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
    return executionError('execution_aborted', error.message ?? 'execution aborted', error);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function waitWithSignal(promise, signal) {
  // Attach to the producer even when already cancelled, containing a later
  // rejection while the activation's finally block drains its handle.
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    Promise.resolve(promise).then(
      value => { signal.removeEventListener('abort', abort); signal.aborted ? reject(signal.reason) : resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(signal.aborted ? signal.reason : error); },
    );
  });
}

async function preflightCommand(command, cwd) {
  // Check direct npm script invocations only. --prefix intentionally selects a
  // different project; shell programs that change directory own that behavior.
  const directNpmScript = /^\s*(?:npm(?:\.cmd|\.exe)?|["']npm(?:\.cmd|\.exe)?["'])\s+(?:test|t|run|run-script)(?:\s|$)/i.test(command);
  if (!directNpmScript || /(?:^|\s)--prefix(?:\s|=)/.test(command)) return;
  const manifest = path.join(cwd, 'package.json');
  try {
    if ((await stat(manifest)).isFile()) return;
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
  }
  throw Object.assign(executionError('invalid_command_cwd', `cannot run ${command} in ${cwd}: package.json is missing; select the project cwd before retrying`), { cwd, command });
}

function modelCandidates(node, lane) {
  if (Array.isArray(node.config.models) && node.config.models.length > 0) {
    return node.config.models.map(entry => ({
      provider: entry.provider ?? null,
      model: entry.model ?? null,
      reasoningEffort: entry.reasoningEffort ?? null,
    }));
  }
  const provider = node.config.provider ?? lane?.adapter ?? null;
  const model = node.config.model ?? lane?.model ?? null;
  return [{ provider, model, reasoningEffort: node.config.reasoningEffort ?? lane?.reasoningEffort ?? null }];
}

function agentOptionsFor(candidate, lane) {
  const options = {};
  const provider = candidate.provider ?? lane?.adapter;
  const model = candidate.model ?? lane?.model;
  if (provider) options.provider = provider;
  if (model && model !== 'host-default') options.model = model;
  // A candidate without effort uses its own model default, not another lane's effort.
  const reasoningEffort = candidate.reasoningEffort;
  if (reasoningEffort) options.reasoningEffort = reasoningEffort;
  if (lane?.maxTokens) options.maxTokens = lane.maxTokens;
  return Object.keys(options).length > 0 ? options : null;
}

function candidateLabel(candidate) {
  if (!candidate.provider && !candidate.model) return 'host-default';
  return `${candidate.provider ?? 'host-default'}/${candidate.model ?? 'host-default'}`;
}

function commandResultError(message) {
  return executionError('invalid_command_output', message);
}

/** Accept exactly one trailing JSON decision from a JSON command node. */
export function parseCommandResult(stdout, { code = 0, stderr = '', cwd = '', command = '' } = {}) {
  const text = String(stdout ?? '').trim();
  if (text === '') throw commandResultError('JSON command node printed no result; expected {"outcome":"...","output":...}');
  let value;
  try { value = JSON.parse(text); }
  catch {
    const objects = jsonObjects(text);
    if (objects.length !== 1 || text.slice(objects[0].end).trim() !== '') throw commandResultError('JSON command needs one final unambiguous result');
    value = objects[0].value;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw commandResultError('JSON command node must print one object: {"outcome":"...","output":...}');
  }
  if (typeof value.outcome !== 'string' || value.outcome.trim() === '') {
    throw commandResultError('JSON command result needs a non-empty "outcome" string');
  }
  return {
    outcome: value.outcome,
    output: Object.hasOwn(value, 'output') ? value.output : value,
  };
}

export function agentPrompt({ definition, node, input, context, outcomes }) {  return [
    `You are executing node "${node.id}" of workflow "${definition.name}".`,
    node.role ? `Role: ${node.role}` : '',
    node.config.prompt ? `Instructions:\n${node.config.prompt}` : '',
    `Input:\n${JSON.stringify(input, null, 2)}`,
    `Context:\n${JSON.stringify(context, null, 2)}`,
    `Allowed outcomes: ${outcomes.join(', ')}`,
    'Do the work with the tools you have. Do not create workflows or spawn agents.',
    'Reply with a JSON object: {"outcome":"<one of the allowed outcomes>","output":<any JSON>}.',
    'Choose one outcome only when supported by the work. Never default to the first outcome; if none is justified, explain the uncertainty instead of claiming success.',
  ].filter(Boolean).join('\n\n');
}

export function parseAgentText(text, { outcomes, fallback = outcomes[0] }) {
  const trimmed = text.trim();
  const invalid = reason => executionError('invalid_agent_output', `${reason}; expected one explicit outcome: ${outcomes.join(', ')}`);
  if (trimmed === '') throw invalid('agent returned no text');
  if (outcomes.includes(trimmed)) return { outcome: trimmed, output: { text: trimmed } };

  let objects;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw invalid('agent response is not an object');
    }
    objects = [{ value: parsed, end: trimmed.length }];
  } catch (error) {
    if (error.code === 'invalid_agent_output') throw error;
    // Accept fenced JSON and leading commentary without mistaking nested output
    // objects or braces inside strings for additional decisions.
    objects = jsonObjects(trimmed);
  }
  const decisions = objects.filter(({ value }) => Object.hasOwn(value, 'outcome'));
  if (decisions.length > 1) throw invalid('agent returned multiple decision objects');
  const candidate = decisions[0] ?? (objects.length === 1 ? objects[0] : null);
  if (candidate) {
    const suffix = trimmed.slice(candidate.end).trim();
    if (suffix !== '' && suffix !== '```') throw invalid('decision is not the final response');
    const parsed = candidate.value;
    if (Object.hasOwn(parsed, 'outcome') && !outcomes.includes(parsed.outcome)) throw invalid('agent returned an unknown outcome');
    if (!Object.hasOwn(parsed, 'outcome')) throw invalid('agent omitted its outcome');
    return {
      outcome: parsed.outcome ?? outcomes[0],
      output: Object.hasOwn(parsed, 'output') ? parsed.output : parsed,
    };
  }
  throw invalid('agent response contains no unambiguous decision');
}

function providerSupportsOutputSchema(subagents, name) {
  if (typeof subagents?.getProvider !== 'function') return false;
  try {
    return subagents.getProvider(name)?.capabilities?.outputSchema === true;
  } catch {
    return false;
  }
}

/** The host validates this schema when the child calls `structured_output`. */
function agentOutputSchema(outcomes) {
  return {
    type: 'object',
    properties: {
      outcome: { type: 'string', enum: [...outcomes] },
      output: {},
    },
    required: ['outcome'],
    additionalProperties: true,
  };
}

function structuredAgentResult(value, outcomes) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const outcome = value.outcome;
  if (typeof outcome !== 'string' || !outcomes.includes(outcome)) {
    throw executionError('invalid_agent_output', `structured result returned an unknown outcome; expected one of: ${outcomes.join(', ')}`);
  }
  return { outcome, output: Object.hasOwn(value, 'output') ? value.output : value };
}

export function textExcerpt(text, limit = 300) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(-limit);
}

function jsonObjects(text) {
  const objects = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (depth === 0) {
      if (char === '{') { start = index; depth = 1; }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) {
      try {
        objects.push({ value: JSON.parse(text.slice(start, index + 1)), end: index + 1 });
      } catch {
        // Prose/code braces are not a decision object.
      }
    }
  }
  return objects;
}

export function textOf(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n').trim();
}
