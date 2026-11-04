---
name: recoscan
display_name: 项目计划台
display_name_en: RecoScan
description: 项目资料目录喂进去，每个项目下一步做什么+3 条带依据的任务清单出来——健康摘要、任务清单、风险提示一次给全
description_zh: 直接读取知识库/项目资料目录（只读），按目录名/文件名前缀自动归项目并抽取信号（最近活跃、停滞天数、待办标记、版本残留、文件名截止日期、跨项目引用），输出每个项目的健康摘要+下一步 3 条任务（动作+依据文件行+优先级）+风险提示；台账体检保留为信号来源；每条结论带依据引用，不做根因推断、不做风险预测
description_en: Point it at your project or knowledge-base folders and get a next-step work plan per project - a health summary, three evidence-backed tasks with priorities, and risk hints. Read-only directory scanning with filename and sampled-text signals; zero network, zero third-party dependencies.
category: 开发效率
version: 0.2.0
author: 弈枢AI Easur Work
---

# 项目计划台（RecoScan）

把**知识库/项目资料目录**喂进来，每个项目「下一步做什么」直接出来：健康摘要 + 3 条带依据的任务清单 + 风险提示。

## 什么时候用 / 不用

- 用：手头有一堆项目资料/知识库目录（Markdown、文档、表格……结构不限），想知道**每个项目现在该干什么**、哪些停滞了、哪些临近截止、哪些版本乱成一团。
- 也用：有项目台账（JSON/CSV）时，可叠加五指标体检（风险等级+证据行+下一步建议），体检面作为计划面的**信号来源**。
- 不用：想要根因推断或风险预测（本工具刻意不做——只做「此刻资料能支撑的计划」）。

## 工具面（配合同名连接器 recoscan 使用）

| 工具 | 作用 |
| --- | --- |
| `plan.generate` | **主入口**：输入资料目录路径（只读，不落盘），返回计划卡——每个项目「健康摘要 + 下一步 3 条任务（动作+依据文件行+优先级）+ 风险提示」 |
| `check.analyze` | 输入台账，返回体检卡——每个项目「风险等级 + 归因理由 + 证据行 + 下一步建议」 |
| `plan.suggest` | 按状态/截止/依赖给排期建议（完成殿后、阻塞前置、临期优先），无证据不出建议 |
| `rules.validate` | 校验规则包 YAML 结构，改完规则先跑它 |

未安装连接器时，本技能仍可用于：理解信号口径、准备资料目录或台账数据、解读计划卡与调整规则包参数。

## plan.generate 怎么用

对它说一个目录路径（知识库根目录/项目资料根目录），例如：

```text
请用 plan.generate 分析 D:\资料\产品知识库，给出每个项目下一步计划
```

返回的计划卡里，每条任务都带**依据**（哪个文件哪一行/哪个文件名信号），优先级 高/中/低——逾期与临期（默认 7 天窗口）自动升「高」，停滞（默认 14 天阈值）项目整体前置。可选参数：staleDays / deadlineSoonDays / maxFiles 等。

信号面全部可解释：最近活跃度与停滞天数（文件修改时间）、待办标记（TODO/待办/未完/草案等文件名模式+文本抽样行）、版本残留（旧版/备份/vN 并存，按修改时间定新旧）、截止暗示（文件名日期）、依赖线索（文件名或抽样文本引用兄弟项目名）。文件内容只抽样首 2KB，不读全文。

## 台账输入格式（check.analyze / plan.suggest）

JSON 数组或 CSV 文本，字段——`name` 项目名 / `status` 状态 / `deadline` 截止日 / `depends` 前置依赖 / `evidence` 证据或说明。最小示例：

```text
灯塔项目,进行中,2026-11-30,围墙项目,与对方确认了交付窗口
围墙项目,阻塞中,2026-11-10,,等待采购合同盖章
```

## 体检五指标（权重可调，默认 3/2/1/1/2）

承诺兑现率 / 阻塞时长 / 依赖未闭合 / 决策未落任务 / 变更密度。阈值与护栏参数全部在 `templates/rules.example.yaml`（全字段中文注释），示例权重即引擎默认口径。

## 边界与隐私

零联网、零第三方依赖（仅 Node.js 内置模块）、零账号；判定是纯函数——同一份资料任何机器跑出同一份输出；目录扫描只读、不落盘，文件内容不外传。开源仓 github.com/wusongwwss-collab/recoscan（Apache-2.0）。
