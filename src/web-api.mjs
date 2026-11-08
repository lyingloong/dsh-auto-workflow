/**
 * dsh-auto-workflow Web API and private board origin.
 *
 * Routes are session-scoped and share the tools' persistent execution owner and
 * artifact store. The board page is served both on the DSH web server (behind
 * the Connection fence) and on a dedicated token-protected loopback origin so
 * the native Browser sidebar tab can open it from a different localhost port.
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

import { SessionStore } from './store.mjs';
import { panelState } from './view.mjs';
import { WorkflowRunner } from './runner.mjs';

export const ROUTE_PREFIX = '/plugins/dsh-auto-workflow';
const MAX_BODY_BYTES = 1024 * 1024;
const SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const BOARD_HTML = readFileSync(new URL('./board.html', import.meta.url), 'utf8');

export function installWebApi({ ctx, dataRoot, storeFor: providedStoreFor = null, agents = new Map(), settings = {}, logger = console, runner = null }) {
  const root = path.resolve(dataRoot);
  const stores = new Map();
  const routes = new Map();
  const publicRoutes = new Map();
  const publicToken = typeof settings.boardToken === 'string' && settings.boardToken !== '' ? settings.boardToken : randomUUID();

  const storeFor = session => {
    if (typeof session !== 'string' || !SESSION_PATTERN.test(session)) {
      throw Object.assign(new Error('session must be a safe session id'), { code: 'invalid_session', status: 400 });
    }
    if (providedStoreFor) return providedStoreFor(session);
    if (!stores.has(session)) stores.set(session, new SessionStore(path.join(root, 'sessions', session)));
    return stores.get(session);
  };
  const ownsRunner = runner === null;
  runner ??= new WorkflowRunner({ ctx, storeFor, agents, settings: { subagentProvider: 'spawn', ...settings }, logger });

  const guard = handler => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (!error?.status && !error?.code) logger.error?.(`dsh-auto-workflow: request failed: ${error?.stack ?? error}`);
      if (res.headersSent) {
        res.destroy?.();
        return;
      }
      sendJson(res, error?.status ?? (error?.code ? 400 : 500), {
        error: { code: error?.code ?? 'internal', message: error?.message ?? String(error) },
      });
    }
  };
  const route = (suffix, handler) => routes.set(`${ROUTE_PREFIX}${suffix}`, guard(handler));
  const routePublic = (suffix, handler) => publicRoutes.set(`${ROUTE_PREFIX}${suffix}`, guard(handler));

  let boardBase = '';
  let boardServer = null;
  let resolveBoardReady;
  const boardReady = new Promise(resolve => { resolveBoardReady = resolve; });
  const tokenFor = session => createHmac('sha256', publicToken).update(session).digest('hex');
  const boardUrl = session => {
    if (!boardBase || typeof session !== 'string' || !SESSION_PATTERN.test(session)) return null;
    return `${boardBase}${ROUTE_PREFIX}/board?session=${encodeURIComponent(session)}&token=${encodeURIComponent(tokenFor(session))}`;
  };
  const authorizePublic = req => {
    const authority = boardBase && new URL(boardBase).host;
    if (!authority || req.headers?.host !== authority || (req.headers?.origin && req.headers.origin !== boardBase)) {
      throw Object.assign(new Error('untrusted board authority/origin'), { code:'forbidden', status:403 });
    }
    const url = new URL(req.url ?? '/', 'http://local');
    const token = url.searchParams.get('token') || req.headers?.['x-auto-workflow-token'];
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw Object.assign(new Error('invalid board token'), { code: 'unauthorized', status: 401 });
    url.privateToken = token;
    return url;
  };

  const loadState = async (store, runId) => {
    if (typeof runId === 'string' && runId !== '') return store.loadRun(runId);
    return store.latestRun();
  };
  const apiError = (status, code, message) => Object.assign(new Error(message), { status, code });
  const requestSession = (url, body = null) => {
    const query = url.searchParams.get('session');
    if (query !== null && body?.session !== undefined && query !== body.session) {
      throw apiError(400, 'invalid_session', 'body.session and query.session must match');
    }
    const session = body?.session ?? query;
    storeFor(session);
    if (url.privateToken && !timingSafeEqual(Buffer.from(url.privateToken, 'hex'), Buffer.from(tokenFor(session), 'hex'))) throw apiError(401, 'unauthorized', 'board token does not authorize this session');
    return session;
  };
  const requestBody = async req => {
    if (req.method !== 'POST') throw apiError(405, 'method_not_allowed', 'this operation requires POST');
    const body = await readJson(req);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw apiError(400, 'invalid_json', 'request body must be a JSON object');
    }
    return body;
  };
  const requireWorkflow = async store => {
    const stored = await store.loadDefinition();
    if (!stored) throw apiError(409, 'no_workflow', 'no workflow defined');
    return stored;
  };
  const respondState = async (res, session, state, status = 200, extras = {}) => {
    const store = storeFor(session);
    const stored = await store.loadDefinition();
    sendJson(res, status, {
      ...panelState(stored, state),
      control: await store.loadControl(),
      models: extras.models,
    });
  };

  const changeModel = async (req, res, url) => {
    const body = await requestBody(req);
    const session = requestSession(url, body);
    const result = await runner.updateModels(session, { nodeId: requireText(body.nodeId, 'nodeId'), models: body.models });
    const store = storeFor(session);
    const stored = await store.loadDefinition();
    sendJson(res, 200, {
      ...panelState(stored, result.state),
      control: await store.loadControl(),
      models: await readModelCatalog(ctx, result.definition),
    });
  };
  const controlRun = async (req, res, url) => {
    if (req.method === 'GET') {
      const store = storeFor(requestSession(url));
      return sendJson(res, 200, { control: await store.loadControl() });
    }
    const body = await requestBody(req);
    const session = requestSession(url, body);
    const result = await runner.control(session, {
      ...(body.continuous !== undefined ? { continuous: body.continuous } : {}),
      ...(body.nodeId !== undefined ? { nodeId: requireText(body.nodeId, 'nodeId'), enabled: body.enabled } : {}),
    });
    const store = storeFor(session);
    const stored = await store.loadDefinition();
    sendJson(res, 200, { ...panelState(stored, result.state), control: result.control });
  };
  const decideRun = async (req, res, url) => {
    const body = await requestBody(req);
    const session = requestSession(url, body);
    const state = await runner.decide(session, {
      ...(typeof body.runId === 'string' && body.runId !== '' ? { runId: body.runId } : {}),
      tokenId: requireText(body.tokenId, 'tokenId'),
      outcome: requireText(body.outcome, 'outcome'),
      output: body.output ?? null,
    });
    await respondState(res, session, state);
  };
  const dispatchRun = async (req, res, url) => {
    const body = await requestBody(req);
    const session = requestSession(url, body);
    const state = await runner.dispatch(session, typeof body.runId === 'string' && body.runId !== '' ? body.runId : undefined, {});
    await respondState(res, session, state, state.execution?.active ? 202 : 200);
  };
  const stopRun = async (req, res, url) => {
    const body = await requestBody(req);
    const session = requestSession(url, body);
    const result = await runner.stop(session);
    const store = storeFor(session);
    const state = await loadState(store, typeof body.runId === 'string' && body.runId !== '' ? body.runId : null);
    sendJson(res, result.requested ? 202 : 200, {
      ...result,
      ...(state ? panelState(await store.loadDefinition(), state) : {}),
      control: await store.loadControl(),
    });
  };
  const enqueueRun = async (req, res, url) => {
    const body = await requestBody(req);
    const session = requestSession(url, body);
    const state = await runner.enqueue(session, {
      input: body.input !== null && typeof body.input === 'object' ? body.input : {},
      ...(typeof body.nodeId === 'string' && body.nodeId !== '' ? { nodeId: body.nodeId } : {}),
      ...(typeof body.runId === 'string' && body.runId !== '' ? { runId: body.runId } : {}),
    });
    await respondState(res, session, state);
  };
  const stateFor = async url => {
    const session = requestSession(url);
    const store = storeFor(session);
    const stored = await store.loadDefinition();
    const state = await loadState(store, url.searchParams.get('runId'));
    return { ...panelState(stored, state), control: await store.loadControl() };
  };
  const modelsFor = async url => {
    const session = requestSession(url);
    const stored = await storeFor(session).loadDefinition();
    return readModelCatalog(ctx, stored?.definition);
  };
  const historyFor = async url => {
    const session = requestSession(url);
    const runId = requireText(url.searchParams.get('runId'), 'runId');
    const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get('limit')) || 30));
    const items = await storeFor(session).readHistory(runId, {
      ...(url.searchParams.get('nodeId') ? { nodeId: url.searchParams.get('nodeId') } : {}),
      ...(url.searchParams.get('packetId') ? { packetId: url.searchParams.get('packetId') } : {}),
      limit,
    });
    return { items };
  };
  const artifactFor = async url => {
    const session = requestSession(url);
    const runId = requireText(url.searchParams.get('runId'), 'runId');
    const ref = requireText(url.searchParams.get('ref'), 'ref');
    try {
      const value = await storeFor(session).readArtifact(runId, ref, { maxBytes: 256 * 1024 });
      return { ref, value, bytes: Buffer.byteLength(JSON.stringify(value), 'utf8'), truncated: false };
    } catch (error) {
      if (error?.code !== 'artifact_too_large') throw error;
      return { ref, value: { note: 'Artifact exceeds the board read limit. Inspect the underlying workflow data or files in the run cwd.' }, bytes: null, truncated: true };
    }
  };

  const jsonRoute = handler => async (req, res) => {
    if (req.method !== 'GET') throw apiError(405, 'method_not_allowed', 'GET required');
    const url = new URL(req.url ?? '/', 'http://local');
    sendJson(res, 200, await handler(url));
  };

  route('/api/state', jsonRoute(stateFor));
  route('/api/models', jsonRoute(modelsFor));
  route('/api/history', jsonRoute(historyFor));
  route('/api/artifact', jsonRoute(artifactFor));
  route('/api/board-url', async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const base = boardBase || await boardReady;
    sendJson(res, 200, { url: base ? (boardUrl(url.searchParams.get('session')) ?? '') : '' });
  });
  route('/api/node-model', (req, res) => changeModel(req, res, new URL(req.url ?? '/', 'http://local')));
  route('/api/control', (req, res) => controlRun(req, res, new URL(req.url ?? '/', 'http://local')));
  route('/api/decide', (req, res) => decideRun(req, res, new URL(req.url ?? '/', 'http://local')));
  route('/api/run', (req, res) => dispatchRun(req, res, new URL(req.url ?? '/', 'http://local')));
  route('/api/stop', (req, res) => stopRun(req, res, new URL(req.url ?? '/', 'http://local')));
  route('/api/enqueue', (req, res) => enqueueRun(req, res, new URL(req.url ?? '/', 'http://local')));

  const serveBoard = (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    res.end(BOARD_HTML);
  };
  route('/board', async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    storeFor(url.searchParams.get('session'));
    serveBoard(req, res);
  });

  // Token-protected loopback mirror used by the native Browser sidebar tab.
  routePublic('/board', async (req, res) => {
    const url = authorizePublic(req);
    requestSession(url);
    serveBoard(req, res);
  });
  routePublic('/api/state', (req, res) => guard(async () => {
    const url = authorizePublic(req);
    sendJson(res, 200, await stateFor(url));
  })(req, res));
  routePublic('/api/models', (req, res) => guard(async () => {
    const url = authorizePublic(req);
    sendJson(res, 200, await modelsFor(url));
  })(req, res));
  routePublic('/api/history', (req, res) => guard(async () => {
    const url = authorizePublic(req);
    sendJson(res, 200, await historyFor(url));
  })(req, res));
  routePublic('/api/artifact', (req, res) => guard(async () => {
    const url = authorizePublic(req);
    sendJson(res, 200, await artifactFor(url));
  })(req, res));
  routePublic('/api/board-url', (req, res) => guard(async () => {
    const url = authorizePublic(req);
    requestSession(url);
    const base = boardBase || await boardReady;
    sendJson(res, 200, { url: base ? (boardUrl(url.searchParams.get('session')) ?? '') : '' });
  })(req, res));
  routePublic('/api/node-model', (req, res) => guard(async () => changeModel(req, res, authorizePublic(req)))(req, res));
  routePublic('/api/control', (req, res) => guard(async () => controlRun(req, res, req.method === 'GET' ? authorizePublic(req) : authorizePublic(req)))(req, res));
  routePublic('/api/decide', (req, res) => guard(async () => decideRun(req, res, authorizePublic(req)))(req, res));
  routePublic('/api/run', (req, res) => guard(async () => dispatchRun(req, res, authorizePublic(req)))(req, res));
  routePublic('/api/stop', (req, res) => guard(async () => stopRun(req, res, authorizePublic(req)))(req, res));
  routePublic('/api/enqueue', (req, res) => guard(async () => enqueueRun(req, res, authorizePublic(req)))(req, res));

  let attached = false;
  const closeBoardServer = async () => {
    const server = boardServer;
    boardServer = null;
    boardBase = '';
    resolveBoardReady(null);
    if (server) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
    if (ownsRunner) await runner.dispose();
  };
  const startBoardServer = () => {
    if (boardServer) return;
    const server = createServer(guard(async (req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://local').pathname;
      const handler = publicRoutes.get(pathname);
      if (!handler) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('not found');
        return;
      }
      Promise.resolve(handler(req, res)).catch(error => {
        logger.warn?.(`dsh-auto-workflow: board server failed: ${error?.message ?? error}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          res.end('board server error');
        } else {
          res.destroy?.();
        }
      });
    }));
    server.on('error', error => {
      logger.warn?.(`dsh-auto-workflow: board server unavailable: ${error?.message ?? error}`);
      resolveBoardReady(null);
    });
    server.listen(Number(settings.boardPort ?? 0), '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        boardBase = `http://127.0.0.1:${address.port}`;
        resolveBoardReady(boardBase);
      } else {
        resolveBoardReady(null);
      }
    });
    server.unref?.();
    boardServer = server;
  };
  if (typeof ctx.effect === 'function') ctx.effect(() => {
    startBoardServer();
    return closeBoardServer;
  }, 'dsh-auto-workflow: board server');
  else startBoardServer();

  const connection = () => ctx.get?.('connection');
  const authenticated = handler => async (req, res) => {
    const gate = connection();
    const rejection = typeof gate?.requestRejection !== 'function' ? 503 : gate.requestRejection(req);
    if (rejection !== undefined) {
      sendJson(res, rejection, {
        error: rejection === 503 ? 'authentication unavailable' : rejection === 401 ? 'unauthorized' : 'forbidden',
      });
      return;
    }
    await handler(req, res);
  };
  const attach = () => {
    if (attached) return true;
    const server = ctx.get?.('webServer') ?? ctx.get?.('httpServer');
    if (!server || typeof server.register !== 'function') return false;
    attached = true;
    for (const [routePath, handler] of routes) {
      const register = () => server.register({ kind: 'exact', path: routePath, handler: authenticated(handler) });
      if (typeof ctx.effect === 'function') ctx.effect(register, `dsh-auto-workflow: ${routePath}`);
      else register();
    }
    return true;
  };
  attach();
  if (!attached && typeof ctx.on === 'function') {
    ctx.on('internal/service', name => {
      if (name === 'webServer' || name === 'httpServer') attach();
    });
  }

  return { routes, publicRoutes, attach, boardUrl, boardReady, closeBoardServer, publicToken, runner };
}

async function readModelCatalog(ctx, definition) {
  const providers = new Map();
  const addProvider = (id, name) => {
    if (typeof id !== 'string' || id === '') return null;
    if (!providers.has(id)) providers.set(id, { id, name: typeof name === 'string' && name !== '' ? name : id, models: [] });
    return providers.get(id);
  };
  const addModel = (provider, model) => {
    if (!model || typeof model.id !== 'string' || model.id === '') return;
    const efforts = normalizeEfforts(model.reasoningEfforts ?? model.reasoning?.efforts);
    const existing = provider.models.find(item => item.id === model.id);
    if (existing) {
      if (efforts.length) existing.reasoningEfforts = efforts;
      return existing;
    }
    const entry = {
      id: model.id,
      name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id,
      ...(typeof model.description === 'string' ? { description: model.description } : {}),
      reasoningEfforts: efforts,
    };
    provider.models.push(entry);
    return entry;
  };

  const llm = ctx.get?.('llm');
  if (llm && typeof llm.listProviders === 'function') {
    try {
      const list = await llm.listProviders();
      for (const item of Array.isArray(list) ? list : []) {
        const id = item?.id ?? item?.provider;
        const provider = addProvider(id, item?.name ?? item?.displayName);
        if (!provider || typeof llm.listModels !== 'function') continue;
        const models = await Promise.resolve(llm.listModels(id)).catch(() => []);
        for (const model of Array.isArray(models) ? models.slice(0, 100) : []) addModel(provider, model);
        // listModels is advisory and usually omits reasoning metadata; resolve
        // each exact model so the board offers only its real effort levels.
        if (typeof llm.resolveModelInfo === 'function') {
          const resolved = await Promise.allSettled(provider.models.map(entry => llm.resolveModelInfo(id, entry.id)));
          for (const result of resolved) {
            if (result.status !== 'fulfilled') continue;
            const info = result.value;
            const entry = provider.models.find(item => item.id === info?.id);
            if (entry) entry.reasoningEfforts = normalizeEfforts(info?.reasoning?.efforts);
          }
        }
      }
    } catch {
      // The catalog is advisory; lanes and saved candidates below still appear.
    }
  }
  for (const lane of definition?.providers ?? []) {
    if (typeof lane.adapter !== 'string' || lane.adapter === '') continue;
    const provider = addProvider(lane.adapter, lane.adapter);
    if (provider && typeof lane.model === 'string' && lane.model !== '' && lane.model !== 'host-default') {
      addModel(provider, { id: lane.model, name: lane.model });
    }
  }
  for (const node of definition?.nodes ?? []) {
    if (node.type !== 'agent') continue;
    for (const candidate of Array.isArray(node.config?.models) ? node.config.models : []) {
      if (candidate?.provider && candidate?.model) addModel(addProvider(candidate.provider, candidate.provider), { id: candidate.model });
    }
    if (node.config?.provider && node.config?.model) {
      addModel(addProvider(node.config.provider, node.config.provider), { id: node.config.model });
    }
  }

  let defaultSelection = null;
  try {
    defaultSelection = ctx.get?.('agentDefaultModel')?.currentSelection?.() ?? null;
  } catch {
    // A host without a default selection still shows the discovered list.
  }
  return { providers: [...providers.values()], default: defaultSelection };
}

function normalizeEfforts(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const efforts = [];
  for (const item of value) {
    const id = typeof item === 'string' ? item : item?.id;
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue;
    seen.add(id);
    efforts.push({ id, label: typeof item?.name === 'string' && item.name !== '' ? item.name : id });
  }
  return efforts;
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
  });
  res.end(JSON.stringify(value));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('request body is too large'), { code: 'payload_too_large', status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(Object.assign(new Error('request body is not valid JSON'), { code: 'invalid_json', status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function requireText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw Object.assign(new Error(`${label} must be a non-empty string`), { code: 'invalid_argument', status: 400 });
  }
  return value.trim();
}
