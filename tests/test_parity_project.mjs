/**
 * YQ…（中性）项目域 parity 硬出口机闸 —— 公开仓 core/js 实现 vs 主仓 pc_client 实现
 * ---------------------------------------------------------------------------
 * 判据：同一输入分别喂「公开仓 core/js/{reco-engine,project-ontology}.js」与
 *   「主仓 pc_client/{reco-engine,project-ontology}.js」，输出 JSON.stringify 逐字相等
 *   （含 key 顺序）。≥8 组合成 fixture，覆盖：
 *   · scoreProjects：实体名全中(3)／仅别名(2)／术语(1)／会议实体别名对应项目实体名(1)／
 *     org 入历史标题(2)／全不中不入列／多项目排序
 *   · assertionGraph：断言聚合（count/sources 去重）、discarded 剔除与「待定」节点
 *   · entityFileGraph：基本投影（counts/efile 聚合）、护栏截断 truncated
 *   · reco-engine：normalizeRulePackage 两级校验、compareSemver、createRecoEngine 注入时钟求值
 * 运行：node tests/test_parity_project.mjs（零依赖，不引测试框架）
 * 说明：全部合成数据为虚构名称，禁真实客户名。
 *       parity 属开发期机闸，非公开仓功能测试：主仓底本缺失时本文件整体跳过
 *       （exit 0，不算失败）；同机开发可用 NW_MAIN_PC_CLIENT 环境变量注入主仓路径。
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN_PC = process.env.NW_MAIN_PC_CLIENT || 'C:/yice/negotiation-workbench/pc_client';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPEN_JS = path.join(HERE, '..', 'core', 'js');

// 主仓底本缺失 → 整体 skip（与 Python 侧 test_parity_meeting.py 的 skipif 同形）
if (!fs.existsSync(path.join(MAIN_PC, 'reco-engine.js'))) {
  console.log(`SKIP 主仓底本不存在（parity 机闸需同机执行）：${MAIN_PC}`);
  process.exit(0);
}

const mainRequire = createRequire(path.join(MAIN_PC, 'reco-engine.js'));
const openRequire = createRequire(path.join(OPEN_JS, 'reco-engine.js'));

const MAIN = {
  reco: mainRequire(path.join(MAIN_PC, 'reco-engine.js')),
  ontology: mainRequire(path.join(MAIN_PC, 'project-ontology.js')),
};
const OPEN = {
  reco: openRequire(path.join(OPEN_JS, 'reco-engine.js')),
  ontology: openRequire(path.join(OPEN_JS, 'project-ontology.js')),
};

let pass = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) pass += 1;
  else failures.push(msg);
}

// ---------------- 合成数据（全部虚构名称） ----------------

const P1 = { project_id: 'p1', name: '项目甲', entityNames: ['甲科技'], entityAliasMap: [], terms: [], titleText: '' };
const P_ALIASED = { project_id: 'p2', name: '项目乙', entityNames: ['乙智造'], entityAliasMap: [{ alias: '乙制造', name: '乙智造' }], terms: [], titleText: '' };
const P_TERM = { project_id: 'p3', name: '项目丙', entityNames: ['丙能源'], entityAliasMap: [], terms: ['交付窗口'], titleText: '' };
const P_ALIAS_REV = { project_id: 'p4', name: '项目丁', entityNames: ['甲方'], entityAliasMap: [], terms: [], titleText: '' };
const P_TITLE = { project_id: 'p5', name: '项目戊', entityNames: ['丁电力'], entityAliasMap: [], terms: [], titleText: '丙能源二期项目周例会纪要' };
const P_NONE = { project_id: 'p6', name: '项目己', entityNames: ['戊咨询'], entityAliasMap: [], terms: ['无关术语'], titleText: '完全无关的历史标题' };

const ENT_JIA = { name: '甲科技', type: 'org', aliases: [] };
const ENT_JIA_ALIAS = { name: '甲科技', type: 'org', aliases: ['乙方', '对方'] };
const ENT_YI = { name: '乙制造', type: 'org', aliases: [] };
const ENT_BING = { name: '丙能源', type: 'org', aliases: [] };

// ---------------- fixture 定义 ----------------
// fx(name, run(mods) => out, expect(openOut))
const fixtures = [];
const fx = (name, run, expect) => fixtures.push({ name, run, expect });

// -- scoreProjects --
fx('scoreProjects·实体名全中 score=3', (m) => m.ontology.scoreProjects([ENT_JIA], [], [P1]),
  (o) => { ok(o.length === 1 && o[0].score === 3 && o[0].project_id === 'p1', '实体名全中应 score=3 且 p1 入列'); });
fx('scoreProjects·仅别名 score=2', (m) => m.ontology.scoreProjects([ENT_YI], [], [P_ALIASED]),
  (o) => { ok(o.length === 1 && o[0].score === 2 && o[0].reasons.join(',').includes('别名'), '仅别名应 score=2 且理由带别名标注'); });
fx('scoreProjects·术语重合 score=1', (m) => m.ontology.scoreProjects([], ['交付窗口'], [P_TERM]),
  (o) => { ok(o.length === 1 && o[0].score === 1, '术语重合应 score=1'); });
fx('scoreProjects·会议实体别名对应项目实体名 score=1', (m) => m.ontology.scoreProjects([ENT_JIA_ALIAS], [], [{ ...P1, entityNames: ['乙方'] }]),
  (o) => { ok(o.length === 1 && o[0].score === 1 && o[0].reasons[0] === '乙方', '别名对应项目实体名应 score=1 且理由=乙方'); });
fx('scoreProjects·org 入历史标题 score=2', (m) => m.ontology.scoreProjects([ENT_BING], [], [P_TITLE]),
  (o) => { ok(o.length === 1 && o[0].score === 2 && o[0].reasons[0].includes('历史会议'), 'org 入历史标题应 score=2'); });
fx('scoreProjects·全不中不入列', (m) => m.ontology.scoreProjects([ENT_JIA], ['交付窗口'], [P_NONE]),
  (o) => { ok(o.length === 0, '全不中项目不得入列'); });
fx('scoreProjects·多项目按分值降序排序', (m) => m.ontology.scoreProjects([ENT_JIA], ['交付窗口'], [P_TERM, { ...P1, titleText: '甲科技启动会' }]),
  (o) => { ok(o.length === 2 && o[0].project_id === 'p1' && o[0].score === 5 && o[1].score === 1, '应 p1(5) 在前、p3(1) 在后'); });

// -- assertionGraph --
const FLAT_ROWS = [
  { id: 1, subject_name: '甲科技', predicate: '承诺', object_value: '交付窗口', kind: 'action', status: 'active',
    ref_type: 'file', ref_id: 11, anchor: '周报A', quote: '甲科技承诺交付窗口' },
  { id: 1, subject_name: '甲科技', predicate: '承诺', object_value: '交付窗口', kind: 'action', status: 'active',
    ref_type: 'file', ref_id: 12, anchor: '周报B', quote: '甲科技承诺交付窗口' },
  { id: 1, subject_name: '甲科技', predicate: '承诺', object_value: '交付窗口', kind: 'action', status: 'active',
    ref_type: 'file', ref_id: 13, anchor: '周报A', quote: '甲科技承诺交付窗口' },
];
fx('assertionGraph·断言聚合+sources 去重', (m) => m.ontology.assertionGraph(FLAT_ROWS),
  (o) => {
    ok(o.edges.length === 1 && o.edges[0].id === 'a1', '同 id 三行扁平行应聚合为一条边 a1');
    ok(o.edges[0].sources.length === 2, 'sources 应按 anchor+quote 去重为 2 条');
    ok(o.nodes.length === 2 && o.nodes.every((n) => n.count === 1), '主体/对象各一节点且 count=1');
  });
fx('assertionGraph·discarded 剔除与「待定」节点', (m) => m.ontology.assertionGraph([
  { id: 1, subject_name: '甲科技', predicate: '承诺', object_value: '交付窗口', status: 'active' },
  { id: 2, subject_name: '乙制造', predicate: '要求', object_value: '验收标准', status: 'user_discarded' },
  { id: 3, subject_name: '', predicate: '确认', object_value: '', status: 'active' },
]),
  (o) => {
    ok(o.edges.length === 2, 'discarded 行应剔除，仅剩 2 条边');
    ok(o.nodes.some((n) => n.label === '待定'), '空主语/宾语应归「待定」固定节点');
  });

// -- entityFileGraph --
const SNAPSHOT = {
  entities: [
    { id: 1, name: '甲科技', etype: 'org', status: 'active', aliases: [], merged_to: 0 },
    { id: 2, name: '乙制造', etype: 'org', status: 'active', aliases: ['乙智造'], merged_to: 0 },
  ],
  assertions: [
    { id: 1, subject_entity_id: 1, subject_name: '甲科技', predicate: '承诺', object_value: '乙制造二期交付', status: 'active',
      ref_type: 'file', ref_id: 101, anchor: '周报A', quote: 'q1' },
    { id: 2, subject_entity_id: 2, subject_name: '乙制造', predicate: '要求', object_value: '甲科技确认范围', status: 'active',
      ref_type: 'file', ref_id: 101, anchor: '周报B', quote: 'q2' },
    { id: 2, subject_entity_id: 2, subject_name: '乙制造', predicate: '要求', object_value: '甲科技确认范围', status: 'active',
      ref_type: 'file', ref_id: 102, anchor: '周报C', quote: 'q3' },
  ],
};
const FILES = [
  { fid: 101, idx: 3, project: 9, name: '合同扫描件.pdf', type: 'pdf' },
  { fid: 102, idx: 4, project: 9, name: '会议纪要.docx', type: 'docx' },
];
fx('entityFileGraph·基本投影（counts/efile 聚合）', (m) => m.ontology.entityFileGraph(SNAPSHOT, { files: FILES }),
  (o) => {
    ok(o.truncated.entities === false && o.truncated.assertEdges === false && o.truncated.fileEdges === false, '未超限不得报 truncated');
    ok(o.nodes.filter((n) => n.kind === 'entity').length === 2 && o.nodes.filter((n) => n.kind === 'file').length === 2, '实体 2 + 文件 2 节点');
    const efile = o.edges.filter((e) => e.kind === 'efile');
    ok(efile.length === 4, '实体-文件边应按 (实体,文件) 聚合为 4 条');
    const hit = efile.find((e) => e.s === 'E1' && e.t === 'F9_3');
    ok(!!hit && hit.count === 2, 'E1↔F9_3 应聚合 count=2');
    ok(o.edges.filter((e) => e.kind !== 'efile').length === 2, '断言边应 2 条');
  });
fx('entityFileGraph·护栏截断 truncated', (m) => ({
  ent: m.ontology.entityFileGraph(SNAPSHOT, { files: FILES, maxEntities: 1, maxFileEdges: 1 }),
  edges: m.ontology.entityFileGraph(SNAPSHOT, { files: FILES, maxAssertEdges: 1 }),
}),
  (o) => {
    ok(o.ent.truncated.entities === true && o.ent.truncated.fileEdges === true, '实体/实体-文件边超限应 truncated 真');
    ok(o.ent.truncated.assertEdges === false, '活边因端点截断归零 ≠ 断言边自身截断（口径如实）');
    ok(o.ent.nodes.filter((n) => n.kind === 'entity').length === 1, '实体节点应截到 1');
    ok(o.ent.edges.filter((e) => e.kind === 'efile').length === 1, '实体-文件边应截到 1');
    ok(o.edges.truncated.assertEdges === true && o.edges.edges.filter((e) => e.kind !== 'efile').length === 1, '断言边超限应截到 1 且 truncated 真');
  });

// -- reco-engine --
const RULE = {
  rule_id: 'demo.reco.weekly',
  priority: 10,
  when: { op: 'all', conds: [{ key: 'work.meeting.count_30d', op: 'gte', value: 1 }] },
  then: {
    action: 'recommend',
    target: { target_kind: 'item', target_id: 7 },
    placement: 's1',
    weight: 80,
    copy: { title: '试试 {item_name}', reason: '近 30 天会议较密' },
  },
};
const GOOD_PKG = { ok: true, schema: 'yishu.discovery/v1', version: 1, content_hash: 'h1', ttl_seconds: 60,
  controls: {}, published_at: '2026-10-31T00:00:00Z', rules: [RULE] };
fx('reco-engine·normalizeRulePackage 两级校验（好包/坏包）', (m) => ({
  good: m.reco.normalizeRulePackage(GOOD_PKG, { slots: ['s1'] }),
  bad: m.reco.normalizeRulePackage({ ...GOOD_PKG, extra_top_key: 1 }, { slots: ['s1'] }),
  badRule: m.reco.normalizeRulePackage({ ...GOOD_PKG, rules: [{ ...RULE, rule_id: 'BAD ID!' }] }, { slots: ['s1'] }),
}),
  (o) => {
    ok(o.good.ok === true && o.good.rules.length === 1 && o.good.skipped.length === 0, '好包应通过且 1 条规则');
    ok(o.bad.ok === false && o.bad.reason === 'unknown_top_key:extra_top_key', '契约外顶层键应整包丢弃');
    ok(o.badRule.ok === true && o.badRule.skipped.length === 1, '坏条应跳过并计数（不半套执行）');
  });
fx('reco-engine·compareSemver 与注入时钟 evaluate', (m) => {
  const engine = m.reco.createRecoEngine({
    now: () => 1789971200,   // 2026-09-21 14:13 本地（避开默认免打扰 22:00-08:00，呈现不被推迟）
    provider: { 'work.meeting.count_30d': 5 },
    config: { slots: ['s1'], dailyCap: 3 },
  });
  const loadRes = engine.load(GOOD_PKG);
  return { cmp: m.reco.compareSemver('1.2.3', '1.2.10'), cmp2: m.reco.compareSemver('2.0.0-rc.2', '2.0.0'), load: loadRes, ev: engine.evaluate('s1') };
},
  (o) => {
    ok(o.cmp === -1 && o.cmp2 === -1, 'semver：1.2.3<1.2.10 且 rc.2<正式版');
    ok(o.load.ok === true, '好包装载应 ok');
    ok(o.ev.presented === 1 && o.ev.cards.length === 1 && o.ev.cards[0].score === 0.8, '注入时钟求值应出 1 卡且 score=0.8（80 权重×1 因子）');
    ok(o.ev.cards[0].rule_refs[0] === 'demo.reco.weekly', '卡片应携带规则引用');
  });

// ---------------- 执行 parity ----------------

for (const f of fixtures) {
  let outMain;
  let outOpen;
  try { outMain = f.run(MAIN); } catch (e) { failures.push(`[${f.name}] 主仓侧抛错: ${e && e.message}`); continue; }
  try { outOpen = f.run(OPEN); } catch (e) { failures.push(`[${f.name}] 公开仓侧抛错: ${e && e.message}`); continue; }
  const sMain = JSON.stringify(outMain);
  const sOpen = JSON.stringify(outOpen);
  ok(sMain === sOpen, `[${f.name}] parity 逐字不等：\n  主仓  = ${sMain}\n  公开仓 = ${sOpen}`);
  if (sMain === sOpen && f.expect) f.expect(outOpen);
}

const total = fixtures.length;
console.log(`parity fixtures: ${total} 组合；断言通过 ${pass} 条；失败 ${failures.length} 条`);
if (failures.length) {
  for (const m of failures) console.error('FAIL ' + m);
  process.exit(1);
}
console.log('PASS 公开仓 core/js 与主仓 pc_client 实现输出逐字一致（JSON.stringify 含 key 顺序）');
