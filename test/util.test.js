import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stableRead } from '../helper/utils.js';

test('stableRead reads complete bundle', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-v1-'));
  const f = path.join(d, 'bundle.js');
  await fs.writeFile(f, 'bundle');
  assert.equal((await stableRead(f, { attempts: 3, interval: 2 })).data.toString(), 'bundle');
  await fs.rm(d, { recursive: true, force: true });
});
