import fs from 'node:fs/promises';
import path from 'node:path';

const isBundleName = name => /^bundle(?:\.min)?\.js$/i.test(name);
const SKIP_DIRS = ['node_modules', '.git', '.vs', 'obj', 'bin'];

/** Derive resource type from a specific file path. The one source of truth
 * for "what kind of override is this" - callers should derive from the
 * actual selected file, not carry a separate type value that can go stale
 * relative to what's actually selected. */
export function deriveResourceType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.html' || extension === '.htm') return 'html';
  if (extension === '.js') return isBundleName(path.basename(filePath)) ? 'pcf' : 'script';
  return null;
}

async function walk(dir, depth, found) {
  if (depth < 0) return;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, depth - 1, found);
    else if (isBundleName(entry.name)) found.push(full);
  }
}

/** Recursively collect every .js/.html file under a folder - the fallback
 * when a folder contains plain web resources rather than a PCF build. */
async function collectWebResources(dir, depth, found) {
  if (depth < 0) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectWebResources(full, depth - 1, found);
    } else if (deriveResourceType(entry.name)) {
      found.push(full);
    }
  }
}

const BUILD_FOLDER_NAMES = ['out', 'dist', 'build'];

async function findBuildFolders(root, depth, found) {
  if (depth < 0) return;
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.includes(entry.name)) continue;
    const full = path.join(root, entry.name);
    if (BUILD_FOLDER_NAMES.includes(entry.name)) {
      found.add(full);
      continue; // don't look for a build folder nested inside a build folder
    }
    await findBuildFolders(full, depth - 1, found);
  }
}

export async function discoverBundles(root) {
  const buildFolders = new Set();
  // Depth 4 covers root/out (a single-control project) as well as
  // root/ControlA/out (a multi-control solution folder) without scanning an
  // entire large repository.
  await findBuildFolders(root, 4, buildFolders);

  const found = [];
  for (const folder of buildFolders) {
    await walk(folder, 6, found).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  // Fallback: some build tooling doesn't use out/dist/build at all. If the
  // targeted search found nothing, fall back to a full (bounded) recursive
  // search from the root itself, regardless of intermediate folder names.
  if (!found.length) {
    await walk(root, 8, found).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  return [...new Set(found)];
}

async function resolveTypedFile(input, extension, option, label) {
  const resolved = path.resolve(input);
  let stat;
  try { stat = await fs.stat(resolved); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`${label} path does not exist:\n${resolved}`);
    throw error;
  }
  if (!stat.isFile() || path.extname(resolved).toLowerCase() !== extension) {
    throw new Error(`${option} requires an existing ${label} file:\n${resolved}`);
  }
  return resolved;
}

export const resolveScript = input => resolveTypedFile(input, '.js', '--script', 'JavaScript');
export const resolveHtml = input => resolveTypedFile(input, '.html', '--html', 'HTML');

/**
 * Resolve an arbitrary user-chosen path (file or folder). Returns
 * { bundles, resourceType }. `resourceType` is only a UI hint for what to
 * show first - callers that add an override rule must derive the real type
 * per-file via deriveResourceType(bundlePath), since a folder can contain a
 * mix of PCF bundles, plain scripts, and HTML web resources together.
 *
 * Folder -> PCF bundles at any depth, if any exist; otherwise every
 *           .js/.html file found anywhere under the folder (a plain web
 *           resource folder is just as valid a selection as a PCF build).
 * *.html  -> html
 * bundle(.min).js -> pcf
 * other *.js -> script
 */
export async function resolveArtifact(input) {
  const resolved = path.resolve(input);
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Path does not exist:\n${resolved}`);
    throw error;
  }

  if (stat.isDirectory()) {
    const bundles = await discoverBundles(resolved);
    if (bundles.length) return { bundles, resourceType: 'pcf' };

    const webResources = [];
    await collectWebResources(resolved, 8, webResources);
    if (webResources.length) {
      return { bundles: webResources, resourceType: deriveResourceType(webResources[0]) };
    }

    throw new Error(`No bundle.js, .js, or .html file found anywhere under:\n${resolved}`);
  }

  if (!stat.isFile()) throw new Error(`Path must be a file or folder:\n${resolved}`);

  const resourceType = deriveResourceType(resolved);
  if (!resourceType) {
    throw new Error(`Unsupported file type "${path.extname(resolved) || 'none'}". Select a .js, .html, or PCF bundle folder:\n${resolved}`);
  }
  return { bundles: [resolved], resourceType };
}

export async function resolveBundle(input) {
  const resolved = path.resolve(input);
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Bundle path does not exist:\n${resolved}`);
    throw error;
  }

  if (stat.isFile()) {
    if (!isBundleName(path.basename(resolved))) {
      throw new Error(`Expected bundle.js or bundle.min.js, received:\n${resolved}`);
    }
    return resolved;
  }
  if (!stat.isDirectory()) throw new Error(`Bundle path must be a file or folder:\n${resolved}`);

  const matches = (await fs.readdir(resolved, { withFileTypes: true }))
    .filter(entry => entry.isFile() && isBundleName(entry.name))
    .map(entry => path.join(resolved, entry.name));
  if (!matches.length) throw new Error(`No bundle.js found directly inside:\n${resolved}`);
  if (matches.length > 1) throw new Error(`Multiple bundles found in ${resolved}. Pass the exact bundle file.`);
  return matches[0];
}
