import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { stableRead } from './utils.js';

export function watchBundle(file, onChange) {
  let timer, hash;
  stableRead(file)
    .then(({ data }) => hash = createHash('sha256').update(data).digest('hex'))
    .catch(() => {});

  const watcher = fs.watch(path.dirname(file), (_e, name) => {
    if (name && name.toString() !== path.basename(file)) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const result = await stableRead(file);
        const next = createHash('sha256').update(result.data).digest('hex');
        if (next !== hash) {
          hash = next;
          await onChange(result);
        }
      } catch (e) {
        console.error(`Watcher: ${e.message}`);
      }
    }, 250);
  });

  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}
