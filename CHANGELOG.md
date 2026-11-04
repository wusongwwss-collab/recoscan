# 更新日志（CHANGELOG）

本项目更新日志遵循「人读优先」格式，版本号遵循语义化版本（SemVer）。

## v0.2.0（2026-11-05）· 项目计划台重定位

### 重定位

- **产品定位改为「项目计划台」**：基于项目资料自动分析，生成下一步工作计划及任务——
  把知识库/项目资料目录喂进去，每个项目「下一步做什么 + 3 条带依据的任务清单」直接出来。
  v0.1 的五指标台账体检（`check.analyze`）保留为计划面的**信号来源**之一。

### 新增

- **目录直读计划引擎**：`core/js/plan-engine.js`——目录直读（只读、不落盘、文件内容只
  抽样首 2KB）→ 按目录名/文件名前缀归项目 → 信号抽取（最近活跃/停滞天数、待办标记、
  版本残留按修改时间定新旧、文件名截止日期逾期与临期、跨项目引用）→ 输出计划卡
  （`easur.plan/card/v1`：健康摘要 + 下一步 3 条任务（动作+依据文件行+优先级）+ 风险提示）。
  纯函数核心与 IO 薄壳分离，零第三方依赖、零联网。
- **MCP 新工具 `plan.generate`**（`hosts/mcp/project_server.mjs`）：只读生成计划卡，
  可选参数 staleDays / deadlineSoonDays / maxFiles 等。
- **匿名反馈轻量 CLI**：`hosts/cli/feedback_cli.mjs`（仅 Node 内置模块）——
  `on/off/show/send/clear` 五子命令；同意位/游标/回执码落 `.recoscan/state.json`；
  发送前打印最终脱敏形态确认（非交互环境必须 `--yes`）；HMAC-SHA256 签名传输；
  422 逐条永久跳过、余量自动重试；429/5xx 指数退避 ≤3 次；端点可用环境变量
  `NW_OSS_FEEDBACK_ENDPOINT` 覆盖。反馈与隐私说明见 `docs/FEEDBACK.md`，
  CONTRIBUTING 新增「数据回流与贡献双用途」声明。

### 变更

- 反馈 SDK（`core/js/feedback.mjs`）完成 quickcue 拷改底本的命名残留清理：
  `SDK_SCHEMA` → `recoscan.feedback/v1`、落盘目录 → `.recoscan/`、环境变量新名
  `RECOSCAN_FEEDBACK_DIR`（旧名 `QUICKCUE_FEEDBACK_DIR` 保留兼容读取并提示迁移）；
  L1 结果点选值改为项目计划台口径 **adopted / rejected / revised**（采纳/否决/改判）。

### 说明

- 自本版本起，本日志逐版记录「含社区 N 条改进」的回灌情况（v0.2.0 暂无社区回灌记录）。

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
