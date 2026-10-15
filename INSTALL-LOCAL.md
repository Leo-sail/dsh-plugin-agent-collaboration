# 本地开发安装（把仓库里的插件装进 DSH profile）

这份文档记录**验证过的**本地安装步骤，以及每一步为什么必要。踩过的坑都在下面，别重复踩。

## 一条命令（从仓库根目录）

```bash
pnpm run bundle                     # 出构建产物（lib/），check-build 会校验形状
bash scripts/install-profile.sh desktop   # 把三个组件拷进 profile 的新 scope
```

然后 **重启 DSH**（Node 那一半在启动时装载），浏览器刷新一次（客户端那一半）。

## 为什么是这几步

### 1. 组件必须放在 profile 的 `@dsh-plugin-agent-community/` 下，而且是**真目录**

bundle 的 `cordis.patch.yml` 用**模块名**挂载三行：

```yaml
- id: plugin-agent-community
  name: "@dsh-plugin-agent-community/agent-community"
```

宿主 loader 按 profile 目录解析这些名字（`cordis-plugin-loader` 用 `ctx.baseUrl`），所以文件必须落在
`~/.dsh/profiles/<profile>/node_modules/@dsh-plugin-agent-community/<组件>/` 里，且目录里要有
**`package.json`**（`main`/`exports` 指向 `lib/index.js`）——只有 `lib/` 的话，`require`/`import` 解析不到包。
`scripts/install-profile.sh` 只负责刷新 `lib/*` 字节，包目录本身要存在。

### 2. ⛔ 绝对不要把 `@deepseek-ai/*` 装进 profile —— 这是 2026-10-15 那次事故的根因

我按前一节的推理手装了一套 `@deepseek-ai/dsh-*@0.2.0-rc.2` 到 profile，结果**把启动这个 profile 的运行时
自带的同名包遮蔽掉了**。用 `npx @deepseek-ai/dsh`（0.1.2-rc.1）启动时直接炸：

```
parameter codec is not backed by a zod v4 schema
    at requireStrictCodec (file:///Users/changhao/.npm/_npx/1e7f6d9597241db0/node_modules/...)
```

连带症状：**无法创建原生会话、无法在原生会话发消息**，而且 Agent Teams 的行被挂载两次 →
`tool "send_message" is already registered`。

**规则**：profile 里只有你自己插件的包；DSH 的包由**启动这个 profile 的那个运行时**提供。
插件声明的是 peerDependencies，装插件请用**同一个运行时**的插件管理器：

```bash
dsh plugin --profile <profile> add <插件包或本地路径>     # 用启动该 profile 的那个 dsh
```

运行时的版本必须 ≥ 插件的 peer 要求（本插件 0.2.0 要求 `@deepseek-ai/dsh-* >= 0.2.0-rc.1`）。
旧 CLI（0.1.2-rc.1）装不了本插件；要么升级运行时，要么别在那个运行时里用它。

### 2b. 三行 patch 挂的组件名必须在 profile 的 node_modules 里解析得到

### 2c. 宿主会自己提供给插件 DSH 包 —— 别在任何解析路径上放它们

**证据**：2026-10-11 到 10-15 插件在本机稳定工作，而这段时间
`@deepseek-ai/dsh-typert-protocol` / `dsh-llm` / `dsh-atomic-write` **在 profile 及其任何上级目录里都不存在**
（`~/.dsh/profiles/node_modules` 的 APFS 创建时间是 10-15 13:19，是后来才出现的）。
也就是说这些包是**宿主自己提供给插件的**，profile 里放了只会遮蔽它。

所以下列位置都必须是"空的"：

- `<profile>/node_modules/@deepseek-ai/`（必须 0 项，见校验脚本的断言）
- `~/.dsh/profiles/node_modules/`（**profile 的上级目录**）：用 `npx @deepseek-ai/dsh` 启动过一次 profile 就会
  生成这个 hoisted 树（223 个软链指向 npx 缓存里的那个版本），它会在解析顺序上抢先。实测 2026-10-15
  它指向 **0.1.2-rc.1**，而 app 是 0.2.0-rc.2 —— 版本不匹配正是 typert 报
  `parameter codec is not backed by a zod v4 schema` 的成因。清掉（或改名移出解析路径）：

  ```bash
  mv ~/.dsh/profiles/node_modules ~/.dsh/profiles/node_modules.shadow-backup-$(date +%s)
  ```

### 2d. 安装脚本会连 `package.json` 一起放

只有 `lib/` 的目录 Node 解析不到包（字节数看起来完全正常）——`scripts/install-profile.sh` 现在同时拷
`package.json`，所以它单独就能产出一个可加载的包，不需要中间跑 pnpm。

### 3. 出问题时的清理顺序

1. 从 profile 的 `bundles` 里去掉 `dsh-plugin-agent-collaboration`，并删掉它的 dependency；
2. 删 `node_modules/dsh-plugin-agent-collaboration`；
3. 跑一次 `pnpm install`（会按 package.json 重算依赖树）；
4. **删掉手装进 profile 的 `node_modules/@deepseek-ai/`** —— 这是遮蔽源，留着就还会炸；
5. 重启 DSH。

### 4. 验证（不需要启动服务）

```bash
cd ~/.dsh/profiles/<profile>
node -e '
const {createRequire}=require("module");
const r=createRequire(process.cwd()+"/probe.cjs");
for (const m of ["agent-community","tool-agent-community","ui-agent-community"]) {
  console.log(m, r.resolve("@dsh-plugin-agent-community/"+m));
}'
```

更严格的一步是**真加载**（模拟宿主 `import` 入口）；脚本在 `scripts/verify-install.mjs`。
它必须报三个入口都 `ok`，并且 `agent-community` 导出 `AgentCommunityService`、`tool-agent-community` 导出
`apply`/`inject`、`ui-agent-community` 导出 `apply`。

## 恢复

安装前的 profile 备份：`/tmp/ac-profile-backup-*.tar.gz`（含 `package.json`、`cordis.patch.yml`、
`pnpm-lock.yaml`、旧的 `node_modules/@dsh-plugin` 与 bundle 副本）。要回退就解开覆盖回去，然后重启 DSH。
