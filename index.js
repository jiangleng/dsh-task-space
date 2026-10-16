// @ts-check
/**
 * dsh-task-space — Host half of the plugin bundle.
 *
 * Responsibilities (all triggered by one browser POST, no directory-picker
 * dialog anywhere in the flow):
 *   1. resolve config (defaults <- cordis row config <- package settings.yaml)
 *   2. permission-check the configured task root, auto-creating it when absent
 *   3. create one task directory from the folder template
 *   4. register that directory as a DSH workspace
 *   5. create a new session bound to that workspace with the configured preset
 *   6. kick off the asynchronous auto-cleanup scan (logged, never silent)
 *
 * HTTP surface: `/api/task-space/*` routes registered directly on the
 * `webServer` service (the built-in /api gateway only dispatches build-time
 * routes, so runtime plugin endpoints must register here — the pattern used
 * by other DSH community plugins). Every route sits behind the loopback /
 * same-origin trust fence plus the plugin's own `x-dsh-plugin` header for
 * mutating requests.
 *
 * @module dsh-task-space
 */

import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import z from '@deepseek-ai/schemastery';
import { DEFAULTS, DEFAULT_TEMPLATE, createTaskDir, ensureRootDir, expandHome, renderFolderName, resolveEffectiveConfig, writeMarker } from './config.js';
import { ApiError, optionalString, readJsonBody, writeJson, writeOk } from './wire.js';
import { hasPluginHeader, isTrustedApiRequest } from './trust-fence.js';
import { runCleanup } from './cleanup.js';

/** Plugin row name (matches the cordis.patch.yml insert row). */
export const name = 'task-space';

/**
 * Service dependencies; also mirrored on the loader row in cordis.patch.yml.
 *
 * Deliberately minimal: only `webServer` gates activation, because the HTTP
 * routes MUST exist the moment the host web server is up. The heavy services
 * (workspace/session controllers, presets, webRuntime) are resolved lazily
 * per request via `service(ctx, ...)` below — declaring them here used to
 * delay activation for ~28s after boot, and any 【新建临时对话】 click inside that
 * window fell through to the gateway's plain-text 404 ("not found").
 */
export const inject = ['webServer'];

/**
 * Configuration schema. Drives (a) activation-time validation of the row
 * `config` and (b) the auto-generated Settings form for this plugin.
 *
 * `.volatile()` on every field is the switch that makes the four settings
 * appear on the DSH plugin page (插件 → 任务空间 → 行「配置」):
 * the Host settings service only exports a namespace for entries whose schema
 * contains at least one volatile field (`dsh-settings` describe() skips
 * `volatileForm(schema) === void 0`). Without it the plugin page shows the
 * description text only, with no configure control. Fields are top-level
 * leaves of this object, which `validateVolatileSchema` requires ("volatile
 * fields require a fixed object path"). Writes land in the Cordis row `config`
 * layer — i.e. the patch config, NOT settings.yaml — and take effect on the
 * next request because `resolveEffectiveConfig` re-reads every layer per call.
 * @type {any}
 */
export const Config = z.object({
  /** Task root directory; `~` home shorthand is expanded. */
  rootDir: z.string().default(DEFAULTS.rootDir).volatile().description('任务根目录'),
  /** Folder name template (`${YYYYMMDD}-${HHMMSS}-${taskShortId}` by default). */
  folderTemplate: z.string().default(DEFAULT_TEMPLATE).volatile().description('文件夹命名模板'),
  /** Agent preset for new task sessions. */
  defaultPreset: z.string().default(DEFAULTS.defaultPreset).volatile().description('默认 Agent 预设'),
  /** 0 disables auto-cleanup; >0 deletes marked task dirs older than N days. */
  autoCleanDays: z.number().default(DEFAULTS.autoCleanDays).min(0).volatile().description('自动清理天数（0 = 关闭）'),
});

/** Route prefix for every plugin endpoint. */
const ROUTE_PREFIX = '/api/task-space';

/**
 * Resolve a host service by name regardless of whether it was mixed into
 * `ctx` directly or only reachable through `ctx.get`.
 * @param {any} ctx - Cordis context.
 * @param {string} key - service name.
 * @returns {any}
 */
function service(ctx, key) {
  // MUST try `ctx.get(key)` FIRST: it reads the cordis service store without
  // the inject requirement and returns undefined instead of throwing.
  // Direct `ctx[key]` access THROWS `cannot get property "<name>" without
  // inject` for any service not listed in this fiber's inject — that error
  // escaped the old implementation because the direct access ran first and
  // the `ctx.get` fallback never got a chance.
  try {
    const viaGet = typeof ctx?.get === 'function' ? ctx.get(key) : undefined;
    if (viaGet !== undefined && viaGet !== null) return viaGet;
  } catch {
    /* fall through */
  }
  // Fallback for services that ARE mixed into this context (e.g. webServer)
  // and for the smoke-test mock contexts, which expose plain properties.
  try {
    const direct = ctx?.[key];
    if (direct !== undefined && direct !== null) return direct;
  } catch {
    /* fall through */
  }
  return undefined;
}

/**
 * Build a logger that prefers the Cordis logger service and falls back to
 * the console — cleanup and creation must always leave a trace.
 * @param {any} ctx - Cordis context.
 * @param {string} tag - log tag.
 * @returns {{info: (...a: unknown[]) => void, warn: (...a: unknown[]) => void, error: (...a: unknown[]) => void}}
 */
function makeLogger(ctx, tag) {
  const sink = ctx?.logger;
  /** @param {unknown} level @param {unknown[]} args */
  const emit = (level, args) => {
    const text = args
      .map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()))
      .join(' ');
    const line = `[dsh-task-space] ${text}`;
    try {
      if (sink && typeof sink[level] === 'function') {
        sink[level](line);
        return;
      }
    } catch { /* fall through to console */ }
    const fn = level === 'warn' ? console.warn : level === 'error' ? console.error : console.log;
    fn(line);
  };
  return {
    info: (...a) => emit('info', a),
    warn: (...a) => emit('warn', a),
    error: (...a) => emit('error', a),
  };
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Register (or reuse) the DSH workspace for a task directory.
 * Prefers `workspaceController.create({path})` — the sanctioned API behind
 * `ctx.remote.workspace.create` — and falls back to the durable registry.
 *
 * @param {any} ctx - Cordis context.
 * @param {string} dir - absolute task directory.
 * @returns {Promise<string>} workspace id.
 */
async function registerWorkspace(ctx, dir) {
  const control = service(ctx, 'workspaceController');
  try {
    if (control && typeof control.create === 'function') {
      const value = await control.create({ path: dir });
      const id = value?.workspace?.workspaceId ?? value?.workspace?.id;
      if (typeof id === 'string' && id !== '') return id;
    }
  } catch (error) {
    throw new ApiError('WORKSPACE_CREATE_FAILED', `registering workspace "${dir}": ${messageOf(error)}`, 500);
  }
  const registry = service(ctx, 'workspaceRegistry');
  try {
    if (registry && typeof registry.create === 'function') {
      const ws = await registry.create(dir);
      const id = ws?.id ?? ws?.workspaceId;
      if (typeof id === 'string' && id !== '') return id;
    }
  } catch (error) {
    throw new ApiError('WORKSPACE_CREATE_FAILED', `registering workspace "${dir}": ${messageOf(error)}`, 500);
  }
  throw new ApiError('WORKSPACE_CREATE_FAILED', `no workspace service accepted "${dir}"`, 500);
}

/**
 * Resolve the configured agent preset, falling back to `standard` and then
 * to the registry default rather than failing the whole creation.
 *
 * @param {any} ctx - Cordis context.
 * @param {string} requested - configured preset id.
 * @param {{warn: (...a: unknown[]) => void}} log - logger.
 * @returns {Promise<string | undefined>} preset id to pass to session create.
 */
async function resolvePresetId(ctx, requested, log) {
  const presets = service(ctx, 'agentPresets');
  if (!presets || typeof presets.resolve !== 'function') return requested;
  for (const candidate of [requested, 'standard']) {
    try {
      const preset = await presets.resolve(candidate);
      const id = preset?.id ?? candidate;
      if (requested !== candidate) log.warn(`preset "${requested}" not found, using "${id}" instead`);
      return String(id);
    } catch (error) {
      log.warn(`agent preset "${candidate}" could not be resolved: ${messageOf(error)}`);
    }
  }
  log.warn('no agent preset resolved; the session will use the registry default');
  return undefined;
}

/**
 * Create a session bound to the workspace (and rooted in the task dir).
 * @param {any} ctx - Cordis context.
 * @param {{workspaceId: string, cwd: string, agentPreset?: string}} request - session create request.
 * @returns {Promise<string>} session id.
 */
async function createBoundSession(ctx, request) {
  const controller = service(ctx, 'sessionController');
  if (!controller || typeof controller.create !== 'function') {
    throw new ApiError('SESSION_CREATE_FAILED', 'sessionController service is unavailable', 503);
  }
  const created = await controller.create(request);
  const sessionId = created?.sessionId;
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new ApiError('SESSION_CREATE_FAILED', 'session create returned no sessionId', 500);
  }
  return sessionId;
}

/**
 * Plugin entry: register HTTP routes and their cleanup.
 * @param {any} ctx - Cordis context.
 * @param {unknown} config - validated row config from the loader.
 */
export function apply(ctx, config) {
  const log = makeLogger(ctx, 'task-space');

  /**
   * Wrap a handler with the trust fence, method check and error envelope.
   * @param {'GET' | 'POST'} method - allowed HTTP method.
   * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} handler - business handler.
   */
  const route = (method, handler) => (req, res) => {
    void (async () => {
      try {
        // Arrival log: proves in the host log that a browser request reached
        // this plugin's handler (or which fence rejected it below).
        log.info(`route hit ${req.method} ${req.url}`);
        const trustedHosts = service(ctx, 'webRuntime')?.trustedHosts ?? [];
        if (!isTrustedApiRequest(req, trustedHosts)) {
          writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'untrusted request origin' } });
          return;
        }
        if (req.method !== method) {
          writeJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: `${method} only` } });
          return;
        }
        if (method !== 'GET' && !hasPluginHeader(req)) {
          writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'missing x-dsh-plugin header' } });
          return;
        }
        await handler(req, res);
      } catch (error) {
        log.warn(`route ${req.url} failed: ${messageOf(error)}`);
        const failure = error instanceof ApiError ? error : new ApiError('internal', messageOf(error), 500);
        writeJson(res, failure.status, { ok: false, error: { code: failure.code, message: failure.message } });
      }
    })();
  };

  /**
   * POST /api/task-space/create — the single entry point behind the
   * 【新建临时对话】 button: no picker dialog, folder + workspace + session.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  const createTask = async (req, res) => {
    const payload = await readJsonBody(req);
    // Config is re-resolved per request: a settings.yaml edit applies to the
    // very next click without restarting DSH.
    const cfg = resolveEffectiveConfig(config);
    const title = optionalString(payload, 'title');
    const root = expandHome(cfg.rootDir);

    // Permission gate: root must exist (auto-created) and be writable.
    const verifiedRoot = await ensureRootDir(root);

    // Folder creation from the template — this is where a permission failure
    // surfaces as ROOT_ACCESS_DENIED / MKDIR_FAILED for the WebUI dialog.
    const taskId = randomUUID().replace(/-/g, '').slice(0, 8);
    const folderName = renderFolderName(cfg.folderTemplate, { taskId, taskTitle: title });
    const dir = await createTaskDir(verifiedRoot, folderName);

    try {
      await writeMarker(dir, { taskId, template: cfg.folderTemplate, title });
    } catch (error) {
      // The marker only gates auto-cleanup; a failure here must not block the task.
      log.warn(`could not write marker in "${dir}": ${messageOf(error)}`);
    }

    // From here on, a failure rolls the fresh (still empty) directory back so
    // a retry does not litter the root with half-created task folders.
    let workspaceId = '';
    let sessionId = '';
    let preset;
    try {
      workspaceId = await registerWorkspace(ctx, dir);
      preset = await resolvePresetId(ctx, cfg.defaultPreset, log);
      // session.create accepts workspaceId OR cwd, never both (enforced in
      // dsh-api-session-controller). With workspaceId present the session cwd
      // resolves to the workspace path, which registerWorkspace bound to this
      // task directory — same semantics, minus the bad-request.
      sessionId = await createBoundSession(ctx, {
        ...(workspaceId ? { workspaceId } : { cwd: dir }),
        agentPreset: preset,
      });
    } catch (error) {
      try {
        await rm(dir, { recursive: true, force: true });
        log.info(`rolled back "${dir}" after failed task creation`);
      } catch (rollbackError) {
        log.warn(`rollback of "${dir}" failed: ${messageOf(rollbackError)}`);
      }
      throw error;
    }

    log.info(`created task ${taskId} at "${dir}" (workspace=${workspaceId}, session=${sessionId}, preset=${preset ?? 'default'})`);

    // Requirement: every 【新建临时对话】 click also triggers the asynchronous
    // auto-cleanup scan (fire-and-forget, fully logged — see cleanup.js).
    scheduleCleanup(ctx, config, log);

    writeOk(res, { path: dir, taskId, workspaceId, sessionId, agentPreset: preset ?? null, rootDir: verifiedRoot, autoCleanDays: cfg.autoCleanDays });
  };

  /**
   * POST /api/task-space/cleanup — manual/forced cleanup trigger (also used
   * by the test commands in README.md).
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  const forceCleanup = async (req, res) => {
    await readJsonBody(req);
    const cfg = resolveEffectiveConfig(config);
    const result = await runCleanup(ctx, cfg, log);
    writeOk(res, result);
  };

  /**
   * GET /api/task-space/config — the effective configuration (read-only),
   * useful for verification and debugging.
   * @param {import('node:http').IncomingMessage} _req
   * @param {import('node:http').ServerResponse} res
   */
  const readConfig = async (_req, res) => {
    writeOk(res, resolveEffectiveConfig(config));
  };

  // Register routes as a context-owned effect: HMR/reload disposes them.
  ctx.effect(() => {
    const disposers = [];
    /** @param {string} path @param {'GET'|'POST'} method @param {any} handler */
    const add = (path, method, handler) => {
      try {
        const dispose = ctx.webServer.register({ kind: 'exact', path, handler: route(method, handler) });
        if (typeof dispose === 'function') disposers.push(dispose);
        log.info(`route registered: ${method} ${path}`);
      } catch (error) {
        // A duplicate path means a previous generation still holds it; the
        // plugin stays active but that endpoint reports the failure.
        log.error(`failed to register ${method} ${path}: ${messageOf(error)}`);
      }
    };
    add(`${ROUTE_PREFIX}/create`, 'POST', createTask);
    add(`${ROUTE_PREFIX}/cleanup`, 'POST', forceCleanup);
    add(`${ROUTE_PREFIX}/config`, 'GET', readConfig);
    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch { /* already disposed */ }
      }
    };
  }, 'task-space: /api/task-space routes');
}

/**
 * Kick the auto-cleanup scan asynchronously after a creation response.
 * Never throws into the request path.
 * @param {any} ctx - Cordis context.
 * @param {unknown} config - row config.
 * @param {ReturnType<typeof makeLogger>} log - logger.
 */
function scheduleCleanup(ctx, config, log) {
  setImmediate(() => {
    void runCleanup(ctx, resolveEffectiveConfig(config), log).catch((error) => {
      log.warn(`cleanup scan failed: ${messageOf(error)}`);
    });
  });
}
