# 更新日志（CHANGELOG）

本项目更新日志遵循「人读优先」格式，版本号遵循语义化版本（SemVer）。

## v0.1.0（2026-10-31）· 首发版本

### 首发

- **项目体检规则包（项目体检）**：项目台账（CSV / Markdown 表）→ 带证据引用的
  体检卡（风险 / 证据行 / 下一步 / 建议计划），指标权重与风险阈值在
  `packs/project/rules.example.yaml` 全部可改（全字段中文注释，示例权重即
  引擎默认口径）。
- **纯函数体检引擎**：`core/js/project-ontology.js`（五要素抽取 + 归因计分 +
  断言/证据网投影，护栏截断明示）与 `core/js/reco-engine.js`（推荐规则引擎：
  `normalizeRulePackage` 两级校验 / `compareSemver` / 注入时钟求值），仅
  Node.js 内置模块，零第三方依赖、零联网。
- **MCP stdio 服务器**：项目体检（`hosts/mcp/project_server.mjs`，Node.js
  stdio）MCP 服务器，可挂进任何支持 MCP 的宿主（Claude Desktop、VS Code 等），
  工具面：`check.analyze` / `plan.suggest` / `rules.validate`。
- **诊断与处方分开**：`check.analyze` 只给「此刻数据能支撑的判断」（每条风险
  结论带证据引用）；`plan.suggest` 给「先做哪个」（每条建议必须挂证据行，
  无证据不出建议）；不做根因推断、不做风险预测。
- **反馈 SDK（默认关闭）**：三档匿名反馈（卡片评价 / 加规则改动结构 /
  加脱敏失败样例），默认关闭、首启仅询问一次、随时可关、本地脱敏后上行、
  可查看上行记录；不开反馈也照常能用全部功能。

### 说明

- 自下一版本起，本日志将新增「含社区 N 条改进」字段，逐版记录社区规则改动
  经云端聚合回灌默认规则包的情况（首发版本为初始基线，无回灌记录）。
