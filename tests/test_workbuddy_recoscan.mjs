/**
 * WorkBuddy 送审包机闸（YQ-1153）——源件格式 + 构建产物完整性 + 幂等
 * 运行：node tests/test_workbuddy_recoscan.mjs（零依赖）
 * 判据：
 *   1. wb-skill/SKILL.md YAML 头：七个必填字段齐全；每行「字段: 」冒号后恰一个空格；值不以引号包裹
 *   2. connector-meta.json：必填字段与 author 口径（弈枢AI Easur Work）；name 与 mcp.json 服务键一致
 *   3. mcp.json：mcpServers.recoscan 指向 ${CONNECTOR_DIR} 且被引文件在构建产物中真实存在
 *   4. build.mjs：产物清单完整（SKILL/模板/meta/mcp/icon/服务器/三内核/LICENSE/内附技能）且连跑两次逐字节一致（幂等）
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const WB = path.join(ROOT, 'hosts', 'workbuddy');
const DIST = path.join(ROOT, 'dist');
let failed = 0;
const ok = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) failed += 1; };

// 1) SKILL.md YAML 头
const skill = readFileSync(path.join(WB, 'wb-skill', 'SKILL.md'), 'utf8');
const head = skill.split('---')[1];
const fields = ['name', 'display_name', 'display_name_en', 'description', 'description_zh', 'description_en', 'category', 'version', 'author'];
for (const f of fields) {
  ok(`SKILL.md 含字段 ${f}`, new RegExp(`^${f}: .+`, 'm').test(head));
}
const headLines = head.split('\n').filter((l) => /^\S/.test(l));
ok('YAML 头冒号后恰一空格', headLines.every((l) => /^[\w_]+: /.test(l)));
ok('YAML 头值不加引号', headLines.every((l) => !/^[\w_]+: ["']/.test(l)));
ok('display_name 为项目体检（命名铁律）', /display_name: 项目体检/.test(head));
ok('author 口径＝弈枢AI Easur Work', /author: 弈枢AI Easur Work/.test(head));

// 2) connector-meta.json
const meta = JSON.parse(readFileSync(path.join(WB, 'wb-connector', 'connector-meta.json'), 'utf8'));
for (const f of ['name', 'display_name', 'display_name_en', 'description_zh', 'category', 'version', 'author', 'type']) {
  ok(`meta 含字段 ${f}`, Boolean(meta[f]));
}
ok('meta.author＝弈枢AI Easur Work', meta.author === '弈枢AI Easur Work');
ok('meta.type＝mcp', meta.type === 'mcp');
ok('meta.name＝recoscan', meta.name === 'recoscan');

// 3) mcp.json
const mcp = JSON.parse(readFileSync(path.join(WB, 'wb-connector', 'mcp.json'), 'utf8'));
ok('mcpServers 含 recoscan', Boolean(mcp.mcpServers && mcp.mcpServers.recoscan));
ok('mcpServers 键与 meta.name 一致', Object.keys(mcp.mcpServers).join(',') === meta.name);
ok('command＝node（零依赖形态）', mcp.mcpServers.recoscan.command === 'node');
ok('args 用 ${CONNECTOR_DIR} 占位', mcp.mcpServers.recoscan.args[0].includes('${CONNECTOR_DIR}'));

// 4) 构建产物完整 + 幂等
execFileSync('node', [path.join(WB, 'build.mjs')], { cwd: ROOT });
const mustExist = [
  ['wb-skill', 'SKILL.md'], ['wb-skill', 'references', 'README.md'], ['wb-skill', 'templates', 'rules.example.yaml'], ['wb-skill', 'LICENSE'],
  ['wb-connector', 'connector-meta.json'], ['wb-connector', 'mcp.json'], ['wb-connector', 'icon.svg'],
  ['wb-connector', 'hosts', 'mcp', 'project_server.mjs'],
  ['wb-connector', 'core', 'js', 'reco-engine.js'], ['wb-connector', 'core', 'js', 'project-ontology.js'], ['wb-connector', 'core', 'js', 'plan-engine.js'], ['wb-connector', 'core', 'js', 'feedback.mjs'],
  ['wb-connector', 'skills', 'SKILL.md'], ['wb-connector', 'LICENSE'],
];
for (const seg of mustExist) ok(`产物存在 ${path.join(...seg)}`, existsSync(path.join(DIST, ...seg)));

function hashTree(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(DIST, p) + ':' + createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16));
    }
  };
  walk(dir);
  return out.sort().join('|');
}
const h1 = hashTree(DIST);
execFileSync('node', [path.join(WB, 'build.mjs')], { cwd: ROOT });
ok('构建幂等（两次产物逐字节一致）', h1 === hashTree(DIST));

if (failed) { console.log(`共 ${failed} 项未过`); process.exit(1); }
console.log('PASS WorkBuddy 送审包机闸全部达标');
