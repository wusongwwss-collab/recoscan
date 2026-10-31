/**
 * feedback — QuickCue 反馈 SDK（JS 侧，与 core/py/feedback.py 接口面同形；
 * Easur Open 反馈组件）。
 * -------------------------------------------------------------------
 * 定位（组件设计长期约定）：
 *   遥测默认关、首启问一次、随时可关、说明白上行什么。
 *   反馈三档：L1=只回传结果卡点选（对/不对/已处理）；L2=加规则 delta；
 *   L3=加脱敏失败样例。
 *
 * 职责边界：
 *   - 只做「档位状态机 + 本地落盘 + 上行预检与脱敏」，**不内置任何 UI、
 *     不内置任何网络调用**；上行动作归宿主/云端侧。
 *   - 本地落盘路径：`.quickcue/feedback.jsonl`（相对当前工作目录；目录可用
 *     环境变量 QUICKCUE_FEEDBACK_DIR 覆盖，与 PY 侧同名）。
 *   - sanitize 本地 PII 槽位化（手机号/金额/人名/公司名/邮箱），原文永不出本地；
 *     prepare_upload 对最终载荷做原文残留检测（未槽位化手机号/邮箱命中即拒绝）。
 *
 * 接口面（与 PY 侧同形；camelCase 为主，snake_case 别名同义导出）：
 *   shouldAskConsent(state) / should_ask_consent   首启问一次纯函数（无 UI）
 *   sanitize(text, slots?)                         本地 PII 槽位化
 *   detectResidue(payload) / detect_residue        原文残留检测
 *   createFeedbackSdk({level, feedbackDir, packageVersion, now}).record(level, payload)
 *   ...同实例.prepareUpload(level, payload) / .prepare_upload(...)
 *
 * 零第三方依赖：仅 Node.js 内置模块（node:fs / node:path）。Node 18+。
 */

import fs from 'node:fs';
import path from 'node:path';

export const SDK_SCHEMA = 'quickcue.feedback/v1';
export const SDK_VERSION = '0.1.0';

// 档位：L0=关（默认）；L1/L2/L3 逐档叠加（高档位内容包含低档位内容）
export const LEVEL_ORDER = { L0: 0, L1: 1, L2: 2, L3: 3 };

export const FEEDBACK_ENV_DIR = 'QUICKCUE_FEEDBACK_DIR';

// L2 规则 delta 只允许这些字段（结构层面保证「不含话术原文」）
const RULE_DELTA_KEYS = ['rule_id', 'field', 'before', 'after'];

// L1 结果卡点选值白名单（对 / 不对 / 已处理）
const RESULT_VALUES = ['对', '不对', '已处理'];

// ------------------------------------------------------------------
// 首启问一次（纯函数，无 UI、无副作用）
// ------------------------------------------------------------------
export function shouldAskConsent(state) {
  if (!state || typeof state !== 'object') return true;
  return !state.consent_asked;
}
export const should_ask_consent = shouldAskConsent;

// ------------------------------------------------------------------
// 本地 PII 槽位化（中文语境正则；同槽去重：<PHONE_1>/<PHONE_2> …）
// ------------------------------------------------------------------
const EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
// 手机号：11 位连写，或 3-4-4 带空格/连字符分隔
const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)|(?<!\d)1[3-9]\d{2}[ \-]\d{4}[ \-]\d{4}(?!\d)/g;
// 金额：¥/￥ 前缀，或数字 + 元/块/万/亿 后缀（中文语境）
const AMOUNT_RE = /(?:[￥¥]\s*\d[\d,，]*(?:\.\d+)?(?:万|千万|百万|亿)?)|(?:\d[\d,，]*(?:\.\d+)?\s*(?:万|千万|百万|亿)?\s*(?:元|块钱?))|(?:\d[\d,，]*(?:\.\d+)?\s*(?:万|亿)(?![\u4e00-\u9fa5A-Za-z0-9]))/g;
// 公司/机构：实体名 + 常见机构后缀
const ORG_RE = /[\u4e00-\u9fa5A-Za-z0-9]{2,16}?(?:股份有限公司|有限公司|集团公司|集团|科技公司|银行|大学|医院|研究院)/g;
const ORG_SUFFIXES = ['股份有限公司', '集团公司', '有限公司', '科技公司', '研究院', '集团', '银行', '大学', '医院'];
// 实体名部分出现这些功能词/动词 -> 收窄到其后（「让李娜联系甲科技有限公司」-> 甲科技有限公司）
const ORG_NAME_STOP = new Set('让请和与跟向对给找叫去来在由把被从至到是说讲问已曾还没不未正将想联系告知提供接待负责表示认为建议要求协助沟通对接汇报'.split(''));
// 人名：常见姓氏 + 1~2 个汉字（启发式）
const SURNAMES = '王李张刘陈杨黄赵吴周徐孙马朱胡郭何林罗高郑梁谢宋唐许韩冯邓曹彭' +
  '曾肖田董潘袁蔡蒋余于杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖' +
  '贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱' +
  '严覃武戴莫孔向汤';
const NAME_RE = new RegExp('[' + SURNAMES + '][\\u4e00-\\u9fa5]{1,2}', 'g');
// 姓氏后紧跟这些字视为非人名（「马上」「当年」等常用词误报抑制）
const NAME_FOLLOW_STOP = new Set('上下来去的是在和与说会能要不很路天年月日点次个中时为款货钱费单'.split(''));
// 人名尾部这些虚词/动词回退掉（「张伟说」-> 槽位化「张伟」留「说」）
const NAME_TRAILING_TRIM = new Set('说的了是在和与等吗呢吧啊对不对也很但就都又还把被向往联系'.split(''));

const PII_SLOT = { email: 'EMAIL', phone: 'PHONE', amount: 'AMOUNT', org: 'ORG', name: 'PERSON' };

// 残留检测：只押高精度模式（手机号 / 邮箱）——槽位化对这两类是确定性的，
// 因此最终载荷里再出现即视为「原文残留」，直接拒绝上行。
const RESIDUE_PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/;
const RESIDUE_EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/;

export class SanitizeState {
  constructor() { this._slots = new Map(); }
  slotFor(piiType, original) {
    const key = piiType + '\u0000' + original;
    if (!this._slots.has(key)) {
      let n = 0;
      for (const k of this._slots.keys()) if (k.startsWith(piiType + '\u0000')) n += 1;
      this._slots.set(key, '<' + PII_SLOT[piiType] + '_' + (n + 1) + '>');
    }
    return this._slots.get(key);
  }
}

export function sanitize(text, slots) {
  if (typeof text !== 'string' || !text) return text;
  const state = slots instanceof SanitizeState ? slots : new SanitizeState();
  const sub = (re, piiType) => text.replace(re, (m) => state.slotFor(piiType, m));
  // 应用顺序：email（防其中数字被手机号吃掉）-> phone -> amount -> org -> name
  text = sub(EMAIL_RE, 'email');
  text = sub(PHONE_RE, 'phone');
  text = sub(AMOUNT_RE, 'amount');
  text = text.replace(ORG_RE, (m) => {
    const suffix = ORG_SUFFIXES.find((s) => m.endsWith(s));
    if (!suffix) return m;
    let namePart = m.slice(0, m.length - suffix.length);
    let cut = -1;
    for (let i = 0; i < namePart.length; i += 1) if (ORG_NAME_STOP.has(namePart[i])) cut = i;
    let prefix = '';
    if (cut >= 0) {
      prefix = namePart.slice(0, cut + 1); // 功能词前缀原样保留（不吞正文）
      namePart = namePart.slice(cut + 1);
    }
    if (namePart.length < 1) return m;
    return prefix + state.slotFor('org', namePart + suffix);
  });
  text = text.replace(NAME_RE, (m) => {
    let token = m;
    if (token.length >= 2 && NAME_FOLLOW_STOP.has(token[1])) return m; // 姓氏后虚词 -> 非人名
    let tail = '';
    while (token.length > 2 && NAME_TRAILING_TRIM.has(token[token.length - 1])) {
      tail = token.slice(-1) + tail; // 尾部虚词/动词回退但保留原字（不吞正文）
      token = token.slice(0, -1);
    }
    if (token.length < 2) return m;
    return state.slotFor('name', token) + tail;
  });
  return text;
}

export function detectResidue(payload) {
  const hits = [];
  const walk = (node) => {
    if (typeof node === 'string') {
      if (!hits.includes('phone') && RESIDUE_PHONE_RE.test(node)) hits.push('phone');
      if (!hits.includes('email') && RESIDUE_EMAIL_RE.test(node)) hits.push('email');
    } else if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === 'object') {
      Object.values(node).forEach(walk);
    }
  };
  walk(payload);
  return hits;
}
export const detect_residue = detectResidue;

// ------------------------------------------------------------------
// 反馈 SDK 主体
// ------------------------------------------------------------------
function nowIso(now) {
  const d = now == null ? new Date() : new Date(now * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

export function defaultFeedbackDir() {
  return process.env[FEEDBACK_ENV_DIR] || path.join(process.cwd(), '.quickcue');
}

export class FeedbackSdk {
  /**
   * @param {{level?: string, feedbackDir?: string|null, packageVersion?: string, now?: number|null}} opts
   */
  constructor(opts = {}) {
    this._level = opts.level || 'L0';
    this._dir = opts.feedbackDir != null ? opts.feedbackDir : null;
    this._packageVersion = opts.packageVersion || SDK_VERSION;
    this._now = opts.now != null ? opts.now : null;
  }

  get level() { return this._level; }

  setLevel(level) {
    if (!(level in LEVEL_ORDER)) throw new Error('未知反馈档位：' + level);
    this._level = level;
  }

  _feedbackPath() {
    return path.join(this._dir || defaultFeedbackDir(), 'feedback.jsonl');
  }

  /** record：本地落盘 .quickcue/feedback.jsonl（JSONL 追加一行）。 */
  record(level, payload) {
    if (!(level in LEVEL_ORDER) || level === 'L0') {
      throw new Error('record 档位须为 L1/L2/L3，收到 ' + level);
    }
    if (this._level === 'L0') return { dropped: true, reason: 'feedback_off(L0)' };
    if (LEVEL_ORDER[level] > LEVEL_ORDER[this._level]) {
      return { dropped: true, reason: 'level_below_consent(' + this._level + '<' + level + ')' };
    }
    const p = this._feedbackPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const line = JSON.stringify({
      schema: SDK_SCHEMA,
      ts: nowIso(this._now),
      level,
      payload,
      sdk_version: SDK_VERSION,
    });
    fs.appendFileSync(p, line + '\n', 'utf8');
    return { dropped: false, path: p };
  }

  /** prepare_upload：上行预检与脱敏（只产载荷，不联网）。 */
  prepareUpload(level, payload) {
    if (!(level in LEVEL_ORDER) || level === 'L0') {
      throw new Error('prepare_upload 档位须为 L1/L2/L3，收到 ' + level);
    }
    if (this._level === 'L0') return { ok: false, rejected: true, reason: 'feedback_off(L0)' };
    if (LEVEL_ORDER[level] > LEVEL_ORDER[this._level]) {
      return { ok: false, rejected: true, reason: 'level_below_consent(' + this._level + '<' + level + ')' };
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { ok: false, rejected: true, reason: 'payload 须为对象' };
    }

    const upload = {
      schema: SDK_SCHEMA,
      level,
      package_version: this._packageVersion,
      ts: nowIso(this._now),
      event: extractEvent(payload),
    };
    if (LEVEL_ORDER[level] >= LEVEL_ORDER.L2) {
      const delta = extractRuleDelta(payload);
      if (delta && delta.__rejected__) return { ok: false, rejected: true, reason: delta.__rejected__ };
      if (delta) upload.rule_delta = delta;
    }
    if (LEVEL_ORDER[level] >= LEVEL_ORDER.L3) {
      const samples = payload.samples;
      if (!Array.isArray(samples) || samples.length === 0) {
        return { ok: false, rejected: true, reason: 'L3 须带非空 samples 列表' };
      }
      const slots = new SanitizeState();
      upload.samples = samples
        .filter((s) => s && typeof s === 'object' && !Array.isArray(s))
        .map((s) => ({ reason: s.reason || '', sample: sanitize(s.sample || '', slots) }));
    }

    const residues = detectResidue(upload);
    if (residues.length) {
      return { ok: false, rejected: true, reason: 'residue_detected(' + residues.join('+') + ')' };
    }
    return { ok: true, upload };
  }
}

// L1 最小面：事件类型/结果卡点选值/卡类型（值一律标量字符串化）
function extractEvent(payload) {
  const event = {};
  if ('event_type' in payload) event.type = String(payload.event_type);
  const result = payload.result;
  if (typeof result === 'string' && RESULT_VALUES.includes(result)) event.result = result;
  else if (result != null) event.result = String(result);
  if ('card_type' in payload) event.card_type = String(payload.card_type);
  return event;
}

// L2 规则 delta：字段白名单（rule_id/field/before/after），值限标量——
// 结构层面保证不含话术原文；越权字段直接拒绝
function extractRuleDelta(payload) {
  const delta = payload.rule_delta;
  if (delta == null) return null;
  if (typeof delta !== 'object' || Array.isArray(delta)) return { __rejected__: 'rule_delta 须为对象' };
  for (const k of Object.keys(delta)) {
    if (!RULE_DELTA_KEYS.includes(k)) return { __rejected__: 'rule_delta 含越权字段:' + k };
  }
  const out = {};
  for (const k of RULE_DELTA_KEYS) {
    if (!(k in delta)) continue;
    const v = delta[k];
    if (v !== null && !['string', 'number', 'boolean'].includes(typeof v)) {
      return { __rejected__: 'rule_delta.' + k + ' 须为标量' };
    }
    out[k] = v;
  }
  return out;
}

// JS 侧同形入口：snake_case 别名（与 PY 侧接口面逐字对齐）
export const create_feedback_sdk = createFeedbackSdk;
export function createFeedbackSdk(opts) { return new FeedbackSdk(opts || {}); }
FeedbackSdk.prototype.prepare_upload = FeedbackSdk.prototype.prepareUpload;
FeedbackSdk.prototype.set_level = FeedbackSdk.prototype.setLevel;

export default { shouldAskConsent, sanitize, detectResidue, FeedbackSdk, createFeedbackSdk };
