<div align="center">

# Agent Community —— DeepSeek Harness 的持久化 Bot

**在 DSH 里常驻的 Bot、群聊房间，以及一份不会丢的运行记录。**

[English](README.md) · [设计说明](DESIGN.md) · [MIT](LICENSE)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.2-2563eb.svg)](#环境要求)
[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-0f766e.svg)](https://github.com/topics/dsh-plugin)

</div>

> 本插件由社区维护，不是 DeepSeek 官方产品。

这里的 Bot 不是一次性的子代理：它有身份、有自己的模型与权限预设、有自己的工作区，以及一个**重启后仍在**的会话。
把几个 Bot 放进同一个房间，它们会一起回应。每一次回答都有运行记录，所以即使产出它的会话已经不在，对话仍可回看。

<p align="center"><img src="packages/bundle/agent-collaboration/screenshots/02-group-conversation.png" alt="三个 Bot 在同一个群里各自回答一条消息，各自署名" width="100%"></p>

## 功能

- **Bot 是常驻的。** 名字、模型、权限预设、工作区都落在磁盘上，面板里一直列着，重启前后都能在所属房间里回答。
- **单聊与群聊。** 房间就是成员列表。点名某个 Bot 的消息只路由给它；不点名的消息由**每个成员各自回答**——因为一句问候是说给整个房间的。
- **运行可排队、可租约、可恢复。** 每次回答是一个带租约与心跳的 run。运行时进程死掉的 run 会被回收而不是把房间卡住，房间在你去做别的事时照常工作。
- **转录是持久的。** 面板画的是运行过程中写下的 ledger（消息、工具调用与结果、审批、错误），不是会话日志。被压缩掉的旧历史会换成一条摘要，而不是悄悄消失。
- **15 个模型可调用工具**，Bot 因此可以建房间、把活交给另一个 Bot、把需求拆成任务并回报：
  `agent_community_create_bot`、`agent_community_update_bot`、`agent_community_list_bots`、
  `agent_community_create_room`、`agent_community_send_message`、`agent_community_list_runs`、
  `agent_community_get_context`、`agent_community_post_message`、`agent_community_task_decompose`、
  `agent_community_task_assign`、`agent_community_task_status`、`agent_community_task_report`、
  `agent_community_submit_final`、`agent_community_remember`、`agent_community_deliver`。
- **模型全部来自 DSH 设置。** Bot 设置与输入框的模型菜单都读取部署实时的模型目录——全部提供方、全部模型、
  它们在设置里的显示名与思考档位。没有任何厂商/模型名被写死；在设置里新增或改名的提供方无需重启即可出现。
- **Bot 交付的文件有卡片。** Bot 用 `agent_community_deliver` 声明它产出的文件；该回合回复下方会出现文件卡片——
  在面板里预览、用本机关联应用打开、在 Finder 中定位。文件可以在 Bot 工作区里，也可以是任意绝对路径。
- **面板内是真查看器，不是浏览器默认打开。** 点卡片打开右侧预览栏：**PDF** 用内置 PDF.js 自绘（翻页、缩放、
  适应宽度），**`.docx`** 用 docx-preview 直接渲染（分页、正文可选中、适应宽度），**`.xlsx`/`.csv`** 用
  SheetJS（多工作表标签、冻结表头、虚拟滚动）。PowerPoint 与旧版 `.doc`/`.xls` 先由宿主转成 PDF，再进同一个
  PDF 查看器。三个查看器都打包进插件的单文件浏览器产物（3.3 MB，gzip 后约 0.9 MB），面板不会联网取查看器。
  许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- **附件。** 消息可以带文件与图片，存放在接收方 Bot 自己的工作区里，并附到模型看到的内容上；气泡里显示的仍然是你原样输入的东西。
- **可手动触发的压缩。** `/compact` 用该房间自己的 Bot 模型把较早的对话总结成摘要，原样保留最近几条，并**退掉承载旧历史的会话**——所以下一次回答是从摘要继续，而不是把整份记录重放一遍。
- **未读角标跟着你实际看到的内容走。** 已读水位记的是"读到什么时间"，而不是只记一个消息 id，因此被压缩过的房间仍然能告诉你哪些是新的。**屏幕上的房间即视为已读**——它一显示出来角标就清零，停留期间到达的回复也会立刻清零；只有 DSH 窗口在后台/最小化时到达的消息保持未读，所以你回来时看到的数字仍然是准的。角标按**未读回复条数**计数：每次 Bot 运行算 1 条（定时任务的多次运行分别计数），同一回合里同一 Bot 的附加消息不重复计数。

## 环境要求

| | |
| --- | --- |
| DeepSeek Harness | `0.2.1-rc.2`（构建与实测所用版本；插件不锁定 DSH 版本） |
| Node.js | `^22.19.0` 或 `>=24` |
| pnpm | `11.7.0`（从源码构建时需要） |

`@deepseek-ai/*` 这些包**没有**发布到公共 npm registry，因此本仓库单独 `pnpm install` 解析不到它们（属于预期）。
插件**刻意不锁定 DSH 版本**：所有 peer 范围都是 `*`，缺少宿主包时降级加载而不是让安装失败。这也是这个插件要装进
**由目标运行时提供这些包的 DSH profile** 的原因。

## 安装

```bash
dsh plugin --profile <你的profile> add dsh-plugin-agent-collaboration
```

包里已经带了三个**预构建**的包，本机不会编译任何东西。装完重启 DSH 并刷新页面，侧栏会出现 **Bots团队**。

### 改用 release tarball 安装

```bash
dsh plugin --profile <你的profile> add \
  https://github.com/Leo-sail/dsh-plugin-agent-collaboration/releases/download/v0.3.1/dsh-plugin-agent-collaboration-0.3.1.tgz
```

同一份产物，附在 release 上——不想经过 npm 就直接用它。

### 改用本地源码目录安装

```bash
dsh plugin --profile <你的profile> add "file:/path/to/this/repo/packages/bundle/agent-collaboration"
```

**`file:` 前缀不要去掉。** pnpm 会把裸绝对路径记成 `link:` 符号链接，于是 bundle 自己的 `file:` 依赖一个都不会被安装：
profile 里只有 bundle、没有 `@dsh-plugin-agent-community/*` 那几行，结果每一行都 import 失败。DSH 自带的插件管理器同样如此，它会把绝对路径原样透传。

确认安装结果——三行都必须是**真实目录**而不是符号链接：

```bash
ls -ld ~/.dsh/profiles/<你的profile>/node_modules/@dsh-plugin-agent-community/*
```

### 让 Agent 帮你装

```text
> **注意**：仓库里的当前版本是 **0.3.1**，与下面的链接一致；改动见 [CHANGELOG.md](CHANGELOG.md)，
> 装好后的自测步骤见 [ACCEPTANCE.zh-CN.md](ACCEPTANCE.zh-CN.md)。

把 https://github.com/Leo-sail/dsh-plugin-agent-collaboration/releases/download/v0.3.1/dsh-plugin-agent-collaboration-0.3.1.tgz
装进目标 DSH profile，重启 DSH，并确认侧栏出现「Bots团队」。
```

## 使用

| 想做什么 | 怎么做 |
| --- | --- |
| 新建 Bot | 打开 **Bots团队** → **＋** → 填名字、模型、权限、工作区。立刻创建并出现在列表里。 |
| 和单个 Bot 对话 | 在 **Bots** 标签里选中它（单聊房间），然后发消息。 |
| 建群聊 | **群聊** 标签里的 **＋**，勾选成员。 |
| 只叫群里某一个人 | 输入 `@` 从菜单里选；或直接在文字里写它的名字。只有它会被排队。 |
| 说给整个房间 | 发一条不点名的消息，所有成员都会回答。 |
| 加文件或图片 | **＋** → **文件**，或直接粘贴/拖到输入框。 |
| 给某个房间换模型 | **＋** → **模型**。影响下一次运行，不影响正在跑的那一次。 |
| 改 Bot 的权限预设 | **＋** → **权限**：仅可查看 / 工作区内修改 / 完全权限。 |
| 压缩很长的房间 | **＋** → **压缩**。会出现一条摘要行，并保留最近几条。 |
| 停止运行 | 标题栏的 **停止** 会取消该房间正在跑的 run。 |
| 看更早的内容 | 往上滚，转录区会分页加载更早的记录。 |
| 清空房间 | 房间标题栏的 **清空消息**。 |

过程是可见的：排队的 run 显示 **排队**，运行中的显示 **进行中** 并带实时耗时，失败的显示为**红色行并写明 provider 的错误**，
而不是悄悄把更早的一条回答当成新回答发出来。

## 配置

所有配置项都是可选的，写在 profile 的 `cordis.patch.yml` 里 bundle 那一行的 `config` 下。

| 键 | 默认值 | 作用 |
| --- | --- | --- |
| `maxBots` | `32` | 允许存在的 Bot 数 |
| `maxRooms` | `64` | 允许存在的房间数 |
| `maxMessages` | `10000` | 保留的消息数，超出后淘汰最旧的 |
| `maxRuns` | `1000` | 保留的运行记录数 |
| `maxConcurrentRuns` | `8` | **全局**同时在回答的 Bot 数（不是每房间） |
| `runTimeoutMs` | `600000` | 超过此时长的 run 判定为失败 |
| `runLeaseMs` | `60000` | 没有心跳时，run 租约的有效时长 |
| `historyMessagesInPrompt` | `10` | 每次回答附带的历史消息条数 |
| `a2aMinIntervalMs` | `3000` | Bot 之间消息的最小间隔 |
| `groupProposalTimeoutMs` | `120000` | 建群提议等待回答的时长 |
| `idleLimit` | `12` | 最多保留多少个活跃 Bot 会话，超出后淘汰最久未用的——淘汰正是释放其会话写租约的时机 |
| `hardLimit` | `24` | 活跃 Bot 会话的硬上限 |
| `botReasoningEffort` | `max` | Bot 回合的推理强度：`off` `low` `high` `max`，或 `''` 交给 provider 默认值。单个 Bot 可覆盖 |
| `botAgentPreset` | `standard` | 传给每个 Bot 会话的 agent preset |
| `botDeniedTools` | `plugin_manager`、`ask_user_question`、`skill` | Bot 永远看不到的工具 |
| `homeDir` | `$DSH_HOME`，否则 `~/.dsh` | 看板存放位置 |
| `sessionsDir` | `<homeDir>/sessions` | Bot 会话日志的写入位置 |

`maxConcurrentRuns` 是**全局**的，不是每房间的。设成 `2` 时，四个 Bot 的群只有两个能回答，其余两个卡在 **排队** 后面——
这正好和"建群就是为了让成员同时干活"相反。需要更多并发就调大它。

## 数据放在哪

```
$DSH_HOME/agent-community/state.json        看板：Bot、房间、消息、运行、已读水位
$DSH_HOME/agent-community/workspaces/<bot>  每个 Bot 的工作区，附件也在里面
```

`$DSH_HOME` 默认是 `~/.dsh`。删掉这个目录就等于把插件恢复成全新安装；数据不存放在别处。

## 与 DSH 内置 Agent Teams 的关系

本仓库只发布 **Community** 这一半。DSH 内置的 Agent Teams bundle 负责队友、共享任务板与点对点消息，
所以本 bundle 只挂载**内置版没有对应物**的部分。两者可以并存，不需要关掉任何一个。

仓库里曾经有一个未挂载、也无法构建的 `@dsh-plugin-agent-community/agent-team` 分支（连同它的 `tool-`、`ui-` 包），已删除。

## 截图

群里一条消息，三个 Bot 各自回答、各自署名：

![三个 Bot 同时回答的群聊](packages/bundle/agent-collaboration/screenshots/02-group-conversation.png)

Bot 列表与房间列表，侧栏入口带未读数：

![Bot 列表与房间列表](packages/bundle/agent-collaboration/screenshots/01-bot-roster.png)

输入框的菜单——文件 / 压缩 / 权限 / 模型，下面是技能分组：

![输入框菜单](packages/bundle/agent-collaboration/screenshots/04-composer-menu.png)

这些截图声明在 [`screenshots.json`](packages/bundle/agent-collaboration/screenshots.json) 里——它放在
bundle 的 `package.json` 旁边，因为本插件以 monorepo 子包的形式收录，市场正是从这个位置读取它。
拍摄方式见 [screenshots/README.md](packages/bundle/agent-collaboration/screenshots/README.md)。

## 开发

```bash
pnpm install      # 按设计会失败：@deepseek-ai/* 不在公共 registry 上
pnpm typecheck    # 依赖可解析时，对所有包做真实 DSH 类型的类型检查
pnpm bundle       # 构建全部包并跑构建形状检查
```

> **浏览器产物依赖。** 面板内的三个查看器（PDF.js / docx-preview / SheetJS）在构建时被打进
> `ui-agent-community/lib/client.js`：DSH 的客户端模块系统每个插件只取一个脚本，不会去读兄弟资源，
> 所以不能把 worker 或查看器当作独立文件发布。这些库因此是 workspace 的 devDependencies（根
> `package.json`），安装一次即可构建；产物体积 3.3 MB（gzip 后约 0.9 MB），许可证见
> [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

`pnpm bundle` 会运行 [`scripts/check-build.mjs`](scripts/check-build.mjs)——里面每一条断言都对应本仓库**真实出过**的一个 bug
（裸 ESM 的客户端 bundle、`files` 漏掉自己的类型声明、过期的 `lib/`、指向不存在文件的 `exports`、重复的 CSS 选择器）。
装上一个坏掉的产物比拒绝安装更糟，所以 `scripts/install-profile.sh` 在拷贝任何东西之前会跑同一套检查。

要对着真实运行时开发，用 `scripts/install-profile.sh <profile>` 装进一个 profile，然后重启 DSH。

## 架构

```
packages/
  core/agent-community         服务：Bot、房间、运行、会话、ledger
                               AgentCommunityService（ctx.agentCommunity），持久化 state.json
  tools/tool-agent-community   15 个模型可调用工具（ctx.tools.register）
  ui/ui-agent-community        浏览器面板：侧栏入口、转录区、输入框、右侧预览栏与三个查看器
  bundle/agent-collaboration   可安装入口（cordis.patch.yml）
```

bundle 会挂载上面三个包；每个包也**可以单独安装**——`core/agent-community` 自带 `cordis.patch.yml` 与 `dsh.bundle`，
这正是无界面部署需要的形态。

界面相关决策见 [DESIGN.md](DESIGN.md)（DSH token 体系、DSH 客户端原语、用 `StateDot` 表示状态）。

## 许可证

[MIT](LICENSE)

浏览器产物内打包的第三方库（PDF.js、docx-preview、JSZip、SheetJS）另按各自许可证分发，见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
