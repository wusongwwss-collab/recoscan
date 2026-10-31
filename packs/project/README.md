# packs/project · 项目体检规则包

一包两件：

| 文件 | 作用 |
| --- | --- |
| `rules.example.yaml` | 体检规则示例（指标权重 3/2/1/1/2、风险阈值、护栏 300/450/600、抽取参数等，字段全中文注释） |
| `README.md` | 本文件：包说明与 70/80 分使用路径 |

规则包是**声明式投影**：它把引擎加载阶段的内置判据逐字段摊开给人看，本身不参与运行时计算。
真正的计算在 `core/js/project-ontology.js`（五要素抽取 + 归因计分 + 断言/证据网投影），
工具面入口在 `hosts/mcp/project_server.mjs`（stdio MCP：`check.analyze` / `plan.suggest` / `rules.validate`）。

## 引擎五接（规则包字段 ↔ 引擎判据）

1. **指标权重** `metrics` → `scoreProjects` 五因子：实体名完全命中 +3／别名命中 +2／会议实体别名对应项目实体名 +1／术语重合 +1／公司名入历史标题 +2。
2. **风险阈值** `risk_thresholds` → 体检卡风险分级（高/中/低 + 逾期直判）。
3. **护栏上限** `guardrails` → `entityFileGraph` 三上限：实体节点 300／断言边 450／实体-文件边 600，超限截断并明示 `truncated`。
4. **抽取参数** `extraction` → `extract` 纯函数参数（出处 ±22 字、主语窗口 14 字、宾语 40 字、术语 4-8 字词频 ≥2 等）。
5. **归因策略** `attribution` → 体检卡证据行/建议装配口径（理由 3 条封顶、证据行上限、陈旧/临期信号）。

## 70 分路径：零配置开箱（约 10 分钟）

1. 把你的项目台账导出成 JSON 数组或 CSV 文本（字段：`name` 项目名／`status` 状态／`deadline` 截止日／`depends` 前置依赖／`evidence` 证据或说明）。
2. 在任意支持 stdio MCP 的客户端里挂上 `hosts/mcp/project_server.mjs`，调用 `check.analyze`（台账文本作入参）。
3. 拿到体检卡：每项目「风险等级 + 归因理由 + 证据行 + 下一步建议」，建议逐条带证据引用；`plan.suggest` 直接给排期建议。
4. `rules.example.yaml` 原样不动——示例权重即引擎默认口径。

适用判断：台账 ≤ 几百行、字段规整、只要「哪个项目危险、为什么、下一步干什么」。

## 80 分路径：自定义规则包（半天）

在 70 分路径基础上：

1. 复制 `rules.example.yaml` 为 `rules.custom.yaml`，按需改参——最常动的三处：
   - `risk_thresholds`：你的组织对「高/中风险」的分界与引擎归因分不同，先校这个；
   - `attribution.stale_days` / `deadline_soon_days`：陈旧与临期信号窗口对齐你的节奏；
   - `guardrails`：台账量大时提高三上限（引擎护栏上限同步改须走 `rules.validate` 复核）。
2. 用 MCP 工具 `rules.validate` 校验规则包结构（支持本包 schema 与 `yishu.discovery/v1` 推荐规则载荷两种面，后者走 `reco-engine.normalizeRulePackage` 两级校验）。
3. 回归：`node tests/test_parity_project.mjs`（与主实现逐字 parity 机闸）＋ `node tests/test_mcp_project.mjs`（MCP 真握手机闸）双绿再换参。
4. 校验通过后把 `rules.custom.yaml` 交给你的接线层加载（引擎加载阶段五接逐字段映射；接线层自备 YAML→JSON 解析，引擎与 MCP 服务器保持零依赖，不内置 YAML 解析器）。

## 反馈与隐私（默认关闭）

反馈 SDK（本仓含 Node 侧实现 `core/js/feedback.mjs`；Python 侧 `core/py/feedback.py`
接口同形）提供三档
匿名反馈，**默认关闭（L0）**：首启只问一次（包提供 `should_ask_consent(state)`
纯函数，询问 UI 归宿主），随时可关。

| 档位 | 上行内容 |
| --- | --- |
| L1 | 只回传结果卡点选：事件类型 + 结果卡点选值（对/不对/已处理）+ 卡类型 + 时间戳 + 包版本 |
| L2 | L1 + 规则 delta（规则 id、改前值→改后值；字段白名单，不含话术原文） |
| L3 | L2 + 本地脱敏后的失败样例 |

- **本地落盘**：反馈流水一律先落本地 `.quickcue/feedback.jsonl`（目录可用环境变量
  `QUICKCUE_FEEDBACK_DIR` 覆盖）；默认档 L0 时 `record` 直接丢弃（`dropped: true`）、
  不产生文件。
- **脱敏先行**：`sanitize` 在本机把手机号/金额/人名/公司名/邮箱槽位化为
  `<PHONE_N>`/`<AMOUNT_N>`/`<PERSON_N>`/`<ORG_N>`/`<EMAIL_N>`（同序号去重），
  原文永不出本地；`prepare_upload` 只做上行预检与脱敏、**不内置任何网络调用**
  （上行动作归宿主/云端侧），并对最终载荷做原文残留检测——含未槽位化手机号/邮箱
  即拒绝上行（`rejected: true` + reason）。
- **永不上行**：台账内容、项目名、公司、金额、人名等任何具体业务内容；
  体检包本身不产生反馈上行，接线层如复用反馈 SDK 须遵同一口径。

## 边界与免责

- 本包为**展示性示例**：所有阈值/权重是设计初值，不是实测标定；换参前先在小台账上对照人工判断。
- 引擎为纯函数层：不读文件、不联网、无第三方依赖；数据安全边界由调用方（MCP 宿主/接线层）负责。
- 合成与测试数据一律使用虚构名称，不得投喂真实客户名（测试机闸同口径）。
