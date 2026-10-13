// @ts-check
/**
 * dsh-task-space — Node functional smoke test (no browser, no live DSH server).
 *
 * What it exercises, all against the REAL plugin modules:
 *   1. config.js   — settings.yaml dialect, three-layer merge, template
 *                    rendering, Windows name sanitizing, root permission gate,
 *                    collision-suffixed directory creation, marker write/read
 *   2. index.js    — apply() registers the three /api/task-space routes; the
 *                    test invokes those handlers with mock req/res and mock
 *                    Cordis services (workspaceController / sessionController /
 *                    agentPresets), asserting the full create pipeline,
 *                    rollback-on-failure, trust fence and error envelopes
 *   3. cleanup.js  — auto-cleanup scan: expired marked dir removed (logged),
 *                    fresh marked dir kept, unmarked user dir never touched,
 *                    autoCleanDays=0 disabled, missing root tolerated
 *   4. wire.js     — bounded JSON body reading + error codes
 *   5. trust-fence.js — loopback/origin/cross-site decisions
 *
 * Why no HTTP: the DSH platform gate rejects every out-of-band HTTP client
 * (403 before any plugin route), so browser-equivalent same-origin fetch is
 * the only live transport. Per the plugin-verification rules this test drives
 * the handlers directly instead of opening a browser.
 *
 * Isolation: all filesystem work happens in a unique temp directory that is
 * removed afterwards. The package settings.yaml is stashed for the duration of
 * the test (restored in `finally`) so the lower-precedence layers can be
 * asserted without touching the real configuration.
 *
 * Run: node scripts/smoke-test.mjs   (exit code 0 = all checks passed)
 */

import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

import {
  DEFAULTS, DEFAULT_TEMPLATE, MARKER_FILE, createTaskDir, ensureRootDir, expandHome,
  parseSettingsYaml, readMarker, readSettingsFile, renderFolderName, resolveEffectiveConfig,
  sanitizeFolderName, writeMarker,
} from '../config.js';
import { runCleanup } from '../cleanup.js';
import { ApiError, readJsonBody, requireString } from '../wire.js';
import { PLUGIN_HEADER_VALUE, hasPluginHeader, isTrustedApiRequest } from '../trust-fence.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SETTINGS_FILE = path.join(PKG_ROOT, 'settings.yaml');
const SETTINGS_BACKUP = path.join(PKG_ROOT, 'settings.yaml.smoketest.bak');
const PLUGIN_HEADER = 'x-dsh-plugin';
const PLUGIN_HDR = { [PLUGIN_HEADER]: PLUGIN_HEADER_VALUE };

/* ------------------------------------------------------------------ *
 * tiny assertion kit
 * ------------------------------------------------------------------ */
let passed = 0;
let failed = 0;
let group = '';
/** @param {string} name */
function head(name) {
  group = name;
  console.log(`\n== ${name}`);
}
/** @param {unknown} cond @param {string} label */
function check(cond, label) {
  if (cond) {
    passed += 1;
    console.log(`   ok  ${label}`);
  } else {
    failed += 1;
    console.error(` FAIL  [${group}] ${label}`);
  }
}
/**
 * Assert that an async function throws an ApiError with the given code.
 * @param {Promise<unknown>} promise
 * @param {string} expectedCode
 * @returns {Promise<boolean>}
 */
async function throwsCode(promise, expectedCode) {
  try {
    await promise;
    return false;
  } catch (error) {
    return error instanceof ApiError && error.code === expectedCode;
  }
}

/* ------------------------------------------------------------------ *
 * dependency bootstrap: index.js bare-imports @deepseek-ai/schemastery.
 * DSH resolves it from the profile install; for plain `node` runs we link
 * the same package into the plugin's node_modules (junction, idempotent,
 * excluded from packaging by npm/pnpm pack rules).
 * ------------------------------------------------------------------ */
async function ensureSchemastery() {
  try {
    await import('@deepseek-ai/schemastery');
    return;
  } catch {
    /* not resolvable yet — link it below */
  }
  /** @type {string[]} */
  const candidates = [];
  const profiles = path.join(os.homedir(), '.dsh', 'profiles');
  try {
    for (const entry of await fs.readdir(profiles)) {
      candidates.push(path.join(profiles, entry, 'node_modules', '@deepseek-ai', 'schemastery'));
    }
  } catch { /* no profiles dir */ }
  if (process.env.ProgramFiles) {
    candidates.push(path.join(process.env.ProgramFiles, 'DSH Desktop', 'resources', 'app', 'node_modules', '@deepseek-ai', 'schemastery'));
  }
  const target = candidates.find((candidate) => existsSync(candidate));
  if (!target) throw new Error('cannot locate @deepseek-ai/schemastery (DSH profile or app install) for the smoke test');
  const link = path.join(PKG_ROOT, 'node_modules', '@deepseek-ai', 'schemastery');
  await fs.mkdir(path.dirname(link), { recursive: true });
  await fs.symlink(target, link, 'junction');
  console.log(`(linked node_modules/@deepseek-ai/schemastery -> ${target})`);
  await import('@deepseek-ai/schemastery');
}

/* ------------------------------------------------------------------ *
 * settings.yaml stash / restore (package file must survive untouched)
 * ------------------------------------------------------------------ */
async function stashSettings() {
  if (existsSync(SETTINGS_BACKUP) && !existsSync(SETTINGS_FILE)) {
    await fs.rename(SETTINGS_BACKUP, SETTINGS_FILE); // recover from a crashed run
  }
  if (existsSync(SETTINGS_FILE)) await fs.rename(SETTINGS_FILE, SETTINGS_BACKUP);
}
async function unstashSettings() {
  if (existsSync(SETTINGS_FILE)) await fs.rm(SETTINGS_FILE, { force: true });
  if (existsSync(SETTINGS_BACKUP)) await fs.rename(SETTINGS_BACKUP, SETTINGS_FILE);
}

/* ------------------------------------------------------------------ *
 * mock Cordis environment for apply()
 * ------------------------------------------------------------------ */
/** @type {{kind: string, path: string, handler: Function}[]} */
const routes = [];
const logs = [];
const sessions = [];
const state = { ws: 0, ses: 0, sessionMode: 'ok', workspaceDeletes: [] };
const logger = {
  /** @param {...unknown} a */
  info: (...a) => logs.push(a.join(' ')),
  /** @param {...unknown} a */
  warn: (...a) => logs.push(a.join(' ')),
  /** @param {...unknown} a */
  error: (...a) => logs.push(a.join(' ')),
};
const ctx = {
  logger,
  /** @param {() => unknown} fn */
  effect(fn) {
    const dispose = fn();
    return () => {
      if (typeof dispose === 'function') dispose();
    };
  },
  webServer: {
    /** @param {{kind: string, path: string, handler: Function}} route */
    register(route) {
      routes.push(route);
      return () => {};
    },
  },
  webRuntime: { trustedHosts: [] },
  workspaceController: {
    /** @param {{path: string}} request */
    async create(request) {
      state.ws += 1;
      return { workspace: { workspaceId: `ws-${state.ws}`, path: request.path } };
    },
    /** @param {{workspaceId: string}} request */
    async delete(request) {
      state.workspaceDeletes.push(request.workspaceId);
      return {};
    },
  },
  sessionController: {
    /** @param {{workspaceId: string, cwd: string, agentPreset?: string}} request */
    async create(request) {
      if (state.sessionMode === 'empty') return {};
      if (state.sessionMode === 'throw') throw new Error('simulated session failure');
      state.ses += 1;
      sessions.push(request);
      return { sessionId: `ses-${state.ses}`, agentPreset: request.agentPreset };
    },
  },
  agentPresets: {
    /** @param {string} id */
    async resolve(id) {
      if (id === 'standard') return { id: 'standard' };
      throw new Error(`unknown preset "${id}"`);
    },
  },
};

/* ------------------------------------------------------------------ *
 * mock req/res + route driver
 * ------------------------------------------------------------------ */
/**
 * @param {string} method
 * @param {string} url
 * @param {Record<string, string>} [headers]
 * @param {unknown} [body]
 */
function mockReq(method, url, headers = {}, body) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const req = /** @type {any} */ (Readable.from([Buffer.from(payload)]));
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1:43120', 'sec-fetch-site': 'same-origin', ...headers };
  return req;
}

function mockRes() {
  /** @type {(res: any) => void} */
  let settle = () => {};
  const promise = new Promise((resolve) => {
    settle = resolve;
  });
  const res = /** @type {any} */ ({
    statusCode: 0,
    headerSent: /** @type {Record<string, string> | null} */ (null),
    body: '',
    ended: false,
    promise,
  });
  res.writeHead = (status, headers) => {
    res.statusCode = status;
    res.headerSent = headers ?? null;
    return res;
  };
  res.end = (chunk) => {
    if (chunk !== undefined && chunk !== null) res.body += String(chunk);
    res.ended = true;
    settle(res);
    return res;
  };
  return res;
}

/**
 * Invoke one registered plugin route and wait for its response envelope.
 * @param {string} pathname
 * @param {{method?: string, headers?: Record<string, string>, body?: unknown, pick?: 'first' | 'last'}} [options]
 */
async function call(pathname, options = {}) {
  const { method = 'POST', headers = {}, body, pick = 'last' } = options;
  const matches = routes.filter((route) => route.path === pathname);
  if (matches.length === 0) throw new Error(`route not registered: ${pathname}`);
  const route = pick === 'first' ? matches[0] : matches[matches.length - 1];
  const res = mockRes();
  route.handler(mockReq(method, pathname, headers, body), res);
  const timer = setTimeout(() => {
    /* unref: a hung handler must not keep the process alive */
  }, 5000);
  if (typeof timer.unref === 'function') timer.unref();
  const finished = await Promise.race([
    res.promise,
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for response: ${pathname}`)), 5000);
      if (typeof t.unref === 'function') t.unref();
    }),
  ]);
  clearTimeout(timer);
  /** @type {any} */
  let json = null;
  try {
    json = JSON.parse(finished.body);
  } catch { /* leave null */ }
  return { status: finished.statusCode, json, raw: finished.body, headers: finished.headerSent };
}

/** @param {string} root */
async function listDirs(root) {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/* ================================================================== *
 * the test
 * ================================================================== */
async function main() {
  await ensureSchemastery();
  const { apply } = await import('../index.js');

  const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-task-space-test-'));
  const TASK_ROOT = path.join(TMP, 'tasks');
  const SETTINGS_ROOT = path.join(TMP, 'settings-root');
  const CLEAN_ROOT = path.join(TMP, 'clean');
  await stashSettings();

  try {
    /* ---------------- 1. config: yaml dialect + merge ---------------- */
    head('config: settings.yaml dialect & three-layer merge');
    check(expandHome('~') === os.homedir(), 'expandHome("~") is the home directory');
    check(expandHome('~/sub') === path.join(os.homedir(), 'sub'), 'expandHome("~/sub") joins home');
    check(expandHome('/abs') === '/abs', 'expandHome keeps absolute paths');

    const parsed = parseSettingsYaml('# comment\nrootDir: "/tmp/rt"\nautoCleanDays: 7\ndefaultPreset: standard\nflag: true\n');
    check(parsed.rootDir === '/tmp/rt' && parsed.autoCleanDays === 7 && parsed.defaultPreset === 'standard' && parsed.flag === true,
      'parseSettingsYaml: comments skipped, quotes stripped, numbers/bools typed');

    check(Object.keys(readSettingsFile()).length === 0, 'stashed settings.yaml -> empty layer (missing file tolerated)');

    const dflt = resolveEffectiveConfig(undefined);
    check(dflt.rootDir === DEFAULTS.rootDir && dflt.folderTemplate === DEFAULT_TEMPLATE
      && dflt.defaultPreset === 'standard' && dflt.autoCleanDays === 0,
      'resolveEffectiveConfig() falls back to documented defaults');

    const fromRow = resolveEffectiveConfig({ rootDir: '/row/root', autoCleanDays: 3, defaultPreset: 'ptc', folderTemplate: '${taskId}' });
    check(fromRow.rootDir === '/row/root' && fromRow.autoCleanDays === 3 && fromRow.defaultPreset === 'ptc' && fromRow.folderTemplate === '${taskId}',
      'row config beats defaults for every key');
    check(resolveEffectiveConfig({ autoCleanDays: -5 }).autoCleanDays === 0, 'autoCleanDays <= 0 normalizes to 0 (disabled)');
    check(resolveEffectiveConfig({ autoCleanDays: 2.7 }).autoCleanDays === 2, 'autoCleanDays floors to an integer');

    /* ---------------- 2. config: folder template ---------------- */
    head('config: folder template rendering & Windows name sanitizing');
    const fixedNow = new Date(2026, 1, 14, 15, 30, 45); // 2026-02-14 15:30:45 local
    check(renderFolderName(DEFAULT_TEMPLATE, { taskId: 'abcd1234', now: fixedNow }) === '20260214-153045-abcd1234',
      'default template renders ${YYYYMMDD}-${HHMMSS}-${taskShortId}');
    check(renderFolderName('${date}/${time}/${taskId}', { taskId: 'abcd1234', now: fixedNow }) === '20260214_153045_abcd1234',
      'slashes in a rendered name are sanitized to "_" (single segment guaranteed)');
    check(renderFolderName('${taskTitle}', { taskId: 't1', taskTitle: '', now: fixedNow }) === '20260214-153045-t1',
      'empty render falls back to the default template');
    check(renderFolderName('${unknownVar}', { taskId: 't1' }) === '${unknownVar}', 'unknown variables are preserved verbatim');
    check(renderFolderName('${taskTitle}-${taskShortId}', { taskId: 'ab12cd34', taskTitle: '我的任务' }) === '我的任务-ab12cd34',
      'taskTitle flows into the folder name');
    check(sanitizeFolderName('a:b*c?d"e<f>g|h') === 'a_b_c_d_e_f_g_h', 'Windows-illegal characters replaced');
    check(sanitizeFolderName('name...') === 'name', 'trailing dots trimmed');
    check(sanitizeFolderName('CON') === '_CON', 'reserved device names prefixed');
    check(sanitizeFolderName('..') === '', 'dot names refused');

    /* ---------------- 3. config: root gate + mkdir ---------------- */
    head('config: rootDir permission gate & collision-safe mkdir');
    const createdRoot = path.join(TMP, 'auto-created-root');
    check(await ensureRootDir(createdRoot) === createdRoot, 'missing rootDir is auto-created');
    check((await fs.stat(createdRoot)).isDirectory(), 'auto-created root is a directory');
    const fileAsRoot = path.join(TMP, 'not-a-dir');
    await fs.writeFile(fileAsRoot, 'x');
    check(await throwsCode(ensureRootDir(fileAsRoot), 'PATH_INVALID'), 'rootDir pointing at a file -> PATH_INVALID');
    check(await throwsCode(ensureRootDir(''), 'PATH_INVALID'), 'empty rootDir -> PATH_INVALID');

    const first = await createTaskDir(createdRoot, 'alpha');
    const second = await createTaskDir(createdRoot, 'alpha');
    check(path.basename(first) === 'alpha' && path.basename(second) === 'alpha-2', 'name collision gets a -2 suffix');
    check(await throwsCode(createTaskDir(createdRoot, '..'), 'PATH_INVALID'), '".." refused as folder name');
    check(await throwsCode(createTaskDir(createdRoot, 'sub/inner'), 'PATH_INVALID'), 'separated name refused (escape attempt)');

    /* ---------------- 4. full pipeline via apply() routes ---------------- */
    head('pipeline: POST /api/task-space/create (mock DSH services)');
    const rowConfig = { rootDir: TASK_ROOT, folderTemplate: DEFAULT_TEMPLATE, defaultPreset: 'standard', autoCleanDays: 0 };
    apply(ctx, rowConfig);
    check(routes.length === 3, 'apply() registered the three plugin routes');

    const cfgRes = await call('/api/task-space/config', { method: 'GET' });
    check(cfgRes.status === 200 && cfgRes.json?.ok === true && cfgRes.json.value.rootDir === TASK_ROOT,
      'GET /config returns the effective config envelope');
    check((cfgRes.headers?.['content-type'] ?? '').includes('application/json') && cfgRes.headers?.['cache-control'] === 'no-store',
      'JSON responses carry content-type + no-store');

    const create1 = await call('/api/task-space/create', { headers: PLUGIN_HDR, body: { title: '测试标题' } });
    const v1 = create1.json?.value;
    check(create1.status === 200 && create1.json?.ok === true, 'create responds with the success envelope');
    check(v1 && /^\d{8}-\d{6}-[0-9a-f]{8}$/.test(path.basename(v1.path)), 'folder name matches ${YYYYMMDD}-${HHMMSS}-${taskShortId}');
    check(v1 && existsSync(v1.path) && (await fs.stat(v1.path)).isDirectory(), 'task directory exists on disk');
    check(v1?.workspaceId === 'ws-1' && v1?.sessionId === 'ses-1' && v1?.agentPreset === 'standard',
      'workspace + session bound, preset = standard');
    check(v1 && sessions.length === 1 && sessions[0].workspaceId === 'ws-1' && sessions[0].cwd === undefined && sessions[0].agentPreset === 'standard',
      'sessionController.create received {workspaceId, agentPreset} with cwd OMITTED — create accepts workspaceId OR cwd, not both');
    const marker1 = v1 ? await readMarker(v1.path) : undefined;
    check(marker1?.taskId === v1?.taskId && marker1?.title === '测试标题' && marker1?.plugin === 'dsh-task-space',
      'marker file records plugin/taskId/title');
    check(v1?.autoCleanDays === 0 && v1?.rootDir === TASK_ROOT, 'response echoes rootDir + autoCleanDays');

    const create2 = await call('/api/task-space/create', { headers: PLUGIN_HDR, body: {} });
    const v2 = create2.json?.value;
    check(create2.status === 200 && v2 && v2.path !== v1?.path, 'second click creates a distinct task directory');
    check((await listDirs(TASK_ROOT)).length === 2, 'root now holds exactly two task dirs');

    /* trust fence */
    const noHeader = await call('/api/task-space/create', { headers: {}, body: {} });
    check(noHeader.status === 403 && noHeader.json?.error?.code === 'forbidden', 'mutating request without x-dsh-plugin -> 403');
    const crossSite = await call('/api/task-space/create', { headers: { ...PLUGIN_HDR, 'sec-fetch-site': 'cross-site' }, body: {} });
    check(crossSite.status === 403 && crossSite.json?.error?.code === 'forbidden', 'sec-fetch-site: cross-site -> 403');
    const badHost = await call('/api/task-space/create', { headers: { ...PLUGIN_HDR, host: 'evil.example.com:43120' }, body: {} });
    check(badHost.status === 403, 'non-loopback, untrusted Host -> 403 (DNS rebinding defense)');
    const badOrigin = await call('/api/task-space/create', { headers: { ...PLUGIN_HDR, origin: 'http://evil.example.com' }, body: {} });
    check(badOrigin.status === 403, 'origin not matching Host -> 403');
    const goodOrigin = await call('/api/task-space/create', { headers: { ...PLUGIN_HDR, origin: 'http://127.0.0.1:43120' }, body: {} });
    check(goodOrigin.status === 200 && goodOrigin.json?.ok === true, 'same-origin browser request passes the fence');
    check((await listDirs(TASK_ROOT)).length === 3, 'fence rejections created no directories');

    const wrongMethod = await call('/api/task-space/create', { method: 'GET' });
    check(wrongMethod.status === 405 && wrongMethod.json?.error?.code === 'method-not-allowed', 'GET on the POST route -> 405');
    check((await listDirs(TASK_ROOT)).length === 3, '405 created no directories');

    /* rollback on post-mkdir failure */
    state.sessionMode = 'empty';
    const fail1 = await call('/api/task-space/create', { headers: PLUGIN_HDR, body: {} });
    check(fail1.status === 500 && fail1.json?.error?.code === 'SESSION_CREATE_FAILED', 'session create without sessionId -> SESSION_CREATE_FAILED envelope');
    check((await listDirs(TASK_ROOT)).length === 3, 'failed creation rolled the fresh directory back');
    state.sessionMode = 'throw';
    const fail2 = await call('/api/task-space/create', { headers: PLUGIN_HDR, body: {} });
    check(fail2.status === 500 && fail2.json?.error?.code === 'internal', 'throwing service surfaces as internal 500 envelope');
    check((await listDirs(TASK_ROOT)).length === 3, 'rollback also runs when the service throws');
    check(logs.some((line) => line.includes('rolled back')), 'rollback is logged');
    state.sessionMode = 'ok';

    /* ---------------- 5. second instance: custom template + preset fallback ---------------- */
    head('pipeline: custom folderTemplate + defaultPreset fallback');
    apply(ctx, { rootDir: TASK_ROOT, folderTemplate: '${taskTitle}-${taskShortId}', defaultPreset: 'ghost-preset', autoCleanDays: 0 });
    const custom = await call('/api/task-space/create', { headers: PLUGIN_HDR, body: { title: '我的任务' } });
    const vCustom = custom.json?.value;
    check(custom.status === 200 && vCustom && /^我的任务-[0-9a-f]{8}$/.test(path.basename(vCustom.path)),
      'template with ${taskTitle} names the folder');
    check(vCustom?.agentPreset === 'standard', 'unknown defaultPreset falls back to standard');
    check(logs.some((line) => line.includes('ghost-preset') && line.includes('not found')), 'preset fallback is logged');

    /* ---------------- 6. settings.yaml is the top layer, live ---------------- */
    head('config: settings.yaml overrides live (per-request re-read)');
    await fs.writeFile(SETTINGS_FILE, `rootDir: '${SETTINGS_ROOT}'\nautoCleanDays: 7\n`, 'utf8');
    const merged = resolveEffectiveConfig({ rootDir: '/ignored', autoCleanDays: 9 });
    check(merged.rootDir === SETTINGS_ROOT && merged.autoCleanDays === 7, 'settings.yaml beats row config for its keys');
    const live = await call('/api/task-space/create', { headers: PLUGIN_HDR, body: {}, pick: 'first' });
    const vLive = live.json?.value;
    check(live.status === 200 && vLive?.rootDir === SETTINGS_ROOT, 'the next request already uses the edited rootDir (no restart)');
    check(vLive && existsSync(vLive.path) && (await listDirs(SETTINGS_ROOT)).length === 1, 'task dir created under the settings rootDir');
    check(vLive?.autoCleanDays === 7, 'response echoes settings.yaml autoCleanDays');
    const cleanupRoute = await call('/api/task-space/cleanup', { headers: PLUGIN_HDR, body: {}, pick: 'first' });
    check(cleanupRoute.status === 200 && cleanupRoute.json?.ok === true && cleanupRoute.json.value.enabled === true,
      'POST /cleanup runs the scan (autoCleanDays=7 -> enabled)');

    /* ---------------- 7. auto-cleanup semantics ---------------- */
    head('cleanup: expired marked dirs removed, everything else untouched');
    await fs.mkdir(path.join(CLEAN_ROOT, 'old-task'), { recursive: true });
    await fs.mkdir(path.join(CLEAN_ROOT, 'fresh-task'), { recursive: true });
    await fs.mkdir(path.join(CLEAN_ROOT, 'user-folder'), { recursive: true });
    const oldStamp = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await fs.writeFile(path.join(CLEAN_ROOT, 'old-task', MARKER_FILE),
      JSON.stringify({ plugin: 'dsh-task-space', version: 1, taskId: 'old00001', createdAt: oldStamp }), 'utf8');
    await writeMarker(path.join(CLEAN_ROOT, 'fresh-task'), { taskId: 'fresh001', template: DEFAULT_TEMPLATE });
    await fs.writeFile(path.join(CLEAN_ROOT, 'user-folder', 'keep.txt'), 'user data', 'utf8');

    const cleanLogs = [];
    const cleanCtx = {
      workspaceRegistry: { resolveByPath: async () => ({ workspaceId: 'ws-ghost' }) },
      workspaceController: {
        /** @param {{workspaceId: string}} request */
        async delete(request) {
          state.workspaceDeletes.push(request.workspaceId);
          return {};
        },
      },
    };
    const cleanLog = {
      /** @param {...unknown} a */
      info: (...a) => cleanLogs.push(a.join(' ')),
      /** @param {...unknown} a */
      warn: (...a) => cleanLogs.push(a.join(' ')),
    };
    const summary = await runCleanup(cleanCtx, { rootDir: CLEAN_ROOT, autoCleanDays: 5 }, cleanLog);
    check(summary.enabled === true && summary.scanned === 3 && summary.removed === 1 && summary.skipped === 1 && summary.failed === 0,
      `scan summary is precise (got ${JSON.stringify(summary)})`);
    check(!existsSync(path.join(CLEAN_ROOT, 'old-task')), 'expired marked dir deleted');
    check(existsSync(path.join(CLEAN_ROOT, 'fresh-task')), 'fresh marked dir kept');
    check(existsSync(path.join(CLEAN_ROOT, 'user-folder', 'keep.txt')), 'unmarked user dir never touched');
    check(state.workspaceDeletes.includes('ws-ghost'), 'workspace record dropped before dir removal');
    check(cleanLogs.some((line) => line.includes('cleanup: scanning')) && cleanLogs.some((line) => line.includes('cleanup: removed'))
      && cleanLogs.some((line) => line.includes('cleanup: done')),
      'scan + removal are fully logged (never silent)');

    const disabled = await runCleanup(cleanCtx, { rootDir: CLEAN_ROOT, autoCleanDays: 0 }, cleanLog);
    check(disabled.enabled === false && existsSync(path.join(CLEAN_ROOT, 'fresh-task')), 'autoCleanDays=0 disables the scan entirely');
    const missing = await runCleanup(cleanCtx, { rootDir: path.join(TMP, 'no-such-root'), autoCleanDays: 5 }, cleanLog);
    check(missing.enabled === true && missing.scanned === 0, 'missing rootDir tolerated (nothing to clean)');
    check(cleanLogs.some((line) => line.includes('does not exist yet')), 'missing root is logged');

    /* ---------------- 8. wire + fence units ---------------- */
    head('wire & trust-fence units');
    check(await throwsCode(readJsonBody(Readable.from([Buffer.from('{bad json')])), 'bad-request'), 'malformed JSON body -> bad-request');
    const empty = await readJsonBody(Readable.from([Buffer.from('  ')]));
    check(typeof empty === 'object' && Object.keys(empty).length === 0, 'empty body -> {}');
    const huge = Buffer.alloc((1 << 20) + 1, 0x61);
    check(await throwsCode(readJsonBody(Readable.from([huge])), 'bad-request'), 'body > 1MiB -> bad-request');
    check(await throwsCode(Promise.resolve().then(() => requireString({}, 'title')), 'bad-request'), 'requireString rejects missing fields');
    const apiErr = new ApiError('boom', 'msg', 412);
    check(apiErr.status === 412 && apiErr.code === 'boom' && apiErr.name === 'ApiError', 'ApiError carries code/status');

    check(isTrustedApiRequest({ headers: {} }, []) === false, 'missing Host -> untrusted');
    check(isTrustedApiRequest({ headers: { host: '127.0.0.1:43120' } }, []) === true, 'loopback Host -> trusted');
    check(isTrustedApiRequest({ headers: { host: 'localhost:43120' } }, []) === true, 'localhost Host -> trusted');
    check(isTrustedApiRequest({ headers: { host: '127.0.0.1:43120', 'sec-fetch-site': 'cross-site' } }, []) === false, 'cross-site marker refused');
    check(isTrustedApiRequest({ headers: { host: 'example.test:8080', origin: 'http://example.test:8080' } }, ['example.test:8080']) === true,
      'configured trusted authority accepted');
    check(isTrustedApiRequest({ headers: { host: 'example.test:8080', origin: 'http://other.test' } }, ['example.test:8080']) === false,
      'foreign origin refused even for trusted host');
    check(hasPluginHeader({ headers: { 'x-dsh-plugin': 'DSH-TASK-SPACE' } }) === true, 'plugin header value is case-insensitive');
    check(hasPluginHeader({ headers: { 'x-dsh-plugin': 'other' } }) === false, 'foreign plugin header rejected');

    /* ---------------- 9. client URL building (regression: HTTP_404) ------ */
    head('client URL building');
    const clientSource = await fs.readFile(new URL('../client.js', import.meta.url), 'utf8');
    check(clientSource.includes("pathname.startsWith('/')"),
      'callApi normalizes the base/path join (missing "/" caused /api/task-spacecreate -> 404)');
    const callSites = [...clientSource.matchAll(/callApi\(\s*'([^']*)'/g)].map((m) => m[1]);
    check(callSites.length > 0 && callSites.every((p) => p.startsWith('/')),
      `every callApi() site passes a leading-slash path (got: ${JSON.stringify(callSites)})`);
    check(!/fetch\(\s*API_BASE\s*\+\s*pathname/.test(clientSource),
      'fetch no longer joins API_BASE with a raw pathname');

    /* ---------------- 10. service() resolution order (regression: without inject) --- */
    head('service resolution order');
    for (const rel of ['../index.js', '../cleanup.js']) {
      const src = await fs.readFile(new URL(rel, import.meta.url), 'utf8');
      const body = /function service\(ctx, key\) \{([\s\S]*?)\n\}/.exec(src)?.[1] ?? '';
      check(body.length > 0, `service() found in ${rel}`);
      const getAt = body.indexOf('ctx.get(');
      const directAt = body.indexOf('ctx?.[');
      check(getAt !== -1 && directAt !== -1 && getAt < directAt,
        `${rel}: ctx.get(key) must run BEFORE direct ctx[key] access — direct access throws `
        + '"cannot get property ..." without inject for lazily resolved services');
    }

    /* -------- 11. session.create XOR contract (workspaceId vs cwd) -------- */
    head('session create contract');
    const indexSource = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8');
    check(!/workspaceId\s*,\s*cwd\s*:/.test(indexSource),
      'index.js never sends workspaceId AND cwd in one session.create request '
      + '(dsh-api-session-controller rejects the combination as bad-request)');

    /* -------- 12. hover-row open-directory action (client) ------------- */
    head('session row open-directory action');
    check(clientSource.includes("sidebar.workspaces.session.row.action"),
      'client registers into the native session-row hover action slot (archive/pin/delete row)');
    check(clientSource.includes('openWorkspacePath'),
      'opening goes through the official session.openWorkspacePath Remote (no plugin route)');
    check(clientSource.includes('openWorkspacePath({ path: cwd })'),
      'the remote request carries exactly the resolved session cwd');
    check(clientSource.includes("ApiFailure('NO_CWD'"),
      'a session without cwd surfaces NO_CWD instead of calling the remote');
    check(clientSource.includes("id: 'task-space-open-dir'") && /order:\s*50,/.test(clientSource),
      'row action registered with a stable id and order 50 (first injected action)');
    check(/const inject = \[[^\]]*'remote\.session'/.test(clientSource)
      && /const inject = \[[^\]]*'remote'/.test(clientSource),
      'client inject declares BOTH remote and remote.session — the client enforces the same '
      + '"without inject" gating as the Host, so ctx.remote.session.* throws without them');
    const pkgJson = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
    check(pkgJson.dsh.client.inject.includes('@deepseek-ai/dsh-client-connection'),
      'package.json client.inject lists @deepseek-ai/dsh-client-connection (owns the Remote the row button calls)');
  } finally {
    await unstashSettings();
    await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${'-'.repeat(50)}`);
  console.log(`SMOKE TEST: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('\nSMOKE TEST CRASHED:', error);
  process.exitCode = 1;
});
