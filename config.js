// @ts-check
/**
 * dsh-task-space — configuration resolution, folder-template rendering, and
 * permission-checked directory creation (Host side).
 *
 * Config precedence (low -> high), merged on every request so a settings.yaml
 * edit applies to the very next click without restarting DSH:
 *   1. DEFAULTS (this file)
 *   2. the Cordis row `config` (cordis.patch.yml / Settings auto-form writes)
 *   3. the package-root `settings.yaml` (user requirement: plugin settings file)
 *
 * All file-system operations in this module are confined to the resolved
 * `rootDir`; task folder names are sanitized so a template can never traverse
 * outside of it.
 *
 * @module dsh-task-space/config
 */

import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError } from './wire.js';

/** Package root (this module lives at the package root). */
const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));

/** Path of the plugin's settings file (highest-precedence config layer). */
export const SETTINGS_FILE = path.join(PACKAGE_ROOT, 'settings.yaml');

/** Marker file written into every task directory; cleanup only ever removes marked dirs. */
export const MARKER_FILE = '.dsh-task-space.json';

/** Default folder template: `${YYYYMMDD}-${HHMMSS}-${taskShortId}`. */
export const DEFAULT_TEMPLATE = '${YYYYMMDD}-${HHMMSS}-${taskShortId}';

/** Built-in configuration defaults (lowest precedence). */
export const DEFAULTS = Object.freeze({
  rootDir: '~/.dsh/tasks',
  folderTemplate: DEFAULT_TEMPLATE,
  defaultPreset: 'standard',
  autoCleanDays: 0,
});

/** The only config keys this plugin accepts (everything else in the file is ignored). */
const CONFIG_KEYS = /** @type {const} */ (['rootDir', 'folderTemplate', 'defaultPreset', 'autoCleanDays']);

/**
 * Effective, fully-typed plugin configuration.
 * @typedef {Object} TaskSpaceConfig
 * @property {string} rootDir - task root directory (may contain a leading `~`).
 * @property {string} folderTemplate - folder name template with `${...}` variables.
 * @property {string} defaultPreset - agent preset id for new task sessions.
 * @property {number} autoCleanDays - 0 disables auto-cleanup; >0 deletes task dirs older than N days.
 */

/**
 * Expand a leading `~` / `~user` against the current home directory.
 * @param {string} value - configured path.
 * @returns {string} absolute path.
 */
export function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
  return value;
}

/**
 * Parse the plugin's deliberately-minimal settings.yaml dialect:
 * top-level `key: value` lines, full-line `#` comments, optional single or
 * double quotes around the value. No nested structures are supported (the
 * config surface is flat by design).
 * @param {string} text - raw file content.
 * @returns {Record<string, unknown>} parsed entries.
 */
export function parseSettingsYaml(text) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith("'") && value.endsWith("'") && value.length >= 2) || (value.startsWith('"') && value.endsWith('"') && value.length >= 2)) {
      value = value.slice(1, -1);
    } else if (/^-?\d+(\.\d+)?$/.test(value)) {
      value = Number(value);
    } else if (value === 'true' || value === 'false') {
      value = value === 'true';
    }
    out[match[1]] = value;
  }
  return out;
}

/**
 * Read the package-root settings.yaml (best effort — a missing or malformed
 * file falls back to the lower-precedence layers instead of failing creation).
 * @returns {Record<string, unknown>} parsed (possibly empty) entries.
 */
export function readSettingsFile() {
  try {
    // Synchronous on purpose: called per request, file is tiny, and it keeps
    // config resolution a pure function of the request path.
    return parseSettingsYaml(readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Merge all config layers into a typed, validated configuration.
 * @param {unknown} rowConfig - the Cordis row config passed to `apply(ctx, config)`.
 * @returns {TaskSpaceConfig} effective configuration.
 */
export function resolveEffectiveConfig(rowConfig) {
  const row = typeof rowConfig === 'object' && rowConfig !== null ? /** @type {Record<string, unknown>} */ (rowConfig) : {};
  const file = readSettingsFile();
  /** @type {Record<string, unknown>} */
  const merged = { ...DEFAULTS };
  for (const key of CONFIG_KEYS) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== '') merged[key] = row[key];
    if (file[key] !== undefined && file[key] !== null && file[key] !== '') merged[key] = file[key];
  }
  const autoCleanDays = Number(merged.autoCleanDays);
  return {
    rootDir: typeof merged.rootDir === 'string' && merged.rootDir !== '' ? merged.rootDir : String(DEFAULTS.rootDir),
    folderTemplate: typeof merged.folderTemplate === 'string' && merged.folderTemplate !== '' ? merged.folderTemplate : DEFAULT_TEMPLATE,
    defaultPreset: typeof merged.defaultPreset === 'string' && merged.defaultPreset !== '' ? merged.defaultPreset : String(DEFAULTS.defaultPreset),
    autoCleanDays: Number.isFinite(autoCleanDays) && autoCleanDays > 0 ? Math.floor(autoCleanDays) : 0,
  };
}

/** Pad a number to a two-digit string. */
function pad2(value) {
  return String(value).padStart(2, '0');
}

/** `YYYYMMDD` for `now`. */
function dateToken(now) {
  return `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
}

/** `HHMMSS` for `now`. */
function timeToken(now) {
  return `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
}

/**
 * Render the folder-name template.
 *
 * Supported variables (both spellings kept for compatibility with the
 * documented defaults):
 *   `${YYYYMMDD}` / `${date}`   -> 20260214
 *   `${HHMMSS}`   / `${time}`   -> 153045
 *   `${taskId}`   / `${taskShortId}` -> 8-char random id
 *   `${taskTitle}`              -> caller-supplied title ('' when absent)
 *
 * The result is then sanitized into a legal single path segment; an empty
 * result falls back to the default template rendered with the same values.
 *
 * @param {string} template - configured template.
 * @param {Object} vars - rendering inputs.
 * @param {string} vars.taskId - short task id.
 * @param {string} [vars.taskTitle] - optional task title.
 * @param {Date} [vars.now] - clock (injectable for tests).
 * @returns {string} a single, legal folder name (never contains separators).
 */
export function renderFolderName(template, vars) {
  const now = vars.now ?? new Date();
  const date = dateToken(now);
  const time = timeToken(now);
  const title = vars.taskTitle ?? '';
  const values = {
    YYYYMMDD: date,
    date,
    HHMMSS: time,
    time,
    taskId: vars.taskId,
    taskShortId: vars.taskId,
    taskTitle: title,
  };
  /** @param {string} source */
  const render = (source) => source.replace(/\$\{([A-Za-z][A-Za-z0-9]*)\}/g, (whole, name) => (name in values ? String(values[/** @type {keyof typeof values} */ (name)]) : whole));
  const rendered = render(template).trim();
  const sanitized = sanitizeFolderName(rendered);
  if (sanitized !== '') return sanitized;
  // Template rendered to nothing (e.g. empty title only) -> fall back.
  const fallback = sanitizeFolderName(render(render(DEFAULT_TEMPLATE)));
  return fallback !== '' ? fallback : `task-${vars.taskId}`;
}

/**
 * Sanitize a string into one legal Windows/POSIX path segment.
 * Separators and Windows-illegal characters are replaced, trailing dots and
 * spaces are trimmed, and `.` / `..` / drive-relative names are refused.
 * @param {string} name - raw candidate.
 * @returns {string} sanitized name ('' when nothing legal remains).
 */
export function sanitizeFolderName(name) {
  let out = String(name)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/g, '')
    .trim();
  if (out === '.' || out === '..') return '';
  // Windows reserved device names (also illegal with any extension).
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(out)) out = `_${out}`;
  return out;
}

/**
 * Map a filesystem error onto a user-facing ApiError code.
 * @param {unknown} error - caught fs error.
 * @param {string} fallbackCode - code when the errno is not permission-related.
 * @param {string} action - human action phrase for the message.
 * @returns {ApiError}
 */
function fsErrorToApi(error, fallbackCode, action) {
  const err = /** @type {NodeJS.ErrnoException} */ (error);
  const code = err?.code ?? '';
  const detail = `${err?.message ?? String(error)}`;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return new ApiError('ROOT_ACCESS_DENIED', `permission denied while ${action}: ${detail}`, 403);
  }
  return new ApiError(fallbackCode, `${action}: ${detail}`, 400);
}

/**
 * Ensure the task root exists and is writable — the plugin's permission gate.
 * Throws a localized-by-code ApiError when the directory cannot be created or
 * written (surfaced as a WebUI dialog by the client).
 *
 * @param {string} rootDir - absolute root path.
 * @returns {Promise<string>} the verified absolute root path.
 */
export async function ensureRootDir(rootDir) {
  if (typeof rootDir !== 'string' || rootDir.trim() === '') {
    throw new ApiError('PATH_INVALID', 'rootDir is empty — set it in settings.yaml', 400);
  }
  let stat;
  try {
    stat = await fs.stat(rootDir);
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error)?.code;
    if (code === 'ENOENT') {
      try {
        await fs.mkdir(rootDir, { recursive: true });
      } catch (mkdirError) {
        throw fsErrorToApi(mkdirError, 'ROOT_CREATE_FAILED', `creating task root "${rootDir}"`);
      }
      stat = await fs.stat(rootDir).catch(() => null);
      if (!stat) throw new ApiError('ROOT_CREATE_FAILED', `task root vanished after creation: ${rootDir}`, 400);
    } else if (code === 'EACCES' || code === 'EPERM') {
      throw new ApiError('ROOT_ACCESS_DENIED', `permission denied reading task root "${rootDir}"`, 403);
    } else {
      throw fsErrorToApi(error, 'PATH_INVALID', `accessing task root "${rootDir}"`);
    }
  }
  if (!stat.isDirectory()) {
    throw new ApiError('PATH_INVALID', `rootDir exists but is not a directory: ${rootDir}`, 400);
  }
  try {
    await fs.access(rootDir, fs.constants.W_OK | fs.constants.X_OK);
  } catch (error) {
    throw fsErrorToApi(error, 'ROOT_ACCESS_DENIED', `writing task root "${rootDir}"`);
  }
  return rootDir;
}

/**
 * Create the task directory under a verified root (no picker dialog involved).
 *
 * Permission model: the parent was just verified writable, the folder name is
 * a sanitized single segment (never a separator or `..`), and the final path
 * is re-checked to resolve inside `rootDir`. Existing name collisions get a
 * deterministic `-2`, `-3`, ... suffix instead of failing.
 *
 * @param {string} rootDir - verified absolute root path.
 * @param {string} folderName - sanitized folder name.
 * @returns {Promise<string>} absolute path of the created directory.
 */
export async function createTaskDir(rootDir, folderName) {
  if (folderName === '' || folderName.includes('/') || folderName.includes('\\') || folderName === '.' || folderName === '..') {
    throw new ApiError('PATH_INVALID', `illegal folder name: "${folderName}"`, 400);
  }
  const rootResolved = path.resolve(rootDir);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = attempt === 0 ? folderName : `${folderName}-${attempt + 1}`;
    const target = path.resolve(rootResolved, candidate);
    if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
      throw new ApiError('PATH_INVALID', `refusing to create a directory outside rootDir: ${target}`, 400);
    }
    try {
      await fs.mkdir(target, { recursive: false });
      return target;
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error)?.code;
      if (code === 'EEXIST') continue;
      throw fsErrorToApi(error, 'MKDIR_FAILED', `creating task directory "${target}"`);
    }
  }
  throw new ApiError('MKDIR_FAILED', `could not allocate a unique folder name under ${rootResolved}`, 400);
}

/**
 * Write the plugin marker into a fresh task directory.
 * Cleanup only ever considers marked directories, so user-created folders in
 * the same root are never touched.
 * @param {string} dir - absolute task directory.
 * @param {{taskId: string, template: string, title?: string}} info - marker payload.
 * @returns {Promise<void>}
 */
export async function writeMarker(dir, info) {
  const payload = {
    plugin: 'dsh-task-space',
    version: 1,
    taskId: info.taskId,
    template: info.template,
    title: info.title ?? '',
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(dir, MARKER_FILE), JSON.stringify(payload, null, 2), 'utf8');
}

/**
 * Read a task marker; `undefined` when absent or unreadable.
 * @param {string} dir - absolute directory.
 * @returns {Promise<{taskId?: string, createdAt?: string} | undefined>}
 */
export async function readMarker(dir) {
  try {
    const text = await fs.readFile(path.join(dir, MARKER_FILE), 'utf8');
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}
