# 项目体检（recoscan）· 宿主无关用法说明书

> 本文件写给「任何支持 MCP 的宿主 / 代理」看：无论你运行在哪种宿主环境里，
> 按本说明即可接入 recoscan 的项目体检规则包并正确使用其工具面。

## 是什么

recoscan（中文显示名「项目体检」）是**本地纯函数体检引擎 + 项目体检规则包**：

- **项目体检**（项目体检包）：对项目台账（CSV / Markdown 表，字段：项目名 /
  状态 / 截止 / 依赖 / 证据）做体检，产出带证据引用的体检卡（风险 / 证据行 /
  下一步）与建议计划。

特性：零第三方依赖、零模型调用、零联网、零账号——指标权重、风险阈值与
护栏参数全部以本地 YAML 描述（示例权重即引擎默认口径）；诊断（体检）与
处方（推荐）分开，无证据不出结论、不出建议。

## 工具面

| 工具 | 作用 |
| --- | --- |
| `check.analyze` | 输入台账内容，返回体检卡：每条风险结论都带指向台账行的证据引用 |
| `plan.suggest` | 按体检卡给出「下一步 + 建议计划」，每条建议必须挂证据行，无证据不出建议 |
| `rules.validate` | 校验规则包结构是否合法（含 `yishu.discovery/v1` 推荐规则载荷的两级校验），建议每次改规则后先跑它 |

## 在支持 MCP 的宿主中配置

服务器是 **stdio 形态**：宿主负责拉起进程、通过标准输入输出通信、
退出时回收。命令行形态：

```bash
# 项目体检（Node.js 18+，无需安装任何依赖）
node <recoscan 仓库路径>/hosts/mcp/project_server.mjs
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

配置保存后**重启宿主**，在工具列表里确认 `check.analyze` / `plan.suggest` /
`rules.validate` 可见——以宿主工具列表真实出现为准，配置文件保存成功不等于接入成功。

## 规则包放哪

- 项目体检规则：仓库内 `packs/project/rules.example.yaml`（指标权重 / 风险
  阈值 / 护栏上限 / 抽取参数，全字段中文注释；示例权重即引擎默认口径）；
- 反馈流水（如宿主侧启用反馈 SDK）落 `.quickcue/feedback.jsonl`（位置可用
  环境变量 `QUICKCUE_FEEDBACK_DIR` 覆盖）——删除该目录即可清除全部本地
  派生数据，本软件不写系统目录、不留注册表项。

改规则流程：把 `rules.example.yaml` 复制为 `rules.custom.yaml` 修改成自己的
口径 → 用 `rules.validate` 校验结构 → 回归测试双绿后交接线层加载
（详见 `packs/project/README.md` 的 70 / 80 分路径）。

## 反馈开关在哪

- **默认关闭**；首启只问一次（`should_ask_consent` 纯函数，询问 UI 归宿主），
  随时可关。
- 反馈记录先落本地（默认无上行、数据只留在本机）；任何档位都不含台账原文、
  人名、公司、金额——脱敏在上传前于本机完成。
- 「上行记录」随时可查，能看到到底上传了什么；关闭后已上行的匿名数据可申请删除。

## 常见问题

1. **需要联网或 API key 吗？** 不需要。体检全在本地完成，规则、权重、阈值
   都在仓内；断网环境可跑通全部演示。
2. **台账是什么格式？** JSON 数组或 CSV 文本，字段：`name` 项目名 / `status`
   状态 / `deadline` 截止日 / `depends` 前置依赖 / `evidence` 证据或说明；
   详见面板说明见 `packs/project/README.md`。
3. **改了规则没生效？** 规则包是声明式投影（把引擎判据逐字段摊开给人看），
   运行时计算在 `core/js/` 纯函数引擎上；自定义规则经 `rules.validate` 校验
   后由接线层加载，引擎与 MCP 服务器保持零依赖、不内置 YAML 解析器。
4. **体检结果太粗 / 误报？** 调 `packs/project/rules.example.yaml` 里的
   `risk_thresholds`（风险分界）、`attribution.stale_days` / `deadline_soon_days`
   （陈旧与临期信号窗口）、`guardrails`（大量台账时的护栏上限）。
5. **我的台账内容会被上传吗？** 默认完全不上传；即使宿主侧主动开启匿名反馈，
   上行的也只有脱敏后的结构与评价，原文、人名、公司、金额永不出本机。
