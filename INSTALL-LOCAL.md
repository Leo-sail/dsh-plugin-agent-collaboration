# 从仓库安装到 DSH profile

本文档说明如何把本仓库的三个组件装进一个 DSH profile，以及安装后必须遵守的几条规则。

## 安装

```bash
pnpm run bundle                          # 产出 lib/，check-build 校验构建形状
bash scripts/install-profile.sh desktop  # 安装三个组件到 profile 的插件 scope
```

安装脚本支持任意 DSH home（用于同一台机器上并存多个 DSH 安装）：

```bash
DSH_HOME=/path/to/dsh-home bash scripts/install-profile.sh <profile>
```

安装完成后 **重启 DSH**（Node 半边在宿主启动时装载），随后刷新一次页面（客户端半边）。

## 安装后的验证

```bash
cd <DSH_HOME>/profiles/<profile>
node <repo>/scripts/verify-install.mjs
```

该脚本会真加载三个入口并逐项检查：三个组件都能解析、`agent-community` 导出
`AgentCommunityService`、`tool-agent-community` 与 `ui-agent-community` 导出 `apply`，
且 profile 内不存在 `@deepseek-ai/*`（见下节规则）。全部通过才表示安装可用。

## 必须遵守的规则

### 组件必须位于 profile 的 `@dsh-plugin-agent-community/` 下，且是完整包目录

bundle 的 `cordis.patch.yml` 以**模块名**挂载组件行：

```yaml
- id: plugin-agent-community
  name: "@dsh-plugin-agent-community/agent-community"
```

宿主 loader 从 profile 目录解析这些名字，因此组件必须位于
`<DSH_HOME>/profiles/<profile>/node_modules/@dsh-plugin-agent-community/<组件>/`，
且目录内要有 `package.json`（`main`/`exports` 指向 `lib/index.js`）。只有 `lib/` 的目录在 Node 解析下
不是一个包。`scripts/install-profile.sh` 会一并写入 `package.json`，因此单独运行即可产出可加载的包。

### 不要把 `@deepseek-ai/*` 安装进 profile

DSH 的包由**启动该 profile 的运行时**提供给插件（插件以 `peerDependencies` 声明）。把同名的包装进
profile 会**遮蔽运行时自带的版本**，导致启动失败或功能异常，典型报错：

```
parameter codec is not backed by a zod v4 schema
```

伴随症状包括无法创建原生会话、无法在原生会话发消息，以及 `tool "send_message" is already registered`
（同名工具被挂载两次）。

安装插件请使用**启动该 profile 的同一个运行时**的插件管理器：

```bash
<该运行时>/dsh plugin --profile <profile> add <插件包或本地路径>
```

下列位置必须保持为空：

- `<profile>/node_modules/@deepseek-ai/`
- `<DSH_HOME>/profiles/node_modules/`（profile 的上级目录）

第二种情况由 `npx @deepseek-ai/dsh …` 启动过 profile 时产生：它会在该位置生成一棵 hoisted 依赖树，
并在解析顺序上抢先于运行时。若已存在，移出解析路径：

```bash
mv <DSH_HOME>/profiles/node_modules <DSH_HOME>/profiles/node_modules.backup-$(date +%s)
```

### 客户端半边变更后必须重启宿主

宿主在**启动时**登记客户端模块（带内容哈希）。只替换 `ui-agent-community/lib/client.js` 后刷新页面，
页面会按旧哈希取到新文件，客户端半边加载失败，插件 UI 整体不再注册（侧边栏入口消失），热重挂也无法恢复。
因此：

- 只改 **Node 半边**（core / tools）→ 重启宿主；
- 改了 **UI 半边**（`ui-agent-community`）→ 同样需要重启宿主，重启后再刷新页面；
- 顺序固定为：`install-profile.sh` → 退出并重开 DSH → 刷新页面。

## 主会话工具默认关闭

`cordis.patch.yml` 中 `plugin-tool-agent-community` 一行默认注释。该行会给**用户自己的主会话**注册
`agent_community_post_message`、`task_decompose`、`submit_final`、`create_bot` 等工具，使主会话也能直接
指挥房间，与「房间由 leader 协调」的模型重复。需要恢复时取消该行注释。

Bot 侧的协作工具不受影响：`agent_community_dispatch`、`assign_task`、`message_member`、`finish_task`、
`invite_bot`、`remove_bot`、`propose_group` 由核心包注册进**每个 Bot 自己的作用域**。

## 卸载与回滚

卸载顺序：

1. 从 profile 的 `bundles` 中移除 `dsh-plugin-agent-collaboration`，并删除对应 dependency；
2. 删除 `node_modules/dsh-plugin-agent-collaboration`；
3. 运行一次 `pnpm install`，按 `package.json` 重算依赖树；
4. 删除被手工安装进 profile 的 `node_modules/@deepseek-ai/`；
5. 重启 DSH。

回滚到安装前状态：解开安装前的 profile 备份（含 `package.json`、`cordis.patch.yml`、`pnpm-lock.yaml`
及旧副本）覆盖回 profile，然后重启 DSH。

## 运行时版本

本插件以 `peerDependencies` 声明对 DSH 包的要求，不锁定具体版本。运行时应满足插件的 peer 范围；
过旧的运行时可能无法加载本插件的 bundle。运行时的选择与升级由 DSH 安装方式决定。
