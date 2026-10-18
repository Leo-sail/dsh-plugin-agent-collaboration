## 0.3.1 — 面板内自绘预览：PDF / Word / Excel

交付卡片点击后，面板右侧栏现在用**真正的查看器**打开文件，而不是浏览器内嵌查看器或「不支持内嵌」提示：
PDF 由 PDF.js 自绘（翻页 / 缩放 / 适应宽度），`.docx` 由 docx-preview 直接渲染（分页、正文可选中、适应宽度），
`.xlsx` / `.csv` 由 SheetJS 渲染成可滚动的表格（多工作表、冻结表头、行/列上限）。PowerPoint 与旧版
`.doc` / `.xls` 仍由宿主转成 PDF，再交给同一个 PDF 查看器。

### 新增
- **PDF 查看器（pdfjs-dist 6.3.289）。** canvas 自绘 + 工具栏（上一页/下一页、页码跳转输入、缩放 −/+/百分比、
  适应宽度）；DPR 正确的背板尺寸；每个预览独占自己的 module Worker / loading task，切标签或卸载即取消渲染并终止。
  PDF.js 的 worker 源码在构建期内联进客户端单文件产物，运行时用 Blob URL 启动——DSH 的工作机制是「每个插件一个脚本、
  不读兄弟资源」，这是唯一可行的部署形态（也是本次唯一的硬阻塞，先用 POC 在无头 Chrome 验证后再落地）。
- **`.docx` 直读（docx-preview 0.3.7）。** 直接渲染分页 DOM（正文可选中复制）、页宽自适应 + 缩放；渲染后按白名单
  清理文档内链接（仅保留 http(s)/mailto，`javascript:` 等移除）；无显式页宽的文档补 A4 兜底，避免手搓文档缩成一团。
- **`.xlsx` / `.csv`（SheetJS 0.18.5）。** 多工作表标签、冻结表头与行号、固定行高虚拟滚动（20 万行 / 100 列上限，
  超出在状态栏提示）、列宽取自工作簿、日期/百分比/千分位按单元格格式显示、坏文件给中文错误态；CSV 与 xlsx 共用渲染。
- **宿主预览 RPC 扩展。** `readDeliverablePreview` 对 `.docx` / `.xlsx` 返回原始字节（≤8 MB，超出仍回 `binary` 让用户
  用本机应用打开），客户端因此能直接渲染；`renderDeliverableDocument` 保留给 PPT / 旧版 Office。
- **预览加载路径收敛。** 新增 `preview/load.ts` + `preview/PreviewContent.tsx`：一个地方决定「字节 / 文本 / 图片 /
  宿主转 PDF」，dock 只负责标签与加载态；卡片不再各自维护一份预览逻辑。

### 移除
- 交付卡里那条**不可达**的旧预览对话框（`DeliverablePreviewDialog` / `PreviewBody`）及其重复加载逻辑：右侧预览栏
  是唯一预览路径（该对话框的触发函数从未被调用，属于死代码）。

### 文档
- 新增 `THIRD_PARTY_NOTICES.md`：PDF.js / docx-preview / JSZip / SheetJS 的许可证、打包方式与已知限制。
- README（中英）：功能清单加入三个查看器，开发章节说明「查看器打进单文件浏览器产物」的原因与体积，tarball 链接
  更新到 v0.3.1；`ACCEPTANCE.zh-CN.md` 新增「面板内预览查看器」验收节。

### 发布说明
- 版本：bundle / core / ui 升到 **0.3.1**；`tool-agent-community` 本版无改动，保持 0.3.1 不重发。
- 客户端产物：`ui-agent-community/lib/client.js` 由 560 KB 变为 **3.32 MB**（gzip 168 KB → **913 KB**）。这是把三个
  查看器 + PDF worker 内联进单文件产物的代价；`accepted` 验收记录里含冷启动对比（面板首次打开仍在百毫秒级）。
- 验收：隔离 `$DSH_HOME` 实例 + 无头 Chrome 端到端 33/33（PDF canvas / docx 分页 / xlsx 冻结表头 / 其他类型回归），
  `console.error` 与 `pageerror` 均为 0；0.3.0 基线同环境对照留存。

## 0.3.0 — Bot 交付的文件卡片

Bot 现在可以把本轮产出的文件**交付给用户**：回复下方出现文件卡片，可在面板里预览、用本机关联应用打开、
在 Finder 中定位。卡片形态与 DSH 主会话的交付卡一致（每回合一组、内含多文件），但数据与打开链路完全在插件内，
不依赖 DSH 的 `present` 工具或 `deliverables/presented` 事件。

### 新增
- **`agent_community_deliver` 工具（第 15 个模型工具）。** `files: [{ path, description? }]`，1–8 个；相对路径按
  Bot 工作区解析，绝对路径可指向工作区之外；只接受已存在的普通文件（目录、最终符号链接、缺失路径会被拒绝）。
  校验语义与 DSH `present` 对齐，模型的使用习惯可以直接迁移。
- **交付卡片。** 每回合一张卡组、内含多文件；单文件一行、2–4 个两列网格、>4 折叠；卡片显示类型图标、文件名、
  说明（缺省回退扩展名大写）。点击卡片在面板内预览：Markdown/文本分页、图片内嵌、PDF 内嵌；Office/二进制只给
  「用应用打开」。回复下方渲染，计入空回合守卫（只有文件没有正文的回合不会消失）。
- **打开方式与定位。** 卡片右侧「打开 + 更多打开方式」split 按钮：默认应用、本机 LaunchServices 关联应用列表
  （默认项标「（默认）」）、底部「显示文件位置」（Finder 选中）。无桌面能力的主机自动隐藏该控件。
- **持久化。** 交付文件随 `BotMessage.deliverables` 落盘，重启后由 `seedLedgerRoom` 重建卡片；旧状态文件
  直接兼容（可选字段，不升 `state.version`）。
- **预览走插件自己的受限 RPC。** 只按 `(room, run, index)` 读取已声明的文件，客户端不能传任意路径；文本 ≤512 KB、
  图片/PDF ≤8 MB；Bot 会话 id 不下发到浏览器（保持账本红线）。

### 文档
- README（中英）工具数 14 → 15，并加入交付卡片说明；`ACCEPTANCE.zh-CN.md` 新增「八、文件交付卡」验收节，
  提示词段数同步为九段。

### 发布说明
- `@dsh-plugin-agent-community/tool-agent-community` 的 `0.3.0` 在 npm 一侧停在 staged 状态（既不能覆盖也不能
  删除），因此该组件以 **0.3.1** 发布；bundle 的依赖是 `^0.3.0`，安装时会自动解析到 0.3.1，其余三个包仍为 0.3.0。
- 版本号同步 0.3.0；发布流程按维护基线执行（GitHub Release + npm 四包 + 市场条目更新）。

## 0.2.2 — DSH 0.2.1-rc.2 兼容，模型目录完全跟随设置

本版本修复 DSH 升级到 `0.2.1-rc.2` 之后 Bot 无法运行的问题，并让「提供方 / 模型 / 思考强度」彻底以 DSH 设置为唯一来源。
每一项都在真实的 `0.2.1-rc.2` 环境中复验过。

### 修复
- **DSH `0.2.1-rc.2` 兼容：`{{cwd}}` 不再是提示词变量。** 新版宿主对未知变量**直接抛错**，而 Bot preset 的
  persona `suffix` 还写着 `Your working directory is {{cwd}}.` —— 于是每一轮 Bot 运行都在模型调用之前失败
  （`unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix"`），界面表现为「发消息没有回复、没有 Bot 运行」。
  现在 suffix 为空（工作目录由宿主的 working-directory 服务作为普通上下文提供）；目录形式的 Bot preset 同步改为合法的
  `prefix`（旧的 `text` 键不在 persona 的 schema 里）。
- **Provider / Model / 思考强度全部来自 DSH 设置。** 新增 `modelCatalog()`：一次拿到「全部提供方 + 全部模型 +
  部署默认模型 + 当前不可用的提供方」。新建 Bot 的默认值是设置里的默认模型及其自带档位；编辑 Bot 时可自由切换。
- **模型菜单按 (提供方 × 模型) 列出。** 同一模型 id 挂在多个提供方下时（本机就有）不再被按 id 合并，也不会静默
  落到第一个提供方；菜单项 id 为 `<provider>:<model>`，通知里同时写明模型与提供方。
- **打开模型菜单时重新读取目录。** 在设置里新增/改名的提供方与模型，无需重开面板即可见。
- **设置里配置了但当前不可用的提供方**会在 Bot 设置里说明原因，不再静默消失；Bot 已保存但目录中已不存在的
  提供方 / 模型 / 档位会以「当前值」形式继续显示，而不是空白。

### 文档
- README（中英）更新到 DSH `0.2.1-rc.2` 与 `v0.2.2`，并明确 peer 范围按「不锁 DSH 版本」策略为 `*`。
- 工具数量与清单同步为 14 个（补上 `agent_community_remember`）。

## 0.2.1 — 修复

本版本修复以下问题，每一项都在真实环境中复验过。


### 修复
- 折叠不影响未读计算。
- **`@all` 紧跟中文不再漏判**：`@all你好` 是全员广播，`@allow` 不是。
- **「我做不到」不再被学成做法**：拒绝语在两条晋升通道都不采纳。
- **`remove_bot` 接受名字**，不再只认 id；**队长可以移除自己**（领导权显式交接）。
- **工具 schema 递归归一化**：属性级 `required` 泄漏进 JSON Schema 会让整个请求被拒。
- **0 成员的群**被拒绝创建（永远没有 leader，消息无处可去）。
- **Bot 拥有自己的 agent preset**：`workflow`/`subagent`/`create_goal`/`present`/`exit_plan_mode` 等
  越权工具从 Bot 目录消失（工具面 46 → 37）。用本部署的机制声明：`dsh-agent-preset` 插件行。
- **掩码每回合重贴**：Agent Teams 的工具在创建之后才挂载，一次性的 deny 挡不住它们。
- **删群归档所有记得这里的 Bot**，包括被踢出过的成员（此前会留下孤儿记忆文件）。
- **未读水位真正写入**：房间打开时消息尚未加载，planner 拿不到锚点且不再重试。
- **`message_member`**：成员之间、成员向 leader 的直连消息（此前提示词让成员用不存在的
  `task_report`）。
- **主会话不再指挥 Bots**：`tool-agent-community` 那一行默认关闭。
- 安装器：内容相同不再重写（避免客户端模块哈希失效）、`.ignored` 副本同步（宿主真正加载的那份）、
  `cp` 返回值不再中断安装；`verify-install` 从 profile 解析。

### 移除
- **转写导出**：`exportTranscript.ts` 与「导出」按钮整体移除（它不在 35 项验收清单里）。

# Changelog

## 0.2.0（已发布）

> 这一版把 Bots团队 从"群里每个 Bot 都会看见每条消息"改成一个真正的房间：**只有一个地方决定谁运行**，Bot 有自己的房间记忆与目标，能调用其他成员干活，并且**不会**在别人说话时白跑一轮。

### 运行策略（谁被唤醒）

- **一个决策点**：`routing.ts` 的七步表，其余任何地方都不再为用户消息排 run。
- 七步：单聊 → `@all`/`@所有人` → `@某人` → 管理指令（"把 A 踢出去"给 leader，不给 A 本人）→ 写出名字 → **角色词命中最多者胜、并列才全叫** → **兜底只有 leader**。
- **没点名不再全员运行**：以前一句「你好」会唤醒四个 Bot（四次完整模型调用），现在只有 leader，由它决定要不要分工。
- 新增 **`@all` / `@所有人`**：唯一让全员回答的方式；mention 菜单里有"所有人"一行。普通文本"大家"不触发。
- `@all` 超过并发槽的成员排队，面板提示"已排队 N 个"。
- **删除静默哨兵**（`（无需补充）` 常量、判定、提示词分支）：被点名的才会运行，因此不再需要"叫醒了但要闭嘴"这条路径，也不再出现"跑完整一轮只为说没事"的浪费。
- **删除死代码** `GroupTaskDriver.onUserMessage`（从未被调用，是第二条唤醒路径）。

### 工具面

- **修复黑名单根本没生效**：`tools.restrict()` 会因**任一未知名字**让整次调用失败，而插件只调一次并吞掉异常 —— Bot 目录里 `ask_user_question`、`skill` 在黑名单里却仍然出现。现在**逐名调用**、单项失败只损失那一个名字，并把 `applied/skipped` 写进日志。
- 默认黑名单收敛为完整的"房间 Bot 工具面"：`plugin_manager`、`workflow`、`subagent*`、`goal` 三件套、`present`、`exit_plan_mode`、`load_workspace_dependencies`、Agent Teams 三件套。
- 插件自己注册的同名工具（提问卡、skill 包装）**仍然可用** —— DSH 规定作用域内注册不会被全局禁用遮蔽。

### Bot 的系统提示词

- `bot-prompt.ts` 八段（identity / room / collaboration / memory / boundary / tools / goal / workflow）注册在 **Bot 自己的 agent 作用域**，遮蔽预设里那套"编码代理"的说法。
- 用**空文本遮蔽**五个不适用分节：`tool:goal`、`tool:workflow`、`ui:deliverable-file-references`、`harness:source`、`app:web-surface`。
- 每轮重复注入的 `[工作边界]`、`[群聊规则]`、`[对话]` 移除 —— 它们是系统提示词的一部分，不该每条消息重发一遍。

### 目标与派工

- **目标属于房间**（`room.goal`，只按 `roomId` 索引）：单聊 A／单聊 B／群 A／群 B 四重隔离是**结构性**的，没有"所有目标"的读取口，工具连房间参数都没有。
- `get_goal` 改为读**当前房间**的目标；`agent_community_goal` 负责设定/暂停/继续/完成；群里只有 leader（或用户）能改。
- 目标续跑由插件决定：有实际进展才排下一轮，**连续 3 轮无进展自动暂停**并提示；用户发言重置预算。
- **`agent_community_dispatch`**：把活交给房间里**已存在的成员**（1–4 个），**立即返回**——leader 本轮先向用户汇报"已派给谁"，成员完成后系统带着回报唤醒 leader 继续。单聊里拒绝并提示先建群；只有 leader 能派；每次失败都逐条说明原因。
- `workflow`（DSH 的）被移除：它开的是**调用者会话里的子代理**，房间里看不见、不占并发额度、停止按钮也够不着。

### 记忆

- **文件优先**：`memory/<botId>/rooms/<roomId>.md` 一个房间一个文件，人可以直接打开、编辑；`INDEX.md` 是派生文件，删了能重建。
- **生命周期**：清空消息**不动**记忆；删除群聊**归档**记忆；踢人**保留**；**删除 Bot 才彻底删除**，且先把它在群里的分区归档到 `_archive/<roomId>/` 再删目录。
- **晋升双通道**：同一请求成功两次 → `procedure`；**反复犯错 → 用户干预 → 做对** → `lesson`，**负例与正例都写进 `<Bot 工作区>/AGENTS.md` 的托管区**，带 run id 证据。没有 run 支撑的自述不晋升（弱证据）。用户手写的内容永不覆盖。
- 超限的旧条目移入 `*.overflow.md`（只移不删），文件与注入都有硬预算。
- **注入改成 baseline + 增量**：首轮给最近记忆，之后只给新增，省 token 并保护 prefix cache。
- 新增 `agent_community_recall`：在本房间记忆里按关键词检索，返回**出处**（时间 + run id + 文件路径）——优先参考实际运行，而不是凭记忆推测。

### 上下文压缩

- **压缩 = 折叠，不是删除**：原文留在转写里（可以往上翻），只有模型的窗口换成"1 条摘要 + 最近 N 条"。折叠区间记录在 `room.foldedSeqs`。
- 不再 dispose 成员的 agent、不再清空 `roomAgentSessions`、不再 purge 会话日志、不再推进 `compactCount` —— Bot 自己的上下文窗口交给 DSH（`standard` 预设自带压缩）。

### 修复

- 未读角标闪烁（`planMarkRead` 按时间去重 + 发送路径用真实返回的消息做锚点）。
- 单聊一句话建出两个群（建群只走确认框）。
- 安装脚本因 `head -c 80` 与 83 字节特征串不匹配而永远失败。
- 跨房间读取/写入一律拒绝。

### 测试


## 0.1.2（已发布）

上一个公开发布版本。安装方式见 README。
