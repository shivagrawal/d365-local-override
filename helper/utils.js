import fs from 'node:fs/promises';
import path from 'node:path';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const formatSize = bytes => bytes < 1048576
  ? `${(bytes / 1024).toFixed(1)} KB`
  : `${(bytes / 1048576).toFixed(2)} MB`;

export async function stableRead(file, { attempts = 15, interval = 100 } = {}) {
  let previous;
  for (let i = 0; i < attempts; i++) {
    const stat = await fs.stat(file).catch(() => null);
    if (stat?.size > 0 && previous?.size === stat.size && previous.mtimeMs === stat.mtimeMs) {
      const data = await fs.readFile(file);
      if (data.length === stat.size) return { data, stat };
    }
    previous = stat;
    await sleep(interval);
  }
  throw new Error(`Bundle did not become readable and stable: ${file}`);
}

export const normalize = value => path.resolve(value);
