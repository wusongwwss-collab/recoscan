/**
 * Easur Open 开源版·零依赖 · 项目计划台直读引擎（core/js/plan-engine.js）
 * ---------------------------------------------------------------------
 * 定位（v0.2 重定位，YQ-1154 D5）：**项目资料目录直读 → 项目信号抽取 →
 * 生成下一步工作计划及任务**。知识库/项目资料目录喂进来，每个项目的
 * 「健康摘要 + 下一步 3 条任务（每条=动作+依据文件行+优先级）+ 风险提示」出来。
 * v0.1 的台账体检（check.analyze）保留为「信号来源」之一：没有台账时，
 * 本引擎直接从目录与文件名信号出发给出计划。
 *
 * 职责边界：
 *   - 只读输入目录（readdir/stat/受限文本抽样首 2KB），**不写盘、不联网、
 *     不调用任何模型**；文件内容不读全文（抽样上限 sampleBytes，默认 2048 字节）。
 *   - 纯函数核心（groupProjects / extractSignals / buildTasks / buildRisks /
 *     buildPlanCard）与 IO 薄壳（listFiles / generatePlan）分离，便于无盘测试。
 *   - 零第三方依赖：仅 Node.js 内置模块（node:fs / node:path）。Node 18+。
 *
 * 信号面（全部可解释、带依据文件）：
 *   活跃度/停滞（mtime）、待办标记（文件名 TODO/待办/未完/草案/draft/wip +
 *   文本抽样行 TODO/FIXME/待办/待确认…）、版本残留（旧版/备份/副本/终版/
 *   copy/vN 并存）、截止暗示（文件名日期 YYYY-MM-DD / YYYYMMDD）、
 *   依赖线索（文件名/抽样文本引用同名兄弟项目目录）。
 *
 * 输出 plan.json 形态（schema easur.plan/card/v1）：
 *   { schema, as_of, root, summary:{projects_total, files_total, sampled_files,
 *     stalled_total, overdue_total}, projects:[{project, health, stall_days,
 *     tasks:[{order, action, priority(高|中|低), reason, evidence:[{path, line?, quote?}]}],
 *     risks:[{kind, detail, evidence?}]}] }
 * 优先级排序：高→中→低；每项目恒好 3 条（不足由兜底任务补齐）。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  maxFiles: 4000,            // 目录扫描文件数护栏（超限截断并在 summary 明示）
  maxDepth: 6,               // 目录深度护栏
  sampleBytes: 2048,         // 单文件文本抽样上限（首 2KB，不读全文）
  sampleFilesPerProject: 12, // 每项目文本抽样文件数上限（按最近修改优先）
  staleDays: 14,             // 停滞阈值（天）
  deadlineSoonDays: 7,       // 截止临期窗口（天）
  skipDirNames: new Set(['.git', '.svn', '.idea', '.vscode', 'node_modules',
    '__pycache__', '.venv', 'venv', 'dist', 'build', 'target', '.recoscan', '.quickcue']),
  textExts: new Set(['.md', '.txt', '.csv', '.json', '.yaml', '.yml', '.html',
    '.htm', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.py', '.sql',
    '.log', '.ini', '.cfg', '.conf', '.toml']),
};

// 文件名级待办/未完标记（任务书口径：TODO/待办/未完/草案/旧版/v2 等文件名模式）
const TODO_NAME_RE = /(TODO|FIXME|待办|待完成|未完|草案|草稿|待定|draft|wip)/i;
// 文本抽样行级待办标记（仅强标记词；「草案/草稿/待定」作弱词易误命中标题行，只用于文件名面）
const TODO_TEXT_RE = /(TODO|FIXME|待办|待完成|未完成|待确认|待补充)/;
// 版本残留标记（多版本并存信号）
const VERSION_RE = /(旧版|备份|副本|终版|copy|backup)|(?:^|[-_ .])v\d+(?:$|[-_.])/i;
// 文件名截止日期：2026-11-30 / 2026/11/30 / 2026年11月30日 / 2026.11.30 / 20261130
const DATE_LONG_RE = /(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/g;
const DATE_COMPACT_RE = /(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)/g;
// 文件名分词（前缀聚类用）
const NAME_SPLIT_RE = /[-_—·\s.]+/;

const PRIORITY_RANK = { 高: 0, 中: 1, 低: 2 };
const DAY_MS = 86400000;

function startOfDay(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function asOf(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/** 文件名中的截止日期 → [{date:'YYYY-MM-DD', daysUntil}]（去重、非法月日剔除） */
function extractFilenameDates(name, nowMs) {
  const out = [];
  const seen = new Set();
  const push = (y, m, d) => {
    y = Number(y); m = Number(m); d = Number(d);
    if (!(y >= 1970 && y <= 2999 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return;
    const key = y + '-' + pad2(m) + '-' + pad2(d);
    if (seen.has(key)) return;
    seen.add(key);
    const daysUntil = Math.round((Date.UTC(y, m - 1, d) - startOfDay(nowMs)) / DAY_MS);
    out.push({ date: key, daysUntil });
  };
  let m;
  DATE_LONG_RE.lastIndex = 0;
  while ((m = DATE_LONG_RE.exec(name)) !== null) push(m[1], m[2], m[3]);
  DATE_COMPACT_RE.lastIndex = 0;
  while ((m = DATE_COMPACT_RE.exec(name)) !== null) push(m[1], m[2], m[3]);
  return out;
}

/** 抽样读文件首部（≤sampleBytes 字节），非文本扩展名/读失败返回 null */
function sampleHead(absPath, ext, opts) {
  if (!opts.textExts.has(ext)) return null;
  let fd;
  try {
    fd = fs.openSync(absPath, 'r');
    const buf = Buffer.alloc(opts.sampleBytes);
    const n = fs.readSync(fd, buf, 0, opts.sampleBytes, 0);
    return buf.toString('utf8', 0, n).replace(/\u0000/g, '');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* 忽略 */ } }
  }
}

// ---------------------------------------------------------------------------
// IO 薄壳：目录扫描（只读、有界）
// ---------------------------------------------------------------------------

/** 扫描目录 → 文件/目录条目列表（不读内容）。
 *  entry = {name, ext, relPath(正斜杠), absPath, mtimeMs, size, isDir, top} */
function listFiles(rootPath, opts) {
  const entries = [];
  const walk = (abs, rel, depth) => {
    if (depth > opts.maxDepth || entries.length >= opts.maxFiles) return;
    let items;
    try { items = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (entries.length >= opts.maxFiles) return;
      const name = it.name;
      const relChild = (rel ? rel + '/' : '') + name;
      const absChild = path.join(abs, name);
      if (it.isDirectory()) {
        if (opts.skipDirNames.has(name) || name.startsWith('.')) continue;
        entries.push({ name, ext: '', relPath: relChild + '/', absPath: absChild,
          mtimeMs: 0, size: 0, isDir: true, top: relChild });
        walk(absChild, relChild, depth + 1);
        continue;
      }
      if (!it.isFile()) continue; // 符号链接等跳过（零侵入）
      let st = null;
      try { st = fs.statSync(absChild); } catch { continue; }
      entries.push({
        name, ext: path.extname(name).toLowerCase(), relPath: relChild, absPath: absChild,
        mtimeMs: st.mtimeMs, size: st.size, isDir: false,
        top: rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : rel,
      });
    }
  };
  walk(path.resolve(rootPath), '', 1);
  return entries;
}

// ---------------------------------------------------------------------------
// 纯函数核心：归项目 → 抽信号 → 出计划
// ---------------------------------------------------------------------------

/** 去版本标记后的基名（多版本配对用） */
function baseStem(name) {
  const stem = name.replace(/\.[^.]+$/, '');
  return stem.replace(VERSION_RE, '').replace(/[-_ .]+$/, '').trim().toLowerCase();
}

/** 条目 → 项目分组：一级目录名优先；根散件按文件名前缀聚类（前缀撞目录名则并入） */
function groupProjects(entries) {
  const groups = new Map(); // name -> entries[]
  const ensure = (k) => {
    if (!groups.has(k)) groups.set(k, []);
    return groups.get(k);
  };
  for (const e of entries) {
    if (e.isDir) { ensure(e.relPath.replace(/\/$/, '')); continue; } // 空目录也成组
    if (!e.relPath.includes('/')) {
      // 根散件：取扩展名前第一段做前缀（无分隔符则整名）；前缀撞目录名自然并组
      const stem = e.name.replace(/\.[^.]+$/, '');
      const token = stem.split(NAME_SPLIT_RE)[0] || stem;
      ensure(token).push(e);
      continue;
    }
    ensure(e.top).push(e);
  }
  return groups;
}

/** 单项目信号抽取（纯函数；nowMs 注入保证可复算） */
function extractSignals(groupName, entries, opts, nowMs, groupNames) {
  const files = entries.filter((e) => !e.isDir);
  const mtimes = files.map((e) => e.mtimeMs).filter((x) => x > 0);
  const lastActiveMs = mtimes.length ? Math.max(...mtimes) : null;
  const stallDays = lastActiveMs == null ? null
    : Math.max(0, Math.floor((startOfDay(nowMs) - startOfDay(lastActiveMs)) / DAY_MS));

  // 待办标记：文本抽样（最近修改优先）+ 文件名；同批抽样顺带找跨项目引用行
  const todoHits = [];
  const depTextHits = [];
  const sampled = [];
  const others = [...groupNames].filter((x) => x !== groupName && x.length >= 2);
  const textFiles = files.filter((e) => opts.textExts.has(e.ext) && e.size > 0)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, opts.sampleFilesPerProject);
  for (const e of textFiles) {
    const head = sampleHead(e.absPath, e.ext, opts);
    if (head == null) continue;
    sampled.push(e.relPath);
    const lines = head.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (todoHits.length < 8 && TODO_TEXT_RE.test(lines[i])) {
        todoHits.push({ file: e.relPath, line: i + 1, quote: lines[i].trim().slice(0, 60) });
      }
      if (depTextHits.length < 8 && others.length) {
        for (const other of others) {
          if (lines[i].includes(other)) {
            depTextHits.push({ other, file: e.relPath, line: i + 1 });
            break;
          }
        }
      }
    }
  }
  const todoNameHits = files
    .filter((e) => TODO_NAME_RE.test(e.name) && !todoHits.some((h) => h.file === e.relPath))
    .map((e) => ({ file: e.relPath, line: null, quote: '文件名含待办标记：' + e.name }));

  // 多版本残留配对（同基名且另一份不带版本标记才计；新旧按 mtime 定，防 v2 误判为旧版）
  const versionDups = [];
  const byStem = new Map();
  for (const e of files) {
    const stem = e.name.replace(/\.[^.]+$/, '').toLowerCase();
    if (!byStem.has(stem)) byStem.set(stem, e);
  }
  for (const e of files) {
    if (!VERSION_RE.test(e.name)) continue;
    const cur = byStem.get(baseStem(e.name));
    if (cur && cur !== e && !VERSION_RE.test(cur.name)) {
      const oldOne = e.mtimeMs <= cur.mtimeMs ? e : cur;
      const curOne = e.mtimeMs <= cur.mtimeMs ? cur : e;
      versionDups.push({ old: oldOne.relPath, current: curOne.relPath });
    }
  }

  // 截止暗示（文件名日期）
  const deadlineHints = [];
  for (const e of files) {
    for (const d of extractFilenameDates(e.name, nowMs)) {
      deadlineHints.push({ file: e.relPath, date: d.date, daysUntil: d.daysUntil });
    }
  }

  // 依赖线索：文件名/路径引用其他兄弟项目名优先，其次抽样文本命中行
  const depHints = [];
  for (const other of others) {
    const byName = files.find((e) => e.name.includes(other) || e.relPath.includes(other));
    if (byName) { depHints.push({ other, file: byName.relPath, line: null }); continue; }
    const inText = depTextHits.find((x) => x.other === other);
    if (inText) depHints.push(inText);
  }

  return {
    fileCount: files.length,
    lastActiveMs, stallDays,
    todoHits: todoHits.concat(todoNameHits),
    versionDups,
    deadlineHints,
    depHints,
    sampledCount: sampled.length,
  };
}

/** 生成单项目任务（恒好 3 条；每条必挂依据；优先级 高>中>低） */
function buildTasks(groupName, entries, signals, opts) {
  const cand = [];
  const ev = (relPath, line, quote) => (line == null && quote == null
    ? [{ path: relPath }] : [{ path: relPath, line, quote }]);
  const newest = entries.filter((e) => !e.isDir)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0] || null;

  // 高：已逾期截止
  for (const d of signals.deadlineHints.filter((x) => x.daysUntil < 0)) {
    cand.push({
      action: '「' + d.file + '」标注截止 ' + d.date + ' 已逾期 ' + (-d.daysUntil) + ' 天：今日处置或重排交付窗口',
      priority: '高', reason: '文件名截止日期已过',
      evidence: ev(d.file),
    });
  }
  // 高：临期截止
  for (const d of signals.deadlineHints.filter((x) => x.daysUntil >= 0 && x.daysUntil <= opts.deadlineSoonDays)) {
    cand.push({
      action: '「' + d.file + '」标注截止 ' + d.date + '（剩 ' + d.daysUntil + ' 天）：排入近几日执行',
      priority: '高', reason: '文件名截止日期在临期窗口内',
      evidence: ev(d.file),
    });
  }
  // 高/中：文本待办（停滞时升为高）
  const todoFileSet = new Set();
  for (const h of signals.todoHits.filter((x) => x.line != null)) {
    todoFileSet.add(h.file);
    cand.push({
      action: '处理「' + h.file + '」第 ' + h.line + ' 行待办：' + (h.quote || '(见文件)'),
      priority: (signals.stallDays != null && signals.stallDays >= opts.staleDays) ? '高' : '中',
      reason: '抽样文本命中待办标记',
      evidence: ev(h.file, h.line, h.quote),
    });
  }
  // 中：文件名待办（同文件已有文本命中则不重复）
  for (const h of signals.todoHits.filter((x) => x.line == null)) {
    if (todoFileSet.has(h.file)) continue;
    cand.push({
      action: '推进「' + h.file + '」：' + h.quote,
      priority: '中', reason: '文件名含待办/未完标记',
      evidence: ev(h.file),
    });
  }
  // 中：依赖线索（引用兄弟项目）
  for (const d of signals.depHints) {
    cand.push({
      action: '与「' + d.other + '」对齐：本项目文件引用了该项目，核对口径与前置',
      priority: '中', reason: '存在跨项目引用',
      evidence: ev(d.file),
    });
  }
  // 中：最近活跃（趁热）
  if (newest && signals.stallDays != null && signals.stallDays <= 3) {
    cand.push({
      action: '趁热推进最近更新的「' + newest.relPath + '」：把当前结论落成下一步动作',
      priority: '中', reason: '最近 3 天内有更新',
      evidence: ev(newest.relPath),
    });
  }
  // 低：版本残留
  for (const d of signals.versionDups) {
    cand.push({
      action: '归档旧版「' + d.old + '」，确认「' + d.current + '」为唯一现行版',
      priority: '低', reason: '多版本并存易误用',
      evidence: ev(d.old).concat(ev(d.current)),
    });
  }
  // 低：停滞无标记
  if (newest && signals.stallDays != null && signals.stallDays >= opts.staleDays
      && !signals.todoHits.some((x) => x.line != null)) {
    cand.push({
      action: '复核停滞 ' + signals.stallDays + ' 天的「' + newest.relPath + '」：仍需要则更新，否则归档',
      priority: '低', reason: '超过停滞阈值且无待办标记',
      evidence: ev(newest.relPath),
    });
  }

  // 去重（同动作文本）→ 截取候选 → 兜底补齐到 3 → 统一按 高→中→低 排序定序
  const seen = new Set();
  const uniq = cand.filter((t) => (seen.has(t.action) ? false : (seen.add(t.action), true)));
  const tasks = uniq.slice(0, 3);

  // 兜底补齐到 3 条（保证「下一步做什么」恒有产出；依据挂最新文件或组目录）
  const fallbackBase = newest ? newest.relPath : groupName + '/';
  const fallbackPool = [
    { action: '清点「' + groupName + '」：为项目建立台账行（状态/截止/前置），让计划可跟踪', priority: '中', reason: '兜底：尚无可执行信号', evidence: [{ path: fallbackBase }] },
    { action: '复核「' + groupName + '」最近文件「' + fallbackBase + '」：确认下一步归属', priority: '低', reason: '兜底：以最近修改为起点', evidence: [{ path: fallbackBase }] },
    { action: '为「' + groupName + '」设定下一个检查点日期，写入文件名或台账', priority: '低', reason: '兜底：无截止暗示，补一个', evidence: [{ path: fallbackBase }] },
  ];
  for (const f of fallbackPool) {
    if (tasks.length >= 3) break;
    if (!seen.has(f.action)) { seen.add(f.action); tasks.push(f); }
  }
  tasks.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
  tasks.forEach((t, i) => { t.order = i + 1; });
  return tasks;
}

/** 单项目风险提示 */
function buildRisks(groupName, signals, opts, existingGroupNames) {
  const risks = [];
  if (signals.fileCount === 0) {
    risks.push({ kind: 'empty', detail: '目录为空，无任何文件信号' });
  }
  if (signals.stallDays != null && signals.stallDays >= opts.staleDays) {
    risks.push({ kind: 'stalled', detail: '最近活跃 ' + signals.stallDays + ' 天前，超过停滞阈值 ' + opts.staleDays + ' 天' });
  }
  for (const d of signals.deadlineHints.filter((x) => x.daysUntil < 0)) {
    risks.push({ kind: 'overdue_deadline', detail: '「' + d.file + '」截止 ' + d.date + ' 已逾期 ' + (-d.daysUntil) + ' 天', evidence: { path: d.file } });
  }
  if (signals.versionDups.length) {
    risks.push({ kind: 'version_dup', detail: signals.versionDups.length + ' 组多版本并存（' + signals.versionDups.map((x) => x.old).join('、') + '）' });
  }
  for (const d of signals.depHints) {
    if (!existingGroupNames.has(d.other)) {
      risks.push({ kind: 'dep_missing', detail: '引用了「' + d.other + '」但目录中不存在同名项目', evidence: { path: d.file } });
    }
  }
  return risks;
}

function healthSummary(groupName, signals, opts) {
  if (signals.fileCount === 0) return groupName + '：目录为空（0 个文件）';
  const parts = [
    groupName + '：' + signals.fileCount + ' 个文件',
    '最近活跃 ' + (signals.stallDays == null ? '未知' : signals.stallDays + ' 天前'),
    '待办标记 ' + signals.todoHits.length + ' 处',
  ];
  if (signals.versionDups.length) parts.push('多版本 ' + signals.versionDups.length + ' 组');
  if (signals.deadlineHints.length) parts.push('截止暗示 ' + signals.deadlineHints.length + ' 个');
  if (signals.depHints.length) parts.push('跨项目引用 ' + signals.depHints.length + ' 处');
  return parts.join('；');
}

/** 计划卡装配（纯函数） */
function buildPlanCard(rootPath, groups, opts, nowMs, truncated) {
  const groupNames = new Set(groups.keys());
  const projects = [];
  let filesTotal = 0;
  let sampledTotal = 0;
  for (const [name, entries] of groups) {
    const signals = extractSignals(name, entries, opts, nowMs, groupNames);
    filesTotal += signals.fileCount;
    sampledTotal += signals.sampledCount;
    const tasks = buildTasks(name, entries, signals, opts);
    const risks = buildRisks(name, signals, opts, groupNames);
    const weight = risks.some((r) => r.kind === 'overdue_deadline') ? 0
      : risks.some((r) => r.kind === 'stalled') ? 1
        : (signals.stallDays != null && signals.stallDays <= 3) ? 3 : 2;
    projects.push({
      project: name,
      health: healthSummary(name, signals, opts),
      stall_days: signals.stallDays,
      files: signals.fileCount,
      weight,
      tasks,
      risks,
    });
  }
  projects.sort((a, b) => a.weight - b.weight || b.stall_days - a.stall_days
    || String(a.project).localeCompare(String(b.project), 'zh'));
  for (const p of projects) delete p.weight;
  const stalledTotal = projects.filter((p) => p.risks.some((r) => r.kind === 'stalled')).length;
  const overdueTotal = projects.filter((p) => p.risks.some((r) => r.kind === 'overdue_deadline')).length;
  return {
    schema: 'easur.plan/card/v1',
    as_of: asOf(nowMs),
    root: rootPath,
    summary: {
      projects_total: projects.length,
      files_total: filesTotal,
      sampled_files: sampledTotal,
      stalled_total: stalledTotal,
      overdue_total: overdueTotal,
      truncated: Boolean(truncated),
    },
    projects,
  };
}

// ---------------------------------------------------------------------------
// IO 入口：目录直读 → 计划卡（只读，不落盘）
// ---------------------------------------------------------------------------

/** 生成计划卡。opts 覆盖 DEFAULTS（staleDays/deadlineSoonDays/maxFiles/...）；nowMs 注入。 */
function generatePlan(rootPath, opts) {
  const o = { ...DEFAULTS, ...(opts || {}) };
  if (o.skipDirNames instanceof Array) o.skipDirNames = new Set(o.skipDirNames);
  if (o.textExts instanceof Array) o.textExts = new Set(o.textExts);
  const abs = path.resolve(String(rootPath || ''));
  let st = null;
  try { st = fs.statSync(abs); } catch { /* 下面统一报错 */ }
  if (!st || !st.isDirectory()) throw new Error('目录不存在或不是目录: ' + abs);
  const entries = listFiles(abs, o);
  const truncated = entries.length >= o.maxFiles;
  const groups = groupProjects(entries);
  const nowMs = o.nowMs != null ? o.nowMs : Date.now();
  const card = buildPlanCard(String(rootPath), groups, o, nowMs, truncated);
  return card;
}

module.exports = {
  DEFAULTS,
  listFiles,
  groupProjects,
  extractSignals,
  buildTasks,
  buildRisks,
  buildPlanCard,
  generatePlan,
  extractFilenameDates,
  TODO_NAME_RE,
  TODO_TEXT_RE,
  VERSION_RE,
};
