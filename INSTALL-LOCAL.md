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

### 2. 插件自己的 DSH 依赖必须在**同一个** node_modules 里可解析

插件的运行时代码 `import` 这些包（不是类型导入，是真导入）：

```
@deepseek-ai/dsh-atomic-write   @deepseek-ai/dsh-llm
@deepseek-ai/dsh-typert-protocol  @deepseek-ai/schemastery
```

而它们的传递图还会拉进 `dsh-session` → `dsh-scope`、`dsh-sandbox` 等。**宿主不会替插件解析这些**：
宿主自己的包在 `app.asar` 里，插件文件在 asar 之外，Node 只会从插件的真实路径向上找。所以 profile 里要有这张图：

```bash
cd ~/.dsh/profiles/<profile>
node ~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.cjs add \
  @deepseek-ai/cordis@4.0.4 \
  @deepseek-ai/dsh-agent@0.2.0-rc.2 \
  @deepseek-ai/dsh-atomic-write@0.2.0-rc.2 \
  @deepseek-ai/dsh-llm@0.2.0-rc.2 \
  @deepseek-ai/dsh-session@0.2.0-rc.2 \
  @deepseek-ai/dsh-typert-protocol@0.2.0-rc.2 \
  @deepseek-ai/dsh-tools@0.2.0-rc.2 \
  @deepseek-ai/dsh-scope@0.2.0-rc.2 \
  @deepseek-ai/dsh-sandbox@0.2.0-rc.2 \
  @deepseek-ai/schemastery@3.18.4
```

版本号要对齐宿主当前的 DSH 版本（`~/.dsh/dsh-runtimes/dsh-primary-runtime/runtime.json` 里的
`desktopVersion`）。少了哪个包，验证脚本会直接告诉你是哪一个。

### 3. 别让 pnpm 的清理把这张图删掉

`dsh plugin add` / 插件管理器的安装会用 pnpm 重算依赖树。当 bundle 的组件依赖从「按版本发布」变成
`file:` 本地路径时，pnpm 不再把它们声明为 peer 的 DSH 包视作需要安装的东西，会**顺手删掉**
（实测：一次重装输出 `Packages: -7`，插件随即无法启动）。所以本地开发时：

- 用 `scripts/install-profile.sh` 刷组件字节；
- 用上面的 `pnpm add` 补依赖图；
- 装完之后跑一次验证（下一节）。

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
