#!/usr/bin/env node
/**
 * dsh-task-space — manifest / permission-declaration / syntax validator.
 *
 * Usage:  node scripts/validate-manifest.mjs
 *
 * Checks (all must pass, exit code 0):
 *   1. package.json (manifest) structure — DSH Cordis bundle requirements
 *   2. dsh.bundle.patch / dsh.client declarations + referenced files exist
 *   3. locale metadata (meta.title / meta.description) + icon bounds
 *   4. permission audit: no install hooks, dependency allow-list only
 *   5. cordis.patch.yml insert row (id/name/config keys)
 *   6. every .js file parses as an ES module (node --check on a .mjs copy)
 *
 * No third-party dependencies — this script uses Node built-ins only.
 */
import { readFileSync, existsSync, statSync, copyFileSync, rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;

/** @param {string} name @param {boolean} ok @param {string} detail */
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Read a UTF-8 JSON file, returning null on failure. */
function readJson(rel) {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));
  } catch {
    return null;
  }
}

console.log('[1/6] package.json (manifest) structure');
const pkg = readJson('package.json');
check('package.json parses', pkg !== null);
if (!pkg) process.exit(1);
check('name', pkg.name === 'dsh-task-space', String(pkg.name));
check('version is semver', /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(pkg.version || ''), String(pkg.version));
// npm publish requires `private` to be absent/false (npm refuses `private: true`).
// The plugin is published to npm as part of the marketplace submission flow,
// so the manifest must stay publishable.
check('publishable package (private !== true)', pkg.private !== true, String(pkg.private));
check('license declared (npm publish requirement)', typeof pkg.license === 'string' && pkg.license.length > 0, String(pkg.license));
const repoUrl = pkg.repository && (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository.url);
check('repository declared (npm publish requirement)', typeof repoUrl === 'string' && repoUrl.length > 0, String(repoUrl));
check('LICENSE file shipped', existsSync(path.join(ROOT, 'LICENSE')));
check('type module', pkg.type === 'module');
const exportsMap = pkg.exports || {};
check('exports "." -> ./index.js', exportsMap['.'] === './index.js', JSON.stringify(exportsMap['.']));
check('exports "./client"', exportsMap['./client'] === './client.js', JSON.stringify(exportsMap['./client']));
check('exports "./package.json"', exportsMap['./package.json'] === './package.json');
check('exports "./locale/*.json"', exportsMap['./locale/*.json'] === './locale/*.json');
const files = Array.isArray(pkg.files) ? pkg.files : [];
check('files lists locale/*.json', files.includes('locale/*.json'));
check('files lists icon.svg', files.includes('icon.svg'));

console.log('[2/6] dsh.bundle.patch / dsh.client declarations');
const dsh = pkg.dsh || {};
const patchRel = dsh.bundle && dsh.bundle.patch;
check('dsh.bundle.patch declared', patchRel === './cordis.patch.yml', String(patchRel));
check('cordis.patch.yml exists', patchRel !== undefined && existsSync(path.join(ROOT, patchRel)));
const client = dsh.client || {};
check('dsh.client.platform === "web"', client.platform === 'web', String(client.platform));
const inject = Array.isArray(client.inject) ? client.inject : [];
check('dsh.client.inject non-empty', inject.length > 0, inject.join(', '));
check('dsh.client.inject are @deepseek-ai/* packages', inject.every((s) => typeof s === 'string' && s.startsWith('@deepseek-ai/')));
check('dsh.client.inject includes settings (configForms provider)', inject.includes('@deepseek-ai/dsh-client-ui-settings'), inject.join(', '));
for (const key of ['.', './client']) {
  const target = exportsMap[key];
  check(`entry file exists: ${key}`, typeof target === 'string' && existsSync(path.join(ROOT, target)), String(target));
}

console.log('[3/6] locale metadata + icon');
for (const locale of ['en', 'zh']) {
  const meta = readJson(`locale/${locale}.json`);
  check(`locale/${locale}.json parses`, meta !== null);
  if (meta) {
    check(`locale/${locale}.json meta.title`, typeof (meta.meta && meta.meta.title) === 'string' && meta.meta.title.length > 0);
    check(`locale/${locale}.json meta.description`, typeof (meta.meta && meta.meta.description) === 'string' && meta.meta.description.length > 0);
  }
}
const iconRel = pkg.icon;
check('icon declared', typeof iconRel === 'string' && iconRel.length > 0, String(iconRel));
if (typeof iconRel === 'string') {
  const iconAbs = path.join(ROOT, iconRel);
  const okExt = /\.(svg|png|jpe?g|webp)$/i.test(iconRel);
  check('icon extension svg/png/jpeg/webp', okExt, iconRel);
  if (existsSync(iconAbs)) {
    const size = statSync(iconAbs).size;
    check('icon ≤ 256 KiB', size <= 256 * 1024, `${size} bytes`);
  } else {
    check('icon file exists', false, iconAbs);
  }
}

console.log('[4/6] permission audit');
const pkgScripts = pkg.scripts || {};
const hookNames = Object.keys(pkgScripts).filter((k) => /^(pre|post)(install|publish|pack)$/.test(k) || k === 'install');
check('no install/publish lifecycle hooks', hookNames.length === 0, hookNames.join(', ') || 'none');
const DEP_ALLOW_LIST = ['@deepseek-ai/schemastery'];
const depNames = Object.keys(pkg.dependencies || {});
check('dependencies within DSH SDK allow-list', depNames.every((d) => DEP_ALLOW_LIST.includes(d)), depNames.join(', ') || 'none');
check('no peerDependencies surprises', Object.keys(pkg.peerDependencies || {}).every((d) => d.startsWith('@deepseek-ai/') || d === 'react' || d === 'react-dom'));
const idxSrc = readFileSync(path.join(ROOT, 'index.js'), 'utf8');
const clientSrc = readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const wireSrc = readFileSync(path.join(ROOT, 'wire.js'), 'utf8');
const fenceSrc = readFileSync(path.join(ROOT, 'trust-fence.js'), 'utf8');
check('host declares export const Config (validated schema)', /export\s+const\s+Config\b/.test(idxSrc));
check('host declares service inject list', /export\s+const\s+inject\s*=/.test(idxSrc));
// Volatile fields are what make the four settings appear in the plugin-page
// configuration form (Host settings describe() skips non-volatile schemas).
const volatileFields = ['rootDir', 'folderTemplate', 'defaultPreset', 'autoCleanDays'];
for (const field of volatileFields) {
  check(`Config.${field} is .volatile()`, new RegExp(`${field}:\\s*z\\.(?:string|number)\\(\\)[^;]*?\\.volatile\\(\\)`).test(idxSrc));
}
check('client registers plugins.row.config', /plugins\.row\.config/.test(clientSrc));
check('client row config key is <package>#<row id>', /dsh-task-space#task-space/.test(clientSrc));
check('client gates row config on whileServed', /whileServed\(\[CONFIG_NS\]/.test(clientSrc));
check('client reads configForms service', /configForms\s*\.\s*get\(CONFIG_NS\)/.test(clientSrc));
check('mutating routes enforce x-dsh-plugin header', /x-dsh-plugin/.test(fenceSrc));
check('error envelope present in wire.js', /ok:\s*false/.test(wireSrc) && /ok:\s*true/.test(wireSrc));

console.log('[5/6] cordis.patch.yml insert row');
const patchText = existsSync(path.join(ROOT, 'cordis.patch.yml')) ? readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8') : '';
check('- insert: present', /^\s*-\s*insert:/m.test(patchText));
check('row id: task-space', /^\s*-?\s*id:\s*task-space\s*$/m.test(patchText));
check('row name: dsh-task-space', /name:\s*dsh-task-space\s*$/m.test(patchText));
for (const key of ['rootDir', 'folderTemplate', 'defaultPreset', 'autoCleanDays']) {
  check(`config.${key} present`, new RegExp(`\\b${key}:`).test(patchText));
}
const settingsText = existsSync(path.join(ROOT, 'settings.yaml')) ? readFileSync(path.join(ROOT, 'settings.yaml'), 'utf8') : '';
for (const key of ['rootDir', 'folderTemplate', 'defaultPreset', 'autoCleanDays']) {
  check(`settings.yaml ${key}`, new RegExp(`^${key}:`, 'm').test(settingsText));
}

console.log('[6/6] ES module syntax (node --check on .mjs copies)');
const jsFiles = ['index.js', 'client.js', 'wire.js', 'trust-fence.js', 'config.js', 'cleanup.js', 'scripts/validate-manifest.mjs'];
const tmpDir = path.join(os.tmpdir(), `dsh-task-space-syntax-${process.pid}`);
mkdirSync(tmpDir, { recursive: true });
for (const rel of jsFiles) {
  const abs = path.join(ROOT, rel);
  if (!existsSync(abs)) {
    check(`syntax ${rel}`, false, 'file missing');
    continue;
  }
  const tmp = path.join(tmpDir, path.basename(rel).replace(/\.js$/, '.mjs'));
  copyFileSync(abs, tmp);
  const res = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
  check(`syntax ${rel}`, res.status === 0, res.status === 0 ? '' : String(res.stderr || '').split('\n')[0]);
}
try {
  rmSync(tmpDir, { recursive: true, force: true });
} catch { /* best effort */ }

console.log('');
if (failures === 0) {
  console.log('ALL CHECKS PASSED — manifest valid, permission declarations clean.');
  process.exit(0);
} else {
  console.error(`${failures} check(s) FAILED`);
  process.exit(1);
}
