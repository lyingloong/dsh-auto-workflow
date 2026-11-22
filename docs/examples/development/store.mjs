/** Workflow-owned business storage. The generic plugin never imports this module. */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, lstat, realpath, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const directories = ['requirements', 'seeds', 'artifacts', 'reviews', 'worktrees', 'locks'];
const pendingStatuses = new Set(['queued', 'intake', 'requirement-pending', 'requirement-revision', 'ready', 'preparing', 'engineering-ready', 'engineering']);
const storeVersion = 3;
const defaultMaxMiningSeeds = 3;
const defaultStaleClaimMs = 1_800_000;

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

/**
 * A seed is a discovery direction, not a requirement. Its rotation position is
 * `rotationRound`, so re-armed seeds queue behind every direction mined in a
 * later round; no wall-clock cooldown is involved.
 */
function newSeedRecord({ id, title, evidence, tags, origin, category, relatedRequirementId, order, previous = null }) {
  return {
    id, title, evidence, tags, origin, category, relatedRequirementId, order,
    status: 'queued', claimId: null, claimedAt: null,
    attempts: previous?.attempts ?? 0,
    rotationRound: previous?.rotationRound ?? null,
    requirementId: previous?.requirementId ?? null,
    lastAttemptAt: previous?.lastAttemptAt ?? null,
    lastOutcome: previous?.lastOutcome ?? null,
    lastReason: previous?.lastReason ?? null,
    recoveredAt: previous?.recoveredAt ?? null,
    retiredAt: null, retiredReason: null,
  };
}

export class DevelopmentStore {
  constructor(config) { this.config = config; this.root = config.dataRoot; }
  static async create({ dataRoot, repoRoot, baseBranch = 'main', cleanupPolicy = 'after-verified-merge', integrationMode = 'pull-request', prRemote = 'origin', selfMergeAfterMs = 300_000, maxMiningSeeds = defaultMaxMiningSeeds, staleClaimMs = defaultStaleClaimMs }) {
    dataRoot = absolute(dataRoot, 'dataRoot'); repoRoot = await realpath(absolute(repoRoot, 'repoRoot'));
    if (!['retain', 'after-verified-merge'].includes(cleanupPolicy)) throw new Error('Invalid cleanup policy');
    if (!['local', 'pull-request'].includes(integrationMode)) throw new Error('Invalid integration mode');
    if (!Number.isInteger(selfMergeAfterMs) || selfMergeAfterMs < 0 || selfMergeAfterMs > 86_400_000) throw new Error('Invalid self-merge delay');
    if (!Number.isInteger(maxMiningSeeds) || maxMiningSeeds < 1 || maxMiningSeeds > 100) throw new Error('Invalid max mining seeds');
    if (!Number.isInteger(staleClaimMs) || staleClaimMs < 60_000 || staleClaimMs > 604_800_000) throw new Error('Invalid stale claim age');
    if (typeof prRemote !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(prRemote)) throw new Error('Invalid PR remote');
    if (typeof baseBranch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(baseBranch) || baseBranch.includes('..') || baseBranch.endsWith('/') || baseBranch.endsWith('.lock')) throw new Error('Unsafe base branch');
    await mkdir(dataRoot, { recursive: true });
    if ((await lstat(dataRoot)).isSymbolicLink() || path.resolve(await realpath(dataRoot)) !== dataRoot) throw new Error('Business root must be canonical, not a symlink');
    const existing = await optionalJSON(path.join(dataRoot, 'config.json'));
    if (existing) {
      if (existing.version !== storeVersion) throw new Error(`Unsupported business store version ${existing.version}; create a new dataRoot`);
      if (existing.repoRoot !== repoRoot || existing.baseBranch !== baseBranch || existing.cleanupPolicy !== cleanupPolicy || (existing.integrationMode ?? 'local') !== integrationMode || (existing.prRemote ?? 'origin') !== prRemote || (existing.selfMergeAfterMs ?? 300_000) !== selfMergeAfterMs || existing.maxMiningSeeds !== maxMiningSeeds || existing.staleClaimMs !== staleClaimMs) throw new Error('Store configuration is immutable');
      return DevelopmentStore.open(dataRoot);
    }
    for (const name of directories) await mkdir(path.join(dataRoot, name));
    const config = { version: storeVersion, dataRoot, repoRoot, baseBranch, cleanupPolicy, integrationMode, prRemote, selfMergeAfterMs, maxMiningSeeds, staleClaimMs };
    await atomicJSON(path.join(dataRoot, 'config.json'), config);
    return new DevelopmentStore(config);
  }
  static async open(dataRoot) {
    dataRoot = absolute(dataRoot, 'dataRoot');
    const config = await readJSON(path.join(dataRoot, 'config.json'));
    // Persisted seed lifecycle, rotation and claim fields changed; old roots are
    // evidence, not something to reinterpret in place.
    if (config.version !== storeVersion) throw new Error(`Unsupported business store version ${config.version}; create a new dataRoot`);
    if (config.dataRoot !== dataRoot || path.resolve(await realpath(dataRoot)) !== dataRoot || (await lstat(dataRoot)).isSymbolicLink()) throw new Error('Invalid business store root');
    for (const name of directories) if ((await lstat(path.join(dataRoot, name))).isSymbolicLink()) throw new Error('Business directories cannot be symlinks');
    absolute(config.repoRoot, 'repoRoot');
    if (!Number.isInteger(config.maxMiningSeeds) || config.maxMiningSeeds < 1 || config.maxMiningSeeds > 100 || !Number.isInteger(config.staleClaimMs) || config.staleClaimMs < 60_000 || config.staleClaimMs > 604_800_000) throw new Error('Invalid business store root');
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
  /** Newest rotation position. Seeds are ordered by `rotationRound`. */
  async allocateRound() {
    const counterPath = path.join(this.root, 'sequence.json'), counter = await optionalJSON(counterPath) ?? { next: 1 };
    counter.round = (counter.round ?? 0) + 1; await atomicJSON(counterPath, counter); return counter.round;
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
      if (previous && previous.status !== 'queued') throw new Error('Seed already claimed, proposed or retired; do not create duplicate requirements');
      const seed = newSeedRecord({
        id,
        title: text(spec.title, 'seed title', 500),
        evidence: text(spec.evidence, 'seed evidence'),
        tags: normalizeTags(spec.tags),
        origin: text(spec.origin ?? 'explicit', 'seed origin', 100),
        category: spec.category ? text(spec.category, 'seed category', 100) : null,
        relatedRequirementId: spec.relatedRequirementId ? requirementId(spec.relatedRequirementId) : null,
        order: previous?.order ?? await this.nextOrder(),
        previous,
      });
      await atomicJSON(file, seed); return seed;
    });
  }

  /** Idempotent bootstrap for discovery directions; never overwrites an existing seed. */
  async ensureBaselineSeeds(seeds = baselineSeeds) {
    return this.locked(async () => {
      const created = [];
      for (const spec of seeds) {
        const id = seedId(spec.id), file = await this.checkedFile(this.seedRef(id));
        if (await optionalJSON(file)) continue;
        const seed = newSeedRecord({
          id,
          title: text(spec.title, 'seed title', 500),
          evidence: text(spec.evidence, 'seed evidence'),
          tags: normalizeTags(spec.tags),
          origin: 'baseline',
          category: text(spec.category, 'seed category', 100),
          relatedRequirementId: null,
          order: await this.nextOrder(),
        });
        await atomicJSON(file, seed); created.push(seed);
      }
      return created;
    });
  }

  async readSeeds() {
    const names = (await readdir(path.join(this.root, 'seeds'))).filter(name => /^seed-[a-z0-9][a-z0-9_-]{0,63}\.json$/.test(name));
    return Promise.all(names.map(name => this.checkedFile(path.join(this.root, 'seeds', name)).then(readJSON)));
  }

  /**
   * Claim the next rotation slice. Never-mined seeds come first, then the least
   * recently mined, so a re-armed seed queues behind everything mined in later
   * rounds. The mining cap is store policy, not an input from the graph; the
   * `maxMining` option exists only for tests that need a whole fixture pool.
   */
  async claimSeeds(limit = 3, { maxMining = this.config.maxMiningSeeds } = {}) {
    limit = batchLimit(limit);
    return this.locked(async () => {
      const seeds = await this.readSeeds();
      const mining = seeds.filter(seed => seed.status === 'mining').length;
      const room = Math.min(limit, Math.max(0, maxMining - mining));
      if (room === 0) return [];
      const candidates = seeds.filter(seed => seed.status === 'queued')
        .sort((a, b) => (a.rotationRound ?? -1) - (b.rotationRound ?? -1) || a.order - b.order || a.id.localeCompare(b.id))
        .slice(0, room);
      if (candidates.length === 0) return [];
      const round = await this.allocateRound(), claimedAt = new Date().toISOString();
      for (const seed of candidates) {
        seed.status = 'mining'; seed.claimId = randomUUID(); seed.claimedAt = claimedAt;
        seed.attempts = (seed.attempts ?? 0) + 1; seed.rotationRound = round;
        await atomicJSON(this.seedRef(seed.id), seed);
      }
      return candidates.map(seed => ({ dataRef: this.seedRef(seed.id), cwd: this.config.repoRoot, label: seed.title, seedId: seed.id, claimId: seed.claimId, dataRoot: this.root, origin: seed.origin ?? 'explicit', category: seed.category ?? null, relatedRequirementId: seed.relatedRequirementId ?? null, rotationRound: round }));
    });
  }

  async pendingCount() {
    return (await this.list()).filter(item => pendingStatuses.has(item.status)).length;
  }

  async seedCounts({ now = Date.now() } = {}) {
    const seeds = await this.readSeeds();
    const counts = { total: seeds.length, queued: 0, mining: 0, proposed: 0, retired: 0, stale: [] };
    for (const seed of seeds) {
      counts[seed.status] = (counts[seed.status] ?? 0) + 1;
      if (seed.status !== 'mining') continue;
      const ageMs = claimAge(seed, now);
      if (ageMs >= this.config.staleClaimMs) counts.stale.push({ seedId: seed.id, claimedAt: seed.claimedAt ?? null, ageMs: Number.isFinite(ageMs) ? ageMs : null, attempts: seed.attempts ?? 0 });
    }
    return counts;
  }

  /**
   * Release mining claims old enough to be dead. Explicit operator action: age
   * alone cannot tell a slow miner from an interrupted one, so the runtime never
   * reclaims work by itself.
   */
  async recoverSeeds({ olderThanMs = this.config.staleClaimMs, dryRun = false } = {}) {
    if (!Number.isInteger(olderThanMs) || olderThanMs < 0) throw new Error('olderThanMs must be a non-negative integer');
    return this.locked(async () => {
      const now = Date.now();
      const stale = (await this.readSeeds()).filter(seed => seed.status === 'mining' && claimAge(seed, now) >= olderThanMs);
      const found = stale.map(seed => ({ seedId: seed.id, claimedAt: seed.claimedAt ?? null, ageMs: Number.isFinite(claimAge(seed, now)) ? claimAge(seed, now) : null, attempts: seed.attempts ?? 0 }));
      if (dryRun) return { dryRun: true, stale: found, recovered: [] };
      for (const seed of stale) {
        seed.status = 'queued'; seed.claimId = null; seed.claimedAt = null;
        seed.lastOutcome = 'recovered-stale-claim';
        seed.lastReason = `claim released after ${olderThanMs}ms without a recorded proposal`;
        seed.recoveredAt = new Date(now).toISOString();
        await atomicJSON(this.seedRef(seed.id), seed);
      }
      return { dryRun: false, stale: found, recovered: stale.map(seed => seed.id) };
    });
  }

  async retireSeed(id, reason) {
    return this.locked(async () => {
      const file = await this.checkedFile(this.seedRef(id)), seed = await readJSON(file);
      if (seed.status === 'mining') throw new Error('Recover the stale claim before retiring a mining seed');
      if (seed.status === 'retired') return seed;
      seed.status = 'retired'; seed.claimId = null; seed.claimedAt = null;
      seed.retiredAt = new Date().toISOString();
      seed.retiredReason = text(reason, 'retire reason', 500);
      seed.lastOutcome = 'retired'; seed.lastReason = seed.retiredReason;
      await atomicJSON(file, seed); return seed;
    });
  }

  async rearmSeed(id) {
    return this.locked(async () => {
      const file = await this.checkedFile(this.seedRef(id)), seed = await readJSON(file);
      if (seed.status !== 'retired') throw new Error('Only a retired seed can be re-armed');
      // Re-arming a direction whose requirement is still in flight would open a
      // second requirement for the same discovery direction.
      if (seed.requirementId && !await this.requirementIsTerminal(seed.requirementId)) throw new Error('The retired seed still has an active requirement; settle it before re-arming');
      seed.status = 'queued'; seed.retiredAt = null; seed.retiredReason = null;
      // Take the newest rotation position so this direction goes to the back.
      seed.rotationRound = await this.allocateRound();
      seed.lastOutcome = 're-armed'; seed.lastReason = null;
      await atomicJSON(file, seed); return seed;
    });
  }

  async requirementIsTerminal(id) {
    const item = await optionalJSON(await this.checkedFile(this.ref(id)));
    return !item || ['merged', 'rejected'].includes(item.status);
  }

  /**
   * Return the seed behind a settled requirement to the rotation. Called with the
   * store lock already held: merge and PR verification run inside mutate.
   */
  async settleSeedForRequirementUnlocked(item) {
    if (!item?.seedId) return null;
    const file = await this.checkedFile(this.seedRef(item.seedId)), seed = await optionalJSON(file);
    if (!seed || seed.status !== 'proposed' || seed.requirementId !== item.id) return null;
    seed.status = 'queued'; seed.claimId = null; seed.claimedAt = null;
    // Take the newest rotation position: the direction queues behind everything
    // mined in later rounds instead of jumping back to the front.
    seed.rotationRound = await this.allocateRound();
    seed.lastOutcome = `requirement-${item.status}`;
    seed.lastReason = null;
    await atomicJSON(file, seed); return seed;
  }

  /**
   * Stable id for the first requirement a direction produces (`req-<seed>`).
   * A direction that yields another requirement after its previous one settled
   * gets a suffixed id, so re-mining never tries to overwrite a terminal item.
   */
  async requirementIdForSeed(base) {
    const first = requirementId(`req-${base}`);
    if (!await optionalJSON(await this.checkedFile(this.ref(first)))) return first;
    for (let attempt = 2; attempt < 1000; attempt++) {
      const suffix = `-r${attempt}`;
      const candidate = requirementId(`req-${base.slice(0, 64 - suffix.length)}${suffix}`);
      if (!await optionalJSON(await this.checkedFile(this.ref(candidate)))) return candidate;
    }
    throw new Error('Too many requirements for this seed');
  }

  async proposeSeed({ seedId: id, claimId, proposal, reason }) {
    return this.locked(async () => {
      const seed = await readJSON(await this.checkedFile(this.seedRef(id)));
      if (seed.claimId !== claimId || seed.status !== 'mining') throw new Error('Stale seed claim');
      const now = new Date().toISOString();
      if (proposal === null || proposal === undefined) {
        seed.status = 'queued'; seed.claimId = null; seed.claimedAt = null;
        seed.lastOutcome = 'no-proposal';
        // Diagnostic metadata from the model must never turn a valid idle
        // outcome into a failed packet.
        seed.lastReason = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 500) : null;
        seed.lastAttemptAt = now;
        await atomicJSON(this.seedRef(id), seed); return null;
      }
      const item = await this.upsertUnlocked({ ...proposal, id: await this.requirementIdForSeed(seedId(id).slice(5)), source: 'mined', seedId: id });
      seed.status = 'proposed'; seed.requirementId = item.id;
      seed.lastAttemptAt = now; seed.lastOutcome = 'proposed'; seed.lastReason = null;
      seed.claimId = null; seed.claimedAt = null;
      await atomicJSON(this.seedRef(id), seed); return item;
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
    return this.mutate(id, claimId, async item => {
      if (item.status !== 'human-pending' || !['approve', 'revise', 'reject'].includes(decision) || item.implementation?.artifactRef !== artifactRef) throw new Error('No matching implementation approval pending');
      if (decision !== 'approve') text(note, 'review feedback');
      item.approval = { decision, revision: item.revision, artifactRef, commit: item.implementation.commit, actor: text(actor, 'actor', 200), note: note ?? '' };
      if (decision !== 'approve') item.feedback.push({ scope: 'implementation', artifactRef, note });
      item.status = decision === 'approve' ? 'approved' : decision === 'revise' ? 'engineering-ready' : 'rejected';
      // A rejected requirement is terminal: its seed returns to the rotation.
      if (item.status === 'rejected') await this.settleSeedForRequirementUnlocked(item);
    });
  }
}
export function assertClaim(item, claimId) { if (!claimId || claimId !== item.claimId) throw new Error('Stale/missing requirement claim'); }
export function compareRequirements(a, b) { return (a.source === 'user' ? 0 : 1) - (b.source === 'user' ? 0 : 1) || a.priority - b.priority || a.order - b.order || a.id.localeCompare(b.id); }
function normalizeTags(tags = []) { if (!Array.isArray(tags) || tags.length > 30) throw new Error('Invalid tags'); return tags.map(tag => text(tag, 'tag', 100)); }
function batchLimit(limit) { if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('batchSize must be 1..100'); return limit; }
function claimAge(seed, now) {
  const claimedAt = Date.parse(seed.claimedAt ?? '');
  return Number.isFinite(claimedAt) ? Math.max(0, now - claimedAt) : Number.POSITIVE_INFINITY;
}
