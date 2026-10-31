/**
 * 反馈 SDK 机闸（tests/test_feedback.mjs）· 零框架，node 直跑
 * -------------------------------------------------------------------
 * 判据面（与 tests/test_feedback.py 同题同形：反馈三档 + 隐私约定）：
 *   1) 默认 L0（关）：record 直接丢弃 dropped:true，不产生落盘文件
 *   2) 首启问一次：shouldAskConsent 状态机（consent_asked 置位后永不再问）
 *   3) L1 上行载荷最小面：只含事件类型/结果卡点选值/卡类型/时间戳/包版本
 *   4) L2 规则 delta：白名单字段（rule_id/field/before/after），越权字段拒绝
 *   5) L3 sanitize 槽位化：手机/金额/人名/公司/邮箱各 >=2 例，同序号去重
 *   6) 原文残留检测：载荷含未槽位化手机号/邮箱 -> rejected:true + reason
 *
 * 纪律：落盘目录一律 fs.mkdtempSync(os.tmpdir()) 临时目录（测试数据隔离），
 * 另验证 QUICKCUE_FEEDBACK_DIR 环境变量覆盖面；跑完即清理。
 * 运行：node tests/test_feedback.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FeedbackSdk,
  createFeedbackSdk,
  create_feedback_sdk,
  detectResidue,
  detect_residue,
  sanitize,
  shouldAskConsent,
  should_ask_consent,
} from '../core/js/feedback.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
const failures = [];
const ok = (cond, msg) => { if (cond) pass += 1; else failures.push(msg); };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg + `（实际=${JSON.stringify(a)} 期望=${JSON.stringify(b)}）`);

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'quickcue-fb-'));
}
function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ① 默认 L0 = 关：丢弃且不落盘
{
  const dir = tmpDir();
  const sdk = new FeedbackSdk({ feedbackDir: dir });
  ok(sdk.level === 'L0', '默认档位应为 L0');
  const r = sdk.record('L1', { event_type: 'card_feedback', result: '对' });
  ok(r.dropped === true && typeof r.reason === 'string', `默认 L0 record 应丢弃并带 reason（实际=${JSON.stringify(r)}）`);
  ok(!fs.existsSync(path.join(dir, 'feedback.jsonl')), '默认 L0 不应产生落盘文件');
  const u = sdk.prepareUpload('L1', { event_type: 'card_feedback', result: '对' });
  ok(u.ok === false && u.rejected === true && u.reason.includes('L0'), `默认 L0 prepare_upload 应拒绝（实际=${JSON.stringify(u)}）`);
  cleanup(dir);
}

// 随时可关 + 档位不足丢弃
{
  const dir = tmpDir();
  const sdk = new FeedbackSdk({ feedbackDir: dir });
  sdk.setLevel('L2');
  eq(sdk.record('L2', { rule_delta: { rule_id: 'r', field: 'f', before: 1, after: 2 } }).dropped, false, 'L2 开启后 record 应落盘');
  sdk.setLevel('L0'); // 随时可关
  eq(sdk.record('L2', { rule_delta: { rule_id: 'r', field: 'f', before: 1, after: 2 } }).dropped, true, '关回 L0 后 record 应丢弃');
  const l1 = new FeedbackSdk({ level: 'L1', feedbackDir: dir });
  ok(l1.record('L3', { samples: [{ sample: 'x' }] }).dropped === true, '请求档位高于已开档位应丢弃');
  cleanup(dir);
}

// ② 首启问一次状态机（纯函数，无 UI）
ok(shouldAskConsent(null) === true, '无 state 应返回该问(true)');
ok(shouldAskConsent({}) === true, '无 consent_asked 标志应返回该问(true)');
ok(shouldAskConsent({ consent_asked: false }) === true, 'consent_asked=false 应返回该问(true)');
ok(shouldAskConsent({ consent_asked: true }) === false, 'consent_asked=true 应返回不再问(false)');
ok(shouldAskConsent('junk') === true, '非对象 state 应回退为该问(true)');
{
  const state = {};
  ok(should_ask_consent(state) === true, 'snake_case 别名同义：未问应 true');
  state.consent_asked = true; // 宿主问完置位（置位动作归宿主）
  ok(shouldAskConsent(state) === false && shouldAskConsent(state) === false, '置位后永不再问');
}

// ③ L1 上行载荷最小面
{
  const dir = tmpDir();
  const sdk = new FeedbackSdk({ level: 'L1', feedbackDir: dir, packageVersion: '0.1.0', now: 1730000000 });
  const r = sdk.prepareUpload('L1', {
    event_type: 'card_feedback', result: '不对', card_type: '客户问题速答',
    utterance: '这句不该出现在载荷里',
  });
  ok(r.ok === true, `L1 prepare_upload 应通过（实际=${JSON.stringify(r)}）`);
  if (r.ok) {
    const up = r.upload;
    eq(Object.keys(up).sort(), ['event', 'level', 'package_version', 'schema', 'ts'], 'L1 载荷应只含五键');
    eq(Object.keys(up.event).sort(), ['card_type', 'result', 'type'], 'L1 event 应只含类型/点选/卡类型');
    eq(up.event.result, '不对', 'L1 点选值应透传');
    eq(up.level, 'L1', 'L1 载荷应带档位');
    eq(up.package_version, '0.1.0', 'L1 载荷应带包版本');
    ok(!JSON.stringify(up).includes('这句不该出现'), '话术原文不入 L1 载荷');
  }
  for (const v of ['对', '不对', '已处理']) {
    const w = sdk.prepareUpload('L1', { event_type: 'card_feedback', result: v });
    ok(w.ok && w.upload.event.result === v, `点选值白名单「${v}」应透传`);
  }
  cleanup(dir);
}

// ④ L2 规则 delta：白名单字段、不含话术原文
{
  const dir = tmpDir();
  const sdk = new FeedbackSdk({ level: 'L2', feedbackDir: dir });
  const r = sdk.prepareUpload('L2', {
    event_type: 'card_feedback', result: '已处理', card_type: '客户问题速答',
    rule_delta: { rule_id: 'meeting.gate.max_per_meeting', field: 'max_per_meeting', before: 12, after: 8 },
    script: '按坐席年费计，含全部功能模块',
  });
  ok(r.ok === true, 'L2 合法 delta 应通过');
  if (r.ok) {
    eq(r.upload.rule_delta, { rule_id: 'meeting.gate.max_per_meeting', field: 'max_per_meeting', before: 12, after: 8 }, 'L2 delta 应逐字保留白名单字段');
    const dumped = JSON.stringify(r.upload);
    ok(!dumped.includes('按坐席年费计'), '话术原文不入 L2 载荷');
    ok(!dumped.includes('script'), 'script 键不入 L2 载荷');
  }
  const bad = sdk.prepareUpload('L2', { rule_delta: { rule_id: 'r', field: 'f', before: 1, after: 2, script: '话术原文' } });
  ok(bad.ok === false && bad.rejected === true && bad.reason.includes('越权字段'), `L2 越权字段应拒绝（实际=${JSON.stringify(bad)}）`);
  const bad2 = sdk.prepareUpload('L2', { rule_delta: { rule_id: 'r', field: 'f', before: { 嵌: '对象' }, after: 2 } });
  ok(bad2.ok === false && bad2.rejected === true, 'L2 非标量值应拒绝');
  cleanup(dir);
}

// record 落盘 JSONL 一行 + 环境变量覆盖
{
  const dir = tmpDir();
  const sdk = new FeedbackSdk({ level: 'L1', feedbackDir: dir, now: 1730000000 });
  const r = sdk.record('L1', { event_type: 'card_feedback', result: '对', card_type: '卡' });
  eq(r.dropped, false, 'record 应落盘');
  const rows = fs.readFileSync(r.path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  eq(rows.length, 1, '应恰好一行 JSONL');
  eq(rows[0].schema, 'quickcue.feedback/v1', '落盘行应带 schema');
  eq(rows[0].level, 'L1', '落盘行应带档位');
  eq(rows[0].payload.result, '对', '落盘行应带点选值');
  cleanup(dir);
}
{
  const dir = tmpDir();
  process.env.QUICKCUE_FEEDBACK_DIR = dir;
  const sdk = createFeedbackSdk({ level: 'L1' }); // 不注入 feedbackDir，走环境变量
  const r = sdk.record('L1', { event_type: 'card_feedback', result: '对' });
  eq(r.dropped, false, '环境变量覆盖下 record 应落盘');
  ok(r.path.startsWith(dir), `落盘路径应在环境变量目录下（实际=${r.path}）`);
  ok(fs.existsSync(r.path), '环境变量覆盖面应真实产生文件');
  delete process.env.QUICKCUE_FEEDBACK_DIR;
  cleanup(dir);
}

// ⑤ L3 sanitize：六类 PII 槽位化（每类 >=2 例）+ 同序号去重
eq(sanitize('回头打我电话 13812345678，或者备用号 15987654321 都行'),
  '回头打我电话 <PHONE_1>，或者备用号 <PHONE_2> 都行', '手机号双例应 PHONE_1/PHONE_2');
eq(sanitize('联系 13812345678；再联系 13812345678').split('<PHONE_1>').length - 1, 2, '同号复用 <PHONE_1>');
ok(!sanitize('联系 13812345678；再联系 13812345678').includes('<PHONE_2>'), '同号不应产生 PHONE_2');

{
  const out = sanitize('预算大概 3,500,000 元，另外加购 80万 的服务包');
  ok(out.includes('<AMOUNT_1>') && out.includes('<AMOUNT_2>'), `金额双例应 AMOUNT_1/AMOUNT_2（实际=${out}）`);
  ok(!out.includes('3,500,000') && !out.includes('80万'), '金额原文不得残留');
}
{
  const out = sanitize('让张伟对接，抄送给李娜。');
  eq(out, '让<PERSON_1>对接，抄送给<PERSON_2>。', '人名双例应 PERSON_1/PERSON_2 且保留正文');
}
{
  const out = sanitize('甲科技有限公司已付款，乙制造集团还没走流程');
  ok(out.includes('<ORG_1>') && out.includes('<ORG_2>'), `公司名双例应 ORG_1/ORG_2（实际=${out}）`);
  ok(!out.includes('甲科技') && !out.includes('乙制造'), '公司名原文不得残留');
}
{
  const out = sanitize('发到 zhangwei@example.com 和 li.na@corp.org.cn');
  ok(out.includes('<EMAIL_1>') && out.includes('<EMAIL_2>'), `邮箱双例应 EMAIL_1/EMAIL_2（实际=${out}）`);
  ok(!out.includes('zhangwei@example.com'), '邮箱原文不得残留');
}
// 共享序号表（跨文本同号复用）——以 prepare_upload 多样例共享槽位序号行为验证
{
  const dir = tmpDir();
  const sdk = new FeedbackSdk({ level: 'L3', feedbackDir: dir });
  const r = sdk.prepareUpload('L3', {
    samples: [
      { reason: '命中判错', sample: '王建国 13812345678 说预算 50万，发 zhang@ex.com' },
      { reason: '未出卡', sample: '让李娜联系甲科技有限公司，13899997777' },
    ],
  });
  ok(r.ok === true, `L3 双样例应通过（实际=${JSON.stringify(r)}）`);
  if (r.ok) {
    const dumped = JSON.stringify(r.upload);
    ok(!dumped.includes('王建国') && !dumped.includes('13812345678') && !dumped.includes('13899997777'), 'L3 载荷不得残留人名/手机号原文');
    ok(!dumped.includes('50万') && !dumped.includes('zhang@ex.com') && !dumped.includes('甲科技有限公司'), 'L3 载荷不得残留金额/邮箱/公司名原文');
    ok(dumped.includes('<PERSON_1>') && dumped.includes('<PERSON_2>'), 'L3 载荷应含人名槽位');
    ok(dumped.includes('<PHONE_1>') && dumped.includes('<PHONE_2>'), 'L3 载荷应含手机槽位（共享序号跨样例递增）');
    ok(dumped.includes('<AMOUNT_1>') && dumped.includes('<EMAIL_1>') && dumped.includes('<ORG_1>'), 'L3 载荷应含金额/邮箱/公司槽位');
  }
  const noSamples = sdk.prepareUpload('L3', {});
  ok(noSamples.ok === false && noSamples.rejected === true && noSamples.reason.includes('samples'), 'L3 缺 samples 应拒绝');
  cleanup(dir);
}

// ⑥ 原文残留检测：未槽位化手机号/邮箱 -> 拒绝
{
  const dir = tmpDir();
  const sdk = new FeedbackSdk({ level: 'L3', feedbackDir: dir });
  const r = sdk.prepareUpload('L3', {
    rule_delta: { rule_id: 'r', field: 'note', before: '', after: '拨 13812345678 确认' },
    samples: [{ sample: '样例文本无 PII' }],
  });
  ok(r.ok === false && r.rejected === true, 'L2/L3 载荷携带未槽位化手机号应拒绝');
  eq(r.reason, 'residue_detected(phone)', '拒绝 reason 应指明 phone 残留');
  const e = new FeedbackSdk({ level: 'L1', feedbackDir: dir })
    .prepareUpload('L1', { event_type: 'card_feedback', result: '对', card_type: '联系 admin@corp.example 的人' });
  ok(e.ok === false && e.rejected === true, 'L1 载荷携带未槽位化邮箱应拒绝');
  eq(e.reason, 'residue_detected(email)', '拒绝 reason 应指明 email 残留');
  cleanup(dir);
}
eq(detectResidue({ a: ['干净', { b: '没有问题' }] }), [], '干净载荷应零命中');
eq(detectResidue({ x: '手机 13812345678' }), ['phone'], '手机号残留应命中 phone');
eq(detectResidue({ x: '邮箱 a@b.com' }), ['email'], '邮箱残留应命中 email');
eq(detectResidue({ x: '13812345678 和 a@b.com' }), ['phone', 'email'], '双残留应按序双命中');
eq(detect_residue({ x: '<PHONE_1> 和 <EMAIL_1>' }), [], '已槽位化载荷不应误报');

// 收尾
console.log(`反馈 SDK 机闸（JS 侧）：断言通过 ${pass} 条；失败 ${failures.length} 条`);
if (failures.length) {
  for (const m of failures) console.error('FAIL ' + m);
  process.exit(1);
}
console.log('PASS 默认L0丢弃/首启问一次/L1最小面/L2白名单/L3六类PII槽位化/原文残留拒绝 全达标');
