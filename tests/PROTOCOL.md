# 测试协议卡（Protocol Cards）

评测/回归只有在「测试条件被写下来」时才可比较。模型相关（model-dependent）的测试尤其如此：
同一个问题，换模型、换提示词契约、换历史窗口，结果就会变。本文件定义一张协议卡的模板，
并给出两个示例。纯函数测试（`tests/*.test.ts` 里的多数文件）不需要协议卡——它们的输入输出
完全确定；**任何会调用模型、或依赖真实 DSH 宿主的测试/评测，都必须先写一张协议卡。**

## 模板（复制后填写）

```markdown
### <卡片编号> · <一句话名称>

- **model-dependent?** 是/否（是 → 模型、provider、reasoning effort、温度/采样；否 → 说明为何确定）
- **fixtures**：隔离的 state / 目录 / 房间 / bot 名单；是否使用真实用户数据（应为“否”）
- **窗口与预算**：historyMessages、memoryPromptEntries、runTimeoutPolicy（bootstrap/floor/cap）、
  runRetryPolicy（maxAttempts/backoffMs）、目标的授权轮次
- **权限**：bot permission（read-only / workspace-write / full-access）、工具允许/拒绝清单
- **失败判据**：什么算 pass、什么算 fail（按可观察事实写，如“只出现 1 条最终回复”）
- **重复次数**：跑几次、通过阈值（确定性测试写 1 次；模型相关写 N 次 + 通过率）
- **归因**：每次运行必须记录 `harnessRevision`、`promptContract`、`preset`、窗口预算
  （见 OP-01：`runs[].harness` 在 claim 时写入一次）
- **运行命令**：可直接复制执行的命令
```

## 示例 1 · PC-001 · 停止生成真正中断模型 turn（model-dependent? 否）

- **model-dependent?** 否。用假 runner/AbortSignal 断言“已中断的 signal 不会再 followup、
  不会进入 repair、返回 stopped”，不调用模型。
- **fixtures**：无状态依赖；`SessionRunner` 用测试注入的 accessor（Proxy 拒绝一切访问，
  证明中断发生在任何 agent/accessor 工作之前）。
- **窗口与预算**：N/A（本测试不涉及历史窗口/超时；超时策略另有 `run-budget.test.ts`）。
- **权限**：N/A。
- **失败判据**：`run()` 返回 `stopped: true` 且 `stopReason: 'aborted'`；accessor 未被调用；
  listener 在 turn 结束后被移除（迟到的 abort 不再回调）。
- **重复次数**：1 次（确定性）。并发/竞态类断言在同一文件内跑多轮。
- **归因**：不需要（不产生模型结果）；若在生产环境做同类验证，读取该 run 的
  `runs[].harness.harnessRevision` 确认版本。
- **运行命令**：`node --test tests/session-runner-abort.test.ts`

## 示例 2 · PC-010 · 群聊 leader 派工后只汇总一次（model-dependent? 是）

- **model-dependent?** 是。模型：部署默认 provider + bot 配置的 model，reasoning effort = bot
  设置（默认 `max`）；温度用宿主默认。换模型/effort 必须换一张卡。
- **fixtures**：隔离 `DSH_HOME`（`homeDir` 指向临时目录）+ 一个群（leader 1 个、成员 2 个）+
  一条用户任务；禁止指向真实 `~/.dsh/agent-community/state.json`。
- **窗口与预算**：`historyMessagesInPrompt=10`、`memoryPromptEntries=8`；`runTimeoutPolicy` 用默认
  （bootstrap 900s / floor 180s / cap 7200s）；`runRetryPolicy` 默认（3 次 / 5000ms 起步）；
  不使用目标自动续跑（不授权）。
- **权限**：bot `workspace-write`；工具按 bot preset 默认允许/拒绝清单（见 `DEFAULT_DENIED_TOOLS`）。
- **失败判据**：① 每个成员只回复一次；② leader 只发一条最终汇总（不得与 `finish_task` 报告重复）；
  ③ 群聊面板每条消息只有一个 runId；④ 全程无超时/无进展终止。任一违反即 fail。
- **重复次数**：10 次取通过率；<8/10 为 fail，并记录每次的耗时与 token 用量分布。
- **归因**：每次 run 读取 `runs[].harness`，确认 `harnessRevision='paper-batch8-2026-10-22'`、
  `promptContract=2`、`preset` 与窗口预算与本卡一致；不一致的运行不计入通过率。
- **运行命令**：在隔离实例中手动执行本卡流程，然后
  `node --test tests/group-task.test.ts`（确定性部分）+ 记录 10 次人工/脚本运行结果。

## 本仓库的协议卡清单

| 卡片 | 主题 | model-dependent? | 状态 |
|---|---|---|---|
| PC-001 | 停止生成真正中断模型 turn | 否 | 已实现（`session-runner-abort.test.ts`） |
| PC-010 | 群聊 leader 单次汇总 | 是 | 待跑（本批只出协议模板） |

> 注意：`tests/*.test.ts` 里除模型相关的手工/集成评测外，均按纯函数测试处理；新增模型相关
> 测试时，把卡片写进本文件并在测试文件头注释里引用卡片编号。
