import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseLaunchArgs } from '../helper/cli.js';
import { resolveBundle, resolveHtml, resolveScript } from '../helper/bundles.js';

test('parses launch options', () => {
  assert.deepEqual(parseLaunchArgs(['--root', 'C:\\project', '--bundle', 'C:\\project\\bundle.js']), {
    root: 'C:\\project', bundle: 'C:\\project\\bundle.js'
  });
  assert.throws(() => parseLaunchArgs(['--bundle']), /requires/);
  assert.deepEqual(parseLaunchArgs(['--script', 'C:\\scripts\\account.js']), { script: 'C:\\scripts\\account.js' });
  assert.deepEqual(parseLaunchArgs(['--html', 'C:\\pages\\dialog.html']), { html: 'C:\\pages\\dialog.html' });
  assert.throws(() => parseLaunchArgs(['--bundle', 'bundle.js', '--script', 'form.js']), /only one/);
});

test('resolves bundle file or containing folder', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-cli-'));
  const bundle = path.join(folder, 'bundle.js');
  await fs.writeFile(bundle, 'bundle');
  assert.equal(await resolveBundle(folder), bundle);
  assert.equal(await resolveBundle(bundle), bundle);
  await fs.rm(folder, { recursive: true, force: true });
});

test('resolves explicit JS and HTML files', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-resource-'));
  const script = path.join(folder, 'account-form.js');
  const html = path.join(folder, 'dialog.html');
  await fs.writeFile(script, 'function onLoad() {}');
  await fs.writeFile(html, '<h1>Local</h1>');
  assert.equal(await resolveScript(script), script);
  assert.equal(await resolveHtml(html), html);
  await fs.rm(folder, { recursive: true, force: true });
});
