import fs from 'node:fs/promises';
import path from 'node:path';

const CANDIDATE_SCRIPTS = ['start:watch', 'watch', 'dev', 'start'];

async function looksLikePcfProject(dir) {
  try {
    await fs.access(path.join(dir, 'ControlManifest.Input.xml'));
    return true;
  } catch {
    // fall through to checking package.json's dependencies
  }
  try {
    const raw = await fs.readFile(path.join(dir, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return Boolean(parsed.dependencies?.['pcf-scripts'] || parsed.devDependencies?.['pcf-scripts']);
  } catch {
    return false;
  }
}

/**
 * Walk up from a bundle file's directory to find the nearest ancestor that
 * is genuinely a PCF control project - not just any directory that happens
 * to contain a package.json. Without the ControlManifest.Input.xml/
 * pcf-scripts check, a walk that doesn't find a real project root nearby can
 * keep climbing past legitimate boundaries (out of a temp folder, past
 * AppData, into the user's home directory) and land on some unrelated
 * package.json there, suggesting the wrong project's npm scripts entirely.
 */
export async function findPcfProjectRoot(bundlePath, maxLevels = 8) {
  let dir = path.resolve(path.dirname(bundlePath));

  for (let level = 0; level <= maxLevels; level++) {
    let hasPackageJson = false;
    try {
      await fs.access(path.join(dir, 'package.json'));
      hasPackageJson = true;
    } catch {
      // no package.json at this level; keep walking up regardless
    }

    if (hasPackageJson && await looksLikePcfProject(dir)) return dir;

    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return null;
}

/**
 * Read a project's npm scripts. Returns {} on any read/parse failure rather
 * than throwing - a missing or malformed package.json just means no scripts
 * were found, not a hard error for the caller.
 */
export async function readNpmScripts(projectRoot) {
  try {
    const raw = await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed.scripts && typeof parsed.scripts === 'object' ? parsed.scripts : {};
  } catch {
    return {};
  }
}

/**
 * Pick the best watch-style script from a project's scripts map. Prefers an
 * explicit watch-flavored name; falls back to plain "start" since
 * pcf-scripts' own "start" already runs a watching dev server by default in
 * standard PCF projects. Returns null when nothing plausible is present, so
 * the caller can ask the developer to choose instead of guessing wrong.
 */
export function pickWatchScript(scripts) {
  for (const name of CANDIDATE_SCRIPTS) {
    if (Object.prototype.hasOwnProperty.call(scripts, name)) return name;
  }
  return null;
}

/**
 * Convenience: detect project root, available scripts, and the suggested
 * one in a single call for the extension's "PCF build watch" panel.
 */
export async function detectWatchTarget(bundlePath) {
  const projectRoot = await findPcfProjectRoot(bundlePath);
  if (!projectRoot) {
    return { projectRoot: null, scripts: {}, suggested: null };
  }
  const scripts = await readNpmScripts(projectRoot);
  return { projectRoot, scripts, suggested: pickWatchScript(scripts) };
}
