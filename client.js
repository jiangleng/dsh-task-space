/**
 * dsh-task-space — Client (browser) half of the plugin bundle.
 *
 * Registers one button in the sidebar panellist ("【新建临时对话】", the first
 * row directly under the native New Session button — which this plugin never
 * touches or modifies), one error dialog on the `shell.overlay` slot, one
 * hover-row folder button on `sidebar.workspaces.session.row.action` (same row
 * as the native archive/pin/delete actions) that opens the session's working
 * directory in the OS file manager via the official Session Remote, and the
 * plugin-page configuration card on `plugins.row.config` (插件 → 任务空间 →
 * 行「配置」), which edits the four plugin settings without a restart.
 *
 * Click flow: POST /api/task-space/create -> Host creates the dated folder,
 * registers the workspace and creates a bound session (no directory picker is
 * ever opened) -> browser opens the new session. Failures surface as a modal
 * WebUI dialog, localized by the server's error code.
 *
 * Contract notes:
 *   - the factory body only defines things (no side effects); every
 *     registration, listener and resource lives in `apply` behind a cleanup
 *   - visible copy is registered with the Client locale service (`ctx.locale`)
 *   - React comes from the browser module table via `require('react')`
 *   - containers inherit the host theme via `--dsw-alias-*` tokens
 *
 * Source is plain ESM-free browser JS with TypeScript-checked JSDoc (DSH
 * Cordis bundles execute directly in the browser — there is no build step by
 * design, see README.md "TypeScript 说明").
 */
window.__ModuleLoader__.load({
  id: 'dsh-task-space',
  factory(require) {
    const React = require('react');
    const { createElement: h, useState, useEffect, useCallback, useRef } = React;

    // module/exports shim so the loader sees { inject, apply } exports.
    const module = { exports: {} };
    const exports = module.exports;

    /** Dictionary namespace registered with the Client locale service. */
    const NS = 'dsh-task-space';
    /**
     * Host settings namespace of this plugin's row — the `id` declared in
     * cordis.patch.yml's insert, which `dsh-settings` uses as the namespace
     * for `ConfigFormController`. It is NOT the package name and NOT the
     * locale namespace above; `configForms.get()` and `whileServed()` both
     * key on it.
     */
    const CONFIG_NS = 'task-space';
    /**
     * Cell key for the `plugins.row.config` slot. The contract is
     * `<package name>#<row id>` — here `dsh-task-space#task-space`. The
     * plugin page derives the very same key to decide whether the row gets a
     * 「配置」 control at all.
     */
    const CONFIG_SLOT_KEY = 'dsh-task-space#task-space';
    /** Plugin route prefix (mirrors the Host). */
    const API_BASE = '/api/task-space';
    /** The header every mutating request carries (Host trust fence). */
    const PLUGIN_HEADER = { 'x-dsh-plugin': 'dsh-task-space' };

    /** English copy (key set mirrors zh). */
    const en = {
      'button': 'New temporary session',
      'button.busy': 'Creating…',
      'button.title': 'New temporary session: create a dated task folder, workspace and session',
      'error.title': 'Task Space',
      'error.close': 'Close',
      'error.create': 'Failed to create the temporary session',
      'error.ROOT_ACCESS_DENIED': 'No permission to write the task directory — check rootDir in settings.yaml',
      'error.ROOT_CREATE_FAILED': 'Could not create the task root directory',
      'error.MKDIR_FAILED': 'Could not create the task directory',
      'error.PATH_INVALID': 'The configured rootDir is invalid',
      'error.WORKSPACE_CREATE_FAILED': 'Directory created, but DSH workspace registration failed',
      'error.SESSION_CREATE_FAILED': 'Workspace created, but the new session could not be created',
      'error.OPEN_FAILED': 'Session created, but it could not be opened automatically — find it in the sidebar',
      'error.internal': 'Unexpected server error',
      'error.bad-request': 'Invalid request',
      'error.forbidden': 'Request rejected by the security check',
      'error.method-not-allowed': 'HTTP method not allowed',
      'row.openDir': 'Open working directory',
      'row.openDir.title': 'Open the working directory of “{name}” in the file manager',
      'error.openDir': 'Failed to open the working directory',
      'error.NO_CWD': 'This session has no working directory',
      'error.DESKTOP_UNAVAILABLE': 'The host desktop cannot open folders right now',
      'error.OPEN_DIR_FAILED': 'The host could not open this path in the file manager',
      // Plugin-page configuration card (plugins.row.config).
      'config.title': 'Task Space',
      'config.summary': 'Configure the task root, folder template, default preset and cleanup window.',
      'config.rootDir': 'Task root directory',
      'config.rootDirHint': 'Where task folders are created. `~` is expanded to the home directory.',
      'config.folderTemplate': 'Folder name template',
      'config.folderTemplateHint': 'Variables: ${date} ${time} ${taskId} ${taskShortId} ${taskTitle}',
      'config.defaultPreset': 'Default agent preset',
      'config.defaultPresetHint': 'Agent preset applied to new task sessions (e.g. standard).',
      'config.autoCleanDays': 'Auto-cleanup (days)',
      'config.autoCleanDaysHint': '0 disables cleanup; a positive value removes task folders older than N days.',
      'config.overridden': 'customized',
      'config.reset': 'Reset',
      'config.save': 'Save',
      'config.saving': 'Saving…',
      'config.discard': 'Discard',
      'config.readOnly': 'Read-only in this deployment',
      'config.unavailable': 'Configuration is unavailable on this host',
      'config.saveFailed': 'Save failed — the draft is kept, please retry',
      'config.invalidNumber': 'Please enter a number',
      'config.fileOverrideHint': 'Values are written to the plugin’s patch config. A settings.yaml in the plugin directory still takes precedence over this form.',
    };

    /** Chinese copy (key set is the source of truth). */
    const zh = {
      'button': '新建临时对话',
      'button.busy': '创建中…',
      'button.title': '新建临时对话：按模板创建任务目录、注册工作区并打开会话',
      'error.title': '任务空间',
      'error.close': '关闭',
      'error.create': '新建临时对话失败',
      'error.ROOT_ACCESS_DENIED': '没有权限写入任务目录，请检查 settings.yaml 中的 rootDir',
      'error.ROOT_CREATE_FAILED': '无法创建任务根目录',
      'error.MKDIR_FAILED': '无法创建任务目录',
      'error.PATH_INVALID': '配置的 rootDir 无效',
      'error.WORKSPACE_CREATE_FAILED': '目录已创建，但 DSH 工作区注册失败',
      'error.SESSION_CREATE_FAILED': '工作区已创建，但新会话创建失败',
      'error.OPEN_FAILED': '临时对话已创建，但未能自动打开会话——可从侧边栏进入',
      'error.internal': '服务端内部错误',
      'error.bad-request': '请求无效',
      'error.forbidden': '请求被安全校验拒绝',
      'error.method-not-allowed': 'HTTP 方法不允许',
      'row.openDir': '打开工作目录',
      'row.openDir.title': '在文件管理器中打开「{name}」的工作目录',
      'error.openDir': '打开工作目录失败',
      'error.NO_CWD': '该会话还没有工作目录',
      'error.DESKTOP_UNAVAILABLE': '宿主桌面当前无法打开文件夹',
      'error.OPEN_DIR_FAILED': '宿主无法在文件管理器中打开该路径',
      // 插件页配置卡片（plugins.row.config）。
      'config.title': '任务空间',
      'config.summary': '在此配置任务根目录、文件夹命名模板、默认 Agent 预设与自动清理天数。',
      'config.rootDir': '任务根目录',
      'config.rootDirHint': '任务文件夹的创建位置，支持 ~ 家目录简写。',
      'config.folderTemplate': '文件夹命名模板',
      'config.folderTemplateHint': '可用变量：${date} ${time} ${taskId} ${taskShortId} ${taskTitle}',
      'config.defaultPreset': '默认 Agent 预设',
      'config.defaultPresetHint': '新建临时对话使用的 Agent 预设（例如 standard）。',
      'config.autoCleanDays': '自动清理天数',
      'config.autoCleanDaysHint': '0 表示关闭自动清理；大于 0 时删除创建超过 N 天的任务目录。',
      'config.overridden': '已自定义',
      'config.reset': '恢复默认',
      'config.save': '保存',
      'config.saving': '保存中…',
      'config.discard': '放弃',
      'config.readOnly': '当前部署为只读',
      'config.unavailable': '当前宿主不支持配置',
      'config.saveFailed': '保存失败——草稿已保留，请重试',
      'config.invalidNumber': '请输入数字',
      'config.fileOverrideHint': '保存写入插件 patch 配置层；插件目录下的 settings.yaml 优先级更高，会覆盖本表单的值。',
    };

    /* ------------------------------------------------------------------ *
     * Module-scoped store: busy flag + current error.
     * Lives in the factory (definition only); mutated only from events.
     * ------------------------------------------------------------------ */
    const state = { busy: false, error: null, errorSeq: 0 };
    const subscribers = new Set();

    /** @param {Partial<typeof state>} patch */
    function setState(patch) {
      Object.assign(state, patch);
      const snapshot = { ...state };
      for (const subscriber of subscribers) subscriber(snapshot);
    }

    /** React hook: current store snapshot, re-rendering on change. */
    function useStateStore() {
      const [snapshot, setSnapshot] = useState(() => ({ ...state }));
      useEffect(() => {
        const subscriber = (next) => setSnapshot(next);
        subscribers.add(subscriber);
        return () => {
          subscribers.delete(subscriber);
        };
      }, []);
      return snapshot;
    }

    /** The Client context while `apply` is active (cleared on dispose). */
    let activeCtx = null;

    /** API failure carrying a machine-readable code for localization. */
    class ApiFailure extends Error {
      constructor(code, message) {
        super(message);
        this.name = 'ApiFailure';
        this.code = code;
      }
    }

    /** @param {unknown} error */
    function messageOf(error) {
      return error instanceof Error ? error.message : String(error);
    }

    /**
     * Translate a key through the Client locale service, with a dictionary
     * fallback when the service is unavailable (e.g. mid-disposal).
     * @param {string} key - dictionary key.
     * @param {Record<string, unknown>} [params] - `{name}` placeholders.
     * @returns {string}
     */
    function translate(key, params) {
      try {
        const bind = activeCtx?.locale?.bind;
        if (typeof bind === 'function') {
          const text = bind.call(activeCtx.locale, NS)(key, params);
          if (typeof text === 'string' && text !== key) return text;
        }
      } catch { /* fall through */ }
      const isZh = typeof navigator !== 'undefined' && /zh/i.test(navigator.language || '');
      const dict = isZh ? zh : en;
      const template = dict[key] ?? key;
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole));
    }

    /**
     * Resolve a lazily-needed Client service (`uiWorkspace`, `sessions`).
     * They are intentionally NOT part of the static inject list — services are
     * only fetched at click time so the slot registration can never stall
     * activation.
     * @param {string} name - service name.
     * @returns {any}
     */
    function pickService(name) {
      if (!activeCtx) return undefined;
      try {
        const resolved = typeof activeCtx.get === 'function' ? activeCtx.get(name) : undefined;
        if (resolved) return resolved;
      } catch { /* not available yet */ }
      return activeCtx[name] ?? undefined;
    }

    /**
     * Call one plugin route and unwrap the `{ok, value|error}` envelope.
     * @param {string} pathname - route under `/api/task-space`.
     * @param {Record<string, unknown>} [body] - JSON body; omitted for GET.
     * @returns {Promise<any>} the `value` payload.
     */
    async function callApi(pathname, body) {
      // API_BASE has no trailing slash, so the join MUST guarantee a '/'.
      // Without this normalization a bare 'create' pathname joined to
      // "/api/task-spacecreate" → the /api gateway answered plain-text
      // 404 "not found" (the HTTP_404 dialog bug).
      const url = API_BASE + (pathname.startsWith('/') ? pathname : `/${pathname}`);
      let response;
      try {
        response = await fetch(url, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { 'content-type': 'application/json', ...PLUGIN_HEADER },
          body: body === undefined ? undefined : JSON.stringify(body ?? {}),
          credentials: 'same-origin',
        });
      } catch (error) {
        throw new ApiFailure('internal', `cannot reach the DSH host: ${messageOf(error)}`);
      }
      // Read the body as text once: a non-JSON response (e.g. the gateway's
      // plain-text 404 "not found") must surface its text in the dialog so
      // the failure is self-diagnosing instead of a bare "HTTP 404".
      const raw = await response.text().catch(() => '');
      let parsed = null;
      if (raw) {
        try {
          parsed = JSON.parse(raw);
        } catch { /* non-JSON response */ }
      }
      if (parsed && parsed.ok === true) return parsed.value;
      const failure = parsed && parsed.error ? parsed.error : null;
      const detail = raw && !parsed ? ` — ${raw.slice(0, 160)}` : '';
      throw new ApiFailure(
        failure && failure.code ? failure.code : `HTTP_${response.status}`,
        failure && failure.message
          ? failure.message
          : `HTTP ${response.status} for ${url}${detail || ' (empty body)'}`,
      );
    }

    /** Small delay helper for the open-retry loop. */
    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * Open the freshly created session: `uiWorkspace.openSession` first (the
     * dsh 0.1.7+ navigation service), `sessions.open` as fallback, retried
     * while the host-created session is still propagating to the browser.
     * @param {string} sessionId - session to reveal.
     */
    async function openTaskSession(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') {
        throw new ApiFailure('OPEN_FAILED', 'the host returned no sessionId');
      }
      let lastError = null;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const ui = pickService('uiWorkspace');
        if (ui && typeof ui.openSession === 'function') {
          try {
            const result = ui.openSession(sessionId);
            if (result && typeof result.then === 'function') await result;
            return;
          } catch (error) {
            lastError = error;
          }
        }
        const sessions = pickService('sessions');
        if (sessions && typeof sessions.refresh === 'function') {
          try {
            sessions.refresh();
          } catch { /* best effort */ }
        }
        if (sessions && typeof sessions.open === 'function') {
          try {
            const result = sessions.open(sessionId);
            if (result && typeof result.then === 'function') await result;
            return;
          } catch (error) {
            lastError = error;
          }
        }
        await sleep(150);
      }
      throw new ApiFailure('OPEN_FAILED', `session ${sessionId} could not be opened${lastError ? `: ${messageOf(lastError)}` : ''}`);
    }

    /**
     * Open the session's working directory on the Host desktop through the
     * official Session Remote (`openWorkspacePath`) — the same path the
     * shipped open-in-app controls take. The client resolves the session cwd
     * from its local store; the Host verifies the path round-trip
     * (verifyDesktopPath) and runs the native file-manager command. No
     * plugin HTTP route is involved.
     * @param {string} sessionId - session whose `cwd` should open.
     * @returns {Promise<string>} the opened path.
     */
    async function openWorkingDirectory(sessionId) {
      // Session summaries live in the client `sessions` store and already
      // carry `cwd`; no host round-trip is needed just to learn the path.
      const sessions = pickService('sessions');
      let summary = null;
      try {
        summary = sessions?.list?.getSnapshot?.()?.byId?.[sessionId];
      } catch { /* store not ready */ }
      const cwd = summary && typeof summary.cwd === 'string' ? summary.cwd : '';
      if (!cwd) throw new ApiFailure('NO_CWD', `session ${sessionId} has no working directory`);
      // `remote` is resolved like every other service (ctx.get first): an
      // unblessed direct property read must never throw mid-click.
      const remote = pickService('remote');
      if (!remote?.session || typeof remote.session.openWorkspacePath !== 'function') {
        throw new ApiFailure('internal', 'the session remote is unavailable');
      }
      // Availability pre-check: a headless Host reports false here.
      if (typeof remote.session.canOpenWorkspacePath === 'function') {
        let available = false;
        try {
          const result = await remote.session.canOpenWorkspacePath();
          available = result?.ok === true && result?.value === true;
        } catch (error) {
          throw new ApiFailure('DESKTOP_UNAVAILABLE', messageOf(error));
        }
        if (!available) throw new ApiFailure('DESKTOP_UNAVAILABLE', 'canOpenWorkspacePath() reported false');
      }
      let ok = false;
      try {
        // Omitting `action` opens the directory itself in the file manager
        // (Host: shell.openPath for a directory => a file-manager window).
        ok = (await remote.session.openWorkspacePath({ path: cwd })).ok === true;
      } catch (error) {
        throw new ApiFailure('OPEN_DIR_FAILED', messageOf(error));
      }
      if (!ok) throw new ApiFailure('OPEN_DIR_FAILED', `openWorkspacePath refused ${cwd}`);
      return cwd;
    }

    /**
     * The 【新建临时对话】 click flow (single-flight: re-entrant clicks ignored).
     */
    async function createTask() {
      if (!activeCtx || state.busy) return;
      setState({ busy: true });
      try {
        const value = await callApi('/create', {});
        try {
          await openTaskSession(value?.sessionId);
        } catch (error) {
          // The task exists — only navigation failed. Still surface it, but
          // with the "find it in the sidebar" copy.
          throw error;
        }
        setState({ busy: false });
      } catch (error) {
        setState({
          busy: false,
          error: { code: error instanceof ApiFailure ? error.code : 'internal', detail: messageOf(error), seq: state.errorSeq + 1 },
          errorSeq: state.errorSeq + 1,
        });
      }
    }

    /** Dismiss the current error dialog. */
    function closeError() {
      setState({ error: null });
    }

    /* ------------------------------------------------------------------ *
     * Component-local styles — rendered as React elements so unmounting
     * removes them with the component (no document/body mutation).
     * ------------------------------------------------------------------ */
    const CSS = `
.dsh-ts-btn{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;padding:0;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:inherit;font:inherit;line-height:0;cursor:pointer}
.dsh-ts-btn:disabled{opacity:.6;cursor:default}
.dsh-ts-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsh-ts-spin{animation:dsh-ts-rot 1s linear infinite;transform-origin:50% 50%}
@keyframes dsh-ts-rot{to{transform:rotate(360deg)}}
.dsh-ts-backdrop{position:fixed;inset:0;z-index:2147483100;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.45));display:flex;align-items:center;justify-content:center;padding:24px}
.dsh-ts-dialog{width:min(420px,100%);box-sizing:border-box;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:0.5px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.35);padding:16px 16px 14px;font-size:14px}
.dsh-ts-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
.dsh-ts-title{font-weight:600}
.dsh-ts-x{border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:16px;line-height:1;padding:4px;border-radius:6px}
.dsh-ts-x:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-ts-msg{margin:0 0 6px;line-height:1.5}
.dsh-ts-detail{margin:0 0 12px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);word-break:break-all}
.dsh-ts-actions{display:flex;justify-content:flex-end}
.dsh-ts-ok{border:none;border-radius:8px;padding:7px 16px;font:inherit;font-size:13px;cursor:pointer;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dsh-ts-ok:hover{background:var(--dsw-alias-button-primary-hover)}
.dsh-ts-ok:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsh-ts-row-btn{display:inline-flex;align-items:center;justify-content:center;width:22px;height:20px;padding:0;border:none;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm,4px);cursor:pointer}
.dsh-ts-row-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-ts-row-btn:disabled{opacity:.6;cursor:default}
.dsh-ts-row-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.dsh-ts-cfg{display:flex;flex-direction:column;gap:14px;box-sizing:border-box;font-size:13px;color:var(--dsw-alias-label-primary)}
.dsh-ts-cfg-summary{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.dsh-ts-cfg-field{display:flex;flex-direction:column;gap:4px}
.dsh-ts-cfg-label{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dsh-ts-cfg-badge{display:inline-block;padding:0 6px;border-radius:999px;background:var(--dsw-alias-background-selected,var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-label-secondary);font-size:10px;font-weight:500;line-height:16px}
.dsh-ts-cfg-input{box-sizing:border-box;width:100%;padding:6px 8px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
.dsh-ts-cfg-input:focus{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-1px}
.dsh-ts-cfg-input:disabled{opacity:.6;cursor:default}
.dsh-ts-cfg-input[aria-invalid="true"]{border-color:var(--dsw-alias-state-business-critical,var(--dsw-alias-border-l2))}
.dsh-ts-cfg-hint{margin:0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary);word-break:break-word}
.dsh-ts-cfg-invalid{margin:0;font-size:11px;color:var(--dsw-alias-state-business-critical,var(--dsw-alias-label-secondary))}
.dsh-ts-cfg-actions{display:flex;align-items:center;gap:8px}
.dsh-ts-cfg-primary{border:none;border-radius:8px;padding:6px 14px;font:inherit;font-size:12px;cursor:pointer;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dsh-ts-cfg-primary:hover{background:var(--dsw-alias-button-primary-hover)}
.dsh-ts-cfg-primary:disabled{opacity:.5;cursor:default}
.dsh-ts-cfg-primary:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsh-ts-cfg-ghost{border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 12px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.dsh-ts-cfg-ghost:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-ts-cfg-ghost:disabled{opacity:.5;cursor:default}
.dsh-ts-cfg-ghost:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsh-ts-cfg-reset{align-self:flex-start;margin-top:2px;padding:0;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;text-decoration:underline;cursor:pointer}
.dsh-ts-cfg-reset:hover{color:var(--dsw-alias-label-primary)}
.dsh-ts-cfg-reset:disabled{opacity:.5;cursor:default}
.dsh-ts-cfg-status{margin:0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.dsh-ts-cfg-status[data-tone="failed"]{color:var(--dsw-alias-state-business-critical,var(--dsw-alias-label-secondary))}
.dsh-ts-cfg-note{margin:0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
`;

    /** The folder-plus glyph (slot-sized, inherits currentColor). */
    function TaskGlyph(props) {
      const size = Number.isFinite(props?.size) ? props.size : 16;
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false },
        h('path', { d: 'M3 6.5A1.5 1.5 0 0 1 4.5 5h4l1.6 2H19.5A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z' }),
        h('path', { d: 'M12 10.5v5M9.5 13h5' }),
      );
    }

    /** Plain folder glyph for the open-directory row action (no plus sign). */
    function FolderGlyph(props) {
      const size = Number.isFinite(props?.size) ? props.size : 16;
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false },
        h('path', { d: 'M3 6.5A1.5 1.5 0 0 1 4.5 5h4l1.6 2H19.5A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z' }),
      );
    }

    /** Small determinate-free spinner for the busy state. */
    function Spinner(props) {
      const size = Number.isFinite(props?.size) ? props.size : 14;
      return h(
        'svg',
        { className: 'dsh-ts-spin', viewBox: '0 0 16 16', width: size, height: size, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, 'aria-hidden': true, focusable: false },
        h('path', { d: 'M14 8a6 6 0 1 1-6-6', strokeLinecap: 'round' }),
      );
    }

    /**
     * The panellist glyph for 【新建临时对话】.
     *
     * `sidebar.panellist` rows are wrapper-owned `<button>`s: the wrapper
     * (PanelRow in dsh-client-ui-sidebar) renders the registration `label`
     * beside whatever this component returns, so the component must render
     * ONLY the icon — rendering its own text label duplicated the row
     * ("新建临时对话 新建临时对话").
     *
     * Two click paths must both run `createTask`:
     *   - icon clicks: this inner button's React onClick stops propagation
     *   - label/row clicks: land on the wrapper, whose `selectPanel(id)`
     *     THROWS for this key (no `main` panel is registered) — a native
     *     click listener attached to the wrapper row fires BEFORE React's
     *     root listener, so stopping propagation there makes the whole row
     *     clickable while selectPanel never runs
     * Keyboard users focus this inner button and press Enter (the synthesized
     * click bubbles to the same native row listener).
     * @param {{size?: number, active?: boolean}} props - glyph props from PanelRow.
     */
    function TaskPanelGlyph(props) {
      const size = Number.isFinite(props?.size) ? props.size : 16;
      const snapshot = useStateStore();
      const busy = snapshot.busy;
      const rootRef = useRef(null);
      const onClick = useCallback((event) => {
        event.preventDefault();
        event.stopPropagation();
        void createTask();
      }, []);
      // Whole-row bridge (see jsdoc): our glyph sits inside the wrapper's
      // <button> (button > span.panelGlyph > us), so climb to that wrapper.
      useEffect(() => {
        const row = rootRef.current?.parentElement?.closest('button');
        if (!row) return undefined;
        const onRowClick = (event) => {
          event.stopPropagation();
          void createTask();
        };
        row.addEventListener('click', onRowClick);
        return () => row.removeEventListener('click', onRowClick);
      }, []);
      return h(
        'button',
        {
          ref: rootRef,
          type: 'button',
          className: 'dsh-ts-btn',
          disabled: busy,
          title: translate('button.title'),
          'aria-label': busy ? translate('button.busy') : translate('button'),
          'aria-busy': busy ? 'true' : 'false',
          onClick,
        },
        h('style', null, CSS),
        busy ? h(Spinner, { size }) : h(TaskGlyph, { size }),
      );
    }

    /**
     * Hover-row folder button on `sidebar.workspaces.session.row.action` —
     * the same action row as the native archive/pin/delete buttons (visible
     * with them on row hover). Clicking opens this session's working
     * directory in the OS file manager; failures reuse the plugin's modal
     * error dialog.
     * @param {{sessionId?: string, displayTitle?: string}} props - slot props.
     */
    function OpenDirRowButton(props) {
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : '';
      const [busy, setBusy] = useState(false);
      const title = props?.displayTitle || sessionId;
      const onClick = useCallback(async (event) => {
        // The row itself is clickable — never let this button also select it.
        event.preventDefault();
        event.stopPropagation();
        if (busy) return;
        setBusy(true);
        try {
          await openWorkingDirectory(sessionId);
        } catch (error) {
          setState({
            error: { code: error instanceof ApiFailure ? error.code : 'internal', detail: messageOf(error), seq: state.errorSeq + 1 },
            errorSeq: state.errorSeq + 1,
          });
        } finally {
          setBusy(false);
        }
      }, [sessionId, busy]);
      if (!sessionId) return null;
      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-ts-row-btn',
          disabled: busy,
          title: translate('row.openDir.title', { name: title }),
          'aria-label': translate('row.openDir'),
          onClick,
        },
        h('style', null, CSS),
        h(FolderGlyph, { size: 16 }),
      );
    }

    /**
     * Modal error dialog hosted on the `shell.overlay` slot (renders null
     * while there is no error).
     */
    function TaskErrorDialog() {
      const snapshot = useStateStore();
      const error = snapshot.error;
      useEffect(() => {
        if (!error) return undefined;
        /** @param {KeyboardEvent} event */
        const onKeyDown = (event) => {
          if (event.key === 'Escape') closeError();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
      }, [error ? error.seq : null]);
      if (!error) return null;
      const localizedKey = `error.${error.code}`;
      const localized = translate(localizedKey);
      const primary = localized !== localizedKey ? localized : `${translate('error.create')} (${error.code})`;
      const detail = typeof error.detail === 'string' && error.detail !== '' && error.detail !== primary ? error.detail : null;
      return h(
        'div',
        {
          className: 'dsh-ts-backdrop',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) closeError();
          },
        },
        h(
          'div',
          { className: 'dsh-ts-dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'dsh-ts-dialog-title', 'aria-describedby': 'dsh-ts-dialog-msg' },
          h('style', null, CSS),
          h(
            'div',
            { className: 'dsh-ts-head' },
            h('span', { id: 'dsh-ts-dialog-title', className: 'dsh-ts-title' }, translate('error.title')),
            h(
              'button',
              { type: 'button', className: 'dsh-ts-x', 'aria-label': translate('error.close'), onClick: closeError },
              '✕',
            ),
          ),
          h('p', { id: 'dsh-ts-dialog-msg', className: 'dsh-ts-msg' }, primary),
          detail ? h('p', { className: 'dsh-ts-detail' }, detail) : null,
          h(
            'div',
            { className: 'dsh-ts-actions' },
            h('button', { type: 'button', className: 'dsh-ts-ok', autoFocus: true, onClick: closeError }, translate('error.close')),
          ),
        ),
      );
    }

    /* ------------------------------------------------------------------ *
     * Plugin-page configuration card (`plugins.row.config`).
     *
     * The official form primitives (SettingsFormModel / SettingsValueField)
     * live in @deepseek-ai/dsh-client-ui-primitives, which the plugin skill
     * forbids a bundle to require. So the controller below is a local,
     * dependency-free re-implementation of the same semantics (field specs,
     * staged draft, save/discard plan, `remote.settings.mutate` writes) and
     * the card is hand-written with h() + --dsw-alias-* tokens.
     * ------------------------------------------------------------------ */

    /**
     * Editable settings, in form order. Mirrors the Host `Config` schema;
     * `kind` picks the parse/format rules.
     * @type {{field: string, kind: 'text'|'number'}[]}
     */
    const CONFIG_SPECS = [
      { field: 'rootDir', kind: 'text' },
      { field: 'folderTemplate', kind: 'text' },
      { field: 'defaultPreset', kind: 'text' },
      { field: 'autoCleanDays', kind: 'number' },
    ];

    /** @param {string} field @returns {{field: string, kind: string}} */
    function specOf(field) {
      return CONFIG_SPECS.find((spec) => spec.field === field) || { field, kind: 'text' };
    }

    /**
     * Render a stored value as input text (mirrors settingsTextField /
     * settingsNumberField format()).
     * @param {{field: string, kind: string}} spec
     * @param {unknown} value - the effective (live) value from the snapshot.
     * @returns {string}
     */
    function formatFieldValue(spec, value) {
      if (spec.kind === 'number') return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
      return typeof value === 'string' ? value : '';
    }

    /**
     * Parse input text into a form op (mirrors the primitives parse()):
     * empty means "clear" (back to inherited), invalid input returns
     * undefined so the field is flagged invalid.
     * @param {{field: string, kind: string}} spec
     * @param {string} text
     * @returns {{kind: 'set', value: unknown} | {kind: 'clear'} | undefined}
     */
    function parseFieldValue(spec, text) {
      const trimmed = String(text ?? '').trim();
      if (trimmed === '') return { kind: 'clear' };
      if (spec.kind === 'number') {
        const parsed = Number(trimmed);
        if (!Number.isFinite(parsed)) return undefined;
        return { kind: 'set', value: parsed };
      }
      return { kind: 'set', value: trimmed };
    }

    /**
     * Local equivalent of the official SettingsFormModel: owns the staged
     * draft, derives the projection from the Host mirror snapshot and writes
     * back through `ConfigFormController` (remote.settings.mutate).
     */
    class TaskConfigFormController {
      /** @param {any} scope - `ctx.configForms.get(CONFIG_NS)`. */
      constructor(scope) {
        this.scope = scope;
        /** @type {Map<string, {text: string, write?: {kind:'set',value:unknown}|{kind:'clear'}}>} */
        this.staged = new Map();
        this.saving = false;
        this.failed = false;
        this.listeners = new Set();
        // The mirror pushes a fresh snapshot after every accepted write (the
        // Host emits `settings/document-updated`), so a local subscription is
        // the only state we need — no plugin-owned persistence.
        this.unsubscribe = typeof scope?.subscribe === 'function' ? scope.subscribe(() => this.publish()) : undefined;
      }

      /** @returns {any} the mirror snapshot (status/value/base/user/revision/writable). */
      snapshot() {
        return this.scope?.getSnapshot?.() ?? {};
      }

      /** @param {string} field @returns {boolean} true when the override layer sets it. */
      stored(field) {
        const user = this.snapshot().user;
        return user !== undefined && user !== null && Object.hasOwn(user, field);
      }

      /** @param {string} field @returns {unknown} the effective (live) value. */
      valueOfField(field) {
        return this.snapshot().value?.[field];
      }

      /** @param {string} field @returns {unknown} the inherited/base value. */
      baseOfField(field) {
        return this.snapshot().base?.[field];
      }

      /** @param {string} field @returns {{text: string, overridden: boolean, invalid: boolean}} */
      field(field) {
        const spec = specOf(field);
        const staged = this.staged.get(field);
        if (staged) {
          return {
            text: staged.text,
            overridden: staged.write !== undefined && staged.write.kind === 'set',
            invalid: staged.write === undefined,
          };
        }
        return { text: formatFieldValue(spec, this.valueOfField(field)), overridden: this.stored(field), invalid: false };
      }

      /** Form-level state (mirrors SettingsFormModel.shell()). */
      shell() {
        const snap = this.snapshot();
        const invalid = [...this.staged.values()].some((entry) => entry.write === undefined);
        return {
          available: snap.status === 'ready',
          writable: snap.writable === true,
          dirty: this.staged.size > 0,
          invalid,
          saving: this.saving,
          failed: this.failed,
        };
      }

      /** @returns {Record<string, any>} full projection for the card. */
      projection() {
        const out = this.shell();
        for (const spec of CONFIG_SPECS) out[spec.field] = this.field(spec.field);
        return out;
      }

      /** Stage an edit (draft only — nothing is written until save()). */
      edit(field, text) {
        const spec = specOf(field);
        this.staged.set(field, { text, write: parseFieldValue(spec, text) });
        this.publish();
      }

      /** Stage a "back to inherited" for one field. */
      resetField(field) {
        const spec = specOf(field);
        this.staged.set(field, { text: formatFieldValue(spec, this.baseOfField(field)), write: { kind: 'clear' } });
        this.publish();
      }

      /**
       * Translate the staged draft into settings ops. An unchanged field is
       * skipped, an invalid one blocks the whole save.
       * @returns {{ops: {op: string, path: string[], value?: unknown}[], invalid: boolean}}
       */
      plan() {
        /** @type {{op: string, path: string[], value?: unknown}[]} */
        const ops = [];
        let invalid = false;
        for (const [field, entry] of this.staged) {
          if (entry.write === undefined) {
            invalid = true;
            continue;
          }
          if (entry.write.kind === 'clear') {
            if (this.stored(field)) ops.push({ op: 'unset', path: [field] });
            continue;
          }
          const spec = specOf(field);
          const current = formatFieldValue(spec, this.valueOfField(field));
          if (entry.text === current) continue;
          ops.push({ op: 'set', path: [field], value: entry.write.value });
        }
        return { ops, invalid };
      }

      /** Persist the draft; failures keep the draft so nothing is lost. */
      async save() {
        const { dirty, writable, invalid, saving } = this.shell();
        if (!dirty || saving || !writable || invalid) return false;
        const { ops } = this.plan();
        this.saving = true;
        this.failed = false;
        this.publish();
        try {
          // A plan that changes nothing still clears the draft locally.
          if (!ops.length) {
            this.staged.clear();
            this.publish();
            return true;
          }
          const landed = (await this.scope?.mutate?.(ops, this.snapshot().revision)) !== false;
          this.failed = !landed;
          if (landed) this.staged.clear();
          return landed;
        } catch {
          this.failed = true;
          return false;
        } finally {
          this.saving = false;
          this.publish();
        }
      }

      /** Drop the draft without writing. */
      discard() {
        this.staged.clear();
        this.failed = false;
        this.publish();
      }

      /** @param {() => void} listener @returns {() => void} unsubscribe. */
      subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      }

      publish() {
        const snapshot = this.projection();
        for (const listener of this.listeners) listener(snapshot);
      }

      dispose() {
        this.unsubscribe?.();
        this.listeners.clear();
      }
    }

    /** React hook: the controller's projection, re-rendering on every change. */
    function useConfigProjection(controller) {
      const [projection, setProjection] = useState(() => controller.projection());
      useEffect(() => controller.subscribe(() => setProjection(controller.projection())), [controller]);
      return projection;
    }

    /** One labelled input row of the plugin-page form. */
    function ConfigField(props) {
      const { spec, state, disabled } = props;
      const onChange = (event) => props.onEdit(spec.field, event.target.value);
      const onKeyDown = (event) => {
        // Enter saves (the plugin page is a form, not a chat input).
        if (event.key === 'Enter') {
          event.preventDefault();
          props.onSave();
        }
      };
      return h(
        'div',
        { className: 'dsh-ts-cfg-field' },
        h(
          'span',
          { className: 'dsh-ts-cfg-label' },
          props.label,
          state.overridden ? h('span', { className: 'dsh-ts-cfg-badge' }, props.overriddenLabel) : null,
        ),
        h('input', {
          className: 'dsh-ts-cfg-input',
          type: 'text',
          inputMode: spec.kind === 'number' ? 'numeric' : 'text',
          value: state.text,
          disabled,
          spellCheck: false,
          'aria-label': props.label,
          'aria-invalid': state.invalid ? 'true' : 'false',
          onChange,
          onKeyDown,
        }),
        state.invalid ? h('p', { className: 'dsh-ts-cfg-invalid' }, props.invalidLabel) : null,
        props.hint ? h('p', { className: 'dsh-ts-cfg-hint' }, props.hint) : null,
        state.overridden
          ? h(
              'button',
              { type: 'button', className: 'dsh-ts-cfg-reset', disabled, onClick: () => props.onResetField(spec.field) },
              props.resetLabel,
            )
          : null,
      );
    }

    /**
     * Configuration card rendered on the `plugins.row.config` slot.
     * `view: 'summary'` is the one-line description shown on the row;
     * `view: 'page'` is the four-field form opened by the 「配置」 control.
     * @param {{view?: 'summary'|'page', form?: any}} props - slot props.
     */
    function TaskConfigCard(props) {
      const view = props?.view === 'page' ? 'page' : 'summary';
      // The card lives in the page tree, not in the plugin's apply context,
      // so the form controller is created lazily per mounted page view.
      const [controller] = useState(() => new TaskConfigFormController(activeCtx?.configForms?.get?.(CONFIG_NS)));
      const state = useConfigProjection(controller);
      useEffect(() => () => controller.dispose(), [controller]);
      if (view === 'summary') return h('p', { className: 'dsh-ts-cfg-summary' }, translate('config.summary'));
      const disabled = !state.writable;
      const onSave = () => {
        void controller.save();
      };
      return h(
        'div',
        { className: 'dsh-ts-cfg' },
        h('style', null, CSS),
        ...CONFIG_SPECS.map((spec) =>
          h(ConfigField, {
            key: spec.field,
            spec,
            state: state[spec.field],
            disabled,
            label: translate(`config.${spec.field}`),
            hint: translate(`config.${spec.field}Hint`),
            overriddenLabel: translate('config.overridden'),
            resetLabel: translate('config.reset'),
            invalidLabel: translate('config.invalidNumber'),
            onEdit: (field, text) => controller.edit(field, text),
            onResetField: (field) => controller.resetField(field),
            onSave,
          }),
        ),
        h(
          'div',
          { className: 'dsh-ts-cfg-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-ts-cfg-primary',
              disabled: disabled || !state.dirty || state.invalid || state.saving,
              onClick: onSave,
            },
            state.saving ? translate('config.saving') : translate('config.save'),
          ),
          h('button', { type: 'button', className: 'dsh-ts-cfg-ghost', disabled: !state.dirty || state.saving, onClick: () => controller.discard() }, translate('config.discard')),
        ),
        state.available
          ? null
          : h('p', { className: 'dsh-ts-cfg-status', 'data-tone': 'warning' }, translate('config.unavailable')),
        disabled && state.available ? h('p', { className: 'dsh-ts-cfg-status' }, translate('config.readOnly')) : null,
        state.failed ? h('p', { className: 'dsh-ts-cfg-status', 'data-tone': 'failed' }, translate('config.saveFailed')) : null,
        h('p', { className: 'dsh-ts-cfg-note' }, translate('config.fileOverrideHint')),
      );
    }

    /** Services required at activation (kept minimal on purpose). */
    // Client services required at activation. `remote` / `remote.session` are
    // mandatory: the client enforces the same `without inject` gating as the
    // Host, so `ctx.remote.session.openWorkspacePath` throws "cannot get
    // property ..." unless the exact service path is declared here first.
    // `configForms` is the settings-form service (provided by
    // @deepseek-ai/dsh-client-ui-settings, mirrored in package.json's
    // `dsh.client.inject`) and backs the plugin-page configuration card; the
    // official plugin-manager entry declares it too.
    const inject = ['slots', 'locale', 'remote', 'remote.session', 'configForms'];

    /**
     * Register locale dictionaries, the sidebar panellist button and the error
     * dialog. Everything is registered as context-owned effects so plugin
     * disposal / HMR unregisters cleanly.
     * @param {any} ctx - browser plugin context.
     */
    function apply(ctx) {
      activeCtx = ctx;

      // Locale dictionaries (disposer returned through ctx.effect).
      ctx.effect(() => {
        try {
          return ctx.locale.register(NS, { en, zh });
        } catch {
          // Already registered (e.g. HMR re-apply) — keep the old copy.
          return undefined;
        }
      }, 'dsh-task-space: dictionaries');

      // 【新建临时对话】 glyph — first entry of the sidebar panellist, so the
      // row renders directly under the native New Session button. The wrapper
      // row owns the visible label (from `label:` below) and the hover/active
      // styling; the component supplies only the icon and the click handler.
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              { name: 'sidebar.panellist', id: 'task-space', order: -10, label: () => translate('button') },
              TaskPanelGlyph,
            ),
          ),
        'dsh-task-space: sidebar panellist entry',
      );

      // Hover-row folder button: same action row as the native archive/pin/
      // delete buttons (the wrapper shows it on hover). order 50 renders it
      // first among the injected actions, right after the "…" menu. Opening
      // goes through the official Session Remote — no plugin route involved.
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.workspaces.session.row.action', () =>
            ctx.slots.register(
              { name: 'sidebar.workspaces.session.row.action', id: 'task-space-open-dir', order: 50, label: () => translate('row.openDir') },
              OpenDirRowButton,
            ),
          ),
        'dsh-task-space: session row open-directory action',
      );

      // Error dialog on the shell overlay layer.
      ctx.effect(
        () =>
          ctx.slots.inject('shell.overlay', () =>
            ctx.slots.register(
              { name: 'shell.overlay', id: 'task-space-error', order: 900, label: () => translate('error.title') },
              TaskErrorDialog,
            ),
          ),
        'dsh-task-space: error dialog',
      );

      // Plugin-page configuration card. The row only gains its 「配置」 control
      // when this exact key is registered (`plugins.row.config` is keyed by
      // `<package name>#<row id>`), and the Host only serves the namespace
      // when the Config schema has volatile fields — `whileServed` gates the
      // registration on that, so a host without this plugin stays untouched.
      ctx.effect(() => {
        let configForms;
        try {
          configForms = ctx.configForms;
          if (typeof configForms?.get !== 'function') return undefined;
        } catch {
          // `configForms` not injected (older host / service disabled) — the
          // sidebar button and the API routes keep working without it.
          return undefined;
        }
        return configForms.whileServed([CONFIG_NS], () =>
          ctx.slots.inject(
            'plugins.row.config',
            () => ctx.slots.register({ name: 'plugins.row.config', key: CONFIG_SLOT_KEY }, TaskConfigCard),
          ),
        );
      }, 'dsh-task-space: plugin page row config');

      // Disposal: drop module state references and clear subscribers.
      ctx.effect(
        () => () => {
          activeCtx = null;
          subscribers.clear();
        },
        'dsh-task-space: dispose',
      );
    }

    exports.name = 'dsh-task-space';
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
