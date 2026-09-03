import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { watchBundle } from '../helper/watcher.js';

async function tempFile(contents) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'watcher-'));
  const file = path.join(dir, 'bundle.js');
  await fs.writeFile(file, contents);
  return { dir, file };
}

test('fires once for a single content change after the seed has settled', async () => {
  const { file } = await tempFile('v1');
  await new Promise(r => setTimeout(r, 300)); // let the seed read complete first

  const changes = [];
  const stop = watchBundle(file, ({ data }) => changes.push(data.toString()));

  await fs.writeFile(file, 'v2-different-length');
  await new Promise(r => setTimeout(r, 800));

  assert.deepEqual(changes, ['v2-different-length']);
  stop();
});

test('does not fire when the watched file never actually changes', async () => {
  const { file } = await tempFile('v1');
  await new Promise(r => setTimeout(r, 300));

  const changes = [];
  const stop = watchBundle(file, ({ data }) => changes.push(data.toString()));

  // Touch the file (rewrite identical content) - a real fs event with no real change.
  await fs.writeFile(file, 'v1');
  await new Promise(r => setTimeout(r, 800));

  assert.deepEqual(changes, []);
  stop();
});

test('regression: a burst of rapid same-length rewrites starting immediately after watch() must not be silently swallowed', async () => {
  // This reproduces a real bug: the initial hash seed used to be read through
  // a stability-gated loop. If the file kept changing while that loop was
  // still polling, the seed converged on the LAST value written instead of
  // the value present when watching started - making the real change that
  // followed look like "no change" and never firing onChange at all.
  const { file } = await tempFile('v1');

  const changes = [];
  const stop = watchBundle(file, ({ data }) => changes.push(data.toString()));

  // No settle delay: writes start racing the seed read immediately.
  await fs.writeFile(file, 'v2');
  await new Promise(r => setTimeout(r, 60));
  await fs.writeFile(file, 'v3');
  await new Promise(r => setTimeout(r, 60));
  await fs.writeFile(file, 'v4');

  await new Promise(r => setTimeout(r, 800));

  assert.ok(changes.length >= 1, 'a genuine content change must never be silently swallowed');
  assert.equal(changes.at(-1), 'v4', 'the final observed content must be the actual final content');
  stop();
});

test('stop() prevents any further onChange calls', async () => {
  const { file } = await tempFile('v1');
  await new Promise(r => setTimeout(r, 300));

  const changes = [];
  const stop = watchBundle(file, ({ data }) => changes.push(data.toString()));
  stop();

  await fs.writeFile(file, 'v2-different-length');
  await new Promise(r => setTimeout(r, 800));

  assert.deepEqual(changes, [], 'no callback should fire after stop() has been called');
});
