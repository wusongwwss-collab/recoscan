/**
 * Easur Open · 项目体检 stdio MCP 服务器（hosts/mcp/project_server.mjs）
 * ---------------------------------------------------------------------
 * 协议：JSON-RPC 2.0 over stdio（按行分帧，一行一条 JSON；通知不回包）。
 * 依赖：仅 Node 内置模块（node:readline/node:module/node:path/node:url/node:util），
 *       零第三方包、零网络；计算面全部落在 core/js 纯函数引擎上。
 * 工具面：
 *   check.analyze   项目台账（JSON/CSV 文本）→ 体检卡：风险等级/证据行/下一步建议（逐条带证据引用）
 *                   ＝ project-ontology.extract + scoreProjects + assertionGraph
 *   plan.suggest    台账状态/截止/依赖 → 排期建议（完成殿后、阻塞前置、临期优先）
 *   rules.validate  规则包结构校验（easur.project-check/v1 包；yishu.discovery/v1 载荷
 *                   走 reco-engine.normalizeRulePackage 两级校验）
 * 运行：node hosts/mcp/project_server.mjs（stdin/stdout 由 MCP 宿主接管）
 */
'use strict';

import { createRequire } from 'node:module';
import * as readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const requireLocal = createRequire(path.join(HERE, 'project_server.mjs'));
const ontology = requireLocal(path.join(HERE, '..', '..', 'core', 'js', 'project-ontology.js'));
const reco = requireLocal(path.join(HERE, '..', '..', 'core', 'js', 'reco-engine.js'));

const SERVER_INFO = { name: 'easur-project-mcp', version: '1.0.0' };
const PROTOCOL_VERSION = '2024-11-05';

// 与 packs/project/rules.example.yaml 同口径的默认包（rules 参数可覆盖逐节）
const DEFAULT_RULES = {
  schema: 'easur.project-check/v1',
  metrics: { entity_name_exact: 3, entity_alias: 2, alias_to_entity: 1, term_overlap: 1, org_in_history_title: 2 },
  risk_thresholds: { high_min: 6, medium_min: 3, low_min: 1 },
  guardrails: { max_entities: 300, max_assert_edges: 450, max_file_edges: 600 },
  extraction: { quote_padding: 22, subject_window: 14, object_max_len: 40, term_min_len: 4, term_max_len: 8, term_min_freq: 2, terms_cap: 12, quoted_cap: 8 },
  attribution: { reasons_cap: 3, evidence_rows_cap: 10, stale_days: 14, deadline_soon_days: 3, overdue_is_high: true },
};

const DONE_STATUS = new Set(['完成', '已完成', '已上线', '已交付', '已取消', 'done', 'closed', 'completed', 'cancelled', 'canceled']);
const NEGATIVE_PREDICATES = ['拒绝', '否决', '压价'];

// ============================== 台账解析（JSON / CSV） ==============================

const FIELD_ALIASES = {
  name: ['name', 'project', 'project_name', 'projectname', '项目', '项目名', '项目名称', '名称', '任务', '任务名'],
  status: ['status', 'state', '状态'],
  deadline: ['deadline', 'due', 'due_date', 'duedate', '截止', '截止日', '截止日期', '交付日'],
  depends: ['depends', 'depends_on', 'dependson', 'blocked_by', '依赖', '前置', '前置依赖', '前置任务'],
  evidence: ['evidence', 'note', 'notes', 'desc', 'description', '证据', '说明', '证据说明', '描述', '备注'],
  owner: ['owner', 'assignee', '负责人', '责任人'],
};

function canonField(header) {
  const k = String(header || '').trim().toLowerCase().replace(/[\s_]/g, '');
  for (const [canon, list] of Object.entries(FIELD_ALIASES)) {
    if (list.some((a) => a.toLowerCase().replace(/[\s_]/g, '') === k)) return canon;
  }
  return null;
}

function splitCsvLine(line) {
  const cells = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { cells.push(cur); cur = ''; }
    else cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

/** 台账文本 → 行数组（JSON 数组/单对象/CSV 均收；无法解析抛 Error） */
function parseLedger(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) throw new Error('台账文本为空');
  if (t[0] === '[' || t[0] === '{') {
    let data;
    try { data = JSON.parse(t); } catch (e) { throw new Error('JSON 解析失败: ' + e.message); }
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') {
      for (const k of ['rows', 'projects', 'items', 'ledger', 'data', 'tasks']) {
        if (Array.isArray(data[k])) return data[k];
      }
      return [data];
    }
    throw new Error('JSON 台账须为数组或含 rows/projects/items 的对象');
  }
  const lines = t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error('CSV 台账至少需要表头 + 1 行数据');
  const headers = splitCsvLine(lines[0]).map(canonField);
  const rows = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const row = {};
    headers.forEach((h, i) => { if (h && cells[i] !== undefined) row[h] = cells[i]; });
    if (Object.keys(row).length) rows.push(row);
  }
  return rows;
}

// ============================== 体检卡装配 ==============================

function todayKey() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function daysUntil(dateStr) {
  const s = String(dateStr || '').trim();
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (!m) return null;
  const due = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const now = new Date();
  const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due - t0) / 86400000);
}

function normStatus(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
function isDone(row) { return DONE_STATUS.has(normStatus(row.status)); }

/** 引擎断言行形状（assertionGraph 输入面） */
function toAssertionRow(a, id, rowIdx, projName) {
  return {
    id, subject_name: a.subject || '', predicate: a.predicate || '',
    object_value: a.object || '', kind: a.kind || 'relation', act_time: a.actTime || '',
    status: 'active', ref_type: 'row', ref_id: rowIdx, anchor: projName, quote: a.quote || '',
  };
}

function mergeEntities(acc, ents) {
  for (const e of ents) {
    if (!acc.has(e.name)) acc.set(e.name, { name: e.name, type: e.type, aliases: [] });
    const g = acc.get(e.name);
    for (const a of e.aliases) if (!g.aliases.includes(a)) g.aliases.push(a);
  }
}

/** check.analyze 主装配：台账 → 体检卡 */
function analyze(ledgerText, rulesOverride) {
  const rules = rulesOverride && typeof rulesOverride === 'object'
    ? { ...DEFAULT_RULES, ...rulesOverride } : DEFAULT_RULES;
  const rows = parseLedger(ledgerText);
  if (!rows.length) throw new Error('台账为空行');

  const day = todayKey();
  // 按项目聚合行 + 逐行抽取（零模型规则抽取，纯函数）
  const byProject = new Map(); // name -> {rowIdx:[], evidenceText, assertions, ents}
  const allEnts = new Map();
  const allTerms = new Set();
  const assertionRows = [];
  let assertId = 0;
  rows.forEach((raw, i) => {
    const name = String(raw.name || '').trim() || ('未命名项目#' + (i + 1));
    const text = String(raw.evidence || '').trim();
    if (!byProject.has(name)) byProject.set(name, { name, rowIdx: [], texts: [], ents: [], terms: [], assertions: [] });
    const P = byProject.get(name);
    P.rowIdx.push(i + 1);
    P.texts.push(text);
    if (text) {
      const ex = ontology.extract(text);
      mergeEntities(allEnts, ex.entities);
      for (const e of ex.entities) {
        const hit = P.ents.find((x) => x.name === e.name);
        if (hit) { for (const a of e.aliases) if (!hit.aliases.includes(a)) hit.aliases.push(a); }
        else P.ents.push({ name: e.name, type: e.type, aliases: e.aliases.slice() });
      }
      for (const t of ex.terms) { allTerms.add(t.term); P.terms.push(t.term); }
      for (const a of ex.assertions) {
        assertId += 1;
        const row = toAssertionRow(a, assertId, i + 1, name);
        assertionRows.push(row);
        P.assertions.push(row);
      }
    }
  });

  // 归因计分：全局实体/术语 vs 项目画像（scoreProjects 五因子）
  const profiles = Array.from(byProject.values()).map((P) => ({
    project_id: P.name, name: P.name,
    entityNames: P.ents.map((e) => e.name),
    entityAliasMap: P.ents.flatMap((e) => e.aliases.map((alias) => ({ alias, name: e.name }))),
    terms: Array.from(new Set(P.terms)),
    titleText: P.texts.join(' '),
  }));
  const globalEnts = Array.from(allEnts.values());
  const globalTerms = Array.from(allTerms);
  const scored = ontology.scoreProjects(globalEnts, globalTerms, profiles);
  const scoreOf = new Map(scored.map((s) => [s.project_id, s]));

  // 断言关系网（护栏：断言边 ≤ guardrails.max_assert_edges，超限截断明示）
  const graph = ontology.assertionGraph(assertionRows);
  const graphOut = { nodes: graph.nodes, edges: graph.edges };
  const truncated = { assert_edges: false };
  if (graphOut.edges.length > rules.guardrails.max_assert_edges) {
    truncated.assert_edges = true;
    graphOut.edges = graphOut.edges.slice(0, rules.guardrails.max_assert_edges);
  }

  // 逐项目风险合成 + 证据 + 建议
  const projectDone = new Map();
  for (const [pname, P] of byProject) projectDone.set(pname, P.rowIdx.some((n) => isDone(rows[n - 1])));
  const projects = [];
  for (const P of byProject.values()) {
    const rowObjs = P.rowIdx.map((n) => ({ n, raw: rows[n - 1] }));
    const notDone = rowObjs.filter((x) => !isDone(x.raw));
    const signals = [];
    let overdueDays = null;
    let dueIn = null;
    for (const { n, raw } of rowObjs) {
      if (isDone(raw)) continue;
      const d = daysUntil(raw.deadline);
      if (d === null) continue;
      if (d < 0) { overdueDays = Math.max(overdueDays === null ? -Infinity : overdueDays, -d); signals.push({ kind: 'overdue', row: n, detail: `截止 ${raw.deadline} 已逾期 ${-d} 天` }); }
      else if (d <= rules.attribution.deadline_soon_days) { dueIn = dueIn === null ? d : Math.min(dueIn, d); signals.push({ kind: 'due_soon', row: n, detail: `截止 ${raw.deadline} 仅剩 ${d} 天` }); }
    }
    const deps = String((notDone[0] || rowObjs[0] || {}).raw && (notDone[0] || rowObjs[0]).raw.depends || '').trim();
    const blockedBy = deps ? deps.split(/[,;、;]+/).map((s) => s.trim()).filter(Boolean).filter((d) => byProject.has(d) && !projectDone.get(d)) : [];
    for (const d of blockedBy) signals.push({ kind: 'blocked', row: P.rowIdx[0], detail: `前置「${d}」未完成` });
    if (!P.texts.join('').trim()) signals.push({ kind: 'no_evidence', row: P.rowIdx[0], detail: '无证据/说明文本，抽取面为空' });
    const negatives = P.assertions.filter((a) => NEGATIVE_PREDICATES.some((p) => a.predicate === p));
    for (const a of negatives) signals.push({ kind: 'negative_assertion', row: a.ref_id, detail: `断言「${a.subject_name} ${a.predicate} ${a.object_value}」` });

    const s = scoreOf.get(P.name) || { score: 0, reasons: [] };
    const th = rules.risk_thresholds;
    let risk = '未入列';
    const hasOverdue = signals.some((x) => x.kind === 'overdue');
    const hasNeg = signals.some((x) => x.kind === 'negative_assertion');
    if (notDone.length && ((hasOverdue && rules.attribution.overdue_is_high) || (s.score >= th.high_min && (hasNeg || hasOverdue)))) risk = '高';
    else if (hasOverdue || hasNeg || s.score >= th.medium_min || dueIn !== null || blockedBy.length || signals.some((x) => x.kind === 'no_evidence')) risk = '中';
    else if (s.score >= th.low_min) risk = '低';
    else if (s.score === 0 && !notDone.length) risk = '低';

    // 证据行（封顶 attribution.evidence_rows_cap）
    const evidence = rowObjs.slice(0, rules.attribution.evidence_rows_cap).map(({ n, raw }) => {
      const txt = String(raw.evidence || '');
      return {
        row: n, status: String(raw.status || ''), deadline: String(raw.deadline || ''),
        quote: txt ? ontology.quoteAround(txt, 0, Math.min(44, txt.length)) : '',
      };
    });

    // 下一步建议（逐条带证据引用）
    const nextSteps = [];
    const evOf = (row) => ({ row, quote: (assertionRows.find((a) => a.ref_id === row) || {}).quote || '' });
    if (hasOverdue) nextSteps.push({ text: `已逾期：重排「${P.name}」交付计划，并与相关方重述承诺窗口`, evidence: evOf(signals.find((x) => x.kind === 'overdue').row) });
    if (blockedBy.length) nextSteps.push({ text: `被前置阻塞：先推进「${blockedBy.join('」「')}」或调整本项排期`, evidence: evOf(P.rowIdx[0]) });
    for (const a of negatives.slice(0, 2)) nextSteps.push({ text: `存在分歧点（${a.predicate}）：建议复盘该断言的对价与边界`, evidence: { row: a.ref_id, quote: a.quote } });
    if (dueIn !== null) nextSteps.push({ text: `临期（≤${rules.attribution.deadline_soon_days} 天）：确认剩余工作量与验收口径`, evidence: evOf(signals.find((x) => x.kind === 'due_soon').row) });
    if (signals.some((x) => x.kind === 'no_evidence')) nextSteps.push({ text: '补录证据文本（会议结论/承诺/报价），否则体检面为空', evidence: evOf(P.rowIdx[0]) });
    if (!nextSteps.length) nextSteps.push({ text: '无急迫信号：保持台账更新节奏即可', evidence: evOf(P.rowIdx[0]) });

    projects.push({
      project: P.name, score: s.score, reasons: s.reasons.slice(0, rules.attribution.reasons_cap),
      risk, signals: signals.map((x) => ({ kind: x.kind, row: x.row, detail: x.detail })),
      evidence, next_steps: nextSteps.slice(0, 6),
    });
  }
  const riskRank = { 高: 0, 中: 1, 低: 2, 未入列: 3 };
  projects.sort((a, b) => riskRank[a.risk] - riskRank[b.risk] || b.score - a.score);
  const summary = {
    projects_total: projects.length,
    rows_total: rows.length,
    as_of: day,
    risk: projects.reduce((acc, p) => { acc[p.risk] = (acc[p.risk] || 0) + 1; return acc; }, {}),
  };
  return { schema: 'easur.project-check/card/v1', summary, assertion_graph: { ...graphOut, truncated }, projects };
}

// ============================== 计划建议 ==============================

function planSuggest(ledgerText) {
  const rows = parseLedger(ledgerText);
  const tasks = rows.map((raw, i) => ({
    order0: i, task: String(raw.name || '').trim() || ('未命名#' + (i + 1)),
    status: String(raw.status || '').trim(), done: isDone(raw),
    deadline: String(raw.deadline || '').trim(), due: daysUntil(raw.deadline),
    depends: String(raw.depends || '').trim(),
  }));
  const doneNames = new Set(tasks.filter((t) => t.done).map((t) => t.task));
  for (const t of tasks) {
    t.blocked_by = t.depends ? t.depends.split(/[,;、;]+/).map((s) => s.trim()).filter(Boolean).filter((d) => tasks.some((x) => x.task === d && !doneNames.has(d))) : [];
  }
  const rank = (t) => (t.done ? 3 : (t.blocked_by.length ? 2 : 0));
  const planned = tasks.slice().sort((a, b) => rank(a) - rank(b)
    || (a.due === null ? 1 : 0) - (b.due === null ? 1 : 0)
    || (a.due === null ? 0 : a.due) - (b.due === null ? 0 : b.due)
    || a.task.localeCompare(b.task, 'zh'));
  const plan = planned.map((t, i) => {
    let reason;
    let action;
    if (t.done) { reason = '已完成，殿后仅留档'; action = '归档或关闭'; }
    else if (t.blocked_by.length) { reason = `被未完成前置「${t.blocked_by.join('」「')}」阻塞`; action = `先推进前置或与「${t.blocked_by[0]}」对齐时间`; }
    else if (t.due !== null && t.due < 0) { reason = `已逾期 ${-t.due} 天，紧迫度最高`; action = '立即重排交付窗口并知会相关方'; }
    else if (t.due !== null) { reason = `截止 ${t.deadline}（剩 ${t.due} 天）`; action = '按截止日排入近期执行'; }
    else { reason = '无截止日，按名称序殿后于有期任务'; action = '补设截止日后重排'; }
    return { order: i + 1, task: t.task, status: t.status, deadline: t.deadline, blocked_by: t.blocked_by, reason, action };
  });
  return { schema: 'easur.project-check/plan/v1', total: plan.length, plan };
}

// ============================== 规则包校验 ==============================

function validateRules(input, opts) {
  let payload = input;
  if (typeof input === 'string') {
    try { payload = JSON.parse(input); } catch (e) { return { ok: false, mode: 'parse', errors: ['JSON 解析失败: ' + e.message], warnings: [] }; }
  }
  const schema = String((payload && payload.schema) || '');
  if (schema.startsWith('yishu.discovery/')) {
    const r = reco.normalizeRulePackage(payload, { slots: Array.isArray(opts && opts.slots) ? opts.slots : [] });
    return { ok: r.ok, mode: 'discovery_rule_package', reason: r.reason, rules: r.rules.length, skipped: r.skipped, errors: r.ok ? [] : ['整包丢弃: ' + r.reason], warnings: [] };
  }
  const errors = [];
  const warnings = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, mode: 'project_check_pack', errors: ['规则包须为对象'], warnings };
  const allowTop = ['schema', 'metrics', 'risk_thresholds', 'guardrails', 'extraction', 'attribution'];
  for (const k of Object.keys(payload)) if (!allowTop.includes(k)) errors.push(`未知顶层键: ${k}`);
  if (schema !== 'easur.project-check/v1') warnings.push(`schema=${schema || '(缺)'} 非 easur.project-check/v1，按当前唯一认值处理请确认`);
  const intInRange = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  const m = payload.metrics || {};
  for (const k of Object.keys(DEFAULT_RULES.metrics)) {
    if (!intInRange(m[k], 1, 10)) errors.push(`metrics.${k} 缺失或非 1..10 整数（当前=${JSON.stringify(m[k])}）`);
  }
  for (const k of Object.keys(m)) if (!(k in DEFAULT_RULES.metrics)) errors.push(`metrics 未知权重键: ${k}`);
  const th = payload.risk_thresholds || {};
  if (!(intInRange(th.low_min, 1, 99) && intInRange(th.medium_min, 2, 100) && intInRange(th.high_min, 3, 100) && th.low_min < th.medium_min && th.medium_min < th.high_min)) {
    errors.push('risk_thresholds 须满足 low_min < medium_min < high_min 且均为正整数');
  }
  const g = payload.guardrails || {};
  for (const k of Object.keys(DEFAULT_RULES.guardrails)) {
    if (!intInRange(g[k], 1, 100000)) errors.push(`guardrails.${k} 须为 1..100000 整数（当前=${JSON.stringify(g[k])}）`);
  }
  const ex = payload.extraction || {};
  if (!(intInRange(ex.term_min_len, 1, 64) && intInRange(ex.term_max_len, 1, 64) && ex.term_min_len <= ex.term_max_len)) errors.push('extraction.term_min_len ≤ term_max_len 且均为正整数');
  for (const k of ['quote_padding', 'object_max_len', 'term_min_freq', 'terms_cap', 'quoted_cap']) {
    if (!intInRange(ex[k], 0, 100000)) errors.push(`extraction.${k} 须为非负整数（当前=${JSON.stringify(ex[k])}）`);
  }
  const at = payload.attribution || {};
  for (const k of ['reasons_cap', 'evidence_rows_cap', 'stale_days', 'deadline_soon_days']) {
    if (!intInRange(at[k], 1, 100000) && !(k === 'deadline_soon_days' && at[k] === 0)) errors.push(`attribution.${k} 须为正整数（deadline_soon_days 可为 0）`);
  }
  if (typeof at.overdue_is_high !== 'boolean') errors.push('attribution.overdue_is_high 须为布尔');
  return { ok: errors.length === 0, mode: 'project_check_pack', errors, warnings };
}

// ============================== JSON-RPC 2.0 over stdio ==============================

const TOOLS = [
  {
    name: 'check.analyze',
    description: '项目体检：输入项目台账 JSON/CSV 文本，输出体检卡（风险等级/归因理由/证据行/下一步建议，建议逐条带证据引用）+ 断言关系网投影',
    inputSchema: {
      type: 'object', required: ['ledger'],
      properties: {
        ledger: { type: 'string', description: '台账文本：JSON 数组/对象，或 CSV（表头列名支持中英文别名：项目/状态/截止/依赖/证据等）' },
        rules: { type: 'object', description: '可选规则包覆盖（与 packs/project/rules.example.yaml 同构；缺省用内置默认包）' },
      },
    },
  },
  {
    name: 'plan.suggest',
    description: '排期建议：基于台账状态/截止日/前置依赖给出执行顺序（完成殿后、阻塞前置、临期优先），逐条带理由',
    inputSchema: {
      type: 'object', required: ['ledger'],
      properties: { ledger: { type: 'string', description: '台账文本（同 check.analyze）' } },
    },
  },
  {
    name: 'rules.validate',
    description: '规则包结构校验：easur.project-check/v1 体检包逐节校验；yishu.discovery/v1 推荐规则载荷走引擎两级校验（好包通过/坏包整包丢弃/坏条跳过计数）',
    inputSchema: {
      type: 'object', required: ['rules'],
      properties: {
        rules: { description: '规则包对象或 JSON 字符串', oneOf: [{ type: 'object' }, { type: 'string' }] },
        slots: { type: 'array', items: { type: 'string' }, description: '可选推荐位闭集（仅 yishu.discovery/v1 载荷用）' },
      },
    },
  },
];

function toolCall(name, args) {
  const a = args || {};
  switch (name) {
    case 'check.analyze': {
      if (typeof a.ledger !== 'string') throw new Error('参数 ledger 须为台账文本字符串');
      return analyze(a.ledger, a.rules);
    }
    case 'plan.suggest': {
      if (typeof a.ledger !== 'string') throw new Error('参数 ledger 须为台账文本字符串');
      return planSuggest(a.ledger);
    }
    case 'rules.validate':
      if (a.rules === undefined) throw new Error('参数 rules 缺失');
      return validateRules(a.rules, a);
    default:
      return null;
  }
}

function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
function replyErr(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n'); }

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try { msg = JSON.parse(s); } catch (e) { replyErr(null, -32700, 'Parse error: ' + e.message); return; }
  const method = msg && msg.method;
  const hasId = msg && msg.id !== undefined && msg.id !== null;
  if (typeof method !== 'string') { if (hasId) replyErr(msg.id, -32600, 'Invalid Request: 缺 method'); return; }
  if (method === 'initialize') {
    reply(msg.id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    return;
  }
  if (method === 'ping') { reply(msg.id, {}); return; }
  if (method === 'tools/list') { reply(msg.id, { tools: TOOLS }); return; }
  if (method === 'tools/call') {
    const params = msg.params || {};
    const name = String(params.name || '');
    try {
      const out = toolCall(name, params.arguments);
      if (out === null) { replyErr(msg.id, -32602, `Unknown tool: ${name}`); return; }
      reply(msg.id, { content: [{ type: 'text', text: JSON.stringify(out) }] });
    } catch (e) {
      reply(msg.id, { content: [{ type: 'text', text: '工具执行失败: ' + e.message }], isError: true });
    }
    return;
  }
  // 通知（无 id）静默；未知带 id 方法回 method not found
  if (hasId) replyErr(msg.id, -32601, 'Method not found: ' + method);
});
rl.on('close', () => process.exit(0));
process.on('uncaughtException', (e) => {
  process.stderr.write('[easur-project-mcp] uncaught: ' + inspect(e) + '\n');
});
