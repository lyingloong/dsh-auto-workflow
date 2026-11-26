/** GitHub requirement review: publish one redacted issue per requirement and
 * read the maintainer's decision from its comments. The workflow store stays the
 * only source of truth; the issue is a public review surface. */
import os from 'node:os';
import path from 'node:path';
import { writeFile, rm } from 'node:fs/promises';
import { gh, ghJson, repoCoordinates } from './github.mjs';

export const REVIEW_LABEL = 'workflow:requirement-review';
export const APPROVED_LABEL = 'workflow:requirement-approved';
export const REJECTED_LABEL = 'workflow:requirement-rejected';
export const REQUIREMENT_LABELS = [REVIEW_LABEL, APPROVED_LABEL, REJECTED_LABEL];

const AUTHORIZED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const DECISION = /^\s*@workflow\s+(approve|reject)\b([\s\S]*)$/i;
const INTENT_COMMAND = /^\s*@workflow\s+(?!approve\b|reject\b)([\s\S]+)$/i;
const CONFIRM_COMMAND = /^\s*@workflow\s+确认按当前\s*(?:revision|head)\s*处理\s*$/i;
function commentTime(comment) { return Date.parse(comment?.created_at ?? comment?.createdAt ?? '') || 0; }
function evidenceFor(comments, floor) {
  return comments
    .filter(comment => Number(comment.id) > floor)
    .slice(-15)
    .map(comment => ({
      commentId: Number(comment.id),
      author: comment.user?.login ?? comment.author?.login ?? 'unknown',
      association: comment.author_association ?? '',
      role: /\[role=codex\]/i.test(String(comment.body ?? '')) ? 'codex' : null,
      body: String(comment.body ?? '').slice(0, 1200),
    }));
}
/** Acknowledge authorized commands that fell out of the current revision window. */
async function acknowledgeStale(store, item, comments, claimId) {
  const floor = Number(item.github.commentFloor ?? 0);
  const acknowledged = new Set((item.acknowledgedCommands ?? []).map(entry => entry.commentId));
  const operations = item.commandOperations ?? [];
  const operated = new Set(operations.map(operation => operation.commentId));
  const stale = comments
    .filter(comment => Number(comment.id) <= floor)
    .filter(comment => AUTHORIZED.has(String(comment.author_association ?? '').toUpperCase()))
    .filter(comment => INTENT_COMMAND.test(String(comment.body ?? '')))
    .filter(comment => !acknowledged.has(Number(comment.id)))
    .filter(comment => !operated.has(Number(comment.id)))
    .sort((a, b) => Number(a.id) - Number(b.id))
    .slice(0, 2);
  if (!stale.length) return item;
  const replies = [];
  for (const comment of stale) {
    const at = commentTime(comment);
    const during = operations.find(operation => operation.commentId !== Number(comment.id)
      && ['running', 'completed'].includes(operation.state)
      && Number.isFinite(Date.parse(operation.acceptedAt ?? ''))
      && at >= Date.parse(operation.acceptedAt)
      && (!operation.completedAt || at <= Date.parse(operation.completedAt)));
    const queued = Boolean(during);
    const body = queued
      ? [
        `已收到评论 #${Number(comment.id)}（授权命令）。它是在 revision ${during.targetRevision} 修订运行期间收到的，未自动应用；当前 revision 已是 ${item.revision}（${item.status}）。`,
        '如需按当前 revision 处理，请重新评论 `@workflow <具体指令>`，或评论 `@workflow 确认按当前 revision 处理` 复用最近一条旧指令；不会静默覆盖正在进行的操作。',
      ].join('\n\n')
      : [
        `已收到评论 #${Number(comment.id)}（授权命令），但它早于当前 revision 审批窗口，未自动应用。`,
        `当前需求 revision 为 ${item.revision}（${item.status}）。如需按当前 revision 处理，请重新评论 \`@workflow <具体指令>\`，或评论 \`@workflow 确认按当前 revision 处理\` 复用最近一条旧指令；不会静默应用旧命令。`,
      ].join('\n\n');
    await gh(store.config.repoRoot, 'issue', 'comment', String(item.github.number), '--body', body);
    replies.push({
      commentId: Number(comment.id), status: queued ? 'queued' : 'stale', revision: item.revision, currentRevision: item.revision,
      targetRevision: during?.targetRevision ?? null, operationId: during?.operationId ?? null,
      body: String(comment.body ?? '').slice(0, 2000), acknowledgedAt: new Date().toISOString(),
    });
  }
  return store.recordRequirementAcks(item.id, claimId, { acknowledged: replies, stale: replies });
}

/** Deterministic public redaction: paths, emails, tokens, private addresses. */
export function redactForPublic(value) {
  return String(value ?? '')
    .replace(/\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[redacted-token]')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '[redacted-token]')
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '[redacted-token]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/https?:\/\/(?!github\.com\/)[^\s)>\]]+/gi, '<url>')
    .replace(/[A-Za-z]:\\(?:[^\\\s"'`()]+\\)*[^\\\s"'`()]*/g, '<path>')
    .replace(/(?<![A-Za-z0-9.:/<])\/(?:[\w.-]+\/)+[\w.-]*/g, '<path>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>');
}

function issueTitle(item) {
  return redactForPublic(item.title).replace(/\s+/g, ' ').trim().slice(0, 200);
}

export function issueBody(item) {
  const tags = (item.tags ?? []).map(tag => redactForPublic(tag)).join(', ');
  const why = (item.why ?? []).map(line => `- ${redactForPublic(line)}`);
  const acceptance = (item.acceptance ?? []).map(line => `- ${redactForPublic(line)}`);
  return [
    '<!-- workflow-requirement',
    `requirement: ${item.id}`,
    `revision: ${item.revision}`,
    `risk: ${item.risk}`,
    '-->',
    `# ${issueTitle(item)}`,
    '',
    `> risk \`${item.risk}\` · revision ${item.revision}${item.seedId ? ` · seed \`${item.seedId}\`` : ''}${item.relatedRequirementId ? ` · related \`${item.relatedRequirementId}\`` : ''}`,
    '',
    '## What',
    '',
    redactForPublic(item.summary),
    '',
    ...(why.length ? ['## Why / impact', '', ...why, ''] : []),
    '## Acceptance',
    '',
    ...(acceptance.length ? acceptance : ['_No explicit acceptance recorded; rely on the evidence below._']),
    '',
    '## Decision',
    '',
    '评论 `@workflow approve` 或 `@workflow reject <理由>`。只有仓库协作者（OWNER / MEMBER / COLLABORATOR）的决定生效；拒绝必须给出理由。',
    '',
    '<details>',
    '<summary>Full evidence</summary>',
    '',
    redactForPublic(item.evidence),
    '',
    '</details>',
    '',
    '## 元数据',
    '',
    `- requirement: \`${item.id}\``,
    `- revision: ${item.revision}`,
    `- risk: ${item.risk}`,
    `- tags: ${tags || '—'}`,
    ...(item.seedId ? [`- seed: \`${item.seedId}\``] : []),
    ...(item.relatedRequirementId ? [`- related: \`${item.relatedRequirementId}\``] : []),
    '',
    '> 公开版已脱敏：路径、邮箱、令牌和私有地址已替换为占位符。审批对象是本 issue 的描述；执行以工作流内部记录为准。',
  ].join('\n');
}

async function writeBodyFile(body) {
  const file = path.join(os.tmpdir(), `workflow-requirement-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.md`);
  await writeFile(file, `${body}\n`, 'utf8');
  return file;
}

async function listComments(cwd, { owner, name }, number) {
  const rows = await ghJson(cwd, ['api', `repos/${owner}/${name}/issues/${number}/comments?per_page=100`]);
  if (!Array.isArray(rows)) throw new Error('GitHub issue comments were not a list');
  return rows;
}

function parseIssueNumber(value) {
  const match = String(value).match(/\/issues\/(\d+)(?:\b|$)/);
  return match ? Number(match[1]) : null;
}

/** Create or refresh the one issue for this requirement revision. */
export async function publish(store, id, claimId) {
  const item = await store.get(id);
  if (item.status !== 'requirement-pending') throw new Error('Requirement is not pending review');
  const { owner, name } = await repoCoordinates(store);
  const cwd = store.config.repoRoot;
  const title = issueTitle(item);
  const file = await writeBodyFile(issueBody(item));
  let number = item.github?.number ?? null;
  let url = item.github?.url ?? '';
  const existing = number !== null;
  try {
    if (number) {
      const current = await ghJson(cwd, ['issue', 'view', String(number), '--json', 'number,url,state,labels']);
      const labels = new Set((current.labels ?? []).map(label => label.name));
      const args = ['issue', 'edit', String(number), '--title', title, '--body-file', file];
      if (!labels.has(REVIEW_LABEL)) args.push('--add-label', REVIEW_LABEL);
      for (const label of [APPROVED_LABEL, REJECTED_LABEL]) if (labels.has(label)) args.push('--remove-label', label);
      await gh(cwd, ...args);
      if (String(current.state ?? '').toUpperCase() !== 'OPEN') await gh(cwd, 'issue', 'reopen', String(number));
      url = current.url ?? url;
    } else {
      const output = await gh(cwd, 'issue', 'create', '--title', title, '--body-file', file, '--label', REVIEW_LABEL);
      const created = output.split('\n').map(line => line.trim()).filter(Boolean).at(-1) ?? '';
      number = parseIssueNumber(created);
      if (!number) throw new Error(`Cannot parse the created issue URL: ${created.slice(0, 200)}`);
      url = created;
    }
  } finally {
    await rm(file, { force: true });
  }
  // A fresh issue accepts any comment; an updated revision only accepts comments
  // posted after this publication, so a decision on the previous revision cannot
  // decide the new one.
  const comments = existing ? await listComments(cwd, { owner, name }, number) : [];
  const commentFloor = comments.reduce((max, comment) => Math.max(max, Number(comment.id) || 0), 0);
  const saved = await store.attachIssue(id, claimId, { number, url, revision: item.revision, commentFloor });
  return { item: saved, outcome: 'complete' };
}

/** Read the latest authorized decision comment and apply it to the requirement. */
export async function check(store, id, claimId) {
  let item = await store.get(id);
  if (item.status === 'ready') return { item, outcome: 'approved' };
  if (item.status === 'requirement-revision') return { item, outcome: 'rejected' };
  if (item.status !== 'requirement-pending') throw new Error('Requirement is not pending review');
  if (!item.github?.number) throw new Error('Requirement has no review issue; publish it first');
  if (item.github.revision !== item.revision) throw new Error('Requirement revision changed after review publication');
  const { owner, name } = await repoCoordinates(store);
  const cwd = store.config.repoRoot, number = item.github.number;
  const comments = await listComments(cwd, { owner, name }, number);
  item = await acknowledgeStale(store, item, comments, claimId);
  const decisions = comments
    .filter(comment => Number(comment.id) > Number(item.github.commentFloor ?? 0))
    .filter(comment => AUTHORIZED.has(String(comment.author_association ?? '').toUpperCase()))
    .map(comment => ({ comment, match: DECISION.exec(String(comment.body ?? '')) }))
    .filter(entry => entry.match)
    .sort((a, b) => Number(a.comment.id) - Number(b.comment.id));
  if (decisions.length === 0) {
    // Explicit confirmation of a previously acknowledged stale command reuses
    // that command's text against the current revision; it never applies silently.
    const floor = Number(item.github.commentFloor ?? 0);
    const confirmations = comments
      .filter(comment => Number(comment.id) > floor)
      .filter(comment => AUTHORIZED.has(String(comment.author_association ?? '').toUpperCase()))
      .filter(comment => CONFIRM_COMMAND.test(String(comment.body ?? '')))
      .sort((a, b) => Number(a.id) - Number(b.id));
    const confirmation = confirmations.at(-1);
    if (confirmation && item.staleCommands?.length) {
      const prior = item.staleCommands.at(-1);
      return {
        item,
        outcome: 'interpret',
        revision: item.revision,
        command: { commentId: Number(confirmation.id), body: prior.body, author: confirmation.user?.login ?? 'unknown', confirmedFrom: prior.commentId },
        evidence: evidenceFor(comments, floor),
      };
    }
    // No exact command: hand one authorized natural-language command to the
    // intent step. Only the command is an instruction; evidence stays data.
    const commands = comments
      .filter(comment => Number(comment.id) > Number(item.github.commentFloor ?? 0))
      .filter(comment => AUTHORIZED.has(String(comment.author_association ?? '').toUpperCase()))
      .filter(comment => INTENT_COMMAND.test(String(comment.body ?? '')))
      .sort((a, b) => Number(a.id) - Number(b.id));
    const entry = commands.at(-1);
    if (entry) {
      return {
        item,
        outcome: 'interpret',
        revision: item.revision,
        command: { commentId: Number(entry.id), body: String(entry.body ?? '').trim().slice(0, 2000), author: entry.user?.login ?? 'unknown' },
        evidence: evidenceFor(comments, floor),
      };
    }
    return { item, outcome: 'waiting', reason: 'no-decision' };
  }
  const { comment, match } = decisions.at(-1);
  const action = match[1].toLowerCase();
  const note = match[2].trim();
  const login = comment.user?.login ?? comment.author?.login ?? 'unknown';
  const actor = `github:${login}`;
  if (action === 'reject' && note === '') {
    await gh(cwd, 'issue', 'comment', String(number), '--body', '拒绝需要一句理由，例如：`@workflow reject 与已有需求重复`。');
    const floor = Math.max(Number(item.github.commentFloor ?? 0), Number(comment.id) || 0);
    await store.advanceIssueFloor(id, claimId, floor);
    return { item: await store.get(id), outcome: 'waiting', reason: 'missing-rejection-reason' };
  }
  const saved = await store.githubRequirementDecision(id, claimId, {
    decision: action === 'approve' ? 'approve' : 'reject',
    note: action === 'reject' ? note : '',
    actor,
    commentId: Number(comment.id) || 0,
    expectedRevision: item.github.revision,
  });
  const current = await ghJson(cwd, ['issue', 'view', String(number), '--json', 'labels']);
  const labels = new Set((current.labels ?? []).map(label => label.name));
  const args = ['issue', 'edit', String(number)];
  if (labels.has(REVIEW_LABEL)) args.push('--remove-label', REVIEW_LABEL);
  args.push('--add-label', action === 'approve' ? APPROVED_LABEL : REJECTED_LABEL);
  await gh(cwd, ...args);
  await gh(cwd, 'issue', 'comment', String(number), '--body', action === 'approve'
    ? `已批准 revision ${item.revision}（${login}）。工作流继续实现。`
    : `已拒绝 revision ${item.revision}（${login}）：${note}`);
  if (action === 'approve') await gh(cwd, 'issue', 'close', String(number));
  return { item: saved, outcome: action === 'approve' ? 'approved' : 'rejected' };
}

async function syncIssueDecision(store, item, action) {
  const cwd = store.config.repoRoot, number = item.github.number;
  const current = await ghJson(cwd, ['issue', 'view', String(number), '--json', 'labels']);
  const labels = new Set((current.labels ?? []).map(label => label.name));
  const args = ['issue', 'edit', String(number)];
  if (labels.has(REVIEW_LABEL)) args.push('--remove-label', REVIEW_LABEL);
  if (action === 'approve') args.push('--add-label', APPROVED_LABEL);
  else if (labels.has(APPROVED_LABEL)) args.push('--remove-label', APPROVED_LABEL);
  if (action === 'revise') args.push('--add-label', REJECTED_LABEL);
  await gh(cwd, ...args);
  if (action === 'approve') {
    await gh(cwd, 'issue', 'comment', String(number), '--body', `已批准 revision ${item.revision}，工作流继续实现。`);
    await gh(cwd, 'issue', 'close', String(number));
  } else if (action === 'revise') {
    await gh(cwd, 'issue', 'comment', String(number), '--body', `已按命令进入 revision ${item.revision + 1} 修订，完成后会回复请检查。`);
  }
}

/** Apply one interpreted natural-language command to the current requirement. */
export async function applyIntent(store, id, claimId, { action, commentId, revision, summary, cited, error, actor } = {}) {
  const current = await store.get(id);
  if (current.intent?.commentId === Number(commentId)) {
    const stored = current.intent.action;
    return { item: current, outcome: stored === 'approve' ? 'approved' : stored === 'revise' ? 'revision' : 'waiting', duplicate: true };
  }
  const item = await store.applyRequirementIntent(id, claimId, { action, commentId, revision, summary, cited, error, actor });
  if (!item.github?.number) throw new Error('Requirement has no review issue');
  if (action === 'approve' || action === 'revise') {
    await syncIssueDecision(store, item, action);
  } else if (action === 'stop' || action === 'clarify') {
    const body = error
      ? '自动判定暂时不可用，请使用明确命令或稍后重试。'
      : action === 'stop'
        ? '已收到停止指令，保持当前审批状态。'
        : '无法根据这条评论自动判定。请使用明确命令（`@workflow approve` / `@workflow reject <理由>`），或直接说明要修改的具体点。';
    await gh(store.config.repoRoot, 'issue', 'comment', String(item.github.number), '--body', body);
  }
  const outcome = action === 'approve' ? 'approved' : action === 'revise' ? 'revision' : 'waiting';
  return { item: await store.get(id), outcome };
}

/** One Chinese "please check" comment per new revision, after the issue body updates. */
export async function notifyRevision(store, id, claimId) {
  return store.mutate(id, claimId, async item => {
    const brief = item.revisionBrief;
    const operation = (item.commandOperations ?? []).find(entry => entry.state === 'running' && entry.commentId === brief?.commentId);
    const complete = () => {
      if (!operation) return;
      operation.state = 'completed';
      operation.resultRevision = item.revision;
      operation.completedAt = new Date().toISOString();
    };
    if (!brief || brief.revision !== item.revision) return { item, outcome: 'complete', notified: false };
    if (item.notifiedRevision === item.revision) { complete(); return { item, outcome: 'complete', notified: false }; }
    if (!item.github?.number) throw new Error('Requirement has no review issue');
    const items = brief.items ?? [];
    const from = operation?.targetRevision ?? Math.max(1, item.revision - 1);
    const body = [
      `已生成 revision ${from} → ${item.revision}，请检查。`,
      '',
      ...(brief.summary ? [brief.summary, ''] : []),
      ...(items.length ? ['引用反馈：', ...items.map(entry => `- #${entry.commentId}${entry.snippet ? ` · ${entry.snippet}` : ''}${entry.request ? `：${entry.request}` : ''}`), ''] : []),
      '如仍需修改，请评论 `@workflow <具体意见>`；确认后评论 `@workflow approve`。',
    ].join('\n');
    await gh(store.config.repoRoot, 'issue', 'comment', String(item.github.number), '--body', body);
    item.notifiedRevision = item.revision;
    complete();
    return { item, outcome: 'complete' };
  });
}
