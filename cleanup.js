// @ts-check
/**
 * dsh-task-space — asynchronous auto-cleanup of expired task directories.
 *
 * Design rules (explicit plugin requirements):
 *   - runs on every 【新建临时对话】 click, asynchronously (fire-and-forget)
 *   - deletes a direct subdirectory of rootDir only when ALL hold:
 *       1. it carries this plugin's marker file (.dsh-task-space.json),
 *          so user-created folders in the same root are never touched
 *       2. its creation time is older than `autoCleanDays`
 *   - every deletion is logged — the scan is never silent
 *   - `autoCleanDays === 0` disables the scan entirely
 *
 * @module dsh-task-space/cleanup
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { expandHome, readMarker } from './config.js';

/** Milliseconds in one day. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve a host service by name (same lookup rule as index.js).
 * @param {any} ctx - Cordis context.
 * @param {string} key - service name.
 * @returns {any}
 */
function service(ctx, key) {
  // Same contract as index.js: `ctx.get` first (inject-free, never throws,
  // returns undefined when absent); direct property access only as a safe
  // fallback — it THROWS `cannot get property ... without inject` for
  // services missing from this fiber's inject list.
  try {
    const viaGet = typeof ctx?.get === 'function' ? ctx.get(key) : undefined;
    if (viaGet !== undefined && viaGet !== null) return viaGet;
  } catch {
    /* fall through */
  }
  try {
    const direct = ctx?.[key];
    if (direct !== undefined && direct !== null) return direct;
  } catch {
    /* fall through */
  }
  return undefined;
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Drop the workspace record for a directory that is about to be deleted, so
 * the sidebar does not keep a dangling entry. Best effort: a failure logs a
 * warning and never blocks the directory removal.
 *
 * @param {any} ctx - Cordis context.
 * @param {string} dir - absolute directory being removed.
 * @param {{info: Function, warn: Function}} log - logger.
 * @returns {Promise<void>}
 */
async function removeWorkspaceRecord(ctx, dir, log) {
  const registry = service(ctx, 'workspaceRegistry');
  if (!registry || typeof registry.resolveByPath !== 'function') return;
  try {
    const workspace = await registry.resolveByPath(path.resolve(dir));
    if (!workspace) return;
    const workspaceId = workspace.workspaceId ?? workspace.id;
    if (typeof workspaceId !== 'string' || workspaceId === '') return;
    const control = service(ctx, 'workspaceController');
    if (control && typeof control.delete === 'function') {
      await control.delete({ workspaceId });
    } else if (typeof registry.delete === 'function') {
      await registry.delete(workspaceId);
    } else {
      return;
    }
    log.info(`cleanup: dropped workspace record ${workspaceId} for "${dir}"`);
  } catch (error) {
    log.warn(`cleanup: could not drop workspace record for "${dir}": ${messageOf(error)}`);
  }
}

/**
 * Read a directory's effective creation timestamp: marker first (the moment
 * the plugin created it), filesystem birthtime as fallback.
 *
 * @param {string} dir - absolute directory.
 * @param {{taskId?: string, createdAt?: string} | undefined} marker - parsed marker.
 * @returns {Promise<number | undefined>} epoch ms, or undefined when unreadable.
 */
async function createdAtOf(dir, marker) {
  const fromMarker = Date.parse(marker?.createdAt ?? '');
  if (Number.isFinite(fromMarker)) return fromMarker;
  try {
    const stat = await fs.stat(dir);
    const birth = stat.birthtimeMs || stat.ctimeMs;
    return Number.isFinite(birth) && birth > 0 ? birth : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Perform one auto-cleanup scan.
 *
 * @param {any} ctx - Cordis context.
 * @param {{rootDir: string, autoCleanDays: number}} cfg - effective configuration.
 * @param {{info: (...a: unknown[]) => void, warn: (...a: unknown[]) => void}} log - logger.
 * @returns {Promise<{enabled: boolean, scanned: number, removed: number, skipped: number, failed: number}>}
 */
export async function runCleanup(ctx, cfg, log) {
  const summary = { enabled: false, scanned: 0, removed: 0, skipped: 0, failed: 0 };
  const days = Number(cfg?.autoCleanDays) || 0;
  if (days <= 0) return summary; // autoCleanDays = 0 -> disabled, no scan at all
  summary.enabled = true;

  const root = path.resolve(expandHome(String(cfg.rootDir ?? '')));
  const cutoff = Date.now() - days * DAY_MS;

  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error)?.code;
    if (code === 'ENOENT') {
      log.info(`cleanup: task root "${root}" does not exist yet — nothing to clean`);
      return summary;
    }
    log.warn(`cleanup: cannot scan "${root}": ${messageOf(error)}`);
    return summary;
  }

  log.info(`cleanup: scanning "${root}" (autoCleanDays=${days}, cutoff=${new Date(cutoff).toISOString()})`);

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    summary.scanned += 1;
    const dir = path.join(root, entry.name);

    const marker = await readMarker(dir);
    if (!marker) {
      // Not created by this plugin -> never touched.
      summary.skipped += 1;
      continue;
    }

    const createdMs = await createdAtOf(dir, marker);
    if (createdMs === undefined) {
      log.warn(`cleanup: cannot determine creation time of "${dir}" — skipped`);
      summary.failed += 1;
      continue;
    }
    if (createdMs >= cutoff) continue; // still fresh

    const ageDays = Math.floor((Date.now() - createdMs) / DAY_MS);
    // Drop the sidebar record first, then the directory — every step logged.
    await removeWorkspaceRecord(ctx, dir, log);
    try {
      await fs.rm(dir, { recursive: true, force: false });
      summary.removed += 1;
      log.info(`cleanup: removed "${dir}" (created ${new Date(createdMs).toISOString()}, age ${ageDays}d > ${days}d, task ${marker.taskId ?? 'unknown'})`);
    } catch (error) {
      summary.failed += 1;
      log.warn(`cleanup: failed to remove "${dir}": ${messageOf(error)}`);
    }
  }

  log.info(`cleanup: done — scanned ${summary.scanned}, removed ${summary.removed}, skipped ${summary.skipped}, failed ${summary.failed}`);
  return summary;
}
