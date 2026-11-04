---
name: recoscan
display_name: 项目体检台
display_name_en: RecoScan
description: 周会前先知道这个项目下周会在哪三件事上出事——台账喂进去，带证据引用的体检卡出来
description_zh: 五个纯函数指标（承诺兑现率、阻塞时长、依赖未闭合、决策未落任务、变更密度）对项目台账做体检，每条风险带证据行与下一步建议，诊断与处方分开，不做根因预测
description_en: Health-check your project ledger with five deterministic metrics before the weekly meeting, every finding carries evidence rows and a next step
category: 开发效率
version: 0.1.0
author: 弈枢AI Easur Work
---

# 项目体检台（RecoScan）

周会前把项目台账喂进来，先知道**下周会在哪三件事上出事**。

## 什么时候用 / 不用

- 用：手头有项目台账（JSON 或 CSV 文本均可，字段为项目名、状态、截止日、前置依赖、证据说明），想在周会/复盘前拿到一张**每条结论都带证据引用**的体检卡。
- 不用：没有台账数据、想要根因推断或风险预测（本工具刻意不做——只做「此刻数据能支撑的判断」）。

## 工具面（配合同名连接器 recoscan 使用）

| 工具 | 作用 |
| --- | --- |
| `check.analyze` | 输入台账，返回体检卡——每个项目「风险等级 + 归因理由 + 证据行 + 下一步建议」 |
| `plan.suggest` | 按状态/截止/依赖给排期建议（完成殿后、阻塞前置、临期优先），无证据不出建议 |
| `rules.validate` | 校验规则包 YAML 结构，改完规则先跑它 |

未安装连接器时，本技能仍可用于：理解指标口径、准备台账数据、解读体检卡与调整规则包参数。

## 台账输入格式

JSON 数组或 CSV 文本，字段——`name` 项目名 / `status` 状态 / `deadline` 截止日 / `depends` 前置依赖 / `evidence` 证据或说明。最小示例：

```text
灯塔项目,进行中,2026-11-30,围墙项目,与对方确认了交付窗口
围墙项目,阻塞中,2026-11-10,,等待采购合同盖章
```

## 五个指标（权重可调，默认 3/2/1/1/2）

承诺兑现率 / 阻塞时长 / 依赖未闭合 / 决策未落任务 / 变更密度。阈值与护栏参数全部在 `templates/rules.example.yaml`（全字段中文注释），示例权重即引擎默认口径。

## 边界与隐私

零联网、零第三方依赖（仅 Node.js 内置模块）、零账号；判定是纯函数——同一份台账任何机器跑出同一份输出。开源仓 github.com/wusongwwss-collab/recoscan（Apache-2.0）。
