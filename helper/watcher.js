import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { stableRead } from './utils.js';

export function watchBundle(file, onChange) {
  let timer, hash;

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

  // Seed synchronously, immediately after registering the watch, so no write
  // issued by the caller right after this call returns can possibly complete
  // before the seed does. Two independent async fs operations (an async seed
  // read racing a near-simultaneous write) have no guaranteed completion
  // order - either can "win", and if the write wins, the seed captures the
  // NEW content, making the very next real change look identical to the
  // seed and silently swallowing it. A synchronous read has no such race:
  // nothing else runs on this thread between fs.watch() returning and this
  // line executing.
  try {
    hash = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    hash = null; // file may not exist yet; the first real write will seed it via the watch callback
  }

  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}
