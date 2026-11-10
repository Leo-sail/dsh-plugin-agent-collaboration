# 0.5.0 验收记录（2026-11-10）

本版没有可提交进公开仓库的自动化测试目录（测试在开发期执行后移出公开发布集），因此这份文档记录本次发布的
**执行入口、真实机器验收矩阵与已知限制**。所有结果均来自 2026-11-10 的 macOS 真机运行。

## 构建与静态检查

```bash
pnpm install --no-frozen-lockfile   # 版本号变更后刷新 lockfile
pnpm typecheck                      # 0 错误
pnpm run build                      # bundle + check-build: OK
bash scripts/pack-release.sh        # dist/dsh-plugin-agent-collaboration-0.5.0.tgz
node scripts/verify-install.mjs     # 可选：检查一次已安装 profile 的目录形状
```

## 本机 Agent 验收矩阵

| 场景 | 做法 | 结果 |
| --- | --- | --- |
| Codex 基础回合 | headless profile，默认模型 `codex-cli/default` | 真实 Codex 回复，正常退出 |
| Codex 团队工具桥 | prompt 要求调用 `message_member` | `tool_call` → DSH 执行 → `tool_result` 回填 → Codex 回复工具结果 |
| ACP 协议（无真实 ACP CLI 的机器） | fake ACP agent fixture（initialize/session/prompt/permission/MCP tools/call） | 文本、团队工具、权限 deny/allow 全部通过 |
| Claude Code 协议 | fake stream-json fixture | 文本、`message_member` 桥、干净退出 |
| Claude Code 真实二进制 | SDK 二进制 + 用户已有的 cc-switch 中转环境（`claude-sonnet-4-6`） | headless 回复、团队工具回填；真实 Web 房间回复 |
| Claude 未登录 | 无凭据 | 运行失败行显示 `Not logged in · Please run /login`（不再空回合） |
| 发现与自定义 ACP | PATH / npm 全局 / app bundle / `extraSearchDirs`；面板增删改自定义 agent | 全部生效；未安装项显示「未安装」 |
| Bot 级模型 | 设置 provider/model 后发消息 | `request/header` 记录所选模型；ACP 侧 `session/set_config_option` |
| 自然语言切换模型 | `agent_switch_model` 工具 | 会话级生效，未知模型返回可用列表 |
| 权限映射 | workspace-write Bot 发消息 | local-agent 记录 `permission=workspace-write`，回合完成 |
| 审批 fail-closed | headless `--approval-policy never` | 决策 deny，桥接工具未执行 |
| 审批 allow | 测试 answerer 返回 `allowed-once` | 工具执行并回填 |
| UI：新建 Bot | 真实 Chrome + 隔离 web profile | 类型卡片、已安装 CLI 下拉、自定义 CLI 管理均可用 |
| UI：真实房间 | 创建本机 Codex Bot 并对话 | 真实回复（14s/15s/18s 多次） |
| 群聊 @all 去重 | 4 个真实 Codex bot（1 协调者 + 3 成员）发 `@所有人 你们好` | 每人恰好 1 条；无「已派工」；收口行「leader 已在本轮回答，不再额外汇总」 |
| 切换模型后恢复 | Bot 切回 `gpt-6-astra` 后 @gpt/@all | 自动退役旧 thread，新会话 model=`gpt-6-astra`，正常回复 |

## 已知限制

- **真实 ACP CLI**：验收机器上没有安装 Gemini CLI / Grok Build / OpenCode 等，ACP 驱动用 fixture 验证协议；
  安装真实 CLI 后无需改代码即可使用。
- **真实 Claude 登录**：验收机器没有 Claude 套餐；使用用户已有的 cc-switch 中转配置完成真实回合。
- **桌面 profile 加载**：host 插件在启动时装载，安装/升级后需要重启 DSH 一次。
- **发布**：`scripts/publish-release.sh` 需要 `npm login` 到 `registry.npmjs.org`（@dsh-plugin-agent-community
  scope）后才能推送；本仓库的 GitHub Release 由该脚本在发布后创建 tarball 附件。
