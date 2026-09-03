import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseLaunchArgs } from '../helper/cli.js';
import { discoverBundles, resolveArtifact, resolveBundle, resolveHtml, resolveScript } from '../helper/bundles.js';

test('resolveArtifact derives type from the selected path', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-artifact-'));

  const bundle = path.join(folder, 'bundle.js');
  await fs.writeFile(bundle, 'b');
  assert.deepEqual(await resolveArtifact(bundle), { bundles: [bundle], resourceType: 'pcf' });
  assert.deepEqual(await resolveArtifact(folder), { bundles: [bundle], resourceType: 'pcf' });

  const scriptFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-artifact-'));
  const script = path.join(scriptFolder, 'account-form.js');
  await fs.writeFile(script, 'f');
  assert.deepEqual(await resolveArtifact(script), { bundles: [script], resourceType: 'script' });

  const html = path.join(scriptFolder, 'dialog.html');
  await fs.writeFile(html, '<h1>x</h1>');
  assert.deepEqual(await resolveArtifact(html), { bundles: [html], resourceType: 'html' });

  await fs.rm(folder, { recursive: true, force: true });
  await fs.rm(scriptFolder, { recursive: true, force: true });
});

test('resolveArtifact finds bundles under out/dist/build of a project folder', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-project-'));
  const nested = path.join(root, 'out', 'controls', 'MyControl');
  await fs.mkdir(nested, { recursive: true });
  const bundle = path.join(nested, 'bundle.js');
  await fs.writeFile(bundle, 'b');

  assert.deepEqual(await resolveArtifact(root), { bundles: [bundle], resourceType: 'pcf' });
  await fs.rm(root, { recursive: true, force: true });
});

test('discoverBundles finds a control nested one level below the given root (monorepo layout)', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-monorepo-'));
  const nested = path.join(root, 'ControlProject', 'out', 'controls', 'MyControl');
  await fs.mkdir(nested, { recursive: true });
  const bundle = path.join(nested, 'bundle.js');
  await fs.writeFile(bundle, 'b');

  // Pointing at the solution root, not the individual control's project folder,
  // is the case that previously returned nothing.
  assert.deepEqual(await discoverBundles(root), [bundle]);
  await fs.rm(root, { recursive: true, force: true });
});

test('discoverBundles finds multiple sibling controls in a solution folder', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-monorepo-'));
  const a = path.join(root, 'ControlA', 'out', 'controls', 'A', 'bundle.js');
  const b = path.join(root, 'ControlB', 'out', 'controls', 'B', 'bundle.js');
  await fs.mkdir(path.dirname(a), { recursive: true });
  await fs.mkdir(path.dirname(b), { recursive: true });
  await fs.writeFile(a, 'a');
  await fs.writeFile(b, 'b');

  const found = await discoverBundles(root);
  assert.deepEqual(found.sort(), [a, b].sort());
  await fs.rm(root, { recursive: true, force: true });
});

test('discoverBundles never descends into node_modules, even when it contains a dist folder', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-project-'));
  const real = path.join(root, 'out', 'controls', 'MyControl', 'bundle.js');
  await fs.mkdir(path.dirname(real), { recursive: true });
  await fs.writeFile(real, 'real');

  const decoy = path.join(root, 'node_modules', 'some-dep', 'dist', 'bundle.js');
  await fs.mkdir(path.dirname(decoy), { recursive: true });
  await fs.writeFile(decoy, 'decoy');

  assert.deepEqual(await discoverBundles(root), [real]);
  await fs.rm(root, { recursive: true, force: true });
});

test('resolveArtifact reports unusable selections clearly', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-artifact-'));

  await assert.rejects(() => resolveArtifact(path.join(folder, 'nope')), /does not exist/);
  await assert.rejects(() => resolveArtifact(folder), /No bundle\.js found/);

  const text = path.join(folder, 'notes.txt');
  await fs.writeFile(text, 'x');
  await assert.rejects(() => resolveArtifact(text), /Unsupported file type/);

  await fs.rm(folder, { recursive: true, force: true });
});

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
