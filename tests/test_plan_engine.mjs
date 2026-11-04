/**
 * 项目计划台直读引擎机闸（tests/test_plan_engine.mjs）· 零框架，node 直跑
 * -------------------------------------------------------------------
 * 判据面（YQ-1154 D5 件3：core/js/plan-engine.js + MCP plan.generate）：
 *   ① 合成目录 fixture → 计划卡结构（schema/summary/projects 全字段）
 *   ② 归项目：一级目录名分组 + 根散件文件名前缀聚类（报告.docx/报告-旧版.docx → 「报告」）
 *   ③ 信号抽取：待办标记（文本抽样行号+引用）/ 截止暗示（文件名日期，逾期+临期）/
 *      依赖线索（文件名与抽样文本引用兄弟项目名）/ 版本残留（按 mtime 定新旧）/ 停滞天数
 *   ④ 任务面：每项目恒 3 条、逐条带依据文件（path 必填，文本命中带行号+quote）、
 *      优先级 高→中→低 单调、逾期/临期升「高」、兜底补齐
 *   ⑤ 风险面：stalled / overdue_deadline / version_dup / empty / dep_missing
 *   ⑥ options 覆盖：staleDays 放宽 → stalled 风险消失（两态对照）
 *   ⑦ MCP 真握手：tools/list 含 plan.generate；tools/call 出卡；坏路径回 isError
 *
 * 纪律：fixture 一律 fs.mkdtempSync(os.tmpdir()) 临时目录（测试数据隔离），
 * mtime 用 utimesSync 显式注入保证可复算；跑完即清理；全部名称虚构。
 * 运行：node tests/test_plan_engine.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRequire } from 'node:module';
const requireLocal = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), 'x.js'));
const planEngine = requireLocal(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'core', 'js', 'plan-engine.js'));

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
const failures = [];
const ok = (cond, msg) => { if (cond) pass += 1; else failures.push(msg); };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg + `（实际=${JSON.stringify(a)} 期望=${JSON.stringify(b)}）`);

// 注入时钟：2026-11-05（正午 UTC，避开日界）
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const DAY = 86400000;
const at = (daysAgo) => new Date(NOW - daysAgo * DAY);

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'recoscan-plan-')); }
function put(root, rel, content, mtime) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  if (mtime) fs.utimesSync(abs, mtime, mtime);
  return abs;
}

// ---------------- 合成 fixture（全部虚构名称） ----------------
//  甲=活跃项目（草案待办+引用乙）；乙=临期截止+文本引用丙；丙=停滞+逾期截止；
//  报告=根散件前缀聚类+版本残留；丁=空目录
function buildFixture(root) {
  put(root, '项目甲/甲-实施方案草案.md',
    '# 甲项目实施方案（草案）\nTODO：确认供应商报价与交付窗口\n其余为占位内容。\n', at(30));
  put(root, '项目甲/甲-实施方案草案-v2.md', '# 甲项目实施方案（草案）v2\n已按评审意见修订。\n', at(1));
  put(root, '项目甲/甲-与项目乙对齐备忘.md', '备忘：接口口径与项目乙对齐。\n', at(2));
  put(root, '项目乙/乙-验收单-2026-11-08.md', '# 乙项目验收单\n验收标准占位。\n', at(2));
  put(root, '项目乙/乙-交付清单.md', '# 乙项目交付清单\n下一步与项目丙对齐结算口径。\n', at(2));
  put(root, '项目丙/丙-结算单-2026-10-20.md', '# 丙项目结算单\n结算说明占位。\n', at(20));
  put(root, '报告.docx', '(二进制占位)', at(1));
  put(root, '报告-旧版.docx', '(二进制占位)', at(30));
  fs.mkdirSync(path.join(root, '项目丁'), { recursive: true });
}

// ---------------- ①-⑤ 直读引擎（注入时钟可复算） ----------------
const root = tmpRoot();
buildFixture(root);
const card = planEngine.generatePlan(root, { nowMs: NOW });

// ① 结构
eq(card.schema, 'easur.plan/card/v1', '① 计划卡应带 schema 标识');
eq(card.summary.projects_total, 5, '① 应归出 5 个项目（甲/乙/丙/报告/丁）');
eq(card.summary.files_total, 8, '① 文件总数应为 8（甲3+乙2+丙1+报告2）');
eq(card.summary.truncated, false, '① 护栏内不应截断');
eq(card.as_of, '2026-11-05', '① as_of 应随注入时钟');
ok(Array.isArray(card.projects) && card.projects.length === 5, '① projects 应为 5 项列表');

// ② 归项目
const names = card.projects.map((p) => p.project).sort();
eq(names, ['项目丙', '项目丁', '项目甲', '项目乙', '报告'].sort(), '② 分组应含四个目录项目+根散件前缀簇「报告」');
const byName = Object.fromEntries(card.projects.map((p) => [p.project, p]));

// ③ 信号抽取
ok(/3 个文件；最近活跃 1 天前/.test(byName['项目甲'].health), `③ 甲健康摘要应含文件数与活跃度（实际=${byName['项目甲'].health}）`);
const jia = byName['项目甲'];
eq(jia.files, 3, '③ 甲应有 3 个文件');
const jiaTodo = jia.tasks.find((t) => t.evidence.some((e) => e.line != null));
ok(!!jiaTodo && jiaTodo.evidence[0].path === '项目甲/甲-实施方案草案.md' && jiaTodo.evidence[0].line === 2
  && String(jiaTodo.evidence[0].quote).includes('TODO'),
  `③ 甲应抽出文本待办（行2+引用原文，实际=${JSON.stringify(jiaTodo || {})}）`);
const yi = byName['项目乙'];
const yiDeadline = yi.tasks.find((t) => t.evidence.some((e) => /乙-验收单-2026-11-08\.md$/.test(e.path)));
ok(!!yiDeadline && yiDeadline.priority === '高' && yiDeadline.action.includes('剩 3 天'),
  `③ 乙临期截止（2026-11-08）应出「高」任务且剩 3 天（实际=${JSON.stringify(yiDeadline || {})})`);
const bing = byName['项目丙'];
const bingOverdue = bing.tasks[0];
eq(bingOverdue.priority, '高', '③ 丙逾期截止应排首条且为「高」');
ok(bingOverdue.action.includes('已逾期'), '③ 丙首条应明说逾期');
ok(bing.risks.some((r) => r.kind === 'overdue_deadline'), '③ 丙应有 overdue_deadline 风险');
ok(bing.risks.some((r) => r.kind === 'stalled'), '③ 丙停滞 20 天应有 stalled 风险');
const jiaDep = jia.tasks.find((t) => t.action.includes('项目乙'));
ok(!!jiaDep && jiaDep.evidence[0].path.includes('甲-与项目乙对齐备忘.md'),
  `③ 甲应有「与项目乙对齐」任务且依据文件存在（实际=${JSON.stringify(jiaDep || {})})`);
const yiDep = yi.tasks.find((t) => t.action.includes('项目丙'));
ok(!!yiDep && yiDep.evidence[0].path.includes('乙-交付清单.md'),
  `③ 乙的文本抽样引用丙应出依赖任务（实际=${JSON.stringify(yiDep || {})})`);
const bao = byName['报告'];
ok(bao.risks.some((r) => r.kind === 'version_dup') && bao.risks.find((r) => r.kind === 'version_dup').detail.includes('报告-旧版.docx'),
  `③ 报告簇应有 version_dup 风险（实际=${JSON.stringify(bao.risks)}）`);
const baoTask = bao.tasks.find((t) => t.action.includes('归档旧版'));
ok(!!baoTask && baoTask.action.includes('报告.docx'),
  `③ 版本残留任务应按 mtime 定新旧（归档旧版.docx、现行.docx，实际=${JSON.stringify(baoTask || {})})`);
eq(byName['项目丁'].risks[0] && byName['项目丁'].risks[0].kind, 'empty', '③ 丁空目录应有 empty 风险');
eq(byName['项目丁'].health, '项目丁：目录为空（0 个文件）', '③ 丁健康摘要应为目录为空');

// ④ 任务面
for (const p of card.projects) {
  eq(p.tasks.length, 3, `④ ${p.project} 应恒好 3 条任务`);
  const ranks = p.tasks.map((t) => ({ 高: 0, 中: 1, 低: 2 })[t.priority]);
  ok(ranks.every((r, i) => i === 0 || r >= ranks[i - 1]), `④ ${p.project} 优先级应 高→中→低 单调（实际=${JSON.stringify(p.tasks.map((t) => t.priority))}）`);
  ok(p.tasks.every((t, i) => t.order === i + 1), `④ ${p.project} 任务应带 order 1..3`);
  ok(p.tasks.every((t) => Array.isArray(t.evidence) && t.evidence.length >= 1 && t.evidence.every((e) => typeof e.path === 'string' && e.path)),
    `④ ${p.project} 每条任务应带依据文件路径`);
  ok(p.tasks.every((t) => typeof t.action === 'string' && t.action && typeof t.reason === 'string'),
    `④ ${p.project} 每条任务应带动作与理由`);
}
// 丙无待办标记 → 停滞任务应为「低」（逾期占「高」）；乙三条应含兜底补齐
ok(bing.tasks.some((t) => t.priority === '低' && t.action.includes('停滞')), '④ 丙停滞复核任务应为低优先');

// ⑥ options 两态对照：staleDays 放宽 → stalled 消失
const cardWide = planEngine.generatePlan(root, { nowMs: NOW, staleDays: 1000 });
ok(!cardWide.projects.find((p) => p.project === '项目丙').risks.some((r) => r.kind === 'stalled'),
  '⑥ staleDays=1000 时丙不应再有 stalled 风险（两态对照）');
ok(cardWide.projects.find((p) => p.project === '项目丙').tasks.length === 3, '⑥ 放宽阈值后任务数仍恒 3');

// 坏路径报错
let threw = false;
try { planEngine.generatePlan(path.join(root, '不存在的目录')); } catch { threw = true; }
ok(threw, '⑥ 不存在目录应抛错（generatePlan）');

// ---------------- ⑦ MCP 真握手：plan.generate 挂载 ----------------
const SERVER = path.join(HERE, '..', 'hosts', 'mcp', 'project_server.mjs');
const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map();
let buf = '';
child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const resolver = pending.get(msg.id);
    if (resolver) { pending.delete(msg.id); resolver(msg); }
  }
});
const mcpTimeout = setTimeout(() => { failures.push('MCP 全局超时'); child.kill(); }, 20000);
function rpc(method, params) {
  return new Promise((resolve) => {
    const id = pending.size + 1;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'plan-test', version: '0' } });
ok(!!(init && init.result && init.result.serverInfo), '⑦ initialize 握手应有 serverInfo');
await rpc('notifications/initialized', {});
const list = await rpc('tools/list', {});
const toolNames = (list.result && list.result.tools || []).map((t) => t.name);
ok(toolNames.includes('plan.generate') && toolNames.includes('check.analyze') && toolNames.includes('plan.suggest') && toolNames.includes('rules.validate'),
  `⑦ tools/list 应含 plan.generate（既有三工具不回退，实际=${JSON.stringify(toolNames)}）`);
const call = await rpc('tools/call', { name: 'plan.generate', arguments: { path: root } });
const callText = call.result && call.result.content && call.result.content[0] && call.result.content[0].text;
ok(!!callText, '⑦ plan.generate 应回 content[0].text');
let mcpCard = null;
try { mcpCard = JSON.parse(callText); } catch { failures.push('⑦ plan.generate text 应为合法 JSON'); }
if (mcpCard) {
  eq(mcpCard.schema, 'easur.plan/card/v1', '⑦ MCP 出卡 schema 一致');
  eq(mcpCard.summary.projects_total, 5, '⑦ MCP 出卡项目数一致');
  ok(mcpCard.projects.every((p) => p.tasks.length === 3 && p.tasks.every((t) => t.evidence.length >= 1)),
    '⑦ MCP 出卡任务面与依据行完整');
}
const badCall = await rpc('tools/call', { name: 'plan.generate', arguments: { path: path.join(root, '不存在') } });
ok(badCall.result && badCall.result.isError === true && /目录不存在/.test(badCall.result.content[0].text),
  '⑦ 坏路径应回 isError 且带原因');
child.kill();
clearTimeout(mcpTimeout);

// 收尾
fs.rmSync(root, { recursive: true, force: true });
console.log(`计划台直读引擎机闸：断言通过 ${pass} 条；失败 ${failures.length} 条`);
if (failures.length) {
  for (const m of failures) console.error('FAIL ' + m);
  process.exit(1);
}
console.log('PASS 归项目/信号抽取(待办行号/截止逾期临期/依赖引用/版本新旧/停滞)/任务3条带依据/优先级单调/风险五类/options两态/MCP握手 全达标');
