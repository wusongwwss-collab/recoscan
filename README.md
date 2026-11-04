# 项目计划台 RecoScan

> 基于项目资料自动分析，生成下一步工作计划及任务。
> 把知识库/项目资料目录喂进去，每个项目「下一步做什么 + 3 条带依据的任务清单」直接出来。

**v0.2.0**（2026-11-05）：新增目录直读计划引擎与匿名反馈 CLI；v0.1 的台账体检能力保留为「信号来源」之一。

## 它做什么

- **目录直读出计划**（`plan.generate`）：直接读取知识库/项目资料目录（只读，不落盘），按目录名/文件名前缀自动归项目，抽取信号——最近活跃度、停滞天数、待办标记（TODO/待办/未完/草案等文件名模式与文本抽样行）、版本残留（旧版/备份/vN 并存，按修改时间定新旧）、截止暗示（文件名日期）、依赖线索（引用兄弟项目名）——输出每个项目的**健康摘要 + 下一步 3 条任务（每条=动作+依据文件行+优先级）+ 风险提示**
- **台账体检**（`check.analyze`，v0.1 能力，现为信号来源）：有项目台账（JSON/CSV）时，五指标体检出「风险等级 + 归因理由 + 证据行 + 下一步建议」
- **排期建议**（`plan.suggest`）：按台账状态/截止/依赖给执行顺序
- 每条结论都带**依据引用**（文件行/台账行），无证据不出建议
- 不做根因推断、不做风险预测，只做「此刻资料能支撑的计划」

## 文档

完整介绍、快速开始与 FAQ：

**https://www.easurwork.cn/open-source/recoscan/**

## 许可

Apache-2.0

---

## 快速开始（v0.2.0）

计算面是纯函数引擎（`core/js/`，仅 Node.js 内置模块）：信号抽取、任务生成、体检计分全部本地完成，零联网、零第三方依赖；文件内容只抽样首 2KB，不读全文、不上传任何资料。

### 1. 挂进 MCP 宿主

服务器为 stdio 形态（Node.js 18+，无需 npm 安装任何依赖）：

```bash
node <仓库路径>/hosts/mcp/project_server.mjs
```

宿主配置段示例（JSON，路径替换为你本机的仓库路径）：

```json
{
  "mcpServers": {
    "recoscan-project": {
      "command": "node",
      "args": ["/你的路径/recoscan/hosts/mcp/project_server.mjs"]
    }
  }
}
```

配置保存后**重启宿主**，在工具列表确认 `plan.generate` / `check.analyze` / `plan.suggest` / `rules.validate` 真实可见（以宿主工具列表为准）。

### 2. plan.generate：资料喂进去，计划与任务出来

对 `plan.generate` 说一个目录路径（你的知识库/项目资料根目录），返回计划卡：

- 每个项目一条**健康摘要**（文件数/最近活跃/待办数/多版本/截止暗示）
- **下一步 3 条任务**：动作 + 依据文件（文本命中带行号与原文引用）+ 优先级（高/中/低，逾期与临期自动升「高」）
- **风险提示**：停滞、逾期截止、多版本并存、引用了不存在的兄弟项目、空目录

可选参数：`staleDays`（停滞阈值，默认 14 天）、`deadlineSoonDays`（临期窗口，默认 7 天）等，见工具 schema。

### 3. check.analyze / plan.suggest：台账体检（信号来源）

有台账时效果更好。`check.analyze` 输入项目台账（JSON / CSV 文本），返回体检卡；`plan.suggest` 给排期建议。台账字段：`name` 项目名 / `status` 状态 / `deadline` 截止日 / `depends` 前置依赖 / `evidence` 证据或说明。构造两三行台账直接喂入即可看到第一张体检卡。

### 4. 匿名反馈（默认关闭）

改进反馈默认关闭、完全自愿、可随时关、发送由你显式执行：

```bash
node hosts/cli/feedback_cli.mjs on     # 开启（命令即同意；默认 L1 档）
node hosts/cli/feedback_cli.mjs show   # 逐条查看待上行记录
node hosts/cli/feedback_cli.mjs send   # 打印最终脱敏形态，确认后发送（非交互需 --yes）
node hosts/cli/feedback_cli.mjs off    # 随时关
```

上行什么、存多久、如何凭回执码申请删除：见 [docs/FEEDBACK.md](docs/FEEDBACK.md)。不开反馈也照常能用全部功能。

### 5. 规则包位置

体检规则包在 `packs/project/rules.example.yaml`（指标权重 3/2/1/1/2、风险阈值、护栏 300/450/600、抽取参数等，字段全中文注释；示例权重即引擎默认口径）。用法路径见 `packs/project/README.md` 与 `skills/SKILL.md`。
