/**
 * Easur Open 开源版·零依赖
 * ------------------------
 * 来源说明：本文件自 Easur Work（弈枢AI工作台）PC 客户端「本地知识库五要素抽取」模块
 * 原样开源搬运（整文件逐字复制，module.exports 面保持不变；仅新增本头部注释块，
 * 并将文内内部需求编号改为中性表述）。零依赖、零 IO、纯函数计算层，裸 node 可测。
 * 配套组件：core/js/reco-engine.js（云端规则驱动的技能发现与推荐引擎，同范式开源件）。
 */

// 本地知识库五要素抽取（深化版）
// 定位：零模型本地规则抽取（设计件＝本地知识库功能清单与表结构 v1 设计文档）
// 纯函数模块：出入参全是普通对象，无 IO、无副作用；写库在 project-store.js::runOntologyExtract。
// 规则集：R1 实体识别 / R2 代词-公司别名归并 / R3 关系与动作句式 / R4 专有词与术语候选 / R5 出处引用截取

'use strict';

const SURNAMES = '王李张刘陈杨黄赵周吴徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严武戴莫孔向汤';
// 职称后缀（长词在前，防「总经理」被「总」截短）
const TITLES = '董事长|总经理|经理|总监|主管|主任|部长|科长|工程师|顾问|负责人|代表|老师|律师|处长|总';
// 停止词（R4 词频候选过滤用，小型内置集合）
const STOP_CHARS = '的了是在和与及或为被把对中上下内外前后左右这那一个些有就说要会能去到从也没有';
const CORE_STOP_WORDS = new Set(['我们', '他们', '你们', '这个', '那个', '什么', '怎么', '比如', '就是', '因为', '所以', '然后', '但是', '可以', '应该', '还是', '已经', '现在', '今天', '明天', '昨天', '会议', '讨论', '情况', '问题', '事情', '方面', '分钟', '小时', '时候', '甲方', '乙方', '对方', '我方', '我们这边', '大家', '各位']);

// 公司/机构后缀（长词在前，alternation 优先匹配最长公司词，防“有限公司”退化成“公司”；无尾断言，
//   避免公司名后紧跟“的/将/向”等汉字时整体失配——候选制由用户确认兜底误提）
const ORG_RE = /([\u4e00-\u9fa5A-Za-z0-9]{1,14}?(?:股份有限公司|有限责任公司|有限公司|集团公司|集团|公司|研究院|设计院|事务所|中心|银行|大学|医院|厂))/g;
const ORG_SUFFIXES = ['股份有限公司', '有限责任公司', '有限公司', '集团公司', '集团', '公司', '研究院', '设计院', '事务所', '中心', '银行', '大学', '医院', '厂'];
// 介词/连词/结构助词（不做实体名成分）：命中即重置当前名段（如“与武汉…”取下“武汉…”；“的合同由公司”最终剥成裸后缀被丢弃）
const VIRTUAL_CHARS = '与和及或向给为由对把将跟同请的了';

/** 公司名清洗：按虚词切段取尾部连续非虚词段；裸后缀（无实质前缀）视为噪声返回空 */
function cleanOrgName(raw) {
  const n = String(raw || '');
  let seg = '';
  for (const ch of n) {
    if (VIRTUAL_CHARS.includes(ch)) { seg = ''; continue; }
    seg += ch;
  }
  for (const suf of ORG_SUFFIXES) {
    if (seg.endsWith(suf)) {
      const pre = seg.slice(0, -suf.length);
      // 后缀前至少有 1 个实质字（“甲公司”→“甲”保留；洗净后裸“公司”→丢弃）
      return pre.length >= 1 ? seg : '';
    }
  }
  return seg;
}
// 人名：单姓 + 0~2 个名 + 职称（复姓暂不覆盖，规则层按候选处理）
const PERSON_RE = new RegExp(`([${SURNAMES}][\\u4e00-\\u9fa5]{0,2})(${TITLES})`, 'g');
// 金额 / 时间（时间用于断言 act_time；金额随宾语文本自然截取，不单独建实体）
const TIME_RE = /(周[一二三四五六日天]|\d{1,2}月\d{1,2}[日号]|\d{1,2}:\d{2}|明天|后天)/g;
// 我方/对方代词（R2：与同句公司名建立别名关联）
const PARTY_RE = /我方|对方|甲方|乙方|我们|对方公司/g;
// 关系/动作动词（R3 模板；value 截到句末）
const PREDICATES = ['承诺', '同意', '拒绝', '接受', '否决', '确认', '否认', '要求', '坚持', '让步', '压价', '抬价', '报价', '出价', '开价', '负责', '承担'];

/** 截出处引用：命中位置前后各 22 字 */
function quoteAround(text, start, end) {
  const s = Math.max(0, start - 22);
  const e = Math.min(text.length, end + 22);
  return text.slice(s, e).replace(/\s+/g, ' ').trim();
}

/** 判定是否为可接受的命名（不全是停止字/数字，长度 2~30） */
function validName(n) {
  if (!n || n.length < 2 || n.length > 30) return false;
  const ch = n.replace(/[\d.]+/g, '');
  if (ch.length === 0) return false;
  let hit = 0;
  for (const c of ch) if (!STOP_CHARS.includes(c)) hit += 1;
  return hit >= 2;
}

/** R1-R3：从单段文本抽取实体与断言候选（纯函数） */
function extract(text, ctx = {}) {
  const t = String(text || '');
  const out = { entities: [], assertions: [], terms: [] };
  if (!t.trim()) return out;
  const seenEnt = new Map();   // name -> {name,type,aliases[]}

  const addEnt = (name, type, alias) => {
    const n = String(name || '').trim();
    if (!validName(n)) return null;
    const k = n;
    if (!seenEnt.has(k)) seenEnt.set(k, { name: k, type, aliases: [] });
    const e = seenEnt.get(k);
    if (alias && !e.aliases.includes(alias)) e.aliases.push(alias);
    return e;
  };

  // R1a 公司/机构（名清洗后入池）
  let m;
  ORG_RE.lastIndex = 0;
  while ((m = ORG_RE.exec(t)) !== null) {
    const nm = cleanOrgName(m[1]);
    if (nm) addEnt(nm, 'org');
  }
  // R1b 人名（职称后缀）
  PERSON_RE.lastIndex = 0;
  while ((m = PERSON_RE.exec(t)) !== null) addEnt(m[1] + m[2], 'person');
  // R1c 金额 / 时间（作为值实体不落库，供断言 object_value 使用；日期表达入 terms 候选可选，此处仅识别不建实体）
  // R2 代词-公司别名：同一语句（以 。！？；\n 切句）内出现甲方/乙方/我方/对方 与公司名时，代词挂为公司别名
  const sents = t.split(/[。！？；\n]/).map((s) => s.trim()).filter(Boolean);
  for (const s of sents) {
    const orgIn = [];
    ORG_RE.lastIndex = 0;
    while ((m = ORG_RE.exec(s)) !== null) {
      const nm = cleanOrgName(m[1]);
      if (nm) orgIn.push(nm);
    }
    if (orgIn.length === 1) {
      PARTY_RE.lastIndex = 0;
      while ((m = PARTY_RE.exec(s)) !== null) {
        addEnt(orgIn[0], 'org', m[0]);   // 我方/对方/甲方/乙方/我们 统一挂为该句公司别名
      }
    }
  }

  // R3 关系/动作句式：主语（我方/对方/公司/人名，距动词 ≤14 字）＋ 动词 ＋ 宾语（至句末截 40 字）
  const candSubj = t.match(/我方|对方|甲方|乙方|我们|对方公司/g) || [];
  const entitiesNow = Array.from(seenEnt.values()).map((e) => e.name);
  const subjPool = Array.from(new Set([...candSubj, ...entitiesNow]));
  for (const verb of PREDICATES) {
    let from = 0;
    let vIdx;
    while ((vIdx = t.indexOf(verb, from)) !== -1) {
      // 向后找宾语（跳过 的/了/被/把 等虚字）
      let j = vIdx + verb.length;
      while (j < t.length && '了的被把'.includes(t[j])) j += 1;
      const stopAt = t.slice(j).search(/[。！？；\n]/);
      const objRaw = stopAt === -1 ? t.slice(j) : t.slice(j, j + stopAt);
      const obj = objRaw.replace(/^(了|的|就是|是)+/, '').trim().slice(0, 40);
      // 向前找主语
      const pre = t.slice(Math.max(0, vIdx - 14), vIdx);
      let subject = '';
      for (const s of subjPool) {
        const li = pre.lastIndexOf(s);
        if (li >= 0 && (!subject || li > pre.lastIndexOf(subject))) subject = s;
      }
      if (!subject) subject = '待定';
      const qText = quoteAround(t, Math.max(0, vIdx - 14), vIdx + verb.length + Math.min(obj.length, 40));
      // 动作时间：出处片段内最近的时间表达（无则空）
      let actTime = '';
      let tm;
      TIME_RE.lastIndex = 0;
      if ((tm = TIME_RE.exec(qText)) !== null) actTime = tm[0];
      out.assertions.push({
        subject,
        predicate: verb,
        object: obj,
        kind: ['报价', '出价', '开价', '压价', '抬价', '让步'].includes(verb) ? 'action' : 'relation',
        actTime,
        quote: qText,
      });
      from = vIdx + verb.length;
    }
  }

  // R4 术语候选：引号内专有词 ＋ 词频 ≥2 次的长词
  const quoted = t.match(/[“"「『]([^”"」』]{2,12})[”"」』]/g) || [];
  for (const q of quoted.slice(0, 8)) {
    const term = q.slice(1, -1).trim();
    if (validName(term) && !CORE_STOP_WORDS.has(term)) out.terms.push({ term, quote: quoteAround(t, t.indexOf(q), t.indexOf(q) + q.length) });
  }
  const freq = new Map();
  for (const s of sents) {
    for (let i = 0; i + 1 < s.length; i += 1) {
      for (let len = 4; len <= 8 && i + len <= s.length; len += 1) {
        const w = s.slice(i, i + len);
        if (!validName(w) || CORE_STOP_WORDS.has(w)) continue;
        freq.set(w, (freq.get(w) || 0) + 1);
      }
    }
  }
  for (const [w, c] of freq) {
    if (c >= 2 && out.terms.length < 12) out.terms.push({ term: w, quote: '' });
  }
  // 去重术语
  const seenT = new Set();
  out.terms = out.terms.filter((x) => (seenT.has(x.term) ? false : (seenT.add(x.term), true)));

  out.entities = Array.from(seenEnt.values()).map((e) => ({ name: e.name, type: e.type, aliases: e.aliases }));
  return out;
}

/**
 * 归属推荐打分（纯函数）：会议实体/术语 vs 各项目画像。
 * profiles: [{project_id, name, entityNames:[], entityAliasMap:[{alias,name}], terms:[], titleText}]
 * 计分：实体名完全命中 +3；命中别名 +2；会议实体别名对应项目实体名 +1；术语重合 +1；公司名出现在项目历史会议标题 +2
 */
function scoreProjects(meetingEntities, meetingTerms, profiles) {
  const results = [];
  for (const p of profiles) {
    let score = 0;
    const reasons = [];
    const aliasMap = new Map();
    for (const a of p.entityAliasMap || []) aliasMap.set(String(a.alias), a);
    for (const ent of meetingEntities) {
      const n = String(ent.name || '');
      if (!n) continue;
      if (p.entityNames.includes(n)) {
        score += 3;
        if (reasons.length < 3 && !reasons.includes(n)) reasons.push(n);
      } else if (aliasMap.has(n)) {
        score += 2;
        if (reasons.length < 3) reasons.push(n + '（别名）');
      } else {
        for (const a of ent.aliases || []) {
          if (p.entityNames.includes(String(a))) { score += 1; if (reasons.length < 3) reasons.push(String(a)); }
        }
      }
    }
    for (const t of meetingTerms) {
      if (p.terms.includes(String(t))) { score += 1; if (reasons.length < 3) reasons.push(String(t)); }
    }
    for (const ent of meetingEntities) {
      const n = String(ent.name || '');
      if (ent.type === 'org' && n && String(p.titleText || '').includes(n)) {
        score += 2;
        if (reasons.length < 3 && !reasons.includes(n)) reasons.push(n + '（历史会议）');
      }
    }
    if (score > 0) results.push({ project_id: p.project_id, name: p.name, score, reasons: reasons.slice(0, 3) });
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

/**
 * F9 链式查看 · 断言关系网投影（纯函数）：
 *   nodes = 去重实体词（同词一节点，person/org 等类型归类）；edges = 断言 subject→object、标签=谓词、携带断言 id/出处。
 *   代词/「待定」等弱者归入「我方 / 对方 / 待定」固定节点（不逐条发散）。
 * 输入 assertions 形状 = project-store ontologySnapshot 的断言面（含 subject_name/predicate/object_value/id/sources/status）。
 */
function assertionGraph(assertions) {
  const list = (Array.isArray(assertions) ? assertions : []).filter((a) => a && !String(a.status || '').includes('discarded'));
  // 归一化：snapshot 断言面是「断言×出处」扁平行（ref_type/ref_id/anchor/quote 平铺），
  // 按断言 id 聚合为一行，出处聚进 sources[]（anchor+quote 去重）
  const grouped = new Map();
  for (const a of list) {
    const id = Number(a.id || 0);
    if (!grouped.has(id)) grouped.set(id, { ...a, sources: Array.isArray(a.sources) ? a.sources.slice() : [] });
    const g = grouped.get(id);
    if (a.ref_type || a.quote) {
      const cand = { ref_type: a.ref_type, ref_id: a.ref_id, anchor: a.anchor, quote: a.quote };
      if (!g.sources.some((s) => String(s.anchor) === String(cand.anchor) && String(s.quote) === String(cand.quote))) g.sources.push(cand);
    }
  }
  const nodeMap = new Map();   // name -> {id, label, kind, count}
  const edges = [];
  const nodeId = (raw) => {
    let n = String(raw || '').trim();
    if (!n) n = '待定';
    if (!/[\u4e00-\u9fff]/.test(n) && n.length < 2) n = '待定';
    return n;
  };
  const addNode = (name, kind) => {
    const k = String(name || '待定') + '|' + (kind || '');
    if (!nodeMap.has(k)) nodeMap.set(k, { id: k, label: String(name || '待定'), kind: kind || '', count: 0 });
    const nd = nodeMap.get(k);
    nd.count += 1;
    return nd.id;
  };
  for (const a of grouped.values()) {
    const s = addNode(nodeId(a.subject_name), '主体');
    const o = addNode(nodeId(a.object_value), '对象');
    edges.push({
      id: 'a' + a.id,
      assertionId: a.id,
      source: s,
      target: o,
      label: String(a.predicate || ''),
      kind: a.kind || 'relation',
      actTime: String(a.act_time || a.actTime || ''),
      status: a.status,
      sources: a.sources || [],
    });
  }
  const nodes = [...nodeMap.values()].sort((x, y) => y.count - x.count);
  return { nodes, edges };
}

/**
 * 实体-文件证据网投影（纯函数，与 assertionGraph 并列的 v2 口径）：
 *   以 entities 表为锚：① 节点主集 = snapshot.entities（merged_to=0），count=该实体在断言中作为
 *   subject/object 的命中数（object_value 用包含匹配——object 常为复合串，精确等值会断链）；
 *   挂不上实体的断言落点归「待定」聚合节点（沿 assertionGraph 固定节点口径）。
 *   ② 断言边同 assertionGraph（label=谓词、剔 discarded），端点先挂 entity_id（断言行带
 *   subject/object_entity_id 且在实体集内时优先），缺失/失配时按 name（含别名）匹配兜底。
 *   ③ 实体-文件边（kind='efile'）：断言 sources[] 中 ref_type='file' 的出处 ⇄ 挂上的实体，
 *   按 (实体,文件) 去重合并、count 计权重；文件节点只挂被提及文件的最小投影
 *   （id 与 kb-graph-core.js 文件节点同构 'F'+pid+'_'+idx，不铺全库树；opts.files 查不到投影的出处不计边）。
 *   ④ 护栏：实体节点≤300（按 count 降序）、断言边≤450（按输入序=断言 id 降序）、实体-文件边≤600
 *   （按 count 降序）；超限截断并返回 truncated 明示。opts.maxEntities/maxAssertEdges/maxFileEdges 可覆盖（测试用）。
 * 输入 = project-store ontologySnapshot 的 {entities, assertions}（断言面为「断言×出处」扁平行）＋ opts.files。
 */
function entityFileGraph(snapshot, opts) {
  const o = opts || {};
  const maxEntities = Math.max(1, Number(o.maxEntities) || 300);
  const maxAssertEdges = Math.max(1, Number(o.maxAssertEdges) || 450);
  const maxFileEdges = Math.max(1, Number(o.maxFileEdges) || 600);
  const snap = snapshot || {};
  const ents = (Array.isArray(snap.entities) ? snap.entities : [])
    .filter((e) => e && Number(e.merged_to || 0) === 0);
  const entById = new Map();
  for (const e of ents) entById.set(Number(e.id), e);
  const entByName = new Map();   // 名/别名 → 实体（subject name 匹配兜底）
  for (const e of ents) {
    entByName.set(String(e.name || ''), e);
    for (const a of (Array.isArray(e.aliases) ? e.aliases : [])) entByName.set(String(a), e);
  }
  // 文件最小投影：fid → {id:'F'+pid+'_'+idx, label, kind:'file', type, project}
  const fileByFid = new Map();
  for (const f of (Array.isArray(o.files) ? o.files : [])) {
    if (!f || f.fid == null || f.idx == null) continue;
    fileByFid.set(Number(f.fid), {
      id: 'F' + Number(f.project) + '_' + Number(f.idx),
      label: String(f.name || ''), kind: 'file',
      type: String(f.type || ''), project: Number(f.project),
    });
  }
  // 断言聚合（snapshot 断言面是「断言×出处」扁平行；剔 discarded 同 assertionGraph 口径）
  const list = (Array.isArray(snap.assertions) ? snap.assertions : [])
    .filter((a) => a && !String(a.status || '').includes('discarded'));
  const grouped = new Map();
  for (const a of list) {
    const id = Number(a.id || 0);
    if (!grouped.has(id)) grouped.set(id, { ...a, sources: Array.isArray(a.sources) ? a.sources.slice() : [] });
    const g = grouped.get(id);
    if (a.ref_type || a.quote) {
      const cand = { ref_type: a.ref_type, ref_id: a.ref_id, anchor: a.anchor, quote: a.quote };
      if (!g.sources.some((s) => String(s.anchor) === String(cand.anchor) && String(s.quote) === String(cand.quote))) g.sources.push(cand);
    }
  }
  const nodeIdOf = (e) => 'E' + Number(e.id);
  const PENDING_ID = 'pending';
  const norm = (raw) => {
    let n = String(raw || '').trim();
    if (!n) n = '待定';
    if (!/[\u4e00-\u9fff]/.test(n) && n.length < 2) n = '待定';
    return n;
  };
  // object_value 包含匹配：命中多个取名最长者（最具体优先）
  const matchByContain = (text) => {
    if (!text) return null;
    let best = null;
    let bestLen = 0;
    for (const e of ents) {
      const names = [String(e.name || '')].concat((Array.isArray(e.aliases) ? e.aliases : []).map(String));
      for (const nm of names) {
        if (nm && text.indexOf(nm) >= 0 && nm.length > bestLen) { best = e; bestLen = nm.length; }
      }
    }
    return best;
  };
  const resolveSubject = (a) => {
    const sid = Number(a.subject_entity_id || a.subjectEntityId || 0);
    if (sid && entById.has(sid)) return entById.get(sid);
    return entByName.get(norm(a.subject_name)) || null;
  };
  const resolveObject = (a) => {
    const oid = Number(a.object_entity_id || a.objectEntityId || 0);
    if (oid && entById.has(oid)) return entById.get(oid);
    return matchByContain(String(a.object_value || ''));
  };
  const counts = new Map();   // 实体 id（或 'pending'）→ 命中数（subject/object 各计一次）
  const assertEdges = [];
  const efileAgg = new Map(); // 实体id|fid → {ent, file, count}
  for (const a of grouped.values()) {
    const se = resolveSubject(a);
    const oe = resolveObject(a);
    counts.set(se ? se.id : PENDING_ID, (counts.get(se ? se.id : PENDING_ID) || 0) + 1);
    counts.set(oe ? oe.id : PENDING_ID, (counts.get(oe ? oe.id : PENDING_ID) || 0) + 1);
    assertEdges.push({
      id: 'a' + a.id,
      assertionId: a.id,
      s: se ? nodeIdOf(se) : PENDING_ID,
      t: oe ? nodeIdOf(oe) : PENDING_ID,
      label: String(a.predicate || ''),
      kind: a.kind || 'relation',
      actTime: String(a.act_time || a.actTime || ''),
      status: a.status,
      sources: a.sources || [],
    });
    const hitEnts = [];
    if (se) hitEnts.push(se);
    if (oe && oe !== se) hitEnts.push(oe);
    for (const ent of hitEnts) {
      for (const s of (a.sources || [])) {
        if (String(s.ref_type) !== 'file') continue;
        const f = fileByFid.get(Number(s.ref_id));
        if (!f) continue;
        const k = Number(ent.id) + '|' + Number(s.ref_id);
        if (!efileAgg.has(k)) efileAgg.set(k, { ent, file: f, count: 0 });
        efileAgg.get(k).count += 1;
      }
    }
  }
  // 护栏三上限（截断如实明示，不静默）
  const truncated = { entities: false, assertEdges: false, fileEdges: false };
  const entNodes = ents.map((e) => ({
    id: nodeIdOf(e), label: String(e.name || ''), kind: 'entity',
    etype: String(e.etype || ''), status: String(e.status || ''),
    aliases: Array.isArray(e.aliases) ? e.aliases : [],
    count: Number(counts.get(e.id)) || 0,
  })).sort((x, y) => y.count - x.count);
  truncated.entities = entNodes.length > maxEntities;
  const keptEnts = entNodes.slice(0, maxEntities);
  const keptIds = new Set(keptEnts.map((n) => n.id));
  const alive = assertEdges.filter((e) => (e.s === PENDING_ID || keptIds.has(e.s)) && (e.t === PENDING_ID || keptIds.has(e.t)));
  truncated.assertEdges = alive.length > maxAssertEdges;
  const keptAssert = alive.slice(0, maxAssertEdges);
  const efileList = [...efileAgg.values()].filter((x) => keptIds.has(nodeIdOf(x.ent)))
    .sort((x, y) => y.count - x.count);
  truncated.fileEdges = efileList.length > maxFileEdges;
  const keptEfile = efileList.slice(0, maxFileEdges);
  const fileNodes = [];
  const fileSeen = new Set();
  for (const x of keptEfile) {
    if (fileSeen.has(x.file.id)) continue;
    fileSeen.add(x.file.id);
    fileNodes.push(x.file);
  }
  const pendCount = Number(counts.get(PENDING_ID)) || 0;
  const nodes = keptEnts
    .concat(pendCount > 0 ? [{ id: PENDING_ID, label: '待定', kind: 'entity', etype: '', status: '', aliases: [], count: pendCount }] : [])
    .concat(fileNodes);
  const edges = keptAssert.concat(keptEfile.map((x) => ({ s: nodeIdOf(x.ent), t: x.file.id, kind: 'efile', count: x.count })));
  return { nodes, edges, truncated };
}

module.exports = { extract, quoteAround, validName, cleanOrgName, scoreProjects, assertionGraph, entityFileGraph, ORG_RE, PERSON_RE };