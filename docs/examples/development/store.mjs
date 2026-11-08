/** Workflow-owned business storage. The generic plugin never imports this module. */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, lstat, realpath, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const directories = ['requirements', 'seeds', 'artifacts', 'reviews', 'worktrees', 'locks'];
const pendingStatuses = new Set(['queued', 'intake', 'requirement-pending', 'requirement-revision', 'ready', 'preparing', 'engineering-ready', 'engineering']);

/** Baseline discovery directions; actual requirements are still model-proposed. */
export const baselineSeeds = Object.freeze([
  { id: 'seed-baseline-docs', title: 'Documentation gaps', evidence: 'Baseline discovery direction. Inspect README, docs, examples and comments; propose only a concrete evidence-backed gap.', tags: ['docs'], category: 'docs' },
  { id: 'seed-baseline-refactor', title: 'Refactoring opportunities', evidence: 'Baseline discovery direction. Inspect duplication, module boundaries, dead code and awkward interfaces; propose only a bounded improvement.', tags: ['refactor'], category: 'refactor' },
  { id: 'seed-baseline-page', title: 'Pages and navigation', evidence: 'Baseline discovery direction. Inspect routing, page states, loading/empty/error behavior and navigation; propose only a user-visible gap.', tags: ['page', 'ux'], category: 'page' },
  { id: 'seed-baseline-chore', title: 'Build and repository chores', evidence: 'Baseline discovery direction. Inspect scripts, CI, dependencies, release and local setup; propose only a concrete maintenance need.', tags: ['chore', 'tooling'], category: 'chore' },
  { id: 'seed-baseline-tests', title: 'Test coverage gaps', evidence: 'Baseline discovery direction. Inspect tests, fixtures and untested error paths; propose only a measurable missing case.', tags: ['tests'], category: 'tests' },
  { id: 'seed-baseline-bugfix', title: 'Correctness and regressions', evidence: 'Baseline discovery direction. Inspect recent changes, edge cases and failing behavior; propose only a reproducible defect or regression.', tags: ['bugfix', 'correctness'], category: 'bugfix' },
  { id: 'seed-baseline-performance', title: 'Performance and resource use', evidence: 'Baseline discovery direction. Inspect hot paths, startup, memory and unnecessary work; propose only a measurable target.', tags: ['performance'], category: 'performance' },
  { id: 'seed-baseline-security', title: 'Security and data safety', evidence: 'Baseline discovery direction. Inspect input validation, permissions, secrets and destructive paths; propose only a concrete risk reduction.', tags: ['security'], category: 'security' },
  { id: 'seed-baseline-reliability', title: 'Reliability and error handling', evidence: 'Baseline discovery direction. Inspect retries, cancellation, partial failure and error messages; propose only a reproducible reliability gap.', tags: ['reliability'], category: 'reliability' },
  { id: 'seed-baseline-ux-accessibility', title: 'UX and accessibility', evidence: 'Baseline discovery direction. Inspect keyboard access, screen-reader semantics, empty states and copy; propose only a concrete usability gap.', tags: ['ux', 'accessibility'], category: 'ux' },
  { id: 'seed-baseline-data-api', title: 'Data and API contracts', evidence: 'Baseline discovery direction. Inspect schemas, migrations, compatibility and error contracts; propose only a concrete consistency need.', tags: ['data', 'api'], category: 'data' },
  { id: 'seed-baseline-dx-tooling', title: 'Developer experience and tooling', evidence: 'Baseline discovery direction. Inspect local setup, scripts, diagnostics and dev loop; propose only a concrete friction reduction.', tags: ['dx', 'tooling'], category: 'dx' },
  { id: 'seed-baseline-observability', title: 'Observability', evidence: 'Baseline discovery direction. Inspect logs, metrics, traces and failure diagnosis; propose only a concrete blind spot.', tags: ['observability'], category: 'observability' },
  { id: 'seed-baseline-dependencies', title: 'Dependencies and maintenance', evidence: 'Baseline discovery direction. Inspect outdated or risky dependencies and lockfile hygiene; propose only a bounded maintenance need.', tags: ['dependencies'], category: 'dependencies' },
]);
/** Only lock admission can emit this: the protected action has NOT started. */
export class BusinessBusy extends Error {
  constructor(lock) { super(`Business ${lock} lock busy; action not started`); this.code = 'business_busy'; this.lock = lock; }
}
export const requirementId = value => safeId(value, 'req');
export const seedId = value => safeId(value, 'seed');
export function safeId(value, prefix) {
  if (typeof value !== 'string' || !new RegExp(`^${prefix}-[a-z0-9][a-z0-9_-]{0,63}$`).test(value)) throw new Error(`Unsafe ${prefix} id`);
  return value;
}
export function absolute(value, name = 'path') {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${name} must be absolute`);
  return path.resolve(value);
}
export function inside(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('Path must be a child of the business data root');
  return target;
}
export function text(value, name, max = 20_000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${name}`);
  return value.trim();
}
export function risk(value) {
  if (!['low', 'mid', 'high'].includes(value)) throw new Error('risk must be low, mid or high');
  return value;
}
export const readJSON = async file => JSON.parse(await readFile(file, 'utf8'));
const optionalJSON = async file => { try { return await readJSON(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
export async function atomicJSON(file, value, { immutable = false } = {}) {
  if (immutable) {
    try { await lstat(file); throw new Error('Immutable artifact already exists'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}

export class DevelopmentStore {
  constructor(config) { this.config = config; this.root = config.dataRoot; }
  static async create({ dataRoot, repoRoot, baseBranch = 'main', cleanupPolicy = 'after-verified-merge', integrationMode = 'pull-request', prRemote = 'origin' }) {
    dataRoot = absolute(dataRoot, 'dataRoot'); repoRoot = await realpath(absolute(repoRoot, 'repoRoot'));
    if (!['retain', 'after-verified-merge'].includes(cleanupPolicy)) throw new Error('Invalid cleanup policy');
    if (!['local', 'pull-request'].includes(integrationMode)) throw new Error('Invalid integration mode');
    if (typeof prRemote !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(prRemote)) throw new Error('Invalid PR remote');
    if (typeof baseBranch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(baseBranch) || baseBranch.includes('..') || baseBranch.endsWith('/') || baseBranch.endsWith('.lock')) throw new Error('Unsafe base branch');
    await mkdir(dataRoot, { recursive: true });
    if ((await lstat(dataRoot)).isSymbolicLink() || path.resolve(await realpath(dataRoot)) !== dataRoot) throw new Error('Business root must be canonical, not a symlink');
    const existing = await optionalJSON(path.join(dataRoot, 'config.json'));
    if (existing) {
      if (existing.repoRoot !== repoRoot || existing.baseBranch !== baseBranch || existing.cleanupPolicy !== cleanupPolicy || (existing.integrationMode ?? 'local') !== integrationMode || (existing.prRemote ?? 'origin') !== prRemote) throw new Error('Store configuration is immutable');
      return DevelopmentStore.open(dataRoot);
    }
    for (const name of directories) await mkdir(path.join(dataRoot, name));
    const config = { version: 2, dataRoot, repoRoot, baseBranch, cleanupPolicy, integrationMode, prRemote };
    await atomicJSON(path.join(dataRoot, 'config.json'), config);
    return new DevelopmentStore(config);
  }
  static async open(dataRoot) {
    dataRoot = absolute(dataRoot, 'dataRoot');
    const config = await readJSON(path.join(dataRoot, 'config.json'));
    if (config.version !== 2 || config.dataRoot !== dataRoot || path.resolve(await realpath(dataRoot)) !== dataRoot || (await lstat(dataRoot)).isSymbolicLink()) throw new Error('Invalid business store root');
    for (const name of directories) if ((await lstat(path.join(dataRoot, name))).isSymbolicLink()) throw new Error('Business directories cannot be symlinks');
    absolute(config.repoRoot, 'repoRoot');
    config.integrationMode = config.integrationMode ?? 'pull-request';
    config.prRemote = config.prRemote ?? 'origin';
    if (!['local', 'pull-request'].includes(config.integrationMode)) throw new Error('Unsupported legacy integration mode; use a new dataRoot');
    return new DevelopmentStore(config);
  }
  static async fromRef(dataRef) {
    dataRef = absolute(dataRef, 'dataRef');
    const store = await DevelopmentStore.open(path.dirname(path.dirname(dataRef)));
    if (path.dirname(dataRef) !== path.join(store.root, 'requirements')) throw new Error('dataRef must name a requirement instance');
    const id = requirementId(path.basename(dataRef, '.json'));
    if (store.ref(id) !== dataRef) throw new Error('Invalid requirement dataRef');
    await store.get(id); return store;
  }
  ref(id) { return inside(this.root, path.join(this.root, 'requirements', `${requirementId(id)}.json`)); }
  seedRef(id) { return inside(this.root, path.join(this.root, 'seeds', `${seedId(id)}.json`)); }
  async checkedFile(file) {
    inside(this.root, absolute(file));
    let current = this.root;
    for (const component of path.relative(this.root, file).split(path.sep)) {
      current = path.join(current, component);
      try { if ((await lstat(current)).isSymbolicLink()) throw new Error('Symlink business paths are forbidden'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return file;
  }
  async get(id) {
    const item = await readJSON(await this.checkedFile(this.ref(id)));
    if (item.id !== id || !Number.isSafeInteger(item.revision) || item.revision < 1) throw new Error('Invalid requirement instance');
    return item;
  }
  async save(item) {
    requirementId(item.id); item.updatedAt = new Date().toISOString();
    await atomicJSON(await this.checkedFile(this.ref(item.id)), item); return item;
  }
  async locked(action, name = 'store', { timeoutMs = 10_000 } = {}) {
    if (!['store', 'integration'].includes(name)) throw new Error('Invalid lock');
    const lock = path.join(this.root, 'locks', `${name}.lock`), started = Date.now();
    for (;;) {
      try { await mkdir(lock); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (Date.now() - started >= timeoutMs) throw new BusinessBusy(name);
        await delay(10);
      }
    }
    try { await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); return await action(); }
    finally { await rm(lock, { recursive: true }); }
  }
  async list() {
    const names = (await readdir(path.join(this.root, 'requirements'))).filter(name => /^req-[a-z0-9][a-z0-9_-]{0,63}\.json$/.test(name));
    return Promise.all(names.map(name => this.get(name.slice(0, -5))));
  }
  async nextOrder() {
    const counterPath = path.join(this.root, 'sequence.json'), counter = await optionalJSON(counterPath) ?? { next: 1 };
    const order = counter.next++; await atomicJSON(counterPath, counter); return order;
  }
  async upsertRequirement(spec) { return this.locked(async () => this.upsertUnlocked(spec)); }
  async upsertUnlocked(spec) {
    const id = requirementId(spec.id), previous = await optionalJSON(await this.checkedFile(this.ref(id)));
    if (!['user', 'mined'].includes(spec.source)) throw new Error('source must be user or mined');
    if (previous && (previous.source !== spec.source || previous.claimId || previous.status !== 'queued')) throw new Error('Cannot overwrite an active requirement; use revision feedback on its same id');
    if (previous && spec.expectedRevision !== previous.revision) throw new Error('Stale requirement revision');
    const priority = spec.source === 'user' ? 0 : spec.priority ?? 5;
    if (!Number.isInteger(priority) || (spec.source === 'mined' && (priority < 1 || priority > 9))) throw new Error('Mined priority must be 1..9');
    const linkedSeed = spec.source === 'mined' ? seedId(spec.seedId) : null;
    const item = {
      ...(previous ?? {}), id, source: spec.source, seedId: linkedSeed,
      title: text(spec.title, 'title', 500), description: text(spec.description, 'description'),
      tags: normalizeTags(spec.tags), priority, risk: risk(spec.risk ?? 'low'),
      revision: (previous?.revision ?? 0) + 1, order: previous?.order ?? await this.nextOrder(),
      createdAt: previous?.createdAt ?? new Date().toISOString(), status: 'queued',
      worktreePath: previous?.worktreePath ?? null,
      baseRevision: previous?.baseRevision ?? null, implementation: previous?.implementation ?? null,
      reviews: previous?.reviews ?? [], feedback: previous?.feedback ?? [],
      requirementApproval: null, approval: null, claimId: null, engineeringEpoch: 0, pendingSnapshot: null,
    };
    // Requirement revisions retain the same branch and attached worktree.
    if (previous?.branch) item.branch = previous.branch;
    return this.save(item);
  }
  async upsertSeed(spec) {
    return this.locked(async () => {
      const id = seedId(spec.id), file = await this.checkedFile(this.seedRef(id)), previous = await optionalJSON(file);
      if (previous && previous.status !== 'queued') throw new Error('Seed already claimed/proposed; do not create duplicate requirements');
      const relatedRequirementId = spec.relatedRequirementId ? requirementId(spec.relatedRequirementId) : null;
      const seed = {
        id, title: text(spec.title, 'seed title', 500), evidence: text(spec.evidence, 'seed evidence'),
        tags: normalizeTags(spec.tags), origin: text(spec.origin ?? 'explicit', 'seed origin', 100),
        category: spec.category ? text(spec.category, 'seed category', 100) : null,
        relatedRequirementId, order: previous?.order ?? await this.nextOrder(), status: 'queued',
      };
      await atomicJSON(file, seed); return seed;
    });
  }

  /** Idempotent bootstrap for discovery directions; never overwrites a claimed seed. */
  async ensureBaselineSeeds(seeds = baselineSeeds) {
    return this.locked(async () => {
      const created = [];
      for (const spec of seeds) {
        const id = seedId(spec.id), file = await this.checkedFile(this.seedRef(id));
        if (await optionalJSON(file)) continue;
        const seed = {
          id, title: text(spec.title, 'seed title', 500), evidence: text(spec.evidence, 'seed evidence'),
          tags: normalizeTags(spec.tags), origin: 'baseline', category: text(spec.category, 'seed category', 100),
          relatedRequirementId: null, order: await this.nextOrder(), status: 'queued',
        };
        await atomicJSON(file, seed); created.push(seed);
      }
      return created;
    });
  }
  async claimSeeds(limit = 3) {
    limit = batchLimit(limit);
    return this.locked(async () => {
      const files = (await readdir(path.join(this.root, 'seeds'))).filter(name => /^seed-[a-z0-9][a-z0-9_-]{0,63}\.json$/.test(name));
      const seeds = await Promise.all(files.map(name => this.checkedFile(path.join(this.root, 'seeds', name)).then(readJSON)));
      const selected = seeds.filter(seed => seed.status === 'queued').sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)).slice(0, limit);
      for (const seed of selected) { seed.status = 'mining'; seed.claimId = randomUUID(); await atomicJSON(this.seedRef(seed.id), seed); }
      return selected.map(seed => ({ dataRef: this.seedRef(seed.id), cwd: this.config.repoRoot, label: seed.title, seedId: seed.id, claimId: seed.claimId, dataRoot: this.root, origin: seed.origin ?? 'explicit', category: seed.category ?? null, relatedRequirementId: seed.relatedRequirementId ?? null }));
    });
  }

  async pendingCount() {
    return (await this.list()).filter(item => pendingStatuses.has(item.status)).length;
  }
  async proposeSeed({ seedId: id, claimId, proposal }) {
    return this.locked(async () => {
      const seed = await readJSON(await this.checkedFile(this.seedRef(id)));
      if (seed.claimId !== claimId || seed.status !== 'mining') throw new Error('Stale seed claim');
      if (proposal === null) { seed.status = 'idle'; seed.claimId = null; await atomicJSON(this.seedRef(id), seed); return null; }
      const item = await this.upsertUnlocked({ ...proposal, id: `req-${seedId(id).slice(5)}`, source: 'mined', seedId: id });
      seed.status = 'proposed'; seed.requirementId = item.id; await atomicJSON(this.seedRef(id), seed); return item;
    });
  }
  async claimBatch(limit = 3) {
    limit = batchLimit(limit);
    return this.locked(async () => {
      const selected = (await this.list()).filter(item => item.status === 'queued' && !item.claimId).sort(compareRequirements).slice(0, limit);
      for (const item of selected) { item.claimId = randomUUID(); item.status = 'intake'; await this.save(item); }
      return selected.map(item => this.envelope(item));
    });
  }
  envelope(item, extra = {}) { return { dataRef: this.ref(item.id), cwd: item.worktreePath ?? this.config.repoRoot, label: item.title, claimId: item.claimId, revision: item.revision, engineeringEpoch: item.engineeringEpoch, ...extra }; }
  async beginEngineering(id, claimId, { expectedRevision, expectedEpoch }) {
    return this.mutate(id, claimId, item => {
      if (item.status !== 'engineering-ready' || expectedRevision !== item.revision || expectedEpoch !== item.engineeringEpoch) throw new Error('Stale/unrequested engineering admission');
      if (!Number.isSafeInteger(item.engineeringEpoch) || item.engineeringEpoch < 0 || item.engineeringEpoch === Number.MAX_SAFE_INTEGER) throw new Error('Invalid engineering epoch');
      item.engineeringEpoch++; item.status = 'engineering';
    });
  }
  async mutate(id, claimId, action) {
    return this.locked(async () => { const item = await this.get(id); assertClaim(item, claimId); const value = await action(item); await this.save(item); return value ?? item; });
  }
  async route(id, claimId) {
    return this.mutate(id, claimId, item => {
      if (!['intake', 'requirement-revision', 'requirement-pending'].includes(item.status)) throw new Error('Requirement is not at intake');
      const bypass = item.source === 'user' || item.risk === 'low';
      const approved = item.requirementApproval?.revision === item.revision && item.requirementApproval.decision === 'approve';
      if (bypass || approved) {
        item.requirementApproval = item.requirementApproval ?? { decision: 'approve', revision: item.revision, actor: 'policy', reason: item.source === 'user' ? 'user-priority0' : 'low-risk' };
        item.status = 'ready'; return { item, outcome: 'ready' };
      }
      item.status = 'requirement-pending'; return { item, outcome: 'needs_approval' };
    });
  }
  async requirementDecision(id, claimId, { decision, note, actor = 'human', expectedRevision }) {
    return this.mutate(id, claimId, item => {
      if (expectedRevision !== item.revision) throw new Error('Stale requirement approval revision');
      if (item.status !== 'requirement-pending' || !['approve', 'reject'].includes(decision)) throw new Error('No matching requirement approval pending');
      if (decision === 'reject') text(note, 'rejection feedback');
      item.requirementApproval = { decision, revision: item.revision, note: note ?? '', actor: text(actor, 'actor', 200) };
      if (decision === 'reject') item.feedback.push({ scope: 'requirement', revision: item.revision, note });
      item.status = decision === 'approve' ? 'ready' : 'requirement-revision';
    });
  }
  async reviseRequirement(id, claimId, proposal) {
    return this.mutate(id, claimId, item => {
      if (item.status !== 'requirement-revision' || proposal.expectedRevision !== item.revision) throw new Error('Stale or unrequested requirement revision');
      item.title = text(proposal.title, 'title', 500); item.description = text(proposal.description, 'description');
      item.risk = risk(proposal.risk); item.tags = normalizeTags(proposal.tags ?? item.tags);
      item.revision++; item.requirementApproval = null;
      // Deliberately preserve id, order, claim and worktreePath.
    });
  }
  async mergeDecision(id, claimId, { decision, note, actor = 'human', artifactRef }) {
    return this.mutate(id, claimId, item => {
      if (item.status !== 'human-pending' || !['approve', 'revise', 'reject'].includes(decision) || item.implementation?.artifactRef !== artifactRef) throw new Error('No matching implementation approval pending');
      if (decision !== 'approve') text(note, 'review feedback');
      item.approval = { decision, revision: item.revision, artifactRef, commit: item.implementation.commit, actor: text(actor, 'actor', 200), note: note ?? '' };
      if (decision !== 'approve') item.feedback.push({ scope: 'implementation', artifactRef, note });
      item.status = decision === 'approve' ? 'approved' : decision === 'revise' ? 'engineering-ready' : 'rejected';
    });
  }
}
export function assertClaim(item, claimId) { if (!claimId || claimId !== item.claimId) throw new Error('Stale/missing requirement claim'); }
export function compareRequirements(a, b) { return (a.source === 'user' ? 0 : 1) - (b.source === 'user' ? 0 : 1) || a.priority - b.priority || a.order - b.order || a.id.localeCompare(b.id); }
function normalizeTags(tags = []) { if (!Array.isArray(tags) || tags.length > 30) throw new Error('Invalid tags'); return tags.map(tag => text(tag, 'tag', 100)); }
function batchLimit(limit) { if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('batchSize must be 1..100'); return limit; }
