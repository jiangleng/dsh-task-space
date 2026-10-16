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
node D:\dsh_project\dsh-task-space\scripts\validate-manifest.mjs   # 64 项静态校验（manifest + 权限 + 语法）
node D:\dsh_project\dsh-task-space\scripts\smoke-test.mjs          # 117 项断言（真实 Handler + 模拟 Cordis 服务，无需运行中的 DSH）
```

## 2. 使用

1. 点击侧边栏【新建临时对话】按钮（「新会话」正下方；展开态显示文字，收起态/图标行显示图标，带 tooltip）。
2. 插件依次执行：读取生效配置 → 确保 `rootDir` 存在（自动创建 + 写权限校验）→ 按模板生成目录名（重名自动追加 `-2`、`-3`…）→ 创建目录并写入 `.dsh-task-space.json` 标记 → 注册工作区 → 创建绑定工作区的会话（`agentPreset = defaultPreset`，默认 `standard`）→ 浏览器自动打开该会话。
3. 任一步失败：**立即回滚**（已创建的目录会被删除并记日志），WebUI 弹出错误对话框（按错误码本地化 + 服务端原始诊断信息），Esc / 关闭按钮收起。
4. 每次点击都会在后台**异步**扫描 `rootDir`（仅当 `autoCleanDays > 0`）：只删除**带插件标记文件且创建时间超期**的目录；删除前先移除对应工作区记录，全过程写日志（`cleanup: scanning/removed/done …`）。
5. 原生「新建会话」行为不变，仍需手动选择文件夹。
6. **悬停任意会话行**（不限本插件创建的会话）：行内悬停图标区（省略号菜单 / 归档 / 置顶 / 删除同排）出现**文件夹图标**，点击在系统文件管理器中打开该会话的工作目录；空白会话（尚无工作目录）或宿主无桌面打开能力时弹出错误对话框。

## 3. 配置

配置有两条通道，二选一即可（同键同时存在时，**层级高者赢**）：

| 通道 | 写入位置 | 层 | 生效时机 |
| --- | --- | --- | --- |
| **A. WebUI 插件页表单（推荐）** | 插件 → 任务空间 → 组件行「配置」 | patch config（第 2 层） | 保存后**下一次点击即生效**，免重启 |
| B. 插件包 `settings.yaml` | 包根 `settings.yaml` | 文件层（第 3 层，最高） | 每次请求重读，免重启 |

> 表单为什么不是最高层：DSH 官方配置链只有三层——内置 schema 默认值 → profile `cordis.patch.yml` 的 `config:` →（由插件自管的）包内 `settings.yaml`。插件页表单经 `dsh-config-editor` 写的就是 patch config 层（官方对全部插件一视同仁，不会为单个插件发明第四层）；`settings.yaml` 是插件自建的运维层，刻意放在最高，用于**版本化分发 + 团队统一下发**。
>
> **本插件出厂的 `settings.yaml` 四键全部为注释态**，也就是表单值就是当前的最高层：填什么、保存、下一次点击【新建临时对话】立即按新值执行。只有当你手动去掉某行的 `# ` 并填了值，该键才回到文件层管辖（此时表单保存后「生效值」不变属预期——文件层按设计覆盖 GUI，不是 bug）。
>
> 表单保存后会自动向 Host 重读一次 describe 视图，因此输入框显示的值始终与 Host 报告的生效值一致；若发现显示与 `~\.dsh\profiles\<profile>\cordis.patch.yml` 里的 `config:` 不一致，那是上面的层级规则在起作用，而不是保存失败。

### 3.1 在 WebUI 插件页配置（推荐）

1. 侧边栏点【插件】→ 列表中点 **任务空间** 卡片进入详情页；
2. 在「包含的组件」里找到 `dsh-task-space`（`task-space`）这一行，行尾出现**「配置」**按钮（因插件已把该行注册进 `plugins.row.config` 槽）；
3. 点「配置」进入配置页，四个字段即为插件的全部配置项：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `rootDir` | 文本 | 任务存放根目录，支持 `~` 家目录简写 |
| `folderTemplate` | 文本 | 文件夹命名模板，内置 `${date}` `${time}` `${taskId}` `${taskShortId}` `${taskTitle}` |
| `defaultPreset` | 文本 | 新建任务默认 Agent 预设，默认 `standard` |
| `autoCleanDays` | 数字 | 自动清理旧任务目录天数，`0` = 关闭；大于 `0` 时每次点击新建后异步清理 |

4. 改完点【保存】；想恢复某个字段的默认值点该字段旁的【恢复默认】（unset 回 inherited 层）；表单有未保存改动时【放弃】可丢弃草稿；
5. 字段若显示「已自定义」徽标，表示当前值来自 patch config 覆盖层（即非 schema 默认值）；
6. 非回环部署（远程访问）时 `configForms` 持久化退化为 memory，表单呈**只读**——这是 DSH 官方行为，不是插件缺陷。

> 表单写在 patch config 层，由 Host 的 `settings.mutate` 校验后经 `dsh-config-editor` 原子写入 profile 的 `cordis.patch.yml` 并触发 Loader 热重载；插件 Host 侧每次请求都重新读取合并后的配置，因此**保存后立即生效，无需重启**。若保存后行为没变，先看 `settings.yaml` 是否写了同键（见上方说明）。

### 3.2 编辑 `settings.yaml`（最高优先级）

三层合并（优先级从低到高），每一层都可单独覆盖：

1. 插件内置默认值（`index.js` 的 `export const Config` schema）
2. `cordis.patch.yml` insert 行的 `config:`（profile 级；**插件页表单也写这一层**）
3. 插件包根目录的 **`settings.yaml`**（最高优先级；每次 API 请求时重新读取，**改完免重启生效**）

`settings.yaml` 样例（即包根同名文件）：

```yaml
# dsh-task-space 插件配置（最高优先级；UTF-8；支持 ~ 家目录简写）
rootDir: D:\dsh_working                     # 任务存放根目录
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

## 4. 卸载

1. DSH → 设置 → 插件 → `dsh-task-space` → Remove/停用（插件管理器移除 patch 行与安装产物）。
2. 如需彻底清理：删除 profile `cordis.patch.yml` 中残留的 `id: task-space` insert 行；删除任务根目录（默认 `D:\dsh_working`）——**插件卸载不会自动删除你的任务数据**。
3. 删除源码目录（及发布后的 npm 缓存安装）。

## 5. 目录结构

```
dsh-task-space/
├── package.json            # manifest（元数据 + dsh.bundle.patch + dsh.client 双半侧声明）
├── cordis.patch.yml        # Cordis Loader patch：把 host 半侧挂进 profile 组合
├── settings.yaml           # 插件配置（用户可编辑，最高优先级，免重启生效）
├── icon.svg                # 侧边栏/插件页图标（≤256KiB）
├── LICENSE                 # MIT
├── index.js                # Host 半侧：HTTP 路由、目录创建、工作区/会话注册、清理调度
├── client.js               # Client 半侧：侧边栏按钮（sidebar.panellist）、错误弹窗、会话导航、插件页配置卡片（plugins.row.config）
├── wire.js                 # HTTP 响应信封与请求体解析（{ok,value}/{ok:false,error}）
├── trust-fence.js          # 浏览器→Host 请求信任栅栏（回环/受信主机 + x-dsh-plugin 头）
├── config.js               # 三层配置合并、模板渲染、目录名清洗、建目录与标记文件
├── cleanup.js              # 自动清理：只删带标记且超期的目录，逐步记日志
├── locale/{en.json,zh.json}    # 显示元数据（meta.title / meta.description）
├── scripts/
│   ├── validate-manifest.mjs   # manifest + 权限声明 + 语法 校验（64 项）
│   └── smoke-test.mjs          # 功能测试（117 项断言）
└── README.md
```

## 6. manifest 与权限声明

`package.json` 同时声明 Cordis 的两个半侧，缺一不可：

| 字段 | 含义 |
| --- | --- |
| `dsh.bundle.patch: "./cordis.patch.yml"` | Host 半侧安装进 profile 的 Loader patch |
| `dsh.client: { platform:"web", immediately:true, inject:[runtime, ui-slots, ui-locale, ui-settings, connection] }` | Client 半侧进入浏览器模块图（slot + locale + configForms 依赖） |
| `exports["."] / ["./client"]` | Host / Client 入口 |
| `exports["./package.json"]`、`exports["./locale/*.json"]`、`files` | DSH 显示元数据必需声明 |
| `dependencies: { "@deepseek-ai/schemastery": "3.18.1" }` | 唯一依赖：DSH 官方 Config schema SDK |
| `dsh.client.inject` 追加 `@deepseek-ai/dsh-client-ui-settings` | 提供 `configForms` 服务（插件页配置卡片的数据源；`inject` 只声明激活顺序，非 npm 依赖） |
| `icon: "./icon.svg"` | 插件图标 |
| `license / repository / homepage / bugs` | npm 发布与溯源元数据（MIT，GitHub `jiangleng/dsh-task-space`） |

**权限声明检查结论**（`scripts/validate-manifest.mjs` 自动校验，64 项全绿）：

- 无 `install`/`preinstall`/`postinstall`/`prepublish` 等生命周期钩子（不会执行任意安装代码）；
- 依赖白名单仅 `@deepseek-ai/schemastery`（DSH 内置 SDK，非第三方）；无 peerDependencies 越界；
- Client 半侧 `inject` 仅声明 `@deepseek-ai/*` 官方客户端包；
- 运行时能力面：`webServer`（注册 `/api/task-space/{create,cleanup,config}` 三条 exact 路由）+ `webRuntime`、`workspaceController`、`sessionController`、`agentPresets`（`index.js` 模块级 `export const inject` 声明；重服务全部惰性 `ctx.get` 解析）；Client 侧另用 `configForms`（只读 schema + 经 `remote.settings.mutate` 写 patch config 层，无自持持久化）；
- 非 GET 缺 `x-dsh-plugin` 头 → 403；跨站 Origin → 403；方法不符 → 405；错误统一 JSON 信封。

## 7. 开发、打包与测试

```powershell
Set-Location D:\dsh_project\dsh-task-space

# ① 静态校验（manifest 合法性 + 权限声明 + 全部 JS 语法，64 项）
node scripts\validate-manifest.mjs

# ② 功能测试（真实插件 Handler + 模拟 Cordis 服务，117 项断言；不需要运行中的 DSH）
node scripts\smoke-test.mjs
#    覆盖：三层配置合并 / 模板渲染与目录名清洗 / 权限校验与回滚 /
#    信任栅栏（403/405）/ settings.yaml 免重启生效 / 清理语义与日志 /
#    client URL 拼接回归 / session.create 契约（workspaceId XOR cwd）/
#    悬停行「打开工作目录」契约（row.action slot + openWorkspacePath + NO_CWD 防护）/
#    插件页配置卡片契约（Config.volatile + plugins.row.config + configForms + 读写路径）

# ③ 打包（生成可分发 .tgz；files 白名单限定随包文件）
pnpm pack            # 或 npm pack → dsh-task-space-1.2.0.tgz

# ④ 安装：GUI「Install bundle」指向本目录（方式 A），或 dsh plugin add（方式 B）
# ⑤ 生效时机：Host 侧改动需完全重启 DSH Desktop；仅 client.js 改动 F5 刷新即可
# ⑥ 功能验收：点击【新建临时对话】→ 无目录弹窗 → rootDir 出现
#    20260214-153045-a3f9c21b → 自动打开绑定会话（preset=standard）→ 日志有清理记录
# ⑦ 插件页配置验收：侧边栏【插件】→ 任务空间 → 组件行「配置」→ 四字段表单可保存
#    （非回环部署表单只读，属官方行为）
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
- **插件页配置表单只读**：非回环访问时 DSH 的 `configForms` 持久化退化为 memory，表单禁用保存——这是平台行为；本地/回环部署不受影响。
- **表单层与文件层关系**：插件页表单写 patch config 层；包根 `settings.yaml` 仍是最高优先级。若保存表单后行为没变，先检查 `settings.yaml` 是否写有同键——把该键删掉，表单就成为该键的最高层。
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
| 弹「没有权限写入任务目录」 | `rootDir` 不可写：改 `settings.yaml` 或插件页表单为可写路径（默认 `D:\dsh_working`） |
| 弹「无法创建任务根目录」 | 磁盘/路径非法；日志含具体 errno |
| 清理没有执行 | `autoCleanDays: 0`（默认关闭）或目录缺插件标记 |
| 保存了插件页表单但行为没变 | `settings.yaml` 写了同键（文件层按设计覆盖 GUI 层）：删掉该键，或改用文件配置。出厂版四键均为注释态，不会出现此情况 |
| 保存成功但表单显示的值和 patch 文件不一致 | 层级规则：`settings.yaml` 同键更高；表单显示的是 Host 报告的**生效值**，不是 patch 原文 |
| 插件详情页没有「配置」按钮 | Host Config 字段未标 `.volatile()`（`dsh-settings describe()` 不导出该 entry 的 namespace，插件页无从渲染表单）；本版本四字段均已 volatile |
| 插件页表单只读/不可保存 | 非回环部署（remote 访问）持久化为 memory；或 profile 中该 entry 未激活 |
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
- All four settings are configurable from the plugin's detail page in the Web UI (Plugins → 任务空间 → row **配置**), no file editing required.

**Install**

```bash
# CLI (syntax from `dsh --help`)
dsh plugin --profile desktop add github:jiangleng/dsh-task-space   # from GitHub
dsh plugin --profile desktop add dsh-task-space                    # from npm (after publish)

# or in the DSH GUI: Settings -> Plugins -> Install bundle -> path to this folder
```

**Verify**

```bash
node scripts/validate-manifest.mjs   # 64 static checks
node scripts/smoke-test.mjs          # 116 behavioral assertions
```

**Configure** — two channels; when a key exists in both, `settings.yaml` wins by design:

1. **Plugin page form (recommended)** — sidebar Plugins → 任务空间 → component row **配置**: four fields (`rootDir`, `folderTemplate`, `defaultPreset`, `autoCleanDays`) with save/discard/per-field reset. It writes the profile `cordis.patch.yml` `config:` layer through DSH's own `dsh-config-editor` (hot-reloaded, no restart) — that is the standard layer for every DSH plugin. It takes effect on the next click, **unless `settings.yaml` declares the same key**.
2. **`settings.yaml`** in the package root — the plugin's own top layer (for versioned / team-wide distribution); re-read per request, no restart. Remove a key here to let the page form control it.

```yaml
rootDir: D:\dsh_working
folderTemplate: ${YYYYMMDD}-${HHMMSS}-${taskShortId}
defaultPreset: standard
autoCleanDays: 0        # 0 = disabled; N = remove task folders older than N days
```

Template variables: `${YYYYMMDD}`/`${date}`, `${HHMMSS}`/`${time}`, `${taskId}`, `${taskShortId}`, `${taskTitle}`.

Issues: https://github.com/jiangleng/dsh-task-space/issues · License: MIT
