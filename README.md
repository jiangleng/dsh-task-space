# dsh-task-space

DSH（DeepSeek Harness）社区插件：在 WebUI 侧边栏「新会话」按钮正下方新增【新建临时对话】按钮 —— 点击后**不弹目录选择框**，自动在任务根目录下按模板创建独立子目录、注册为 DSH 工作区、创建绑定该工作区的新会话（默认 `standard` 预设），并按配置异步清理过期任务目录。

- TypeScript / 纯 ESM JavaScript，**零第三方依赖**（仅 DSH 官方内置 SDK `@deepseek-ai/schemastery`）
- 不修改、不劫持 DSH 原生「新建会话」入口（原生入口保持手动选文件夹的行为）
- 所有删除动作带日志，绝不静默删除；只删除带本插件标记文件的目录

---

## 1. 目录树

```
dsh-task-space/
├── package.json            # manifest（插件元数据 + dsh.bundle.patch + dsh.client 双半侧声明）
├── cordis.patch.yml        # Cordis Loader patch：把 host 半侧挂进 profile 组合
├── settings.yaml           # 插件配置文件（用户可编辑，最高优先级，免重启生效）
├── icon.svg                # 侧边栏/设置页显示图标（≤256KiB）
├── index.js                # Host 半侧：HTTP 路由、目录创建、工作区/会话注册、清理调度
├── client.js               # Client 半侧：侧边栏按钮、错误弹窗（shell.overlay）、会话导航
├── wire.js                 # HTTP 响应信封与请求体解析（{ok,value}/{ok:false,error}）
├── trust-fence.js          # 浏览器→Host 请求信任栅栏（回环/受信主机 + x-dsh-plugin 头）
├── config.js               # 配置三层合并、模板渲染、目录名清洗、建目录与标记文件
├── cleanup.js              # 自动清理：只删带本插件 marker 且超期的目录，逐步记日志
├── locale/
│   ├── en.json             # 英文元数据（meta.title / meta.description）
│   └── zh.json             # 中文元数据
├── scripts/
│   ├── validate-manifest.mjs  # manifest 合法性 + 权限声明 + 语法 校验脚本
│   └── smoke-test.mjs         # 功能测试：真实 Handler + 模拟 Cordis 服务（80 项断言）
└── README.md               # 本文档
```

## 2. 插件简介（manifest 要点）

`package.json` 同时声明 Cordis 的两个半侧，缺一不可：

| 字段 | 含义 |
| --- | --- |
| `dsh.bundle.patch: "./cordis.patch.yml"` | Host 半侧安装进 profile 的 Loader patch |
| `dsh.client: { platform:"web", immediately:true, inject:[runtime, ui-slots, ui-locale] } | Client 半侧进入浏览器模块图（slot + locale 依赖） |
| `exports["."] / ["./client"]` | Host / Client 入口 |
| `exports["./package.json"]`、`exports["./locale/*.json"]`、`files` | DSH 显示元数据必需声明 |
| `dependencies: { "@deepseek-ai/schemastery": "3.18.1" }` | 唯一依赖：DSH 官方 Config schema SDK |
| `icon` | 插件图标（相对 manifest 的 `./icon.svg`） |

**权限声明检查结论**（`scripts/validate-manifest.mjs` 自动校验）：

- 无 `scripts` / `postinstall` 等安装钩子（不会执行任意安装代码）；
- 依赖白名单仅 `@deepseek-ai/schemastery`（DSH 内置 SDK，非第三方）；
- Client 半侧 `inject` 仅声明 DSH 官方客户端包；
- 运行时能力面：`webServer`（注册 `/api/task-space/*` 路由）、`webRuntime`、`workspaceController`、`sessionController`、`agentPresets`（均在 `cordis.patch.yml` 行级 + `index.js` 模块级双重声明）；
- 所有非 GET 请求必须携带 `x-dsh-plugin: dsh-task-space` 头，并通过回环/受信主机校验（防 CSRF）。

## 3. 安装步骤

### 方式 A：DSH 插件管理器（推荐）

1. 打开 DSH WebUI → 设置 → 插件（Plugin Manager）。
2. 选择 **Install bundle（安装 bundle）**，目标填本目录的绝对路径，例如：
   `D:\dsh_project\dsh-task-space`
3. 插件管理器会在 profile 中执行 pnpm 安装、写入 `cordis.patch.yml` insert 行并启用插件。
4. 刷新 DSH WebUI 页面（F5，加载 Client 半侧），侧边栏「新会话」按钮正下方（面板列表首行）出现【新建临时对话】。

> 插件管理器的安装/卸载动作会弹出审批确认，需在 GUI 中由本人批准。

### 方式 B：命令行验证后安装

```powershell
# 1) 校验 manifest / 权限声明 / 全部 JS 语法
node "D:\dsh_project\dsh-task-space\scripts\validate-manifest.mjs"

# 2) 在 DSH GUI 中安装（plugin_manager install_bundle，target = 上述目录）
#    安装后确认：
dsh --dump-config   # 应能看到 id: task-space / name: dsh-task-space 的 insert 行
```

## 4. 配置

三层合并（优先级从低到高），**每一层都可单独覆盖**：

1. 插件内置默认值（`index.js` 的 `Config` schema）
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
| `${taskId}` | 任务短 ID（随机 8 位，全局唯一性由时间戳保证） | `a3f9c21b` |
| `${taskTitle}` | 任务标题（由 `POST /api/task-space/create` 的 `title` 字段传入；侧边栏按钮流程不收集标题，渲染为空串） | `登录页改版` |

配置也可在 DSH 设置页修改（Config schema 自动生成表单；`settings.yaml` 存在时以文件为准）。

## 5. 卸载步骤

1. DSH → 设置 → 插件 → `dsh-task-space` → Remove/停用（插件管理器会移除 patch 行与安装产物）。
2. 如需彻底清理：删除 profile 中残留的 `cordis.patch.yml` insert 行（`id: task-space`），删除任务根目录（如 `~/.dsh/tasks`）——**插件卸载不会自动删除你的任务数据**。
3. 删除插件源码目录 `D:\dsh_project\dsh-task-space`。

## 6. 打包命令

```powershell
# 生成可分发的 npm 包（.tgz）；files 字段已限定随包文件
Set-Location D:\dsh_project\dsh-task-space
pnpm pack                # 或：npm pack
# 产出 dsh-task-space-1.0.0.tgz，可再次用插件管理器安装（target 指向解压目录）
```

## 7. 本地加载 / 测试命令

```powershell
# ① 静态校验（manifest 合法性 + 权限声明 + JS 语法，46 项）
node "D:\dsh_project\dsh-task-space\scripts\validate-manifest.mjs"

# ② 功能测试（真实插件 Handler + 模拟 Cordis 服务，80 项断言；不需要运行中的 DSH）
node "D:\dsh_project\dsh-task-space\scripts\smoke-test.mjs"
#    覆盖：三层配置合并 / 模板渲染与目录名清洗 / 权限校验与回滚 /
#    信任栅栏（403/405）/ settings.yaml 免重启生效 / 清理语义与日志

# ③ 安装（GUI：设置 → 插件 → Install bundle → 目标 = D:\dsh_project\dsh-task-space）
#    安装后确认 patch 已挂载：
dsh --dump-config | Select-String task-space

# ④ 启动/重启 DSH 桌面端（若已在运行则刷新页面）

# ⑤ 功能测试：侧边栏「新会话」正下方点击【新建临时对话】
#    预期：无目录选择弹窗 → rootDir 下出现 20260214-153045-a3f9c21b 目录
#          → 自动打开绑定该工作区的新会话（preset=standard）→ 后台日志有清理记录
```

API 级调试请在**浏览器 DevTools 控制台**用同源 `fetch`（DSH 平台鉴权会对一切外部 HTTP 客户端返回 403，`curl` 等请求到不了插件路由）：

```js
// 查看生效配置
await fetch('/api/task-space/config').then((r) => r.json());
// 手动触发一次清理（同步返回扫描结果；POST 缺头会 403）
await fetch('/api/task-space/cleanup', { method: 'POST', headers: { 'x-dsh-plugin': 'dsh-task-space' } }).then((r) => r.json());
```

## 8. 使用说明

1. 点击侧边栏【新建临时对话】按钮（位于「新会话」正下方，展开态显示文字，收起态显示图标，带 tooltip）。
2. 插件依次执行：读取生效配置 → 确保 `rootDir` 存在（自动创建 + 写权限校验）→ 按模板生成目录名（重名自动追加 `-2`、`-3`…）→ 创建目录并写入 `.dsh-task-space.json` 标记 → 注册工作区 → 创建绑定工作区的会话（`agentPreset=defaultPreset`）→ 浏览器自动打开该会话。
3. 任一步骤失败：**立即回滚**（已创建的目录会被删除并记日志），并在 WebUI 弹出错误对话框（按错误码本地化 + 服务端原始信息），Esc / 按钮关闭。
4. 每次点击都会在后台异步扫描 `rootDir`（`autoCleanDays>0` 时）：只删除**带本插件标记文件且创建时间超期**的目录；删除前会先移除对应工作区记录，全过程写入日志（`cleanup: scanning/removed/done …`）。
5. 原生「新建会话」按钮行为不变，仍需手动选择文件夹。

## 9. 注意事项

- **TypeScript 说明**：DSH Cordis bundle 直接在浏览器/Host 执行，无构建步骤（skill 规范：部署用 Client 构建工具，不引入自定义 bundler）。本插件源码为带完整 JSDoc 类型标注的 ESM JavaScript（等价于关闭类型擦除的 TS 风格）；如需严格 TS，可在下游用 `tsc --allowJs --checkJs` 校验，运行时无需编译。
- **不做的事**：不修改 `document.body` / 应用根节点、不替换原生选目录流、不注册新的 session 事件 type、不触碰 `sidebar.workspaces.directoryFlow`（原生目录流 slot，抢占会破坏原生行为）。
- **清理安全性**：没有 `.dsh-task-space.json` 标记的目录**永远不会**被自动清理删除；`autoCleanDays: 0`（默认）连扫描都不执行。
- **CSRF 防护**：非 GET 请求缺 `x-dsh-plugin` 头返回 403；跨站 Origin 被拒。
- **重复安装**：同 id 的 insert 行重复会出现 overridden/restart-required 状态，请先移除旧安装。
- **Windows**：目录名会剔除 `\/:*?"<>|` 与控制字符，`CON/PRN/AUX/NUL` 等保留名自动加前缀；`rootDir` 支持 `~` 展开到用户主目录。

## 10. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 点击按钮无反应且无弹窗 | Client 半侧未加载：检查 `dsh.client.inject` 与 patch 行是否安装成功，看 DevTools Console 报错 |
| 弹「没有权限写入任务目录」 | `rootDir` 不可写：改 `settings.yaml` 为可写路径（如 `~/.dsh/tasks`） |
| 弹「无法创建任务根目录」 | 磁盘/路径非法；日志含具体 errno |
| 清理没有执行 | `autoCleanDays: 0`（默认关闭）或目录缺插件标记 |
| 会话创建成功但没自动打开 | 浏览器导航服务延迟超时（约 6s）；从侧边栏进入该会话即可，会话本身已创建 |
