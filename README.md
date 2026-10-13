# dsh-task-space

> **DeepSeek Harness (DSH) 社区插件 —— 一键新建临时任务会话**：自动创建带日期模板的任务目录 → 注册为 DSH 工作区 → 打开绑定该工作区的新会话，全程**不弹目录选择框**。

English quickstart: [English](#english-quickstart)

在侧边栏「新会话」按钮正下方新增【**新建临时对话**】按钮（面板列表首行）：

- **零第三方依赖**：仅使用 DSH 官方内置 SDK `@deepseek-ai/schemastery`；无任何 `install`/`publish` 生命周期钩子（`scripts/validate-manifest.mjs` 第 4 节自动审计）。
- **不改原生入口**：原生「新建会话」保持原样（依旧手动选文件夹），插件不占用 `sidebar.workspaces.directoryFlow` 等原生目录流槽位。
- **配置免重启**：三层合并（schema 默认值 → patch 行 config → 包根 `settings.yaml`），`settings.yaml` 每次请求时重读，改完即生效。
- **安全删除**：自动清理只删除带本插件标记文件 `.dsh-task-space.json` 且超期的目录，全过程写日志，绝不静默删除。
- **悬停打开工作目录**：鼠标移至侧边栏任意会话行，在归档/置顶/删除同一排出现文件夹图标，点击即在系统文件管理器中打开该会话的工作目录（走官方 Session Remote `openWorkspacePath`，带宿主路径强校验）。
- **权限与 CSRF**：非 GET 请求强制 `x-dsh-plugin: dsh-task-space` 头，并通过回环/受信主机 Origin 校验，否则 403。

---

## 目录

1. [安装](#1-安装)
2. [使用](#2-使用)
3. [配置](#3-配置)
4. [卸载](#4-卸载)
5. [目录结构](#5-目录结构)
6. [manifest 与权限声明](#6-manifest-与权限声明)
7. [开发、打包与测试](#7-开发打包与测试)
8. [注意事项](#8-注意事项)
9. [常见问题](#9-常见问题)
10. [发布到插件市场（维护者）](#10-发布到插件市场维护者)
11. [License](#11-license)

## 1. 安装

### 方式 A：插件管理器（GUI，推荐 / 已实测）

1. 打开 DSH WebUI → 设置 → 插件（Plugin Manager）。
2. 选择 **Install bundle（安装 bundle）**，目标填插件包绝对路径，例如 `D:\dsh_project\dsh-task-space`。
3. 插件管理器自动完成三件事：profile 内 pnpm 安装、写入 `cordis.patch.yml` insert 行（`id: task-space`）、启用插件。
4. 按提示批准安装确认；完成后 **F5 刷新页面**（加载 Client 半侧），「新会话」正下方出现【新建临时对话】。

### 方式 B：官方 CLI 一条命令（`dsh plugin add`）

语法出自 `dsh --help`：`dsh plugin --profile <name> <pnpm-args...>`，即把参数转发给 profile 内的 pnpm：

```powershell
# GitHub 源仓库安装
dsh plugin --profile desktop add github:jiangleng/dsh-task-space

# npm 发布完成后（见第 10 节）
dsh plugin --profile desktop add dsh-task-space

# 本地目录 / 本地 .tgz 包
dsh plugin --profile desktop add D:\dsh_project\dsh-task-space
dsh plugin --profile desktop add .\dsh-task-space-1.0.0.tgz
```

安装后确认 patch 已挂载并让宿主加载 Host 半侧（完全重启 DSH Desktop）：

```powershell
dsh --dump-config | Select-String task-space   # 应出现 id: task-space / name: dsh-task-space
```

> CLI 等价于在 profile 目录执行 pnpm 安装；若命令未自动写入 `dsh.profile.bundles` 或 insert 行，请改用方式 A（插件管理器的 `install_bundle` 会把三步一次做完）。

### 方式 C：插件市场（收录后）

本插件提交并被 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 精选注册表收录后，站点与 DSH 插件市场会自动同步（市场安装源白名单只认该注册表），届时在市场内搜索 `dsh-task-space` 直接安装。

### 安装前后自检

```powershell
node D:\dsh_project\dsh-task-space\scripts\validate-manifest.mjs   # 56 项静态校验（manifest + 权限 + 语法）
node D:\dsh_project\dsh-task-space\scripts\smoke-test.mjs          # 97 项断言（真实 Handler + 模拟 Cordis 服务，无需运行中的 DSH）
```

## 2. 使用

1. 点击侧边栏【新建临时对话】按钮（「新会话」正下方；展开态显示文字，收起态/图标行显示图标，带 tooltip）。
2. 插件依次执行：读取生效配置 → 确保 `rootDir` 存在（自动创建 + 写权限校验）→ 按模板生成目录名（重名自动追加 `-2`、`-3`…）→ 创建目录并写入 `.dsh-task-space.json` 标记 → 注册工作区 → 创建绑定工作区的会话（`agentPreset = defaultPreset`，默认 `standard`）→ 浏览器自动打开该会话。
3. 任一步失败：**立即回滚**（已创建的目录会被删除并记日志），WebUI 弹出错误对话框（按错误码本地化 + 服务端原始诊断信息），Esc / 关闭按钮收起。
4. 每次点击都会在后台**异步**扫描 `rootDir`（仅当 `autoCleanDays > 0`）：只删除**带插件标记文件且创建时间超期**的目录；删除前先移除对应工作区记录，全过程写日志（`cleanup: scanning/removed/done …`）。
5. 原生「新建会话」行为不变，仍需手动选择文件夹。
6. **悬停任意会话行**（不限本插件创建的会话）：行内悬停图标区（省略号菜单 / 归档 / 置顶 / 删除同排）出现**文件夹图标**，点击在系统文件管理器中打开该会话的工作目录；空白会话（尚无工作目录）或宿主无桌面打开能力时弹出错误对话框。

## 3. 配置

三层合并（优先级从低到高），每一层都可单独覆盖：

1. 插件内置默认值（`index.js` 的 `export const Config` schema）
2. `cordis.patch.yml` insert 行的 `config:`（profile 级，随 bundle 安装写入）
3. 插件包根目录的 **`settings.yaml`**（最高优先级；每次 API 请求时重新读取，**改完免重启生效**）

`settings.yaml` 样例（即包根同名文件）：

```yaml
# dsh-task-space 插件配置（最高优先级；UTF-8；支持 ~ 家目录简写）
rootDir: ~/.dsh/tasks                      # 任务存放根目录
folderTemplate: ${YYYYMMDD}-${HHMMSS}-${taskShortId}   # 目录命名模板
defaultPreset: standard                    # 新建任务默认 Agent 预设
autoCleanDays: 0                           # 0=关闭自动清理；>0=删除超过 N 天的任务目录
```

模板内置变量：

| 变量 | 说明 | 示例 |
| --- | --- | --- |
| `${YYYYMMDD}` / `${date}` | 日期 | `20260214` |
| `${HHMMSS}` / `${time}` | 时间 | `153045` |
| `${taskId}` | 任务短 ID（随机 8 位；全局唯一性由时间戳保证） | `a3f9c21b` |
| `${taskTitle}` | 任务标题（由 `POST /api/task-space/create` 的 `title` 字段传入；侧边栏按钮流程不收集标题，渲染为空串） | `登录页改版` |

配置也可在 DSH 设置页修改（Config schema 自动生成表单；`settings.yaml` 存在时以文件为准）。

## 4. 卸载

1. DSH → 设置 → 插件 → `dsh-task-space` → Remove/停用（插件管理器移除 patch 行与安装产物）。
2. 如需彻底清理：删除 profile `cordis.patch.yml` 中残留的 `id: task-space` insert 行；删除任务根目录（如 `~/.dsh/tasks`）——**插件卸载不会自动删除你的任务数据**。
3. 删除源码目录（及发布后的 npm 缓存安装）。

## 5. 目录结构

```
dsh-task-space/
├── package.json            # manifest（元数据 + dsh.bundle.patch + dsh.client 双半侧声明）
├── cordis.patch.yml        # Cordis Loader patch：把 host 半侧挂进 profile 组合
├── settings.yaml           # 插件配置（用户可编辑，最高优先级，免重启生效）
├── icon.svg                # 侧边栏/设置页图标（≤256KiB）
├── LICENSE                 # MIT
├── index.js                # Host 半侧：HTTP 路由、目录创建、工作区/会话注册、清理调度
├── client.js               # Client 半侧：侧边栏按钮（sidebar.panellist）、错误弹窗、会话导航
├── wire.js                 # HTTP 响应信封与请求体解析（{ok,value}/{ok:false,error}）
├── trust-fence.js          # 浏览器→Host 请求信任栅栏（回环/受信主机 + x-dsh-plugin 头）
├── config.js               # 三层配置合并、模板渲染、目录名清洗、建目录与标记文件
├── cleanup.js              # 自动清理：只删带标记且超期的目录，逐步记日志
├── locale/{en.json,zh.json}    # 显示元数据（meta.title / meta.description）
├── scripts/
│   ├── validate-manifest.mjs   # manifest + 权限声明 + 语法 校验（56 项）
│   └── smoke-test.mjs          # 功能测试（97 项断言）
└── README.md
```

## 6. manifest 与权限声明

`package.json` 同时声明 Cordis 的两个半侧，缺一不可：

| 字段 | 含义 |
| --- | --- |
| `dsh.bundle.patch: "./cordis.patch.yml"` | Host 半侧安装进 profile 的 Loader patch |
| `dsh.client: { platform:"web", immediately:true, inject:[runtime, ui-slots, ui-locale] }` | Client 半侧进入浏览器模块图（slot + locale 依赖） |
| `exports["."] / ["./client"]` | Host / Client 入口 |
| `exports["./package.json"]`、`exports["./locale/*.json"]`、`files` | DSH 显示元数据必需声明 |
| `dependencies: { "@deepseek-ai/schemastery": "3.18.1" }` | 唯一依赖：DSH 官方 Config schema SDK |
| `icon: "./icon.svg"` | 插件图标 |
| `license / repository / homepage / bugs` | npm 发布与溯源元数据（MIT，GitHub `jiangleng/dsh-task-space`） |

**权限声明检查结论**（`scripts/validate-manifest.mjs` 自动校验，56 项全绿）：

- 无 `install`/`preinstall`/`postinstall`/`prepublish` 等生命周期钩子（不会执行任意安装代码）；
- 依赖白名单仅 `@deepseek-ai/schemastery`（DSH 内置 SDK，非第三方）；无 peerDependencies 越界；
- Client 半侧 `inject` 仅声明 `@deepseek-ai/*` 官方客户端包；
- 运行时能力面：`webServer`（注册 `/api/task-space/{create,cleanup,config}` 三条 exact 路由）+ `webRuntime`、`workspaceController`、`sessionController`、`agentPresets`（`index.js` 模块级 `export const inject` 声明；重服务全部惰性 `ctx.get` 解析）；
- 非 GET 缺 `x-dsh-plugin` 头 → 403；跨站 Origin → 403；方法不符 → 405；错误统一 JSON 信封。

## 7. 开发、打包与测试

```powershell
Set-Location D:\dsh_project\dsh-task-space

# ① 静态校验（manifest 合法性 + 权限声明 + 全部 JS 语法，56 项）
node scripts\validate-manifest.mjs

# ② 功能测试（真实插件 Handler + 模拟 Cordis 服务，97 项断言；不需要运行中的 DSH）
node scripts\smoke-test.mjs
#    覆盖：三层配置合并 / 模板渲染与目录名清洗 / 权限校验与回滚 /
#    信任栅栏（403/405）/ settings.yaml 免重启生效 / 清理语义与日志 /
#    client URL 拼接回归 / session.create 契约（workspaceId XOR cwd）/
#    悬停行「打开工作目录」契约（row.action slot + openWorkspacePath + NO_CWD 防护）

# ③ 打包（生成可分发 .tgz；files 白名单限定随包文件）
pnpm pack            # 或 npm pack → dsh-task-space-1.0.0.tgz

# ④ 安装：GUI「Install bundle」指向本目录（方式 A），或 dsh plugin add（方式 B）
# ⑤ 生效时机：Host 侧改动需完全重启 DSH Desktop；仅 client.js 改动 F5 刷新即可
# ⑥ 功能验收：点击【新建临时对话】→ 无目录弹窗 → rootDir 出现
#    20260214-153045-a3f9c21b → 自动打开绑定会话（preset=standard）→ 日志有清理记录
```

API 级调试请在**浏览器 DevTools 控制台**用同源 `fetch`（DSH 平台鉴权对外部 HTTP 客户端统一返回 403，`curl` 到不了插件路由）：

```js
// 查看生效配置
await fetch('/api/task-space/config').then((r) => r.json());
// 手动触发一次清理（同步返回扫描结果）
await fetch('/api/task-space/cleanup', { method: 'POST', headers: { 'x-dsh-plugin': 'dsh-task-space' } }).then((r) => r.json());
```

## 8. 注意事项

- **TypeScript 说明**：DSH Cordis bundle 直接在 Host/浏览器执行，**无构建步骤**（官方规范：部署用 Client 构建工具，不引入自定义 bundler）。本插件源码为带完整 JSDoc 类型标注的 ESM JavaScript；如需严格 TS 校验，可在下游用 `tsc --allowJs --checkJs`，运行时无需编译。
- **不做的事**：不修改 `document.body` / 应用根节点、不替换原生选目录流、不注册新的 session 事件 type、不抢占原生目录流槽位。
- **侧边栏行渲染方式**：`sidebar.panellist` 的每一行由包装器渲染 `<button>` + 文字 label，插件组件只提供图标（勿再渲染文字，否则一行出现两份文本）。**整行可点**：label 点击会走包装器的 `selectPanel(id)`——该 key 没有注册 `main` 面板时 `layout.selectPanel` 直接抛错，因此插件给包装器行按钮挂了原生 `click` 监听（先于 React 根监听触发），点击行任意位置都会触发创建并用 `stopPropagation` 阻断 `selectPanel`。`sidebar.workspaces.session.row.action` 同理：图标按钮由外层 `.rowActions` 容器负责悬停显隐与点击隔离。
- **打开工作目录**：经官方 `session.openWorkspacePath` Remote 打开（客户端用 `ctx.sessions` 摘要的 `cwd`，宿主 `verifyDesktopPath` 做路径往返校验）；`canOpenWorkspacePath()` 预检失败（无桌面环境）会给出明确提示。
- **清理安全性**：没有 `.dsh-task-space.json` 标记的目录**永远不会**被自动清理删除；`autoCleanDays: 0`（默认）连扫描都不执行。
- **CSRF 防护**：非 GET 缺 `x-dsh-plugin` 头返回 403；跨站 Origin 被拒。
- **重复安装**：同 id 的 insert 行重复会出现 overridden/restart-required 状态，请先移除旧安装。
- **Windows**：目录名剔除 `\/:*?"<>|` 与控制字符，`CON/PRN/AUX/NUL` 等保留名自动加前缀；`rootDir` 支持 `~` 展开到用户主目录。
- **回滚语义**：工作区/会话创建失败时，已建目录会被删除并记日志，不留半成品。

## 9. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 点击按钮无反应且无弹窗 | Client 半侧未加载：检查 `dsh.client.inject` 与 patch 行，看 DevTools Console 报错，F5 刷新 |
| 弹「HTTP 404 / not found」 | Host 路由未注册：完全重启 DSH Desktop；确认 `dsh --dump-config` 有 `id: task-space` |
| 弹「without inject」 | 服务解析方式错误：确认 index.js 使用 `ctx.get` 优先的惰性解析（当前版本已修复） |
| 弹「session.create accepts workspaceId or cwd, not both」 | 会话创建契约：二选一（本插件已修复为有 workspaceId 只传它） |
| 弹「没有权限写入任务目录」 | `rootDir` 不可写：改 `settings.yaml` 为可写路径（如 `~/.dsh/tasks`） |
| 弹「无法创建任务根目录」 | 磁盘/路径非法；日志含具体 errno |
| 清理没有执行 | `autoCleanDays: 0`（默认关闭）或目录缺插件标记 |
| 会话创建成功但没自动打开 | 浏览器导航服务延迟超时（约 6s）；从侧边栏进入该会话即可，会话本身已创建 |

## 10. 发布到插件市场（维护者）

四步流程（本仓库状态见括注）：

1. **公开 GitHub 源仓库** —— 门禁：仓库年龄 ≥1 天、**≥10 个 commits**（README/CHANGELOG 提交都算，勿灌水空提交）。门禁绿灯是快照，等 `regate.yml` 每 6 小时 cron 或推一个提交触发（API 手动 rerun 返回 403）。〔仓库已建，commits 待补至 ≥10〕
2. **npm 发布** —— `package.json` 已具备 `license/repository/homepage/bugs` 且 `private: false`；本机 `npm login` 后执行 `npm publish`。〔包名 `dsh-task-space` 在 registry 未被占用；登录待办〕
3. **提精选注册表 PR** —— 向 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提交条目 PR（**勿提给 dshmarket**），格式按其 CONTRIBUTING，PR 描述附 `dsh plugin add` 一条命令安装 + 真实调用自证；评审清单：`dsh.bundle` 存在、patch 指向存在的 cordis.patch.yml、insert 行带 `id`、`files` 含产物、README 覆盖安装+用法。〔待提交〕
4. **收录自动同步** —— [awesome-dsh-plugin.com/plugins.json](https://awesome-dsh-plugin.com/plugins.json) CI 日更；站点 + DSH 插件市场自动收录（市场安装源白名单只认该注册表）。〔待收录〕

可选第二渠道：[ydhrdh/dsh-marketplace](https://github.com/ydhrdh/dsh-marketplace)（`registry/plugins/<id>/plugin.json` + `npm run validate` + PR）。

## 11. License

[MIT](./LICENSE) © 2026 jiangleng

---

## English quickstart

**dsh-task-space** is a DeepSeek Harness community plugin that adds a **“New temporary session”** button right under the native *New session* button in the sidebar. One click creates a dated task folder (no directory picker), registers it as a DSH workspace, and opens a bound session with your default agent preset (`standard` by default).

- Zero third-party dependencies (only the official `@deepseek-ai/schemastery` SDK), no install/publish lifecycle hooks.
- The native *New session* flow is left untouched.
- Optional auto-clean removes only folders stamped with the plugin marker, always with logs.
- Hovering any session row reveals an **open-working-directory** folder button beside the native archive/pin/delete actions (official `session.openWorkspacePath` Remote).

**Install**

```bash
# CLI (syntax from `dsh --help`)
dsh plugin --profile desktop add github:jiangleng/dsh-task-space   # from GitHub
dsh plugin --profile desktop add dsh-task-space                    # from npm (after publish)

# or in the DSH GUI: Settings -> Plugins -> Install bundle -> path to this folder
```

**Verify**

```bash
node scripts/validate-manifest.mjs   # 56 static checks
node scripts/smoke-test.mjs          # 93 behavioral assertions
```

**Configure** — edit `settings.yaml` in the package root (takes effect without restart):

```yaml
rootDir: ~/.dsh/tasks
folderTemplate: ${YYYYMMDD}-${HHMMSS}-${taskShortId}
defaultPreset: standard
autoCleanDays: 0        # 0 = disabled; N = remove task folders older than N days
```

Issues: https://github.com/jiangleng/dsh-task-space/issues · License: MIT
