# RecoScan · 项目体检台

> 周会前先知道：这个项目下周会在哪三件事上出事。

**状态：v0.1.0 设计已定稿，代码整理中** —— 本仓库先公开定位、许可与文档；代码整理完成后随首个发布推出。

## 它做什么

- 一键体检：五个纯函数指标（承诺兑现率 / 阻塞时长 / 依赖未闭合 / 决策未落任务 / 变更密度）
- 每条风险后跟一句「先做哪个」，诊断（体检）与处方（推荐）分开
- 结果是标准的 `findings.json`，可直接进 CI 或周报
- 不做根因推断、不做风险预测，只做「此刻数据能支撑的判断」

## 文档

完整介绍、快速开始、指标定义与 FAQ：

**https://www.easurwork.cn/open-source/recoscan/**

## 许可

Apache-2.0

---

## 快速开始（v0.1.0 已发布）

RecoScan 的体检面是纯函数引擎（`core/js/`，仅 Node.js 内置模块）：五指标计算、实体归因计分、断言/证据网投影全部本地完成，零联网、零第三方依赖，经 stdio MCP 服务器接入。

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

配置保存后**重启宿主**，在工具列表确认 `check.analyze` / `plan.suggest` / `rules.validate` 真实可见（以宿主工具列表为准）。

### 2. check.analyze / plan.suggest：诊断与处方分开

- `check.analyze`：输入项目台账（JSON / CSV 文本），返回体检卡——每个项目「风险等级 + 归因理由 + 证据行 + 下一步建议」，每条风险结论都带指向台账行的证据引用；五个纯函数指标（承诺兑现率 / 阻塞时长 / 依赖未闭合 / 决策未落任务 / 变更密度）权重可调。
- `plan.suggest`：按台账状态 / 截止 / 依赖给排期建议（完成殿后、阻塞前置、临期优先），每条建议必须挂证据行，无证据不出建议。
- `rules.validate`：校验规则包结构，建议每次改规则后先跑它。

### 3. 台账输入格式

JSON 数组或 CSV 文本，字段：`name` 项目名 / `status` 状态 / `deadline` 截止日 / `depends` 前置依赖 / `evidence` 证据或说明。构造两三行台账（如 `灯塔项目,进行中,2026-11-03,围墙项目,"与对方确认了交付窗口"`）直接喂给 `check.analyze`，即可看到第一张体检卡。

### 4. 规则包位置

体检规则包在 `packs/project/rules.example.yaml`（指标权重 3/2/1/1/2、风险阈值、护栏 300/450/600、抽取参数等，字段全中文注释；示例权重即引擎默认口径）。用法路径见 `packs/project/README.md` 与 `skills/SKILL.md`。
