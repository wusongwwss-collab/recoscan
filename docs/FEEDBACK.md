# 反馈与隐私（Feedback & Privacy）

RecoScan 内置**匿名改进反馈**。本页说明它上行什么、到哪去、如何开关与删除。
对外承诺与总规范：默认关闭 · 自愿 · 可看可关可删 · 载荷白名单 · 不关联账号。

## 默认关闭，命令即同意

反馈**默认关闭**。开启方式（开启动作即你的明确同意）：

```bash
node hosts/cli/feedback_cli.mjs on          # 默认 L1 档
node hosts/cli/feedback_cli.mjs on --level L2
```

随时关闭（关闭后 90 天内不再询问）：

```bash
node hosts/cli/feedback_cli.mjs off
```

## 上行什么（三档）

| 档 | 上行内容 | 一句话解释 |
| --- | --- | --- |
| L1 | 你的结果点选（采纳 adopted / 否决 rejected / 改判 revised）+ 事件类型 + 时间戳 + 包版本 | 「你的评价」 |
| L2 | L1 + 规则/参数调整方向（改前值→改后值）、匿名功能使用计数 | 「大家用出来的改法方向」 |
| L3 | L2 + 出错时的脱敏故障样例（本机槽位化通过后才可发） | 「出错时的匿名故障单」 |

**永不上行（任何档）**：项目资料内容与文件名、目录路径原文、台账原文、账号/邮箱/
设备号、IP——反馈无法也无意关联到个人。

## 流程：先看后发

```bash
node hosts/cli/feedback_cli.mjs show        # 逐条查看待上行记录（含最终脱敏形态）
node hosts/cli/feedback_cli.mjs send        # 打印将上行的最终形态，确认后发送
node hosts/cli/feedback_cli.mjs send --yes  # 跳过确认（脚本/非交互环境必须 --yes）
node hosts/cli/feedback_cli.mjs clear       # 清空本地流水（不联网）
```

发送成功会打印**回执码**（本地 `state.json` 同时留存一份）：凭回执码可在 **30 天内**
到 https://www.easurwork.cn/open-source/feedback 申请删除对应数据。

## 到哪去、存多久

- 端点：`POST https://www.easurwork.cn/api/oss-feedback/v1`（签名传输；单次 ≤20 条）。
  内测/E2E 可用环境变量 `NW_OSS_FEEDBACK_ENDPOINT` 覆盖指向 dev 实例，避免写入生产库。
- 原始数据服务端保留 **90 天**后自动删除；聚合统计（≥3 个独立来源才进人工审核）永久。
- 反馈与 Easur Work 账号体系无关——服务端独立库存储，无法也无意关联到个人。

## 本地文件与清除

- 反馈流水：`.recoscan/feedback.jsonl`（相对工作目录；环境变量
  `RECOSCAN_FEEDBACK_DIR` 可覆盖位置）。
- 同意位/游标/回执：`.recoscan/state.json`。
- 回到初态：`feedback clear` + 删除 `.recoscan/` 目录即可，本软件不写系统目录、
  不留注册表项。

## 双用途声明

你贡献的规则/模板改进与反馈衍生的聚合改进，经人工审核后，可同时用于本开源项目的
默认规则包与 Easur Work 商业产品；审核采用「≥3 个独立来源聚合 → 人工裁决」，采纳
情况按季度公示。全文见 [CONTRIBUTING.md](CONTRIBUTING.md)。
