/**
 * 反馈轻量 CLI 机闸（tests/test_cli_feedback.mjs）· 零框架，node 直跑
 * -------------------------------------------------------------------
 * 判据面（YQ-1154 D4 件3：hosts/cli/feedback_cli.mjs 五子命令）：
 *   ① 同意闸：未开启时 send 拒发（非 TTY 无弹层，命令即同意）；off 后拒发
 *   ② on/off：state.json 同意位与档位落盘正确
 *   ③ show：待上行逐条可见（级别/摘要/时间/未发送态）
 *   ④ send：非 TTY 必须 --yes；--dry-run 不触网
 *   ⑤ 信封契约：八字段逐键对齐服务端（product/channel/schema_version/nonce/ts/
 *      payload.event）；X-OSS-Signature HMAC-SHA256(secret, t+"."+raw_body) 可验算
 *   ⑥ 回执：200 {accepted,deduped} → 回执码（6 hex）+ 游标推进 + state 留存
 *   ⑦ 422 逐条永久跳过 + 余量自动重试；5xx 指数退避 ≤3 次后成功 / 仍败中止保留待发
 *   ⑧ 端点 env 覆盖 NW_OSS_FEEDBACK_ENDPOINT 指向本地测试服（E2E 禁直发生产）
 *   ⑨ clear 清流水重置游标；无密钥时不发签名头（开发态放行路径）
 *
 * 纪律：本地 http 服务（随机端口）+ 异步 spawn 子进程（spawnSync 会阻塞事件循环
 * 死锁本地服务，禁用）；落盘一律 os.tmpdir() 临时目录，跑完即清理。
 * 运行：node tests/test_cli_feedback.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createFeedbackSdk } from '../core/js/feedback.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'hosts', 'cli', 'feedback_cli.mjs');
const HMAC_SECRET = 'test-secret-123';

let pass = 0;
const failures = [];
const ok = (cond, msg) => { if (cond) pass += 1; else failures.push(msg); };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg + `（实际=${JSON.stringify(a)} 期望=${JSON.stringify(b)}）`);

// ---------------- 本地测试服务 ----------------

function makeServer() {
  const state = { hits: 0, mode: 'ok', modeHits: 0, requests: [] };
  const srv = http.createServer((req, res) => {
    let chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      state.hits += 1;
      state.modeHits += 1;
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let parsed = null;
      try { parsed = JSON.parse(rawBody); } catch { /* 保留 null */ }
      const hit = { path: req.url, headers: { ...req.headers }, rawBody, parsed };
      state.requests.push(hit);
      const respond = (status, obj) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const n = parsed && Array.isArray(parsed.events) ? parsed.events.length : 0;
      if (state.mode === 'ok') {
        respond(200, { accepted: n, deduped: 0 });
      } else if (state.mode === 'reject422') {
        if (state.modeHits === 1) respond(422, { ok: false, msg: 'whitelist:foo', errors: [{ index: 1, reason: 'whitelist:foo' }] });
        else respond(200, { accepted: n, deduped: 0 });
      } else if (state.mode === 'flaky500') {
        if (state.modeHits <= 2) respond(500, { ok: false, msg: 'server_error' });
        else respond(200, { accepted: n, deduped: 0 });
      } else if (state.mode === 'always500') {
        respond(500, { ok: false, msg: 'server_error' });
      } else {
        respond(200, { accepted: 0, deduped: 0 });
      }
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ srv, state, url: 'http://127.0.0.1:' + srv.address().port + '/api/oss-feedback/v1' }));
  });
}

/** 切换 mock 模式（模式内计数归零，模式条件不跨用例污染） */
function setMode(server, mode) {
  server.state.mode = mode;
  server.state.modeHits = 0;
}

// ---------------- 夹具与驱动 ----------------

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'recoscan-cli-')); }
function cleanup(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

function seedRecords(dir, defs) {
  const sdk = createFeedbackSdk({ level: 'L3', feedbackDir: dir, packageVersion: '0.2.0', now: 1730000000 });
  for (const d of defs) sdk.record(d.level, d.payload);
}

/** 异步驱动 CLI 子进程（禁 spawnSync：会阻塞事件循环令本地服务无法应答） */
function runCli(args, env, dir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: dir,
      env: {
        ...process.env,
        RECOSCAN_FEEDBACK_DIR: dir,
        RECOSCAN_FEEDBACK_BACKOFF_MS: '10',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let errText = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { errText += c; });
    child.on('close', (code) => resolve({ code, out, err: errText }));
    child.on('error', (e) => resolve({ code: -1, out, err: String(e) }));
  });
}

function readState(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')); } catch { return null; }
}

const timeout = setTimeout(() => { console.error('FAIL 全局超时'); process.exit(1); }, 60000);

const A = await makeServer();
const B = await makeServer();
// 全部服务端交互用例从 env 注入本地测试服端点（测试隔离红线：绝不真连生产端点）
const envMain = { NW_OSS_FEEDBACK_HMAC: HMAC_SECRET, NW_OSS_FEEDBACK_ENDPOINT: A.url };

try {
  // ① 未开启时 send 拒发（非 TTY 无弹层；提示 on 命令即同意）
  {
    const dir = tmpDir();
    const r = await runCli(['send', '--yes'], envMain, dir);
    eq(r.code, 2, '未开启同意位时 send 应退出码 2');
    ok(r.err.includes('on') && r.err.includes('默认关闭'), `拒发提示应指向 on 命令（实际=${JSON.stringify(r.err.slice(0, 100))}）`);
    eq(A.state.hits, 0, '未同意时不应有任何网络请求');
    cleanup(dir);
  }

  // ② on 落同意位 + 档位；off 关闭
  {
    const dir = tmpDir();
    const r1 = await runCli(['on'], envMain, dir);
    eq(r1.code, 0, 'on 应成功');
    let st = readState(dir);
    ok(st && st.consent.on === true && st.consent.asked === true && st.consent.level === 'L1',
      'on 默认 L1 且 asked 置位（实际=' + JSON.stringify(st && st.consent) + '）');
    const r2 = await runCli(['on', '--level', 'L3'], envMain, dir);
    eq(r2.code, 0, 'on --level L3 应成功');
    st = readState(dir);
    eq(st.consent.level, 'L3', 'on --level 应切档');
    const r3 = await runCli(['off'], envMain, dir);
    eq(r3.code, 0, 'off 应成功');
    st = readState(dir);
    ok(st.consent.on === false && st.consent.declined_ts, 'off 后 on=false 且 declined_ts 落盘');
    const r4 = await runCli(['send', '--yes'], envMain, dir);
    eq(r4.code, 2, '关闭态 send 应拒（退出码 2）');
    ok(r4.err.includes('已关闭'), '关闭态拒发提示应明说已关闭');
    cleanup(dir);
  }

  // ③ show：待上行逐条可见 + 未发送态明示
  {
    const dir = tmpDir();
    await runCli(['on'], envMain, dir);
    seedRecords(dir, [
      { level: 'L1', payload: { event_type: 'plan_feedback', result: 'adopted', card_type: '下一步任务' } },
      { level: 'L3', payload: { samples: [{ reason: '引擎断言失败', sample: '样例文本一条' }] } },
    ]);
    const r = await runCli(['show'], envMain, dir);
    eq(r.code, 0, 'show 应成功');
    ok(r.out.includes('待上行 2 条') && r.out.includes('尚未发送'), `show 应含条数与未发送态（实际=${JSON.stringify(r.out.slice(0, 160))}）`);
    ok(r.out.includes('L1') && r.out.includes('L3'), 'show 应逐条列出档位');
    cleanup(dir);
  }

  // ④ 非 TTY 无 --yes 拒发；--dry-run 不触网
  {
    const dir = tmpDir();
    await runCli(['on'], envMain, dir);
    seedRecords(dir, [{ level: 'L1', payload: { event_type: 'plan_feedback', result: 'rejected' } }]);
    const before = A.state.hits;
    const r1 = await runCli(['send'], envMain, dir);
    eq(r1.code, 2, '非 TTY 无 --yes send 应退出码 2');
    ok(r1.err.includes('--yes'), '拒发提示应要求 --yes 显式确认');
    eq(A.state.hits, before, '无 --yes 不应触网');
    const r2 = await runCli(['send', '--yes', '--dry-run'], envMain, dir);
    eq(r2.code, 0, '--dry-run 应成功');
    ok(r2.out.includes('dry-run'), 'dry-run 应明示未发送');
    eq(A.state.hits, before, 'dry-run 不应触网');
    cleanup(dir);
  }

  // ⑤⑥ 信封契约 + HMAC 验算 + 回执与游标
  {
    const dir = tmpDir();
    await runCli(['on'], envMain, dir);
    seedRecords(dir, [
      { level: 'L1', payload: { event_type: 'plan_feedback', result: 'adopted', card_type: '下一步任务' } },
      { level: 'L2', payload: { event_type: 'plan_feedback', result: 'revised', rule_delta: { rule_id: 'plan.health.stale_days', field: 'stale_days', before: 14, after: 7 } } },
    ]);
    const before = A.state.hits;
    const r = await runCli(['send', '--yes'], envMain, dir);
    eq(r.code, 0, `send --yes 应成功（err=${JSON.stringify(r.err.slice(0, 120))}）`);
    eq(A.state.hits, before + 1, '应恰好一拍 POST');
    const hit = A.state.requests[A.state.requests.length - 1];
    eq(hit.path, '/api/oss-feedback/v1', '应 POST 到端点路径');
    const events = hit.parsed && hit.parsed.events;
    ok(Array.isArray(events) && events.length === 2, 'body 应为 {events:[…]} 两条');
    const env0 = events[0];
    eq(Object.keys(env0).sort(), ['channel', 'feedback_level', 'nonce', 'payload', 'product', 'product_version', 'schema_version', 'ts'],
      '信封应恰八字段（逐键对齐服务端 ENVELOPE_KEYS）');
    eq(env0.schema_version, '1', 'schema_version 应为 "1"');
    eq(env0.product, 'recoscan', 'product 应为 recoscan');
    eq(env0.channel, 'github_npm', 'channel 应为 github_npm');
    ok(/^[0-9a-f]{16,32}$/.test(env0.nonce), `nonce 应 16-32 hex（实际=${env0.nonce}）`);
    ok(!Number.isNaN(Date.parse(env0.ts)), 'ts 应为可解析 ISO8601');
    eq(env0.payload, { event: { type: 'plan_feedback', result: 'adopted', card_type: '下一步任务' } },
      'L1 payload 应恰含 event 且点选值透传');
    eq(events[1].payload.rule_delta, { rule_id: 'plan.health.stale_days', field: 'stale_days', before: 14, after: 7 },
      'L2 payload 应含白名单 rule_delta');
    // HMAC 验算：t 偏差窗内 + v1=HMAC-SHA256(secret, t+"."+raw_body)
    const sig = hit.headers['x-oss-signature'] || '';
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sig);
    ok(!!m, `应带可解析 X-OSS-Signature（实际=${sig.slice(0, 40)}…）`);
    if (m) {
      const t = Number(m[1]);
      ok(Math.abs(Date.now() / 1000 - t) <= 300, '签名 t 应在 ±300s 窗内');
      const expect = crypto.createHmac('sha256', HMAC_SECRET).update(m[1] + '.' + hit.rawBody).digest('hex');
      eq(m[2], expect, 'HMAC-SHA256(secret, t+"."+raw_body) 应逐字验算通过');
    }
    // 回执与游标
    ok(/回执码 [0-9a-f]{6}\b/.test(r.out), `应打印 6 位回执码（实际=${JSON.stringify(r.out)}）`);
    ok(r.out.includes('30 天内'), '应提示 30 天删除窗口');
    const st = readState(dir);
    eq(st.cursor, 2, '成功后游标应推进到 2');
    eq(st.receipts.length, 1, '回执应留 state 一份');
    ok(/^[0-9a-f]{6}$/.test(st.receipts[0].code) && st.receipts[0].nonces.length === 2,
      '回执应含 6 hex 码与 nonce 清单');
    const r2 = await runCli(['send', '--yes'], envMain, dir);
    eq(r2.code, 0, '重跑 send 无待发应成功');
    ok(r2.out.includes('暂无待上行'), '无待发应明示');
    eq(A.state.hits, before + 1, '无待发不应再触网（游标去重）');
    cleanup(dir);
  }

  // ⑦a 422 逐条永久跳过 + 余量自动重试
  {
    const dir = tmpDir();
    setMode(A, 'reject422');
    await runCli(['on'], envMain, dir);
    seedRecords(dir, [
      { level: 'L1', payload: { event_type: 'plan_feedback', result: 'adopted' } },
      { level: 'L1', payload: { event_type: 'plan_feedback', result: 'adopted' } },
    ]);
    const before = A.state.hits;
    const r = await runCli(['send', '--yes'], envMain, dir);
    eq(r.code, 0, `422 部分拒绝流程应最终成功（err=${JSON.stringify(r.err.slice(0, 120))}）`);
    eq(A.state.hits - before, 2, '422 后余量应自动重试一拍（共两拍）');
    const st = readState(dir);
    eq(st.cursor, 1, '游标应推进过已上行行（被拒行经 rejected 映射防重发）');
    ok(Object.values(st.rejected).includes('whitelist:foo'), `被拒条应永久标记 reason（rejected=${JSON.stringify(st.rejected)}）`);
    ok(Object.keys(st.rejected).length === 1 && st.rejected[1] === 'whitelist:foo', '被拒行号应对齐服务端 index');
    setMode(A, 'ok');
    cleanup(dir);
  }

  // ⑦b 5xx 退避重试后成功（1s/2s 折算 10ms/20ms）
  {
    const dir = tmpDir();
    setMode(A, 'flaky500');
    await runCli(['on'], envMain, dir);
    seedRecords(dir, [{ level: 'L1', payload: { event_type: 'plan_feedback', result: 'revised' } }]);
    const before = A.state.hits;
    const r = await runCli(['send', '--yes'], envMain, dir);
    eq(r.code, 0, `5xx 退避后应成功（err=${JSON.stringify(r.err.slice(0, 160))}）`);
    eq(A.state.hits - before, 3, '两次 5xx 后第三次应成功（共 3 次请求）');
    ok(r.err.includes('退避'), '退避过程应留痕 stderr');
    const st = readState(dir);
    eq(st.cursor, 1, '成功后游标推进');
    setMode(A, 'ok');
    cleanup(dir);
  }

  // ⑦c 持续 5xx：退避 ≤3 次后中止，游标不动（数据保留待发）
  {
    const dir = tmpDir();
    setMode(A, 'always500');
    await runCli(['on'], envMain, dir);
    seedRecords(dir, [{ level: 'L1', payload: { event_type: 'plan_feedback', result: 'adopted' } }]);
    const before = A.state.hits;
    const r = await runCli(['send', '--yes'], envMain, dir);
    eq(r.code, 1, '持续 5xx 应退出码 1');
    eq(A.state.hits - before, 3, '退避应恰 ≤3 次请求');
    const st = readState(dir);
    eq(st.cursor, 0, '失败后游标不得推进（保留待发）');
    eq(st.receipts.length, 0, '失败不得产生回执');
    setMode(A, 'ok');
    cleanup(dir);
  }

  // ⑧ 端点 env 覆盖 NW_OSS_FEEDBACK_ENDPOINT（E2E 指向 dev 实例；缺省端点不受影响）
  {
    const dir = tmpDir();
    await runCli(['on'], envMain, dir);
    seedRecords(dir, [{ level: 'L1', payload: { event_type: 'plan_feedback', result: 'adopted' } }]);
    const beforeA = A.state.hits;
    const beforeB = B.state.hits;
    const r = await runCli(['send', '--yes'], { ...envMain, NW_OSS_FEEDBACK_ENDPOINT: B.url }, dir);
    eq(r.code, 0, `env 覆盖端点 send 应成功（err=${JSON.stringify(r.err.slice(0, 120))}）`);
    eq(B.state.hits, beforeB + 1, '请求应落在覆盖端点（本地测试服 B）');
    eq(A.state.hits, beforeA, '缺省端点不应被触达');
    eq(B.state.requests[B.state.requests.length - 1].path, '/api/oss-feedback/v1', '覆盖端点路径一致');
    cleanup(dir);
  }

  // ⑨ 无密钥：不发签名头（服务端开发态放行路径）+ clear 清流水重置游标
  {
    const dir = tmpDir();
    await runCli(['on'], envMain, dir);
    seedRecords(dir, [{ level: 'L1', payload: { event_type: 'plan_feedback', result: 'adopted' } }]);
    const before = A.state.hits;
    // 只注入本地端点（测试隔离），不注入 NW_OSS_FEEDBACK_HMAC —— 验证无密钥路径
    const r = await runCli(['send', '--yes'], { NW_OSS_FEEDBACK_ENDPOINT: A.url }, dir);
    eq(r.code, 0, `无密钥 send 应走开发态放行路径（err=${JSON.stringify(r.err.slice(0, 120))}）`);
    eq(A.state.hits - before, 1, '无密钥 send 应恰一拍请求');
    const hit = A.state.requests[A.state.requests.length - 1];
    eq(hit.headers['x-oss-signature'], undefined, '无密钥不应携带签名头');
    ok(r.err.includes('NW_OSS_FEEDBACK_HMAC'), '无密钥应留提示（生产需密钥）');
    eq(readState(dir).cursor, 1, '无密钥发送成功游标照常推进');
    await runCli(['clear'], envMain, dir);
    ok(!fs.existsSync(path.join(dir, 'feedback.jsonl')), 'clear 应删除反馈流水文件');
    const stAfter = readState(dir);
    eq(stAfter.cursor, 0, 'clear 应重置游标');
    ok(stAfter.consent.on === true, 'clear 保留同意态');
    cleanup(dir);
  }
} finally {
  A.srv.close();
  B.srv.close();
  clearTimeout(timeout);
}

console.log(`反馈 CLI 机闸：断言通过 ${pass} 条；失败 ${failures.length} 条`);
if (failures.length) {
  for (const m of failures) console.error('FAIL ' + m);
  process.exit(1);
}
console.log('PASS 同意闸/on-off/show/非TTY确认/信封八字段/HMAC验算/回执游标/422逐条跳过/5xx退避/端点env覆盖/clear 全达标');
