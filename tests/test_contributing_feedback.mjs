/**
 * YQ-1154 T1 机闸 G5：CONTRIBUTING 双用途声明存在性（规范 §2 双用途/§8 G5）
 * -------------------------------------------------------------------
 * 判据（任务书 T1 · G5）：CONTRIBUTING.md 含「数据回流与贡献双用途」章节＋隐私页链接，
 * 缺即红（内容由总控预写、随 D4 批入库，本闸只验证存在性与要素齐全）：
 *   1) 章节标题「数据回流与贡献双用途」；
 *   2) 隐私说明页链接 https://www.easurwork.cn/open-source/feedback；
 *   3) 「双用途声明」正文（开源默认包 + Easur Work 商业产品明示）；
 *   4) 铁律②「默认关闭」表述。
 * 运行：node tests/test_contributing_feedback.mjs（零依赖，不引测试框架）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRIBUTING = path.join(HERE, '..', 'CONTRIBUTING.md');

let pass = 0;
const failures = [];
const ok = (cond, msg) => { if (cond) pass += 1; else failures.push(msg); };

let text = '';
try {
  text = fs.readFileSync(CONTRIBUTING, 'utf8');
} catch (e) {
  failures.push('CONTRIBUTING.md 缺失不可读：' + CONTRIBUTING);
}

ok(text.includes('## 数据回流与贡献双用途'), '缺「数据回流与贡献双用途」章节标题');
ok(text.includes('https://www.easurwork.cn/open-source/feedback'), '缺隐私说明页链接');
ok(text.includes('双用途声明'), '缺双用途声明正文');
ok(text.includes('Easur Work 商业产品'), '缺「可同时用于商业产品」明示');
ok(text.includes('默认关闭'), '缺「默认关闭」铁律②表述');

console.log(`通过 ${pass} 断言，失败 ${failures.length}`);
if (failures.length) {
  for (const f of failures) console.error('FAIL ' + f);
  process.exit(1);
}
