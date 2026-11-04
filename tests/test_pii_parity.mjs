/**
 * YQ-1154 T1 机闸 G2：detectResidue × 服务端实现 同 fixtures 输出全等
 * -------------------------------------------------------------------
 * 判据（任务书 T1 · G2；回流规范 v1 §7.2 闸①/§8 G2）：recoscan detectResidue 与
 * server 端实现同 fixtures 输出全等，fixtures 逐字取自主仓 D1 测试件
 * tests/test_oss_feedback_routes.py::_RESIDUE_FIXTURES（7 条文本）＋结构化补充面。
 *
 * 两段判据：
 *   1) 恒跑段：本仓 detectResidue 输出 == D1 夹具期望值（公开仓 CI 无主仓也跑）；
 *   2) parity 段（开发期机闸）：服务端正本（Python app/oss_feedback_routes.py::
 *      detect_residue）经 python 子进程同 fixtures 对拍；服务端缺席或 python/fastapi
 *      不可用时 parity 段打 SKIP 整体跳过（照 test_parity_project.mjs 先例：
 *      公开仓 CI 不依赖主仓在场；NW_OSS_FEEDBACK_SERVER_ROOT 可覆盖主仓路径）。
 *
 * 运行：node tests/test_pii_parity.mjs（零依赖，不引测试框架）
 */
import { detectResidue } from '../core/js/feedback.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// fixtures：逐字取自主仓 D1 测试件 _RESIDUE_FIXTURES（2026-11-05 版）
// ---------------------------------------------------------------------------
const TEXT_FIXTURES = [
  ['回拨 13812345678 确认', ['phone']],
  ['发到 someone@example.com', ['email']],
  ['13812345678 与 a@b.co 都有', ['phone', 'email']],
  ['12345678901 不是手机号（1[0-2] 段不命中）', []],
  ['138123456789 连写 12 位不命中（边界断言）', []],
  ['客户 <PHONE_1> 的 <EMAIL_1> 已槽位化', []],
  ['正常中文样例，无联系方式', []],
];
// 结构化补充面（递归扫 object/array；SDK 与服务端同为递归实现）
const STRUCT_FIXTURES = [
  [{ a: ['回拨 13812345678 确认'], b: { c: '发到 someone@example.com' } }, ['phone', 'email']],
  [[{ samples: [{ reason: 'E-203', sample: '正常中文样例，无联系方式' }] }], []],
];

let pass = 0;
const failures = [];
const ok = (cond, msg) => { if (cond) pass += 1; else failures.push(msg); };
const eq = (a, b, msg) => ok(
  JSON.stringify(a) === JSON.stringify(b),
  msg + `（实际=${JSON.stringify(a)} 期望=${JSON.stringify(b)}）`);

// ---------------------------------------------------------------------------
// 恒跑段：SDK vs D1 canonical fixtures
// ---------------------------------------------------------------------------
for (const [text, expected] of TEXT_FIXTURES) {
  eq(detectResidue(text), expected, `SDK 漂移（D1 夹具）：${text}`);
}
for (const [node, expected] of STRUCT_FIXTURES) {
  eq(detectResidue(node), expected, `SDK 漂移（结构化夹具）：${JSON.stringify(node)}`);
}

// ---------------------------------------------------------------------------
// parity 段：SDK vs 服务端正本（同 fixtures 全等；python 子进程实调）
// ---------------------------------------------------------------------------
const SERVER_ROOT = process.env.NW_OSS_FEEDBACK_SERVER_ROOT || 'C:\\yice\\negotiation-workbench';
const SERVER_MODULE = path.join(SERVER_ROOT, 'app', 'oss_feedback_routes.py');

const PY_SCRIPT = [
  'import importlib.util, json, sys',
  'spec = importlib.util.spec_from_file_location("_ofr_g2", sys.argv[1])',
  'mod = importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(mod)',
  'inputs = json.loads(open(sys.argv[2], encoding="utf-8").read())',
  'print(json.dumps([mod.detect_residue(x) for x in inputs], ensure_ascii=False))',
].join('\n');

function serverParity() {
  if (!fs.existsSync(SERVER_MODULE)) {
    console.log('SKIP 服务端正本不可达（parity 段跳过；设 NW_OSS_FEEDBACK_SERVER_ROOT 指向主仓后启用）：' + SERVER_MODULE);
    return;
  }
  const candidates = [
    process.env.NW_OSS_FEEDBACK_SERVER_PY,
    'C:/nw_venv/Scripts/python.exe',
    'python',
    'python3',
  ].filter(Boolean);
  const allInputs = TEXT_FIXTURES.map(([t]) => t).concat(STRUCT_FIXTURES.map(([n]) => n));
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'g2_parity_'));
  const scriptPath = path.join(tmpdir, '_g2_server_detect.py');
  const inputsPath = path.join(tmpdir, '_g2_inputs.json');
  let parsed = null;
  try {
    fs.writeFileSync(scriptPath, PY_SCRIPT, 'utf8');
    fs.writeFileSync(inputsPath, JSON.stringify(allInputs), 'utf8');
    let ran = false;
    for (const py of candidates) {
      const proc = spawnSync(py, ['-I', scriptPath, SERVER_MODULE, inputsPath],
        { encoding: 'utf8', timeout: 60000 });
      if (proc.error || proc.status !== 0 || !proc.stdout) {
        if (proc.error && proc.error.code === 'ENOENT') continue;   // 该 python 不存在
        if (!ran && proc.error) continue;
        ran = true;
        const err = String(proc.stderr || proc.error || '');
        if (/ModuleNotFoundError|No module named/.test(err)) {
          console.log('SKIP 服务端环境缺依赖（fastapi 等），parity 段跳过：' + err.split('\n')[0]);
          return;
        }
        console.log('SKIP 服务端子进程执行失败，parity 段跳过：' + err.slice(0, 300));
        return;
      }
      ran = true;
      try {
        parsed = JSON.parse(proc.stdout.trim().split('\n').pop());
      } catch (e) {
        console.log('SKIP 服务端输出不可解析，parity 段跳过：' + String(proc.stdout).slice(0, 200));
        return;
      }
      break;
    }
    if (!ran || !parsed) {
      console.log('SKIP 无可用 python，parity 段跳过');
      return;
    }
    // 全等对拍：server 输出 == SDK 输出 == D1 期望（逐 fixture）
    TEXT_FIXTURES.forEach(([text, expected], i) => {
      const gotServer = parsed[i];
      const gotSdk = detectResidue(text);
      ok(JSON.stringify(gotServer) === JSON.stringify(gotSdk) && JSON.stringify(gotSdk) === JSON.stringify(expected),
        `G2 parity 破损：${text} server=${JSON.stringify(gotServer)} sdk=${JSON.stringify(gotSdk)} 期望=${JSON.stringify(expected)}`);
    });
    const structBase = TEXT_FIXTURES.length;
    STRUCT_FIXTURES.forEach(([node, expected], i) => {
      const gotServer = parsed[structBase + i];
      const gotSdk = detectResidue(node);
      ok(JSON.stringify(gotServer) === JSON.stringify(gotSdk) && JSON.stringify(gotSdk) === JSON.stringify(expected),
        `G2 parity 破损（结构化 #${i}）：server=${JSON.stringify(gotServer)} sdk=${JSON.stringify(gotSdk)}`);
    });
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
}
serverParity();

// ---------------------------------------------------------------------------
// 汇总（仓内测试件统一口径）
// ---------------------------------------------------------------------------
console.log(`通过 ${pass} 断言，失败 ${failures.length}`);
if (failures.length) {
  for (const f of failures) console.error('FAIL ' + f);
  process.exit(1);
}
