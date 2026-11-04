/**
 * feedback_cli — RecoScan 项目计划台反馈轻量 CLI（hosts/cli/feedback_cli.mjs）
 * ---------------------------------------------------------------------
 * 定位（规范 §4.2 A 渠道 / §10 件3）：纯 MCP 产品无壳，本 CLI 承担反馈的
 * 「同意位 + 查看 + 发送 + 清除」终端面；仅 Node.js 内置模块（node:fs /
 * node:path / node:os / node:crypto / node:readline）+ 内置 fetch（Node 18+），
 * 零第三方依赖、断网可看可关可清。
 *
 * 子命令（五枚举）：
 *   on   [--level L1|L2|L3]   开启匿名反馈（命令即同意动作；默认 L1）
 *   off                       随时关（写 declined_ts，90 天内不再询问）
 *   show                      逐条查看待上行记录 + 同意态 + 最近回执
 *   send  [--yes] [--dry-run] 读本地 jsonl 游标后未发记录 → 信封+HMAC → POST；
 *                             发送前打印最终脱敏形态确认（非 TTY 必须 --yes）
 *   clear                     清空本地反馈流水（不联网；同意态与回执历史保留）
 *
 * 端点与覆盖：
 *   缺省 POST https://www.easurwork.cn/api/oss-feedback/v1
 *   env NW_OSS_FEEDBACK_ENDPOINT 可覆盖（E2E/内测指向 dev 实例，禁直发生产库）
 *   env NW_OSS_FEEDBACK_HMAC    签名密钥（与服务端同名 env；未设=不发签名头，
 *                               服务端开发态放行；生产密钥分发由总控波次收口）
 *   env RECOSCAN_FEEDBACK_BACKOFF_MS  5xx/429 退避基值毫秒（默认 1000；测试可调小）
 *
 * 本地面：
 *   .recoscan/feedback.jsonl   反馈流水（SDK record 追加；本 CLI 只读）
 *   .recoscan/state.json       同意位 + 游标 + 单条拒绝标记 + 回执码历史
 *     {schema, consent:{asked,on,level,asked_ts,declined_ts}, cursor, rejected, receipts}
 *
 * 发送契约（服务端 = app/oss_feedback_routes.py，规范 §5.2/§7.1）：
 *   body {"events":[信封…]} 单次 ≤20 条 ≤64KB；信封八字段
 *   {schema_version:"1", product:"recoscan", product_version, channel:"github_npm",
 *    feedback_level, nonce(16-32hex), ts(ISO8601), payload:{event|rule_delta|samples}}
 *   200 {"accepted":n,"deduped":m} → 推进游标 + 落回执码（凭码 30 天内可申请删除）
 *   422 逐条 reason（residue:phone|forbidden_key:k|schema:field|whitelist:k）→
 *        该条永久标 rejected 跳过，余量自动重试一拍
 *   400/401/403/413 → 中止保留待发（配置/签名类错误，不销用户数据）
 *   429/5xx → 指数退避 ≤3 次（base, 2×base, 4×base）仍败则中止保留待发
 * 退出码：0 成功 / 1 发送失败 / 2 用法或同意位不允许。
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import {
  SDK_VERSION,
  LEVEL_ORDER,
  defaultFeedbackDir,
  createFeedbackSdk,
} from '../../core/js/feedback.mjs';

const PRODUCT = 'recoscan';
const CHANNEL = 'github_npm';
const DEFAULT_ENDPOINT = 'https://www.easurwork.cn/api/oss-feedback/v1';
const STATE_SCHEMA = 'recoscan.feedback-cli-state/v1';
const MAX_BATCH = 20;
const MAX_BODY_BYTES = 64 * 1024;
const BACKOFF_TRIES = 3;

// ---------------------------------------------------------------------------
// 状态（同意位/游标/回执）
// ---------------------------------------------------------------------------

export function freshState() {
  return {
    schema: STATE_SCHEMA,
    consent: { asked: false, on: false, level: 'L0', asked_ts: '', declined_ts: '' },
    cursor: 0,
    rejected: {},
    receipts: [],
  };
}

export function loadState(dir) {
  const p = path.join(dir, 'state.json');
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!raw || typeof raw !== 'object') return freshState();
    return { ...freshState(), ...raw, consent: { ...freshState().consent, ...(raw.consent || {}) } };
  } catch {
    return freshState();
  }
}

export function saveState(dir, state) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2) + '\n', 'utf8');
}

export function feedbackRecordsPath(dir) {
  return path.join(dir, 'feedback.jsonl');
}

/** 读反馈流水 → [{idx, row}]（坏行原样带 null row，交由 send 标记） */
export function readRecords(dir) {
  const p = feedbackRecordsPath(dir);
  let text = '';
  try { text = fs.readFileSync(p, 'utf8'); } catch { return []; }
  return text.split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .map((line, idx) => {
      try { return { idx, row: JSON.parse(line) }; } catch { return { idx, row: null }; }
    });
}

/** 游标之后的待发记录（排除已标记 rejected 的行） */
export function pendingRecords(dir, state) {
  return readRecords(dir).filter(({ idx }) => idx >= state.cursor && !state.rejected[idx]);
}

// ---------------------------------------------------------------------------
// 信封组装（与服务端 ENVELOPE_KEYS / L1·L2·L3 白名单逐键对齐）
// ---------------------------------------------------------------------------

export function resolveEndpoint(env) {
  return String(env && env.NW_OSS_FEEDBACK_ENDPOINT || '').trim() || DEFAULT_ENDPOINT;
}

export function resolveHmacSecret(env) {
  return String(env && env.NW_OSS_FEEDBACK_HMAC || '').trim();
}

function hexNonce() { return crypto.randomBytes(12).toString('hex'); }         // 24 hex
export function receiptCode() { return crypto.randomBytes(3).toString('hex'); } // 6 hex

/** 本地流水行 → 服务端信封；不合法返回 {error:reason}（不联网、本机即标记） */
export function buildEnvelope(row) {
  if (!row || typeof row !== 'object') return { error: 'bad_line' };
  const level = row.level;
  if (!(level in LEVEL_ORDER) || level === 'L0') return { error: 'bad_level:' + level };
  const sdk = createFeedbackSdk({ level, packageVersion: row.sdk_version || SDK_VERSION });
  const prep = sdk.prepareUpload(level, row.payload);
  if (!prep.ok) return { error: prep.reason || 'prepare_rejected' };
  const up = prep.upload;
  // payload 键按档严格对齐服务端白名单：L1 只收 event；L2 只收 L2 键；L3 另收 samples
  const allow = level === 'L1'
    ? ['event']
    : (level === 'L2'
      ? ['rule_delta', 'template_hits', 'structure_hash']
      : ['rule_delta', 'template_hits', 'structure_hash', 'samples']);
  const payload = {};
  for (const k of allow) {
    if (up[k] !== undefined) payload[k] = up[k];
  }
  if (!Object.keys(payload).length) return { error: 'empty_payload' };
  return {
    envelope: {
      schema_version: '1',
      product: PRODUCT,
      product_version: String(up.package_version || SDK_VERSION).slice(0, 16),
      channel: CHANNEL,
      feedback_level: level,
      nonce: hexNonce(),
      ts: new Date().toISOString(),
      payload,
    },
  };
}

/** HMAC 传输头（规范 §7.1：t=<unix秒>,v1=HMAC-SHA256(secret, t+"."+raw_body)） */
export function signBody(secret, rawBody, nowMs) {
  const t = Math.floor((nowMs == null ? Date.now() : nowMs) / 1000);
  const v1 = crypto.createHmac('sha256', secret).update(t + '.' + rawBody).digest('hex');
  return 't=' + t + ',v1=' + v1;
}

// ---------------------------------------------------------------------------
// send 主流程（deps 注入便于测试：fetchFn/sleepFn/nowMs/out/err/isTTY/askFn）
// ---------------------------------------------------------------------------

async function postBatch(endpoint, rawBody, secret, deps) {
  const headers = { 'content-type': 'application/json' };
  if (secret) headers['X-OSS-Signature'] = signBody(secret, rawBody, deps.nowMs == null ? undefined : deps.nowMs());
  const res = await (deps.fetchFn || fetch)(endpoint, { method: 'POST', headers, body: rawBody });
  let text = '';
  try { text = await res.text(); } catch { /* 读体失败按空文本 */ }
  return { ok: Boolean(res.ok), status: Number(res.status) || 0, text: String(text || '') };
}

export async function sendPending(opts = {}) {
  const dir = opts.dir || defaultFeedbackDir();
  const endpoint = opts.endpoint || resolveEndpoint(opts.env || process.env);
  const secret = 'secret' in opts ? opts.secret : resolveHmacSecret(opts.env || process.env);
  const yes = Boolean(opts.yes);
  const dryRun = Boolean(opts.dryRun);
  const out = opts.out || process.stdout;
  const err = opts.err || process.stderr;
  const isTTY = opts.isTTY !== undefined ? opts.isTTY : Boolean(process.stdin.isTTY);
  const sleepFn = opts.sleepFn || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const backoffBase = Number((opts.env || process.env).RECOSCAN_FEEDBACK_BACKOFF_MS) || 1000;
  const state = loadState(dir);
  let stateDirty = false;

  // 同意闸（铁律②默认关；非交互环境永不弹层，命令即同意）
  if (!state.consent.on) {
    if (!state.consent.asked && isTTY && opts.askFn) {
      out.write('┌ RecoScan 匿名反馈计划 ──────────────────────────────\n');
      out.write('│ 仅统计与结构信息（匿名、默认关、随时关、30 天内可凭回执码删）。\n');
      out.write('│ 上行什么？见 https://www.easurwork.cn/open-source/feedback\n');
      const ans = await opts.askFn('开启匿名反馈并继续本次发送吗？[y/N]（回车=暂不，90 天内不再询问）');
      if (/^(y|yes|是|开启)/i.test(String(ans).trim())) {
        state.consent = { asked: true, on: true, level: 'L1', asked_ts: new Date().toISOString(), declined_ts: '' };
        stateDirty = true;
        out.write('已开启（L1）。随时可关：node hosts/cli/feedback_cli.mjs off\n');
      } else {
        state.consent.asked = true;
        state.consent.declined_ts = new Date().toISOString();
        stateDirty = true;
        saveState(dir, state);
        out.write('已记录「暂不」，90 天内不再询问。之后想开：feedback on\n');
        return 2;
      }
    } else if (!state.consent.asked) {
      err.write('[recoscan] 匿名反馈默认关闭。先执行 on 子命令开启（命令即同意）：\n' +
        '  node hosts/cli/feedback_cli.mjs on\n');
      return 2;
    } else {
      err.write('[recoscan] 匿名反馈已关闭（' + String(state.consent.declined_ts || '').slice(0, 10) +
        ' 关）。重新开启：node hosts/cli/feedback_cli.mjs on\n');
      return 2;
    }
  }

  const records = readRecords(dir);
  const bad = records.filter(({ idx, row }) => idx >= state.cursor && row === null && !state.rejected[idx]);
  for (const { idx } of bad) {
    state.rejected[idx] = 'bad_line'; // 永久跳过经 rejected 映射；游标只随成功推进
    stateDirty = true;
  }

  // 首拍：本地预检（prepareUpload 与残留检测），坏条本机即标，不发网络
  let pending = pendingRecords(dir, state);
  if (bad.length) {
    err.write('[recoscan] ' + bad.length + ' 条坏行已本地标记跳过（不发）。\n');
    pending = pendingRecords(dir, state);
  }
  if (!pending.length) {
    if (stateDirty) saveState(dir, state);
    out.write('暂无待上行记录（游标 ' + state.cursor + '）。反馈由宿主侧 SDK record 落盘后在此可见。\n');
    return 0;
  }

  // 发送确认：先打印最终脱敏形态；非 TTY 必须 --yes
  const planned = pending.slice(0, MAX_BATCH).map(({ idx, row }) => ({ idx, ...buildEnvelope(row) }));
  const localBad = planned.filter((x) => x.error);
  for (const b of localBad) {
    state.rejected[b.idx] = b.error; // 本机预检不过=永不重发（游标不动，防跳过同批可上行行）
    stateDirty = true;
  }
  const toSend = planned.filter((x) => x.envelope);
  if (!toSend.length) {
    saveState(dir, state);
    out.write('待发记录经本机预检全部不可上行（已逐条标记 reason），本轮无需网络请求。\n');
    return 0;
  }
  out.write('将上行 ' + toSend.length + ' 条（签名传输，不含任何账号信息；逐条最终脱敏形态如下）：\n');
  for (const x of toSend) {
    out.write('  #' + (x.idx + 1) + ' ' + x.envelope.feedback_level + ' ' +
      JSON.stringify(x.envelope.payload) + '\n');
  }
  if (dryRun) { out.write('[dry-run] 未发送。\n'); return 0; }
  if (!yes) {
    if (!isTTY) {
      err.write('[recoscan] 非交互环境必须 --yes 显式确认发送（看不到提示≠自动同意）。\n');
      saveState(dir, state);
      return 2;
    }
    const okSend = await (opts.askFn || defaultAsk)('确认发送？[y/N]');
    if (!/^(y|yes|是)/i.test(String(okSend).trim())) { out.write('已取消（未发送，游标未动）。\n'); return 2; }
  }
  if (stateDirty) saveState(dir, state);

  // 分批发送（≤20 条/拍；422 逐条跳过后余量自动重试；429/5xx 退避 ≤3 次）
  let sentAccepted = 0;
  let sentDeduped = 0;
  const lastReceipt = { code: '', accepted: 0, deduped: 0, ts: '', nonces: [] };
  for (;;) {
    const batch = pendingRecords(dir, state).slice(0, MAX_BATCH).map(({ idx, row }) => ({ idx, ...buildEnvelope(row) }))
      .filter((x) => {
        if (x.error) { state.rejected[x.idx] = x.error; return false; }
        return true;
      });
    if (!batch.length) {
      if (stateDirty) saveState(dir, state);
      break;
    }
    const bodyObj = { events: batch.map((x) => x.envelope) };
    const rawBody = JSON.stringify(bodyObj);
    if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
      err.write('[recoscan] 单批超 64KB，中止（游标未动）；请减少待发记录后重试。\n');
      saveState(dir, state);
      return 1;
    }

    let res = null;
    let attempts = 0;
    for (;;) {
      attempts += 1;
      try {
        res = await postBatch(endpoint, rawBody, secret, opts);
      } catch (e) {
        res = { ok: false, status: 0, text: 'network:' + (e && e.message || e) };
      }
      if (res.status && (res.status === 429 || res.status >= 500) && attempts < BACKOFF_TRIES) {
        const wait = backoffBase * Math.pow(2, attempts - 1);
        err.write('[recoscan] 端点 ' + res.status + '，第 ' + attempts + '/' + BACKOFF_TRIES + ' 次退避 ' + wait + 'ms…\n');
        await sleepFn(wait);
        continue;
      }
      break;
    }

    if (res.ok && res.status >= 200 && res.status < 300) {
      let body = {};
      try { body = JSON.parse(res.text); } catch { /* 保持 {} */ }
      const accepted = Number(body.accepted) || 0;
      const deduped = Number(body.deduped) || 0;
      const maxIdx = Math.max(...batch.map((x) => x.idx));
      state.cursor = Math.max(state.cursor, maxIdx + 1);
      const code = receiptCode();
      state.receipts.push({
        code, accepted, deduped, ts: new Date().toISOString(),
        nonces: bodyObj.events.map((e) => e.nonce),
      });
      saveState(dir, state);
      sentAccepted += accepted;
      sentDeduped += deduped;
      lastReceipt.code = code; lastReceipt.accepted = accepted; lastReceipt.deduped = deduped;
      lastReceipt.ts = state.receipts[state.receipts.length - 1].ts;
      lastReceipt.nonces = bodyObj.events.map((e) => e.nonce);
      out.write('已上行 ' + accepted + ' 条（deduped ' + deduped + '）。如需删除，请 30 天内凭回执码 ' +
        code + ' 到 https://www.easurwork.cn/open-source/feedback 申请删除。\n');
      const rest = pendingRecords(dir, state).length;
      if (!rest) break;
      continue;
    }

    const status = res.status || 0;
    const respText = res.text || '';
    if (status === 422) {
      let errors = [];
      try {
        const body = JSON.parse(respText);
        if (Array.isArray(body.errors)) errors = body.errors;
      } catch { /* 逐条信息缺失按中止处理 */ }
      if (errors.length) {
        for (const e of errors) {
          const item = batch[Number(e.index)];
          if (item) state.rejected[item.idx] = String(e.reason || 'rejected_422');
          // 422 拒整批：游标不动；余量（未拒行）下一拍自动重试
        }
        saveState(dir, state);
        err.write('[recoscan] 422 校验失败 ' + errors.length + ' 条已永久标记（reason 见 state.json），余量自动重试。\n');
        continue;
      }
      err.write('[recoscan] 422 校验失败且未给逐条明细（' + respText.slice(0, 200) + '），中止保留待发。\n');
      return 1;
    }
    if (status === 400 || status === 401 || status === 403 || status === 413) {
      err.write('[recoscan] 端点拒绝（' + status + ' ' + respText.slice(0, 200) + '），中止保留待发' +
        (status === 401 || status === 403 ? '；如为生产端点请确认签名密钥（NW_OSS_FEEDBACK_HMAC）已配置。' : '。') + '\n');
      return 1;
    }
    err.write('[recoscan] 发送未成功（' + (status || '网络错误') + '，重试 ' + attempts + ' 次），中止保留待发；稍后重跑 send 即可。\n');
    return 1;
  }

  out.write('本轮完成：上行 ' + sentAccepted + ' 条、去重命中 ' + sentDeduped + ' 条、游标推进至 ' + state.cursor + '。\n');
  if (!secret) {
    err.write('[recoscan] 提示：未配置 NW_OSS_FEEDBACK_HMAC，本次未携带签名头（服务端开发态放行；生产端点需密钥）。\n');
  }
  return 0;
}

function defaultAsk(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    rl.question(prompt, (ans) => { rl.close(); resolve(ans); });
  });
}

// ---------------------------------------------------------------------------
// 子命令分发
// ---------------------------------------------------------------------------

function printHelp(out) {
  out.write([
    'RecoScan 匿名反馈 CLI（默认关闭；仅统计与结构信息；发送由你显式执行）',
    '',
    '用法：node hosts/cli/feedback_cli.mjs <子命令> [参数]',
    '  on   [--level L1|L2|L3]   开启匿名反馈（命令即同意动作；默认 L1）',
    '  off                       随时关闭（90 天内不再询问）',
    '  show                      逐条查看待上行记录与同意态、最近回执',
    '  send  [--yes] [--dry-run] 发送待上行记录（发送前打印最终脱敏形态；非 TTY 必须 --yes）',
    '  clear                     清空本地反馈流水（不联网）',
    '',
    '上行什么？https://www.easurwork.cn/open-source/feedback',
  ].join('\n') + '\n');
}

function cmdShow(dir, out) {
  const state = loadState(dir);
  const pending = pendingRecords(dir, state);
  const levelTxt = state.consent.on ? (state.consent.level || 'L1') : '关';
  out.write('反馈同意：' + (state.consent.on ? '已开启（' + levelTxt + '）' : '关闭') +
    ' · 待上行 ' + pending.length + ' 条 · 存于本机 ' + feedbackRecordsPath(dir) + ' · 尚未发送\n');
  for (const { idx, row } of pending) {
    const summary = row && row.payload
      ? JSON.stringify(row.payload).slice(0, 72)
      : '(坏行)';
    out.write('  #' + (idx + 1) + '  ' + (row && row.level || '?') + '  ' + summary +
      '  ' + (row && row.ts || '') + '\n');
  }
  const recent = state.receipts.slice(-3);
  if (recent.length) {
    out.write('最近回执（凭码 30 天内可申请删除）：\n');
    for (const r of recent) out.write('  ' + r.ts.slice(0, 16).replace('T', ' ') + '  ' + r.code + '  上行 ' + r.accepted + ' 条\n');
  }
  out.write('[send 发送（--yes 跳过确认）]  [clear 清空本地]  [off 关闭]\n');
  return 0;
}

export async function main(argv, deps = {}) {
  const out = deps.out || process.stdout;
  const err = deps.err || process.stderr;
  const env = deps.env || process.env;
  const dir = deps.dir || defaultFeedbackDir();
  const [cmd, ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  const val = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };

  switch (cmd) {
    case 'on': {
      const level = val('--level') || 'L1';
      if (!(level in LEVEL_ORDER) || level === 'L0') {
        err.write('[recoscan] --level 须为 L1/L2/L3（收到 ' + level + '）。\n');
        return 2;
      }
      const state = loadState(dir);
      state.consent = { asked: true, on: true, level, asked_ts: new Date().toISOString(), declined_ts: '' };
      saveState(dir, state);
      out.write('已开启匿名反馈（' + level + '）。上行什么：https://www.easurwork.cn/open-source/feedback\n' +
        '随时可关（off）；发送需显式执行 send（--yes 跳过确认）。\n');
      return 0;
    }
    case 'off': {
      const state = loadState(dir);
      state.consent.on = false;
      state.consent.level = 'L0';
      state.consent.asked = true;
      state.consent.declined_ts = new Date().toISOString();
      saveState(dir, state);
      out.write('已关闭匿名反馈；90 天内不再询问。本地待发记录保留在 ' + feedbackRecordsPath(dir) +
        '（clear 可清空）。\n');
      return 0;
    }
    case 'show':
      return cmdShow(dir, out);
    case 'send':
      return sendPending({ dir, yes: flags.has('--yes'), dryRun: flags.has('--dry-run'), env, out, err, ...deps.send || {} });
    case 'clear': {
      const p = feedbackRecordsPath(dir);
      const state = loadState(dir);
      try { fs.rmSync(p, { force: true }); } catch { /* 忽略不存在 */ }
      state.cursor = 0;
      state.rejected = {};
      saveState(dir, state);
      out.write('已清空本地反馈流水并重置游标（同意态与回执历史保留；已上行数据凭回执码申请删除）。\n');
      return 0;
    }
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      printHelp(out);
      return 0;
    default:
      err.write('[recoscan] 未知子命令：' + cmd + '（可用：on/off/show/send/clear/help）\n');
      return 2;
  }
}

// 直跑入口（被 import 时不执行）
const isMain = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isMain) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code || 0; }).catch((e) => {
    process.stderr.write('[recoscan] 未预期错误：' + (e && e.stack || e) + '\n');
    process.exitCode = 1;
  });
}
