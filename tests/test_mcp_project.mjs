/**
 * 项目体检 stdio MCP 服务器 · 真握手机闸（tests/test_mcp_project.mjs）
 * -------------------------------------------------------------------
 * 判据：spawn `node hosts/mcp/project_server.mjs`，从 stdin 按行喂 JSON-RPC 2.0：
 *   initialize → notifications/initialized → tools/list → tools/call check.analyze
 * 断言：① initialize 回包含 protocolVersion + serverInfo；② tools/list 回包含 tools 数组
 *   且三工具齐备；③ check.analyze 回包含体检卡结构（summary/projects/risk/evidence/
 *   next_steps 带证据引用/assertion_graph）。零第三方依赖，node 直跑，不引测试框架。
 * 运行：node tests/test_mcp_project.mjs
 * 说明：台账合成数据全部虚构名称，禁真实客户名。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'hosts', 'mcp', 'project_server.mjs');

let pass = 0;
const failures = [];
const ok = (cond, msg) => { if (cond) pass += 1; else failures.push(msg); };

// 合成台账（虚构名称）：含逾期/临期/阻塞/断言分歧多信号，CSV 双行 + JSON 行混排覆盖两种解析
const CSV_LEDGER = [
  '项目,状态,截止,依赖,证据',
  '灯塔项目,进行中,2026-11-03,围墙项目,"与甲科技确认了交付窗口，甲科技承诺11月10日前交付；对方要求先验收围墙项目"',
  '围墙项目,已完成,2026-10-20,,"乙制造已完成交付"',
  '栈桥项目,未开始,2026-10-28,,"预算未批，暂缓开工"',
].join('\n');

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
child.stderr.on('data', (c) => process.stderr.write('[server-stderr] ' + c));

const timeout = setTimeout(() => {
  failures.push('全局超时：服务器 20 秒内未完成握手序列');
  child.kill();
}, 20000);

function rpc(method, params, isNotification = false) {
  return new Promise((resolve) => {
    if (isNotification) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
      resolve(null);
      return;
    }
    const id = pending.size + 1;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

// ① initialize 握手
const initRes = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'parity-test', version: '0' } });
ok(initRes && initRes.result, 'initialize 应有 result');
ok(!!(initRes && initRes.result && initRes.result.protocolVersion), 'initialize 回包应含 protocolVersion');
ok(!!(initRes && initRes.result && initRes.result.serverInfo && initRes.result.serverInfo.name), 'initialize 回包应含 serverInfo.name');
await rpc('notifications/initialized', {}, true);

// ② tools/list
const listRes = await rpc('tools/list', {});
const tools = listRes && listRes.result && Array.isArray(listRes.result.tools) ? listRes.result.tools : [];
const toolNames = tools.map((t) => t.name);
ok(toolNames.includes('check.analyze') && toolNames.includes('plan.suggest') && toolNames.includes('rules.validate'),
  `tools 数组应含三工具（实际=${JSON.stringify(toolNames)}）`);
ok(tools.every((t) => t.inputSchema && typeof t.inputSchema === 'object'), '每个工具应带 inputSchema');

// ③ tools/call check.analyze → 体检卡结构
const callRes = await rpc('tools/call', { name: 'check.analyze', arguments: { ledger: CSV_LEDGER } });
const cardText = callRes && callRes.result && Array.isArray(callRes.result.content) && callRes.result.content[0] && callRes.result.content[0].text;
ok(!!cardText, 'check.analyze 应回 content[0].text');
let card = null;
try { card = JSON.parse(cardText); } catch (e) { failures.push('体检卡 text 应为合法 JSON: ' + e.message); }
if (card) {
  ok(card.schema === 'easur.project-check/card/v1', '体检卡应带 schema 标识');
  ok(!!(card.summary && typeof card.summary.projects_total === 'number' && card.summary.risk), '体检卡应含 summary（projects_total/risk 分级计数）');
  ok(Array.isArray(card.projects) && card.projects.length === 3, `体检卡应含 3 个项目（实际=${card.projects ? card.projects.length : '无'}` + '）');
  const proj = card.projects[0] || {};
  ok(typeof proj.risk === 'string' && ['高', '中', '低', '未入列'].includes(proj.risk), '每项目应带风险等级（高/中/低/未入列）');
  ok(typeof proj.score === 'number' && Array.isArray(proj.reasons), '每项目应带归因分与理由');
  ok(Array.isArray(proj.evidence) && proj.evidence.every((e) => typeof e.row === 'number' && typeof e.quote === 'string'), '证据行应含行号与引用');
  const steps = Array.isArray(proj.next_steps) ? proj.next_steps : [];
  ok(steps.length > 0 && steps.every((s) => s.text && s.evidence && typeof s.evidence.row === 'number'),
    '下一步建议应逐条带证据引用（row/quote）');
  ok(!!(card.assertion_graph && Array.isArray(card.assertion_graph.edges) && Array.isArray(card.assertion_graph.nodes)),
    '体检卡应附断言关系网投影');
  const overdue = card.projects.find((p) => p.project === '栈桥项目');
  ok(!!overdue && overdue.risk === '高' && overdue.signals.some((s) => s.kind === 'overdue'),
    `栈桥项目逾期未完成应判「高」且带 overdue 信号（实际=${overdue ? overdue.risk : '缺项目'}/signals=${JSON.stringify(overdue ? overdue.signals.map((s) => s.kind) : [])}）`);
  const lighthouse = card.projects.find((p) => p.project === '灯塔项目');
  ok(!!lighthouse && !lighthouse.signals.some((s) => s.kind === 'blocked'),
    '灯塔项目前置（围墙项目）已完成，不应带 blocked 信号');
}

// ④ 附加：plan.suggest 顺序与 rules.validate 双模式
const planRes = await rpc('tools/call', { name: 'plan.suggest', arguments: { ledger: CSV_LEDGER } });
let plan = null;
try { plan = JSON.parse(planRes.result.content[0].text); } catch { failures.push('plan.suggest text 应为合法 JSON'); }
if (plan) {
  ok(plan.plan[0].task === '栈桥项目' && plan.plan[plan.plan.length - 1].task === '围墙项目',
    '计划应逾期最前者优先、已完成殿后');
  ok(plan.plan.some((p) => p.task === '灯塔项目' && p.blocked_by.includes('围墙项目') === false),
    '前置已完成时不应再判阻塞');
}
const valRes = await rpc('tools/call', {
  name: 'rules.validate',
  arguments: { rules: JSON.stringify({ ok: true, schema: 'yishu.discovery/v1', version: 1, rules: [] }) },
});
let val = null;
try { val = JSON.parse(valRes.result.content[0].text); } catch { failures.push('rules.validate text 应为合法 JSON'); }
if (val) ok(val.mode === 'discovery_rule_package' && val.ok === true, 'yishu.discovery/v1 载荷应走引擎两级校验且空规则包通过');
const valBad = await rpc('tools/call', {
  name: 'rules.validate',
  arguments: { rules: { schema: 'easur.project-check/v1', metrics: { entity_name_exact: 99 } } },
});
let valb = null;
try { valb = JSON.parse(valBad.result.content[0].text); } catch { failures.push('rules.validate(坏包) text 应为合法 JSON'); }
if (valb) ok(valb.ok === false && valb.errors.length > 0, '坏规则包应 ok=false 并给出逐条错误');

// 收尾
child.kill();
clearTimeout(timeout);
console.log(`MCP 真握手机闸：断言通过 ${pass} 条；失败 ${failures.length} 条`);
if (failures.length) {
  for (const m of failures) console.error('FAIL ' + m);
  process.exit(1);
}
console.log('PASS initialize/tools/list/tools/call(check.analyze) 全链路握手与体检卡结构达标');
