# Tests

Run with Node ≥22.6 (this repo is verified on Node 26, which strips TypeScript types
natively — no test framework or build step is needed):

```bash
npm test        # node --test tests/*.test.ts
node --test tests/prompt-contract.test.ts
```

The tests import source `.ts` modules directly. This is deliberate: the same code that runs in
the plugin/browser is the code under test, rather than a copy that can drift.

## 协议卡（Protocol Cards）

纯函数测试的输入输出是确定的，不需要协议卡。**任何会调用模型、或依赖真实 DSH 宿主的
测试/评测，先写一张协议卡**（模型/effort、fixtures、窗口与预算、权限、失败判据、重复
次数、归因字段、运行命令），否则两次结果不可比。模板与两个示例见
[`PROTOCOL.md`](./PROTOCOL.md)。

协议卡要求每次运行记录 harness 归因（OP-01）：`runs[].harness` 在 claim 时写入一次，
含 `pluginVersion / harnessRevision / promptContract / preset / historyMessages /
memoryPromptEntries`。

## 测试清单

| File | Covers |
|---|---|
| `prompt-contract.test.ts` | **OP-05** 每轮提示词的格式契约：段序 `role/skills/goal/memory/history/input`、`\n\n` 分隔、history 截断 header、input 恒在最后、空段跳过、键序无关，以及逐字节 golden。 |
| `harness-attribution.test.ts` | **OP-01** harness 归因：字段齐全/冻结/默认值、运行时读 package.json 版本、注入 loader 与 `unknown` 回退、promptContract 与契约版本一致、snapshot 保留归因且不泄漏 prompt。 |
| `snapshot-lite.test.ts` | 快照瘦身：消息/运行的白名单字段、文本截断、重字段不泄漏、序列化体积断言。 |
| `session-runner-abort.test.ts` | 停止/中断：已中断的 signal 不再 followup/repair，返回 `stopped`，listener 清理。 |
| `run-budget.test.ts` | 自适应超时（S8）：历史分位、clamp、无进展窗口、延长链、重试分类与退避、无硬编码 600000。 |
| `room-goal.test.ts` | 房间目标：提议/授权/预算/暂停/恢复的纯函数规则。 |
| `room-leader.test.ts` | 房间 leader 解析与候选排序。 |
| `group-task.test.ts` | 群任务 orchestration 的驱动规则（派工/汇报/收尾）。 |
| `publish-policy.test.ts` | 哪个 run 的回合可以出现在房间、一次投递只发一条消息。 |
| `ledger-window.test.ts` | 对话窗口：按 id/rev 合并、单 id 单行、回答行回填游标、无回答行的终态检测。 |
| `ledger-cursor.test.ts` | ledger 增量游标（changeSeq/sequence）与分页。 |
| `compact-fold.test.ts` | 压缩折叠：被摘要替换的消息 id 集合来自 split 段而非时间戳。 |
| `context-window.test.ts` | 提示词历史窗口的字节预算与“本轮输入不重复”规则。 |
| `memory-delta.test.ts` | 房间记忆的 baseline/delta 渲染（前缀缓存友好）。 |
| `capability-proposal.test.ts` | 能力提案（角色匹配/建群建议）的纯规则。 |
| `proposal-edit.test.ts` | 建群提议的编辑/确认状态机。 |
| `agent-tools.test.ts` | Agent 工具面（禁用/守卫/作用域）规则。 |
| `selection.test.ts` | 面板房间选择仲裁：轮询回答不能覆盖更新的用户点击。 |

## 本批（论文第一批：OP-01 + OP-05）

- **OP-05 提示词格式契约**：`packages/core/agent-community/src/prompt-contract.ts` —
  `PROMPT_CONTRACT_VERSION=1`、固定段序、`assemblePrompt` 纯函数；`runs.ts buildPrompt`
  改为填 `PromptSections` 再 `assemblePrompt`，输出字节不变（golden 锁定）。
- **OP-01 harness 归因**：`packages/core/agent-community/src/harness-attribution.ts` —
  `HARNESS_REVISION` + 运行时读 package.json 的 `readPluginVersion` + 冻结的
  `buildHarnessAttribution`；`index.ts claimRun` 每个真正启动的 run 记录一次
  `harness`；`snapshot-lite.ts` 的运行白名单保留该字段。
- **协议卡**：`tests/PROTOCOL.md`（模板 + PC-001/PC-010 两个示例）。
