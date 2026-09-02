import fs from 'node:fs/promises';
import path from 'node:path';

const isBundleName = name => /^bundle(?:\.min)?\.js$/i.test(name);

async function walk(dir, depth, found) {
  if (depth < 0) return;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, depth - 1, found);
    else if (isBundleName(entry.name)) found.push(full);
  }
}

export async function discoverBundles(root) {
  const found = [];
  for (const folder of ['out', 'dist', 'build']) {
    await walk(path.join(root, folder), 6, found).catch(error => {
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
    const direct = (await fs.readdir(resolved, { withFileTypes: true }))
      .filter(entry => entry.isFile() && isBundleName(entry.name))
      .map(entry => path.join(resolved, entry.name));

    if (direct.length > 1) {
      throw new Error(`Multiple bundles found in ${resolved}. Select the exact bundle file.`);
    }
    if (direct.length === 1) return { bundles: direct, resourceType: 'pcf' };

    const discovered = await discoverBundles(resolved);
    if (!discovered.length) {
      throw new Error(`No bundle.js found directly inside, or under out/dist/build of:\n${resolved}`);
    }
    return { bundles: discovered, resourceType: 'pcf' };
  }

  if (!stat.isFile()) throw new Error(`Path must be a file or folder:\n${resolved}`);

  const extension = path.extname(resolved).toLowerCase();
  if (extension === '.html' || extension === '.htm') {
    return { bundles: [resolved], resourceType: 'html' };
  }
  if (extension === '.js') {
    return {
      bundles: [resolved],
      resourceType: isBundleName(path.basename(resolved)) ? 'pcf' : 'script'
    };
  }

  throw new Error(`Unsupported file type "${extension || 'none'}". Select a .js, .html, or PCF bundle folder:\n${resolved}`);
}
