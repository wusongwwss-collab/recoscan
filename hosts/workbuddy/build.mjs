// WorkBuddy 送审包构建器（零依赖，node 18+）
// 用法：node hosts/workbuddy/build.mjs
// 产物：dist/wb-skill/（技能包）与 dist/wb-connector/（连接器包）
// 纪律：本脚本只做「拷贝与组包」，不改动任何源文件；连跑两次产物逐字节一致（幂等）。
import { cpSync, rmSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const DIST = path.join(ROOT, 'dist');

function countFiles(dir) {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(path.join(dir, e.name));
    else n += 1;
  }
  return n;
}

// ---------- 技能包 dist/wb-skill ----------
const SKILL = path.join(DIST, 'wb-skill');
rmSync(SKILL, { recursive: true, force: true });
mkdirSync(path.join(SKILL, 'references'), { recursive: true });
mkdirSync(path.join(SKILL, 'templates'), { recursive: true });
cpSync(path.join(HERE, 'wb-skill', 'SKILL.md'), path.join(SKILL, 'SKILL.md'));
cpSync(path.join(ROOT, 'README.md'), path.join(SKILL, 'references', 'README.md'));
cpSync(path.join(ROOT, 'packs', 'project', 'rules.example.yaml'),
        path.join(SKILL, 'templates', 'rules.example.yaml'));
cpSync(path.join(ROOT, 'LICENSE'), path.join(SKILL, 'LICENSE'));

// ---------- 连接器包 dist/wb-connector ----------
const CONN = path.join(DIST, 'wb-connector');
rmSync(CONN, { recursive: true, force: true });
mkdirSync(CONN, { recursive: true });
cpSync(path.join(HERE, 'wb-connector', 'connector-meta.json'), path.join(CONN, 'connector-meta.json'));
cpSync(path.join(HERE, 'wb-connector', 'mcp.json'), path.join(CONN, 'mcp.json'));
cpSync(path.join(HERE, 'icon.svg'), path.join(CONN, 'icon.svg'));
// 服务器与内核：保持仓内相对结构原样拷贝（零源码改动即可运行）
mkdirSync(path.join(CONN, 'hosts', 'mcp'), { recursive: true });
cpSync(path.join(ROOT, 'hosts', 'mcp', 'project_server.mjs'),
        path.join(CONN, 'hosts', 'mcp', 'project_server.mjs'));
mkdirSync(path.join(CONN, 'core', 'js'), { recursive: true });
for (const f of ['reco-engine.js', 'project-ontology.js', 'plan-engine.js', 'feedback.mjs']) {
  cpSync(path.join(ROOT, 'core', 'js', f), path.join(CONN, 'core', 'js', f));
}
// 连接器包内附使用说明（YQ-1127 先例形态）与许可
mkdirSync(path.join(CONN, 'skills'), { recursive: true });
cpSync(path.join(HERE, 'wb-skill', 'SKILL.md'), path.join(CONN, 'skills', 'SKILL.md'));
cpSync(path.join(ROOT, 'LICENSE'), path.join(CONN, 'LICENSE'));

console.log(`[build] dist/wb-skill: ${countFiles(SKILL)} 件`);
console.log(`[build] dist/wb-connector: ${countFiles(CONN)} 件`);
console.log('[build] 完成——上传时把两个目录分别打成 zip');
