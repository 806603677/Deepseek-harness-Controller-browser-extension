# 示例：给自己的 DSH / Agent 工程接入网页流程记忆

这是可复制的**示范工程**，不是插件自动安装的 Skill，也不会改写当前 Clinflash 工程的 Memory。不同 DSH 版本/其他智能体的 Skill 发现目录可能不同：先确认该智能体的项目级指令文件、Skill 根目录、Memory 根目录、本地命令工具以及 Node.js 是否可用，再把本示例文件映射过去。这里采用 DSH 项目的一层结构 `.agents/skills/<skill-name>/SKILL.md`；不支持该结构的 Agent 需要按其本身文档调整，不能假定复制即自动加载。

## 第一次配置

1. 将 `examples/agent-workspace/` 复制到**自己的独立 Agent 项目目录**，不要复制到浏览器扩展 `extension/` 中，也不要连同原 Clinflash 项目的业务文件一起发布。
2. 把 `config.example.json` 复制为 `config.local.json`；填写本机 `controllerScript` 的绝对路径，以及本项目 `memoryRoot`、`skillsRoot`。按所用模型估计 `modelTokensPerSecond`，慢模型可设得更低；`maxSiteSkillTokens` 默认 300，是每个网站 Skill 的上限而非写作目标。
3. 运行 `node scripts/site-context.mjs check`。若本机 Agent 没有 Node 工具，则改写这层路由脚本或把规则放入其项目指令；不要凭空称已经接通。
4. 确认扩展在浏览器中已安装、网站已由用户授权。智能体用 `node <controllerScript> status`、`list` 检查链路；只对用户当前授权的网站接管标签。

## 每次换网页/任务

用当前网页的**来源+路径**执行 `node scripts/site-context.mjs enter 'https://example.org/catalog'`。不要传查询参数、令牌、账号或片段。工具只记录上次的站点/页面哈希到本地 `.state/`，不缓存网页内容；输出只包含当前站点/页面的 Memory 摘要路径和匹配的站点 Skill。`siteChanged`/`pageChanged` 时，不能沿用之前页面的字段和操作假设。模型同一对话里旧内容无法真正删除；严格隔离或高风险操作时，换一个新的 Agent 上下文并只载入新站点资料。

布局：

```text
<agent-project>/
  AGENTS.md
  config.local.json                       # 本机配置，不提交
  .state/active-site.json                 # 仅站点/页面哈希，不提交
  .agents/skills/site-workflow-router/SKILL.md
  .agents/skills/site-<site-key>/SKILL.md # 有用户同意且确实划算时才建立
  memory/sites/<site-key>/summary.md      # 一站一份简短入口图
  memory/sites/<site-key>/pages/<page-key>.md # 一页一份表单/入口图
```

`samples/site-skill/SKILL.md` 和 `samples/page-memory.md` 是**虚构测试页面**的格式示例，不在发现目录内，不得直接视为真实网站事实。一个站点的不同页面分开存 Memory，站点 Skill 只放稳定的路由、极简表单纲要和停止条件，不复制整张字段表。若已有 Memory，先读取对应页面的短摘要，再决定是否只需把关键字段位置压缩进现有站点 Skill。

## 何时提醒流程化

先用 `node <controllerScript> guide <tabId>` 获取**当前**页的表单与功能入口结构；结果不含字段值。仅在实际完成任务后，以可核实的历史记录填写一个 JSON 证据文件并运行 `node <controllerScript> advise <evidence.json> <tabId>`：

```json
{
  "kind": "task",
  "completedRuns": 2,
  "stableRuns": 2,
  "stepCount": 5,
  "estimatedSavedSeconds": 45,
  "proposedSkillTokens": 180,
  "modelTokensPerSecond": 25,
  "maxSkillTokens": 300,
  "authInterruptions": 0
}
```

“完成两次”指两次可验证的任务成功，不是打开两次网页、做了两次 `guide` 或一次失败重试。`advise` 可能返回 `compact_map_only`、`observe_more`、`split_at_auth`、`trim_or_memory_only` 或 `ask_user_before_skill`。只有最后一种才向用户提出**此网站、此流程**的具体征询；用户同意前不创建或更新站点 Skill。浏览器插件不会替 Agent 写 Memory/Skill，也不会自行判断“用户已同意”。

打开目录、搜索框、个人主页等 ≤3 步的常规导航一般只需要短 Memory 入口图。对已知路径，确认当前起点一次后用一批 `sequence` 到目标，再核对结果；不要每一步重复认证。登录、验证码、OCR/一次性码是明确停止边界，不能尝试规避或把其处理写成无用户参与的常规流程。

若写 Skill 后模型阅读成本接近省下的操作时间，就缩短或退回 Memory-only。候选 Skill 应优先削去字段清单、重复示例和过时路线；保留能改变决策的少数线索。所有记忆都要注明站点、页面、验证时间和易变条件，且不存密码、会话令牌、动态记录 ID 或实际表单值。
