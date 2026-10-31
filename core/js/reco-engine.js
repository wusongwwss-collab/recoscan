/**
 * Easur Open 开源版·零依赖
 * ------------------------
 * 来源说明：本文件自 Easur Work（弈枢AI工作台）PC 客户端「云端规则驱动的技能发现与
 * 推荐引擎」原样开源搬运（整文件逐字复制，module.exports 面保持不变；仅新增本头部
 * 注释块，并将文内内部需求编号改为中性表述）。零第三方依赖、零 IO、零 require，
 * 裸 node 可测；搬运正文不引入任何 node:* 内置模块，保持纯计算层。
 * 配套组件：core/js/project-ontology.js（本地知识库五要素抽取，同范式开源件）。
 */

'use strict';
/**
 * 云端规则驱动的技能发现与推荐引擎 —— 纯逻辑层
 * （零 electron、零第三方依赖、零 IO、零 require ⇒ 裸 node 可测，与 activity-core.js 同范式）。
 *
 * 设计依据（冲突裁决序：用户拍板修正 > Z 主席收口 > A 件 > B 件 > B2 件）：
 *   · A《规则模型与版本治理-云端侧设计》§3.4 规则行 Schema、§3.5 占位符（主席批注扩五变量）、
 *     §4.1 特征键 16 键闭集（键名以此为准）、§4.2 操作符闭集 14 个、§6.4 三条降级路径、
 *     文末「用户评审拍板后的修正」（目标＝item|connector 双键空间）。
 *   · W2-B（2026-10-20）：按 Z 裁决 §一#1 把 B 席四键（cat_top7/slot/idle_bucket/hour_local）
 *     并入 FEATURE_TABLE（act. 命名空间，见表尾标注）⇒ 注册表 16 → 20 键；取值器见 reco-feature-provider.js。
 *   · B《客户端发现与推荐执行链路-PC侧设计》§2.2 两级校验（绝不半套执行）、§5.1 打分公式、
 *     §5.2 排序去重、§六 频控与打扰预算、§七 可解释性；文末主席批注：特征键以 A §4.1 为唯一闭集。
 *   · Z《主席收口裁决》§一#5（DSL 以 A 为正本：禁正则、weight 0..100、占位符统一五变量）、
 *     §一#7（schema＝yishu.discovery/v1）、§五（五类目标、disco_ 前缀、跨域预算互扣 P0 必做）。
 *
 * 分层：本件只做「可复算的纯函数」＋ createRecoEngine(deps) 内存状态机；规则拉取/原子落盘/IPC/
 *   特征采集（FeatureProvider 实现）/市场目录装配全部延 W2 接线波（见文件尾「W2 接线清单」）。
 * 服务端侧本域表名与白名单键统一 `disco_` 前缀（Z §五.3，与推荐策略 rec_policy 同名不同表）；
 *   客户端模块名按派工单定名 reco-engine.js，两者不冲突。
 *
 * 模块速览：
 *   SUPPORTED_SCHEMAS / FEATURE_TABLE / OPERATORS      闭集常量（schema/16 特征键/14 操作符）
 *   normalizeConfig                                     prefs 与服务端下发值的本地钳制层
 *   normalizeRulePackage / validateRule / validateTemplate 包级与条级两级校验（条级跳过＋计数）
 *   resolveFeatures                                     FeatureProvider 取值归一（16 键缺失行为逐键定义）
 *   parseSemver / compareSemver                         semver 比较（rc.N < 正式版）
 *   matchNode / matchLeaf（内部）                        条件树求值 → match ∈ [0,1]
 *   freshnessFactor / penaltyFactor / cooldownDaysForRejectCount  打分因子与冷却曲线
 *   renderReason                                        占位符白名单纯字符串替换（五变量）
 *   isQuietMinutes / isQuietHours                       免打扰时段（默认 22:00-08:00）
 *   createRecoEngine(deps)                              工厂：装载/求值/反馈/频控状态机（时钟等全注入）
 */

const VERSION = '1.0.0';

// ============================== 闭集常量 ==============================

/** 集级 schema 白名单（Z §一#7 统一取 A；首版只认 v1） */
const SUPPORTED_SCHEMAS = Object.freeze(['yishu.discovery/v1']);

/**
 * 下发载荷顶层键闭集（A §8.1 响应段 + A2 EP1 的 published_at——Z 表外#3：响应字段以 A2 EP1 为准；
 * A2 契约定稿后如增键须同批扩本表，契约外顶层键 ⇒ 整包丢弃「不猜语义」）。
 */
const PACKAGE_TOP_KEYS = Object.freeze(['ok', 'schema', 'version', 'content_hash', 'ttl_seconds',
  'controls', 'published_at', 'rules']);

/** 规则行顶层键闭集（A §3.4 + fresh_from：B §5.1 freshness 因子输入，A2 契约待覆盖字段，可选） */
const RULE_KEYS = Object.freeze(['rule_id', 'priority', 'when', 'expires_at', 'then', 'fresh_from']);
const THEN_KEYS = Object.freeze(['action', 'target', 'placement', 'weight', 'copy', 'suppression', 'requires']);
/** A10-01 契约统一（2026-10-22 W3）：服务端规范形状 {target_kind,target_id} 优先（discovery_rules_service
 *  校验闭集逐字）；旧内测形状 {kind,item_id} 兼容保留；两形状同存时以规范形状为准，缺任一键按坏目标拒。 */
const TARGET_KEYS = Object.freeze(['target_kind', 'target_id', 'kind', 'item_id']);
const COPY_KEYS = Object.freeze(['title', 'reason']);
const SUPPRESSION_KEYS = Object.freeze(['max_per_day', 'cooldown_hours', 'dismiss_cooldown_days']);
const REQUIRES_KEYS = Object.freeze(['client_gte', 'dsh_gte', 'features']);

/** 目标双键空间（用户拍板修正#1：四类条目=item 取 superpower_items.id；连接器=connector 取 connectors 表 id，字段名沿用 item_id 承载） */
const TARGET_KINDS = Object.freeze(['item', 'connector']);

/** 操作符闭集（A §4.2，14 个；**无正则**——Z §一#5 正则禁令维持） */
const OPERATORS = Object.freeze(['eq', 'ne', 'in', 'nin', 'gte', 'lte', 'gt', 'lt', 'between',
  'exists', 'contains', 'intersects', 'version_gte']);
const GROUP_OPS = Object.freeze(['all', 'any', 'none']);

/** 文案模板占位符白名单（A §3.5 主席批注扩定：统一五变量；未定义变量渲染留空） */
const REASON_VARS = Object.freeze(['item_name', 'item_category', 'app_name', 'category', 'slot']);

/**
 * 特征键注册常量表（A §4.1 十六键闭集——服务端认可的唯一键名面；B 侧取值器在 W2 逐键实现）。
 * 字段：type 值类型｜set 是否集合键｜appSet 应用名集合（可 contains、可喂 {app_name}）｜
 *       enumSet 枚举集合（命中值可喂 {category}）｜missing 缺失行为（'empty_set'=空集｜'absent'=exists=false）｜
 *       ops 限用操作符（A §4.1 逐键）。
 */
const FEATURE_TABLE = Object.freeze({
  'client.version': { type: 'semver', set: false, missing: 'absent', ops: ['version_gte', 'gt', 'lte', 'eq', 'ne'] },
  'client.platform': { type: 'enum', set: false, missing: 'absent', ops: ['eq', 'ne', 'in'] },
  'dsh.runtime_version': { type: 'semver', set: false, missing: 'absent', ops: ['version_gte', 'gt', 'lte', 'eq', 'ne'] },
  'dsh.enabled': { type: 'bool', set: false, missing: 'absent', ops: ['eq', 'ne'] },
  'user.role': { type: 'enum', set: false, missing: 'absent', ops: ['eq', 'ne', 'in'] },
  'user.account_age_days': { type: 'int', set: false, missing: 'absent', ops: ['gte', 'lte', 'between'] },
  'user.installed_item_ids': { type: 'set_int', set: true, setItem: true, missing: 'empty_set', ops: ['in', 'nin', 'intersects'] },
  'user.installed_item_types': { type: 'set_str', set: true, enumSet: true, missing: 'empty_set', ops: ['in', 'nin', 'intersects', 'exists'] },
  'act.app.daily_names': { type: 'set_str', set: true, appSet: true, missing: 'empty_set', ops: ['intersects', 'contains'] },
  'act.app.top_names_7d': { type: 'set_str', set: true, appSet: true, missing: 'empty_set', ops: ['intersects', 'contains'] },
  'act.app.daily_active_minutes': { type: 'num', set: false, missing: 'absent', ops: ['gte', 'lte', 'between'] },
  'act.app.active_minutes_7d': { type: 'num', set: false, missing: 'absent', ops: ['gte', 'lte', 'between'] },
  'work.kb.project_count': { type: 'int', set: false, missing: 'absent', ops: ['gte', 'lte', 'between'] },
  'work.meeting.count_30d': { type: 'int', set: false, missing: 'absent', ops: ['gte', 'lte', 'between'] },
  'work.meeting.type_top': { type: 'enum', set: false, missing: 'absent', ops: ['eq', 'in'] },
  'work.launcher.top_apps': { type: 'set_str', set: true, appSet: true, missing: 'empty_set', ops: ['intersects', 'contains'] },
  // ---- W2-B（2026-10-20）：Z 裁决 §一#1 四键并入（B 席 feat.* 同义键按 A 命名空间收录）----
  // ⚠️ W2-A 键注册席位未收笔 ⇒ 本批按派工单给定四名先落并标注：act.cat_top7 / act.slot /
  //    act.idle_bucket / act.hour_local（B 件 §4.1 同义：feat.cat_top7/slot/idle_bucket/hour_local）。
  //    W2-A 收笔若定名不同，须同批改名（键名是端云闭集，禁两套并存）。
  'act.cat_top7': { type: 'set_str', set: true, enumSet: true, missing: 'empty_set', ops: ['in', 'nin', 'intersects', 'exists'] },
  'act.slot': { type: 'enum', set: false, missing: 'absent', ops: ['eq', 'ne', 'in'] },
  'act.idle_bucket': { type: 'enum', set: false, missing: 'absent', ops: ['eq', 'ne', 'in'] },  // 闭集 le30/le300/gt300
  'act.hour_local': { type: 'int', set: false, missing: 'absent', ops: ['gte', 'lte', 'between', 'eq', 'ne'] },
});
const FEATURE_KEYS = Object.freeze(Object.keys(FEATURE_TABLE));

// ---- 结构上限（A §5.2 长度与基数上限，端上同口径硬钳）----
const MAX_RULES_PER_SET = 200;
const MAX_CONDS_PER_GROUP = 8;
const MAX_CONDS_PER_RULE = 24;
const MAX_GROUP_DEPTH = 2;
const MAX_COND_VALUE_ITEMS = 32;
const COPY_TITLE_MAX = 60;
const COPY_REASON_MAX = 120;
const MAX_PLACEHOLDERS_PER_TEMPLATE = 3;   // A §3.5：占位符出现总数 ≤3
const RULE_ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const REASON_VAR_MAX = 64;                 // 模板变量值长度上限（appNameOf ≤64 字同款防线）

/**
 * 默认配置（**全部为设计初值·待实测**；可被 prefs / 规则包下发值覆盖，经 normalizeConfig 钳制）。
 * slots＝推荐位闭集，由 W2 按 C 席 s1~s8 清单注入（Z §一#2：C 位清单为产品正本，本件不硬编码）。
 */
const DEFAULT_CONFIG = Object.freeze({
  dailyCap: 3,                    // 全局日预算：呈现条数计（B §六.1，钳制 0-10）
  quietHours: '22:00-08:00',      // 免打扰时段 HH:MM-HH:MM，可跨午夜（B §六.4）
  freshnessTauDays: 14,           // freshness 衰减 τ（B §5.1）
  maxCardsPerPresent: 2,          // 每 slot 单次呈现上限（B §5.2-4）
  defaultSlotPerDay: 2,           // 未特别配置推荐位的每日上限（B §十一 频控初值量级）
  slots: [],
  slotLimits: {},                 // { [slot]: { maxPerDay } }——每推荐位独立频控
  ruleSuppression: Object.freeze({ maxPerDay: 2, cooldownHours: 24, dismissCooldownDays: 3 }),
});

/** 拒绝冷却曲线三档（B §六.3：第 1/2/3 次起 3/14/30 天；第 1 档可被规则 dismiss_cooldown_days 覆盖） */
const REJECT_COOLDOWN_DAYS = Object.freeze([3, 14, 30]);

// ============================== 小工具 ==============================

function _str(v) { return (v === undefined || v === null) ? '' : String(v); }
function _n(v, dflt) { const n = Number(v); return Number.isFinite(n) ? n : dflt; }
function _round6(n) { return Math.round(Number(n) * 1e6) / 1e6; }
function _isPlainObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function _pad2(n) { return (n < 10 ? '0' : '') + n; }

/** 秒级 epoch → 本地时区日期键 'YYYY-MM-DD'（日预算/频控的按日口径） */
function localDayKey(tsSec) {
  const d = new Date(tsSec * 1000);
  return d.getFullYear() + '-' + _pad2(d.getMonth() + 1) + '-' + _pad2(d.getDate());
}

// ============================== 配置钳制 ==============================

/**
 * prefs / 服务端下发 config → 本地安全钳制（normalizeConfig 范式：服务端只发建议值，
 * 最终生效以本地钳制结果为准）。非法/越界值回退或夹取，返回 { config, warnings }。
 */
function normalizeConfig(raw) {
  const warnings = [];
  if (!raw || typeof raw !== 'object') {
    return { config: Object.assign({}, DEFAULT_CONFIG, {
      slots: [], slotLimits: {},
      ruleSuppression: Object.assign({}, DEFAULT_CONFIG.ruleSuppression),
    }), warnings };
  }
  const dailyCap = Math.max(0, Math.min(10, Math.round(_n(raw.dailyCap, DEFAULT_CONFIG.dailyCap))));
  let quietHours = DEFAULT_CONFIG.quietHours;
  if (raw.quietHours !== undefined) {
    if (/^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(_str(raw.quietHours).trim())) quietHours = _str(raw.quietHours).trim();
    else warnings.push('quietHours 非法（须 HH:MM-HH:MM），回退默认 ' + DEFAULT_CONFIG.quietHours);
  }
  const slots = (Array.isArray(raw.slots) ? raw.slots : [])
    .map((s) => _str(s).trim()).filter(Boolean).filter((s, i, a) => a.indexOf(s) === i);
  const slotLimits = {};
  if (raw.slotLimits && typeof raw.slotLimits === 'object') {
    for (const k of Object.keys(raw.slotLimits)) {
      const lim = raw.slotLimits[k];
      if (!lim || typeof lim !== 'object') continue;
      slotLimits[k] = { maxPerDay: Math.max(0, Math.min(20, Math.round(_n(lim.maxPerDay, DEFAULT_CONFIG.defaultSlotPerDay)))) };
    }
  }
  const rs = Object.assign({}, DEFAULT_CONFIG.ruleSuppression, raw.ruleSuppression && typeof raw.ruleSuppression === 'object' ? {
    maxPerDay: Math.max(0, Math.min(20, Math.round(_n(raw.ruleSuppression.maxPerDay, DEFAULT_CONFIG.ruleSuppression.maxPerDay)))),
    cooldownHours: Math.max(0, Math.min(720, _n(raw.ruleSuppression.cooldownHours, DEFAULT_CONFIG.ruleSuppression.cooldownHours))),
    dismissCooldownDays: Math.max(0, Math.min(90, _n(raw.ruleSuppression.dismissCooldownDays, DEFAULT_CONFIG.ruleSuppression.dismissCooldownDays))),
  } : {});
  return {
    config: {
      dailyCap,
      quietHours,
      freshnessTauDays: Math.max(1, Math.min(90, _n(raw.freshnessTauDays, DEFAULT_CONFIG.freshnessTauDays))),
      maxCardsPerPresent: Math.max(1, Math.min(4, Math.round(_n(raw.maxCardsPerPresent, DEFAULT_CONFIG.maxCardsPerPresent)))),
      defaultSlotPerDay: Math.max(0, Math.min(20, Math.round(_n(raw.defaultSlotPerDay, DEFAULT_CONFIG.defaultSlotPerDay)))),
      slots,
      slotLimits,
      ruleSuppression: rs,
    },
    warnings,
  };
}

// ============================== 文案模板（白名单纯替换） ==============================

/**
 * 模板校验：全部 `{…}` 占位符必须在五变量白名单内且总数 ≤3（A §3.5 主席批注扩定；
 * 白名单外占位符/函数调用形态 ⇒ 条级跳过）。返回 { ok, reason }。
 */
function validateTemplate(tpl) {
  const s = _str(tpl);
  const found = [];
  let m;
  const re = /\{([^{}]*)\}/g;
  while ((m = re.exec(s)) !== null) found.push(m[1]);
  if (found.length > MAX_PLACEHOLDERS_PER_TEMPLATE) return { ok: false, reason: 'too_many_placeholders' };
  for (const f of found) {
    if (!REASON_VARS.includes(f)) return { ok: false, reason: 'bad_placeholder:' + f };
  }
  return { ok: true, reason: '' };
}

/**
 * 模板渲染＝**纯字符串替换**：无正则回填、无函数执行、无用户内容拼接。
 * · 只替换五变量白名单内的占位符；白名单外 `{…}` 原样保留（装载层已拒，此处防御性不替换＝注入被拒）；
 * · 未定义/空变量替换为空串（A §3.5 未定义变量留空口径）；
 * · 变量值截 64 字（appNameOf ≤64 同款防线）。
 */
function renderReason(template, vars) {
  const v = vars && typeof vars === 'object' ? vars : {};
  return _str(template).replace(/\{([^{}]*)\}/g, (whole, name) => {
    if (!REASON_VARS.includes(name)) return whole;
    const s = v[name] === undefined || v[name] === null ? '' : String(v[name]);
    return s.slice(0, REASON_VAR_MAX);
  });
}

// ============================== semver 比较（A §4.2 version_gte） ==============================

/** 'X.Y.Z(-pre)?' → {major,minor,patch,pre|null}；不合规返回 null */
function parseSemver(s) {
  const m = SEMVER_RE.exec(_str(s).trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] || null };
}

/**
 * semver 语义比较（rc.N < 正式版；比较器两端同实现）。任一端不可解析 ⇒ null（调用方按不命中处理）。
 * 预发布段按点分数值感知比较（rc.2 < rc.10）；同数值位有无预发布：有 pre < 无 pre。
 */
function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  const tri = [pa.major - pb.major, pa.minor - pb.minor, pa.patch - pb.patch];
  for (const t of tri) {
    if (t !== 0) return t < 0 ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  const sa = pa.pre.split('.');
  const sb = pb.pre.split('.');
  for (let i = 0; i < Math.max(sa.length, sb.length); i += 1) {
    const x = sa[i]; const y = sb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = Number(x); const ny = Number(y);
    const xm = x !== '' && Number.isFinite(nx);
    const ym = y !== '' && Number.isFinite(ny);
    if (xm && ym) { if (nx !== ny) return nx < ny ? -1 : 1; }
    else if (xm !== ym) return xm ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// ============================== 特征取值器（FeatureProvider 注入接口） ==============================

/**
 * FeatureProvider 归一：接受 ①函数 (key)=>value ②带 get(key) 的对象 ③键值平面对象 ④null（无特征源）。
 * 引擎不实现采集（采集在 W2 接线层）；取值抛异常按缺失处理（单条隔离不炸链路）。
 */
function _providerGet(provider) {
  if (typeof provider === 'function') return provider;
  if (provider && typeof provider === 'object' && typeof provider.get === 'function') return (k) => provider.get(k);
  if (provider && typeof provider === 'object') return (k) => provider[k];
  return null;
}

/**
 * 按 A §4.1 十六键表解析特征快照。
 * 缺失行为逐键定义：集合键缺失 ⇒ 空集（present=true, value=[]）；其余键缺失 ⇒ absent（present=false，
 * 除 exists=false 外一切操作符不命中）。返回 { values, present }。
 */
function resolveFeatures(provider, keys) {
  const get = _providerGet(provider);
  const values = {};
  const present = {};
  for (const key of (Array.isArray(keys) ? keys : [])) {
    const spec = FEATURE_TABLE[key];
    if (!spec) continue;
    let raw;
    try { raw = get ? get(key) : undefined; } catch (e) { raw = undefined; }
    if (spec.set) {
      const arr = Array.isArray(raw) ? raw.filter((x) => x !== undefined && x !== null) : [];
      values[key] = spec.setItem
        ? arr.map((x) => Number(x)).filter((x) => Number.isFinite(x))
        : arr.map((x) => String(x));
      present[key] = Array.isArray(raw);
    } else if (raw === undefined || raw === null) {
      values[key] = spec.type === 'bool' ? false : '';
      present[key] = false;
    } else if (spec.type === 'int' || spec.type === 'num') {
      const n = Number(raw);
      if (Number.isFinite(n)) { values[key] = spec.type === 'int' ? Math.round(n) : n; present[key] = true; }
      else { values[key] = 0; present[key] = false; }
    } else if (spec.type === 'bool') {
      values[key] = raw === true || raw === 1;
      present[key] = typeof raw === 'boolean' || raw === 0 || raw === 1;
    } else {
      const s = String(raw);
      values[key] = s;
      present[key] = s !== '';
    }
  }
  return { values, present };
}

// ============================== 条件树求值（match ∈ [0,1]，无正则） ==============================

function _scalarEq(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  if (typeof a === 'boolean' || typeof b === 'boolean') return a === b;
  return String(a) === String(b);
}

/** 集合成员命中（set_int 数值比较 / set_str 精确串比较——模糊面归 contains） */
function _setHas(set, v, spec) {
  if (spec.setItem) {
    const n = Number(v);
    return Number.isFinite(n) && set.includes(n);
  }
  return set.includes(String(v));
}

/** 单叶子条件求值；返回 { factor:1|0, appName?, category? }（命中值喂 {app_name}/{category} 渲染变量） */
function _matchLeaf(cond, feat) {
  const spec = FEATURE_TABLE[cond.key];
  if (!spec) return { factor: 0 };
  const isPresent = !!feat.present[cond.key];
  const val = feat.values[cond.key];
  let hit = 0;
  let appName;
  let category;
  const capApp = (v) => { if (appName === undefined) appName = String(v); };
  const capEnum = (v) => { if (category === undefined) category = String(v); };
  if (spec.set) {
    const set = isPresent ? val : [];                     // 集合键缺失 ⇒ 空集
    if (cond.op === 'in' || cond.op === 'intersects') {
      for (const v of cond.value) {
        if (_setHas(set, v, spec)) {
          hit = 1;
          if (spec.appSet) capApp(v); else if (spec.enumSet) capEnum(v);
          break;
        }
      }
    } else if (cond.op === 'nin') {
      hit = cond.value.every((v) => !_setHas(set, v, spec)) ? 1 : 0;
    } else if (cond.op === 'contains') {
      const needle = String(cond.value).toLowerCase();
      for (const m of set) {
        if (String(m).toLowerCase().includes(needle)) { hit = 1; if (spec.appSet) capApp(m); break; }
      }
    } else if (cond.op === 'exists') {
      // A §3.6 示例2 语义反推：集合键 exists＝「集合非空」（新用户无安装 ⇒ exists=false 命中）
      hit = (set.length > 0) === cond.value ? 1 : 0;
    }
  } else if (!isPresent) {
    // 缺失标量：仅 exists=false 命中，其余操作符一律不命中
    hit = cond.op === 'exists' && cond.value === false ? 1 : 0;
  } else if (cond.op === 'exists') {
    hit = cond.value === true ? 1 : 0;
  } else if (cond.op === 'eq') {
    hit = _scalarEq(val, cond.value) ? 1 : 0;
    if (hit && (spec.type === 'enum')) capEnum(cond.value);
  } else if (cond.op === 'ne') {
    hit = _scalarEq(val, cond.value) ? 0 : 1;
  } else if (cond.op === 'in') {
    for (const v of cond.value) {
      if (_scalarEq(val, v)) { hit = 1; if (spec.type === 'enum') capEnum(v); break; }
    }
  } else if (cond.op === 'nin') {
    hit = cond.value.every((v) => !_scalarEq(val, v)) ? 1 : 0;
  } else if (cond.op === 'gte' || cond.op === 'gt' || cond.op === 'lte' || cond.op === 'lt') {
    const a = Number(val); const b = Number(cond.value);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      hit = (cond.op === 'gte' && a >= b) || (cond.op === 'gt' && a > b)
        || (cond.op === 'lte' && a <= b) || (cond.op === 'lt' && a < b) ? 1 : 0;
    }
  } else if (cond.op === 'between') {
    const a = Number(val);
    hit = Number.isFinite(a) && a >= cond.value[0] && a <= cond.value[1] ? 1 : 0;
  } else if (cond.op === 'version_gte') {
    const c = compareSemver(String(val), String(cond.value));
    hit = c !== null && c >= 0 ? 1 : 0;
  }
  const out = { factor: hit };
  if (appName !== undefined) out.appName = appName;
  if (category !== undefined) out.category = category;
  return out;
}

/**
 * 条件组求值 → match ∈ [0,1]（B §5.1：all 全中才有效（其一不中⇒0，全中取子因子积）；
 * any＝命中数/条件数（嵌套组按其因子计贡献，封顶 1）；none＝全不中方为 1）。
 */
function matchNode(node, feat) {
  const conds = Array.isArray(node.conds) ? node.conds : [];
  const parts = conds.map((c) => (('conds' in c) ? matchNode(c, feat) : _matchLeaf(c, feat)));
  let factor;
  if (node.op === 'all') {
    factor = parts.every((p) => p.factor > 0) ? parts.reduce((a, p) => a * p.factor, 1) : 0;
  } else if (node.op === 'any') {
    factor = conds.length ? Math.min(1, parts.reduce((a, p) => a + p.factor, 0) / conds.length) : 0;
  } else {                                            // none
    factor = parts.every((p) => p.factor <= 0) ? 1 : 0;
  }
  const matched = {};
  for (const p of parts) {
    if (p.appName !== undefined && matched.appName === undefined) matched.appName = p.appName;
    if (p.category !== undefined && matched.category === undefined) matched.category = p.category;
  }
  return { factor, matched };
}

// ============================== 打分因子 ==============================

/** freshness ＝ exp(-Δdays/τ)；未声明 fresh_from ⇒ 1（不衰减）；未来时刻钳 0（不放大） */
function freshnessFactor(freshFromSec, nowSec, tauDays) {
  if (!Number.isFinite(freshFromSec)) return 1;
  const tau = tauDays > 0 ? tauDays : DEFAULT_CONFIG.freshnessTauDays;
  const days = Math.max(0, (nowSec - freshFromSec) / 86400);
  return Math.exp(-days / tau);
}

/** penalty ＝ 0.5^reject_count ×（类目被静音 ⇒ ×0.5）（B §5.1 + §六.3，设计初值·待实测） */
function penaltyFactor(rejectCount, classMuted) {
  const n = Math.max(0, Math.floor(Number(rejectCount) || 0));
  return Math.pow(0.5, n) * (classMuted ? 0.5 : 1);
}

/**
 * 拒绝冷却曲线（B §六.3 三档 3/14/30 天；第 1 档可被规则 suppression.dismiss_cooldown_days 覆盖——
 * A §3.6 示例1 声明 7 天，覆盖值仍受 0-90 钳制）。第 2/3 档固定 14/30。
 */
function cooldownDaysForRejectCount(rejectCount, firstTierDays) {
  const c = Math.max(0, Math.floor(Number(rejectCount) || 0));
  if (c <= 1) {
    const t = Number(firstTierDays);
    return Number.isFinite(t) && t > 0 ? Math.min(90, Math.floor(t)) : REJECT_COOLDOWN_DAYS[0];
  }
  if (c === 2) return REJECT_COOLDOWN_DAYS[1];
  return REJECT_COOLDOWN_DAYS[2];
}

// ============================== 免打扰时段 ==============================

function _parseHm(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim());
  if (!m) return null;
  const h = Number(m[1]); const mi = Number(m[2]);
  if (h > 24 || mi > 59) return null;
  return h * 60 + mi;
}

/**
 * 免打扰判定（区间闭开：起点含、终点不含；跨午夜自动环绕，如 22:00-08:00）。
 * 区间非法 ⇒ false（不因坏配置全天禁推）。minOfDay＝本地日内分钟数（0-1439）。
 */
function isQuietMinutes(minOfDay, rangeStr) {
  const m = /^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/.exec(_str(rangeStr).trim());
  if (!m) return false;
  const a = _parseHm(m[1]);
  const b = _parseHm(m[2]);
  if (a === null || b === null || a === b) return false;
  const t = Math.max(0, Math.min(24 * 60, Math.floor(_n(minOfDay, 0))));
  return a < b ? (t >= a && t < b) : (t >= a || t < b);
}

/** 便捷形态：hour(0-23)/minute(0-59) 直接判 */
function isQuietHours(hour, minute, rangeStr) {
  return isQuietMinutes(Math.max(0, Math.min(23, Math.floor(_n(hour, 0)))) * 60
    + Math.max(0, Math.min(59, Math.floor(_n(minute, 0)))), rangeStr);
}

// ============================== 条级校验 ==============================

function _bad(reason) { return { ok: false, reason }; }

/** 条件组结构校验（递归；深度≤2、单组≤8、单规则≤24、值数组≤32——A §5.2） */
function _checkGroup(node, depth, usedKeys, counter) {
  if (!_isPlainObj(node)) return 'cond_group_not_object';
  for (const k of Object.keys(node)) {
    if (k !== 'op' && k !== 'conds') return 'cond_group_unknown_key:' + k;
  }
  if (!GROUP_OPS.includes(node.op)) return 'bad_group_op';
  if (!Array.isArray(node.conds) || node.conds.length === 0) return 'empty_conds';
  if (node.conds.length > MAX_CONDS_PER_GROUP) return 'too_many_conds_in_group';
  for (const c of node.conds) {
    counter.n += 1;
    if (counter.n > MAX_CONDS_PER_RULE) return 'too_many_conds';
    if (_isPlainObj(c) && ('conds' in c)) {
      if (depth + 1 > MAX_GROUP_DEPTH) return 'group_too_deep';
      const r = _checkGroup(c, depth + 1, usedKeys, counter);
      if (r) return r;
      continue;
    }
    if (!_isPlainObj(c)) return 'cond_not_object';
    for (const k of Object.keys(c)) {
      if (k !== 'key' && k !== 'op' && k !== 'value') return 'cond_unknown_key:' + k;
    }
    const spec = FEATURE_TABLE[c.key];
    if (!spec) return 'unknown_feature_key:' + _str(c.key);
    if (!OPERATORS.includes(c.op)) return 'unknown_op:' + _str(c.op);
    if (!spec.ops.includes(c.op)) return 'op_not_allowed:' + _str(c.key) + '/' + _str(c.op);
    usedKeys.push(c.key);
    const v = c.value;
    if (c.op === 'exists') {
      if (typeof v !== 'boolean') return 'exists_value_not_bool';
    } else if (c.op === 'between') {
      if (!Array.isArray(v) || v.length !== 2 || !Number.isFinite(Number(v[0])) || !Number.isFinite(Number(v[1]))) {
        return 'between_value_not_pair';
      }
    } else if (c.op === 'in' || c.op === 'nin' || c.op === 'intersects') {
      if (!Array.isArray(v) || v.length === 0 || v.length > MAX_COND_VALUE_ITEMS) return 'bad_value_array';
    } else if (c.op === 'version_gte') {
      if (!parseSemver(v)) return 'bad_version_value';
    } else if (c.op === 'contains') {
      if (typeof v !== 'string' || !v) return 'bad_contains_value';
    } else if (v === undefined || v === null || (typeof v === 'number' && !Number.isFinite(v))) {
      return 'bad_scalar_value';
    }
  }
  return '';
}

/**
 * 单条规则校验（A §3.4 Schema 逐字段；契约外字段 ⇒ 该条跳过——服务端 strict、端上 fail-soft）。
 * @returns {{ok:true, rule:object, usedKeys:string[]}|{ok:false, reason:string}}
 *   rule 为引擎内规形态（字段归一后），usedKeys＝when 用到的特征键（requires 穷举性校验用）。
 */
function validateRule(raw, opts) {
  const o = opts || {};
  if (!_isPlainObj(raw)) return _bad('rule_not_object');
  for (const k of Object.keys(raw)) {
    if (!RULE_KEYS.includes(k)) return _bad('unknown_rule_key:' + k);
  }
  for (const k of ['rule_id', 'priority', 'when', 'then']) {
    if (!(k in raw)) return _bad('missing_field:' + k);
  }
  if (!RULE_ID_RE.test(_str(raw.rule_id))) return _bad('bad_rule_id');
  if (!Number.isInteger(raw.priority) || raw.priority < 0 || raw.priority > 10000) return _bad('bad_priority');
  const usedKeys = [];
  const gerr = _checkGroup(raw.when, 1, usedKeys, { n: 0 });
  if (gerr) return _bad(gerr);
  let expiresAtSec = null;
  if (raw.expires_at !== undefined) {
    const t = Date.parse(_str(raw.expires_at));
    if (!Number.isFinite(t)) return _bad('bad_expires_at');
    expiresAtSec = Math.floor(t / 1000);
  }
  let freshFromSec = NaN;
  if (raw.fresh_from !== undefined) {
    const n = Number(raw.fresh_from);
    if (!Number.isFinite(n) || n < 0) return _bad('bad_fresh_from');
    freshFromSec = n;
  }
  const then = raw.then;
  if (!_isPlainObj(then)) return _bad('then_not_object');
  for (const k of Object.keys(then)) {
    if (!THEN_KEYS.includes(k)) return _bad('unknown_then_key:' + k);
  }
  if (then.action !== 'recommend') return _bad('bad_action');          // v1 唯一取值（A §3.3）
  const target = then.target;
  if (!_isPlainObj(target)) return _bad('bad_target');
  for (const k of Object.keys(target)) {
    if (!TARGET_KEYS.includes(k)) return _bad('unknown_target_key:' + k);
  }
  const tgtKind = target.target_kind !== undefined ? target.target_kind : target.kind;
  const tgtId = target.target_id !== undefined ? target.target_id : target.item_id;
  if (tgtKind === undefined || tgtId === undefined) return _bad('bad_target');
  if (!TARGET_KINDS.includes(tgtKind)) return _bad('bad_target_kind');
  if (!Number.isInteger(tgtId) || tgtId < 1) return _bad('bad_target_item_id');
  const placement = _str(then.placement);
  if (!placement) return _bad('bad_placement');
  const slots = Array.isArray(o.slots) ? o.slots : [];
  if (slots.length && !slots.includes(placement)) return _bad('unknown_placement:' + placement);
  let weight = 50;                                                     // 缺省权重（设计初值·待实测；A §3.4 weight 可选）
  if (then.weight !== undefined) {
    if (!Number.isInteger(then.weight) || then.weight < 0 || then.weight > 100) return _bad('bad_weight');
    weight = then.weight;
  }
  let copy = { title: '', reason: '' };
  if (then.copy !== undefined) {
    const c = then.copy;
    if (!_isPlainObj(c)) return _bad('bad_copy');
    for (const k of Object.keys(c)) {
      if (!COPY_KEYS.includes(k)) return _bad('unknown_copy_key:' + k);
    }
    const title = c.title === undefined ? '' : _str(c.title);
    const reason = c.reason === undefined ? '' : _str(c.reason);
    if (title.length > COPY_TITLE_MAX) return _bad('title_too_long');
    if (reason.length > COPY_REASON_MAX) return _bad('reason_too_long');
    const t1 = validateTemplate(title);
    if (!t1.ok) return _bad('title_' + t1.reason);
    const t2 = validateTemplate(reason);
    if (!t2.ok) return _bad('reason_' + t2.reason);
    copy = { title, reason };
  }
  let sup = null;
  if (then.suppression !== undefined) {
    const s = then.suppression;
    if (!_isPlainObj(s)) return _bad('bad_suppression');
    for (const k of Object.keys(s)) {
      if (!SUPPRESSION_KEYS.includes(k)) return _bad('unknown_suppression_key:' + k);
    }
    if (s.max_per_day !== undefined && (!Number.isInteger(s.max_per_day) || s.max_per_day < 0 || s.max_per_day > 20)) return _bad('bad_max_per_day');
    if (s.cooldown_hours !== undefined && (!(typeof s.cooldown_hours === 'number' && Number.isFinite(s.cooldown_hours)) || s.cooldown_hours < 0 || s.cooldown_hours > 720)) return _bad('bad_cooldown_hours');
    if (s.dismiss_cooldown_days !== undefined && (!(typeof s.dismiss_cooldown_days === 'number' && Number.isFinite(s.dismiss_cooldown_days)) || s.dismiss_cooldown_days < 0 || s.dismiss_cooldown_days > 90)) return _bad('bad_dismiss_cooldown_days');
    sup = {
      maxPerDay: s.max_per_day === undefined ? null : s.max_per_day,
      cooldownHours: s.cooldown_hours === undefined ? null : s.cooldown_hours,
      dismissCooldownDays: s.dismiss_cooldown_days === undefined ? null : s.dismiss_cooldown_days,
    };
  }
  let requires = { clientGte: '', dshGte: '', features: [] };
  if (then.requires !== undefined) {
    const r = then.requires;
    if (!_isPlainObj(r)) return _bad('bad_requires');
    for (const k of Object.keys(r)) {
      if (!REQUIRES_KEYS.includes(k)) return _bad('unknown_requires_key:' + k);
    }
    if (r.client_gte !== undefined && !parseSemver(r.client_gte)) return _bad('bad_client_gte');
    if (r.dsh_gte !== undefined && !parseSemver(r.dsh_gte)) return _bad('bad_dsh_gte');
    let feats = [];
    if (r.features !== undefined) {
      if (!Array.isArray(r.features) || r.features.length > 8) return _bad('bad_requires_features');
      feats = r.features.map(String);
      for (const f of feats) {
        if (!FEATURE_TABLE[f]) return _bad('unknown_requires_feature:' + f);
      }
      // A §4.1 规则4：requires.features 必须穷举 when 用到的全部键
      const missing = usedKeys.filter((k) => !feats.includes(k));
      if (missing.length) return _bad('requires_not_exhaustive:' + missing[0]);
    }
    requires = { clientGte: r.client_gte === undefined ? '' : String(r.client_gte), dshGte: r.dsh_gte === undefined ? '' : String(r.dsh_gte), features: feats };
  }
  return {
    ok: true,
    usedKeys,
    rule: {
      ruleId: String(raw.rule_id),
      priority: raw.priority,
      when: raw.when,
      expiresAtSec,
      freshFromSec,
      then: {
        action: 'recommend',
        target: { kind: tgtKind, itemId: tgtId },
        placement,
        weight,
        copy,
        suppression: sup,
        requires,
      },
    },
  };
}

// ============================== 包级校验（绝不半套执行） ==============================

/**
 * 规则包两级校验之包级（B §2.2）：schema 不认 / 契约外顶层键 / kill 急停位 / 结构坏 ⇒ **整包丢弃
 * 返回空态**（ok=false，rules 恒 []——绝不半套执行、不回落旧版本规则）。
 * 单条校验失败 ⇒ 跳过该条并计数（skipped[].reason，供 rule_skipped 上报计数）。
 * @param {object} payload 下发载荷（{ok,schema,version,content_hash,ttl_seconds,controls,published_at,rules}）
 * @param {{slots?:string[]}} [opts] 推荐位闭集（W2 注入；空 ⇒ placement 校验放行、求值时按当前 slot 过滤）
 */
function normalizeRulePackage(payload, opts) {
  const o = opts || {};
  const base = { ok: false, killed: false, reason: '', schema: '', version: 0, rules: [], neededKeys: [], disabledRules: [], skipped: [] };
  if (!_isPlainObj(payload)) return Object.assign({}, base, { reason: 'payload_not_object' });
  if (!SUPPORTED_SCHEMAS.includes(payload.schema)) {
    return Object.assign({}, base, { reason: 'schema_unsupported:' + _str(payload.schema) });
  }
  for (const k of Object.keys(payload)) {
    if (!PACKAGE_TOP_KEYS.includes(k)) return Object.assign({}, base, { reason: 'unknown_top_key:' + k });
  }
  const controls = _isPlainObj(payload.controls) ? payload.controls : {};
  if (controls.kill_all === true || controls.kill_all === 1) {
    return Object.assign({}, base, { killed: true, reason: 'kill_all' });
  }
  if (!Array.isArray(payload.rules)) return Object.assign({}, base, { reason: 'rules_not_array' });
  if (payload.rules.length > MAX_RULES_PER_SET) return Object.assign({}, base, { reason: 'too_many_rules' });
  const slots = Array.isArray(o.slots) ? o.slots.map(String) : [];
  const disabledRules = Array.isArray(controls.disabled_rules)
    ? controls.disabled_rules.map(String).filter(Boolean).slice(0, MAX_RULES_PER_SET) : [];
  const rules = [];
  const skipped = [];
  const seen = new Set();
  const needed = new Set();
  for (const raw of payload.rules) {
    const rid = _isPlainObj(raw) ? _str(raw.rule_id) : '';
    const v = validateRule(raw, { slots });
    if (!v.ok) { skipped.push({ rule_id: rid, reason: v.reason }); continue; }
    if (seen.has(v.rule.ruleId)) { skipped.push({ rule_id: rid, reason: 'dup_rule_id' }); continue; }
    seen.add(v.rule.ruleId);
    rules.push(v.rule);
    for (const k of v.usedKeys) needed.add(k);
    for (const k of v.rule.then.requires.features) needed.add(k);
  }
  return {
    ok: true,
    killed: false,
    reason: '',
    schema: _str(payload.schema),
    version: Number.isFinite(Number(payload.version)) ? Number(payload.version) : 0,
    rules,
    neededKeys: Array.from(needed),
    disabledRules,
    skipped,
  };
}

// ============================== 引擎状态机（createRecoEngine） ==============================

function _freshState() {
  return {
    v: 1,
    day: '',                // 本地日键（日预算/位频控归属日）
    shownToday: 0,          // 本域今日已呈现条数（跨域预算「本域今日已用」读数）
    perSlot: {},            // { [slot]: n } 位内今日已呈现
    perTarget: {},          // { [kind:id]: { day, n, lastSec } } 目标级今日计数与最近呈现时刻
    rejects: {},            // { [kind:id]: { count, until } } 拒绝计数与冷却截止
    mutedItems: {},         // { [kind:id]: true } 永久抑制（B §5.2-1）
    classMute: {},          // { [category]: { until, ever } } 类目静音（30 天窗＋持续降权）
  };
}

function _targetKey(kind, itemId) { return String(kind) + ':' + Number(itemId); }

/**
 * 构造推荐引擎（**依赖全注入**，裸 node 可用桩件复测——activity-sampler 同范式）。
 * @param {object} deps
 *   · now              () => number 秒级 epoch（时钟注入；缺省 Date.now/1000）
 *   · provider         FeatureProvider（16 键；函数/get 方法/键值平面三形态；缺省＝无特征源）
 *   · catalog          (target:{kind,item_id}) => {name,category}|null 市场目录解析（W2 注入；
 *                      注入后查无条目 ⇒ 该卡不渲染——A §3.5 防悬空；未注入 ⇒ 纯逻辑模式，name/category 留空）
 *   · crossBudget      { getUsed(dayKey) => number } 跨域共享预算查询回调（跨域预算互扣，
 *                      Z §五.3 P0 必做接口；实现延 W2——本域消费时按「全局日预算 − 本域已用 − 对方已用」裁剪）
 *   · clientVersion    本端 semver（requires.client_gte 判据；缺省空串＝判不过）
 *   · dshVersion       DSH 运行时 semver（runtime-config.json dsh.version；缺省空串＝设了 dsh_gte 的规则单条抑制）
 *   · config           覆盖项（经 normalizeConfig 钳制）
 *   · log              (msg) => void 留痕（缺省静默）
 * @returns 引擎对象：load/evaluate/reject/muteItem/muteClass/todayUsed/getState/setState/config
 */
function createRecoEngine(deps) {
  const d = deps || {};
  const nowSec = typeof d.now === 'function' ? d.now : () => Math.floor(Date.now() / 1000);
  const provider = d.provider === undefined ? null : d.provider;
  const catalog = typeof d.catalog === 'function' ? d.catalog : null;
  const crossBudget = (d.crossBudget && typeof d.crossBudget.getUsed === 'function') ? d.crossBudget : null;
  const clientVersion = _str(d.clientVersion).trim();
  const dshVersion = _str(d.dshVersion).trim();
  const log = typeof d.log === 'function' ? d.log : () => {};
  const cfgRes = normalizeConfig(d.config);
  const cfg = cfgRes.config;
  for (const w of cfgRes.warnings) log('reco-engine: ' + w);
  const slotSet = new Set(cfg.slots);

  let pkg = null;                 // normalizeRulePackage 结果（ok=false ⇒ 空态）
  let state = _freshState();

  function _tickDay() {
    const tk = localDayKey(nowSec());
    if (state.day !== tk) {
      state.day = tk;
      state.shownToday = 0;
      state.perSlot = {};
      for (const k of Object.keys(state.perTarget)) {
        state.perTarget[k] = { day: tk, n: 0, lastSec: state.perTarget[k].lastSec || 0 };
      }
    }
  }

  function _slotMaxPerDay(slot) {
    const lim = cfg.slotLimits[slot];
    return lim ? lim.maxPerDay : cfg.defaultSlotPerDay;
  }

  /** 规则生效抑制参数：规则声明值 > 本地默认（A §3.3：缺省值由 B 席本地默认兜底） */
  function _suppressionOf(rule) {
    const s = rule.then.suppression || {};
    return {
      maxPerDay: s.maxPerDay === null || s.maxPerDay === undefined ? cfg.ruleSuppression.maxPerDay : s.maxPerDay,
      cooldownHours: s.cooldownHours === null || s.cooldownHours === undefined ? cfg.ruleSuppression.cooldownHours : s.cooldownHours,
      dismissCooldownDays: s.dismissCooldownDays === null || s.dismissCooldownDays === undefined ? cfg.ruleSuppression.dismissCooldownDays : s.dismissCooldownDays,
    };
  }

  function _catalogCategory(tgt) {
    if (!catalog) return '';
    try {
      const meta = catalog({ kind: tgt.kind, item_id: tgt.itemId });
      return meta ? _str(meta.category) : '';
    } catch (e) { return ''; }
  }

  function _isQuietNow(now) {
    const dt = new Date(now * 1000);
    return isQuietMinutes(dt.getHours() * 60 + dt.getMinutes(), cfg.quietHours);
  }

  /** 命中比较器：score 降序 → priority 降序（A §3.2 次级键）→ rule_id 字典序升序（确定性 tie-break） */
  function _cmpHits(a, b) {
    if (a.score !== b.score) return b.score - a.score;
    if (a.rule.priority !== b.rule.priority) return b.rule.priority - a.rule.priority;
    return a.rule.ruleId < b.rule.ruleId ? -1 : (a.rule.ruleId > b.rule.ruleId ? 1 : 0);
  }

  /**
   * 求值一次（B §2.4：匹配 → 打分 → 预算/频控裁剪 → 排序去重）。
   * 免打扰时段内：求值照常产出 ranked，呈现推迟（cards=[]、预算不消耗——预算按呈现条数计）。
   * @returns {{slot, quiet, presented, ranked, cards:Array, crossUsed:number|undefined,
   *            stats:{hit, skipped:Object<string,number>, dropped:Object<string,number>}, reason?:string}}
   */
  function evaluate(slot) {
    _tickDay();
    const out = { slot: _str(slot), quiet: false, presented: 0, ranked: 0, cards: [], stats: { hit: 0, skipped: {}, dropped: {} } };
    if (!pkg || !pkg.ok) {
      out.reason = pkg ? pkg.reason : 'no_package';
      return out;
    }
    if (slotSet.size && !slotSet.has(out.slot)) {
      out.reason = 'unknown_slot';
      return out;
    }
    const now = nowSec();
    const dayKey = localDayKey(now);
    const feat = resolveFeatures(provider, pkg.neededKeys);
    const disabledSet = new Set(pkg.disabledRules);
    const skip = (reason) => { out.stats.skipped[reason] = (out.stats.skipped[reason] || 0) + 1; };
    const drop = (reason) => { out.stats.dropped[reason] = (out.stats.dropped[reason] || 0) + 1; };
    const installedIds = feat.values['user.installed_item_ids'] || [];

    // ---- 逐条：降级路径（A §6.4）→ 匹配 → 打分（单条异常隔离不炸链路，B §九.1）----
    const hits = [];
    for (const rule of pkg.rules) {
      try {
        if (rule.then.placement !== out.slot) continue;                 // 非本推荐位规则不参与
        if (disabledSet.has(rule.ruleId)) { skip('disabled'); continue; }
        if (rule.expiresAtSec !== null && now >= rule.expiresAtSec) { skip('expired'); continue; }
        if (rule.then.requires.clientGte) {
          const c = compareSemver(clientVersion, rule.then.requires.clientGte);
          if (c === null || c < 0) { skip('client_gte'); continue; }    // 路径②：客户端太旧
        }
        if (rule.then.requires.dshGte) {
          const c = dshVersion ? compareSemver(dshVersion, rule.then.requires.dshGte) : null;
          if (c === null || c < 0) { skip('dsh_gte'); continue; }       // 路径③：DSH 单条抑制，不停整集
        }
        if (rule.then.requires.features.some((k) => !feat.present[k])) { skip('feature_missing'); continue; }
        const m = matchNode(rule.when, feat);
        if (m.factor <= 0) continue;                                    // 不命中＝正常落选（非 skip）
        const tkey = _targetKey(rule.then.target.kind, rule.then.target.itemId);
        const rej = state.rejects[tkey] ? state.rejects[tkey].count : 0;
        const cat = _catalogCategory(rule.then.target);
        const cm = cat ? state.classMute[cat] : null;
        const score = _round6((Math.max(0, Math.min(100, rule.then.weight)) / 100)
          * m.factor
          * freshnessFactor(rule.freshFromSec, now, cfg.freshnessTauDays)
          * penaltyFactor(rej, !!(cm && cm.ever)));
        hits.push({ rule, tkey, score, matched: m.matched });
        out.stats.hit += 1;
      } catch (e) {
        skip('rule_error');
        log('reco-engine: 规则求值异常已隔离 ' + rule.ruleId + ' :: ' + (e && e.message));
      }
    }

    // ---- 同目标合并（取 max 不叠加，rule_refs ≤3）＋ 出列判定（B §5.2）----
    const byTarget = new Map();
    for (const h of hits) {
      if (!byTarget.has(h.tkey)) byTarget.set(h.tkey, []);
      byTarget.get(h.tkey).push(h);
    }
    const merged = [];
    for (const arr of byTarget.values()) {
      arr.sort(_cmpHits);
      const win = arr[0];
      const tgt = win.rule.then.target;
      if (tgt.kind === 'item' && installedIds.includes(tgt.itemId)) { drop('installed'); continue; }
      if (state.mutedItems[win.tkey]) { drop('muted_item'); continue; }
      const rj = state.rejects[win.tkey];
      if (rj && rj.until > now) { drop('reject_cooldown'); continue; }
      const cat = _catalogCategory(tgt);
      const cm = cat ? state.classMute[cat] : null;
      if (cm && cm.until > now) { drop('class_cooldown'); continue; }
      const sup = _suppressionOf(win.rule);
      const shown = state.perTarget[win.tkey];
      if (shown && shown.day === dayKey && shown.n >= sup.maxPerDay) { drop('target_daily_cap'); continue; }
      if (shown && shown.lastSec > 0 && now - shown.lastSec < sup.cooldownHours * 3600) { drop('target_cooldown'); continue; }
      merged.push({ tkey: win.tkey, tgt, win, all: arr });
    }
    merged.sort((a, b) => _cmpHits(a.win, b.win));
    out.ranked = merged.length;

    // ---- 卡片组装（catalog 防悬空：注入了目录且查无 ⇒ 丢弃，A §3.5）----
    const renderable = [];
    for (const c of merged) {
      let meta = null;
      if (catalog) {
        try { meta = catalog({ kind: c.tgt.kind, item_id: c.tgt.itemId }); } catch (e) { meta = null; }
        if (!meta) { drop('catalog_missing'); continue; }
      }
      const vars = {
        item_name: meta ? _str(meta.name) : '',
        item_category: meta ? _str(meta.category) : '',
        app_name: c.win.matched.appName || '',
        category: c.win.matched.category || '',
        slot: out.slot,
      };
      renderable.push({
        tkey: c.tkey,
        tgt: c.tgt,
        score: c.win.score,
        rule_refs: c.all.slice(0, 3).map((h) => h.rule.ruleId),
        title: renderReason(c.win.rule.then.copy.title, vars),
        reason_text: renderReason(c.win.rule.then.copy.reason, vars),
        name: meta ? _str(meta.name) : '',
        category: meta ? _str(meta.category) : '',
      });
    }

    // ---- 免打扰：呈现推迟（求值照常、预算不消耗）----
    if (_isQuietNow(now)) {
      out.quiet = true;
      return out;
    }

    // ---- 预算裁剪：全局日预算（含跨域互扣）× 位内每日上限 × 单次呈现上限 ----
    let crossUsed = 0;
    if (crossBudget) {
      try { crossUsed = Math.max(0, _n(crossBudget.getUsed(dayKey), 0)); } catch (e) { crossUsed = 0; }
      out.crossUsed = crossUsed;
    }
    const globalAvail = Math.max(0, cfg.dailyCap - state.shownToday - crossUsed);
    const slotAvail = Math.max(0, _slotMaxPerDay(out.slot) - (state.perSlot[out.slot] || 0));
    const room = Math.max(0, Math.min(cfg.maxCardsPerPresent, globalAvail, slotAvail));
    if (renderable.length > room) drop('budget_or_cap');                 // 超出丢弃留计数（不出网明细）
    const take = renderable.slice(0, room);

    // ---- 呈现记账（预算按呈现条数计）----
    for (const card of take) {
      state.shownToday += 1;
      state.perSlot[out.slot] = (state.perSlot[out.slot] || 0) + 1;
      const pt = state.perTarget[card.tkey] || { day: dayKey, n: 0, lastSec: 0 };
      if (pt.day !== dayKey) { pt.day = dayKey; pt.n = 0; }
      pt.n += 1;
      pt.lastSec = now;
      state.perTarget[card.tkey] = pt;
      out.cards.push({
        target_kind: card.tgt.kind,                                      // connector 目标本波只透传 id 与类型
        target_id: card.tgt.itemId,
        name: card.name,
        category: card.category,
        title: card.title,
        reason_text: card.reason_text,
        rule_refs: card.rule_refs,
        score: card.score,
      });
    }
    out.presented = out.cards.length;
    return out;
  }

  /** 装载规则包（包级校验失败 ⇒ 空态；不回落旧包半套执行——载荷级替换语义） */
  function load(payload) {
    pkg = normalizeRulePackage(payload, { slots: cfg.slots });
    if (!pkg.ok) log('reco-engine: 规则包丢弃(' + pkg.reason + ') ⇒ 空态');
    return { ok: pkg.ok, reason: pkg.reason, skipped: pkg.skipped.length, rules: pkg.rules.length };
  }

  /**
   * 单条负反馈「不感兴趣」：拒绝计数 +1 并按冷却曲线封窗（第 1 档可被规则 dismiss_cooldown_days 覆盖；
   * opts.dismissCooldownDays 由 W2 接线层从命中规则的 suppression 传入）。
   */
  function reject(kind, itemId, opts) {
    _tickDay();
    const key = _targetKey(kind, itemId);
    const cur = state.rejects[key] || { count: 0, until: 0 };
    cur.count += 1;
    const o = opts || {};
    const days = cooldownDaysForRejectCount(cur.count, o.dismissCooldownDays);
    cur.until = Math.max(cur.until, nowSec() + days * 86400);
    state.rejects[key] = cur;
    return { count: cur.count, cooldownDays: days, untilSec: cur.until };
  }

  /** 条目级永久抑制（「不再推荐此类」落位到单条时的静音档） */
  function muteItem(kind, itemId) {
    state.mutedItems[_targetKey(kind, itemId)] = true;
    return true;
  }

  /** 类目级静音：30 天冷却窗（设计初值·待实测）＋窗后持续 penalty ×0.5（B §六.3） */
  function muteClass(category) {
    const cat = _str(category).trim();
    if (!cat) return null;
    const cur = state.classMute[cat] || { until: 0, ever: false };
    cur.until = Math.max(cur.until, nowSec() + 30 * 86400);
    cur.ever = true;
    state.classMute[cat] = cur;
    return { untilSec: cur.until };
  }

  /** 本域今日已用（跨域预算互扣「本域读数」出口；跨域对账侧查询用。Z §五.3） */
  function todayUsed(dayKey) {
    _tickDay();
    if (dayKey !== undefined && String(dayKey) !== state.day) return 0;
    return state.shownToday;
  }

  function getState() { _tickDay(); return JSON.parse(JSON.stringify(state)); }
  function setState(s) {
    if (!_isPlainObj(s)) return false;
    state = JSON.parse(JSON.stringify(s));
    if (state.v !== 1) state.v = 1;
    _tickDay();
    return true;
  }

  return {
    load,
    evaluate,
    reject,
    muteItem,
    muteClass,
    todayUsed,
    getState,
    setState,
    config: cfg,
  };
}

// ============================== W2 接线清单（引擎接口面，延 W2 接线波） ==============================
//
// 1. 规则拉取与缓存：GET /api/discovery/rules（经 main.js apiProxy 出网）；原子写 tmp+rename、
//    writeIfChanged、TTL/expires_at、content_hash 复核（A §8.5；缓存损坏弃用＝空态，Z §一#6）。
// 2. FeatureProvider 实现（16 键逐键）：activity-sampler 快照（act.app.*）、市场目录合并安装态
//    （user.installed_item_ids/types）、runtime-config.json（dsh.*）、package.json（client.version）、
//    本地会议/项目计数（work.*）。
// 3. catalog 注入：(target) => 市场/连接器目录条目 {name, category}；connector 目标渲染分支。
// 4. crossBudget 实现：与推荐策略 rec_policy 域互扣（共享预算账本；服务端白名单键带 disco_ 前缀）。
// 5. 状态持久化：getState/setState → <userData>/reco-state.json（防抖合并写）；prefs.reco_enabled
//    门控（'0' ⇒ 停求值/呈现/上报，抑制表保留）。
// 6. IPC：reco:evaluate / reco:feedback / reco:state（具名最小面）；渲染层 RecoCard + store/reco.js。
// 7. 埋点接线：pc.reco.* 七键 recordFeature 挂点 + metrics 扩族 reco_expose/click/install/feedback。
// 8. 求值触发：T1 启动空闲拍 / T2 场景切换 / T3 任务完成 / T4 会后纪要（含 busy 标志双核、
//    空闲门、全局时钟与 slot 冷却节流）。

module.exports = {
  VERSION,
  SUPPORTED_SCHEMAS,
  PACKAGE_TOP_KEYS,
  OPERATORS,
  GROUP_OPS,
  TARGET_KINDS,
  REASON_VARS,
  FEATURE_KEYS,
  FEATURE_TABLE,
  DEFAULT_CONFIG,
  MAX_RULES_PER_SET,
  normalizeConfig,
  normalizeRulePackage,
  validateRule,
  validateTemplate,
  renderReason,
  resolveFeatures,
  parseSemver,
  compareSemver,
  matchNode,
  freshnessFactor,
  penaltyFactor,
  cooldownDaysForRejectCount,
  isQuietMinutes,
  isQuietHours,
  localDayKey,
  createRecoEngine,
};
