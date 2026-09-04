import fs from 'node:fs/promises';
import path from 'node:path';

const CANDIDATE_SCRIPTS = ['start:watch', 'watch', 'dev', 'start'];

/**
 * A directory is the PCF project root only if its OWN package.json declares
 * pcf-scripts. A ControlManifest.Input.xml alone is not sufficient: in a repo
 * like QOE-PCF-X/SOM_X/X/, the manifest sits beside the real project's
 * package.json while a repo-level package.json sits several levels above.
 * Accepting the manifest without checking that directory's own package.json
 * risks returning a root whose npm scripts don't exist, so "npm run
 * start:watch" fails with a missing-script error.
 */
async function looksLikePcfProject(dir) {
  try {
    const raw = await fs.readFile(path.join(dir, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.dependencies?.['pcf-scripts'] || parsed.devDependencies?.['pcf-scripts']) return true;

    // Fallback for projects that vendor pcf-scripts differently: accept a
    // package.json that has scripts AND a ControlManifest beside it.
    if (parsed.scripts && Object.keys(parsed.scripts).length) {
      try {
        await fs.access(path.join(dir, 'ControlManifest.Input.xml'));
        return true;
      } catch {
        return false;
      }
    }
    return false;
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
