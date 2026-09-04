import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { detectWatchTarget, findPcfProjectRoot, pickWatchScript, readNpmScripts } from '../helper/pcf-watch.js';

async function makeProject(scripts, { withManifest = false, withPcfScriptsDep = true } = {}) {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-watch-project-'));
  const pkg = { scripts };
  if (withPcfScriptsDep) pkg.devDependencies = { 'pcf-scripts': '^1.0.0' };
  await fs.writeFile(path.join(projectRoot, 'package.json'), JSON.stringify(pkg));
  if (withManifest) {
    await fs.writeFile(path.join(projectRoot, 'ControlManifest.Input.xml'), '<manifest/>');
  }
  const bundleDir = path.join(projectRoot, 'out', 'controls', 'MyControl');
  await fs.mkdir(bundleDir, { recursive: true });
  const bundlePath = path.join(bundleDir, 'bundle.js');
  await fs.writeFile(bundlePath, 'b');
  return { projectRoot, bundlePath };
}

test('findPcfProjectRoot walks up from a deeply nested bundle to the package.json directory', async () => {
  const { projectRoot, bundlePath } = await makeProject({ start: 'pcf-scripts start' });
  assert.equal(await findPcfProjectRoot(bundlePath), projectRoot);
  await fs.rm(projectRoot, { recursive: true, force: true });
});

test('findPcfProjectRoot accepts a ControlManifest.Input.xml sibling even without a pcf-scripts dependency', async () => {
  const { projectRoot, bundlePath } = await makeProject({ start: 'webpack --watch' }, { withManifest: true, withPcfScriptsDep: false });
  assert.equal(await findPcfProjectRoot(bundlePath), projectRoot);
  await fs.rm(projectRoot, { recursive: true, force: true });
});

test('findPcfProjectRoot returns null when no package.json exists within range', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-watch-orphan-'));
  const nested = path.join(dir, 'a', 'b', 'c');
  await fs.mkdir(nested, { recursive: true });
  const bundlePath = path.join(nested, 'bundle.js');
  await fs.writeFile(bundlePath, 'b');

  assert.equal(await findPcfProjectRoot(bundlePath, 2), null);
  await fs.rm(dir, { recursive: true, force: true });
});

test('regression: an unrelated package.json along the walk is skipped, not treated as the project root', async () => {
  // Found on a real machine: os.tmpdir() can be shallow enough that an
  // 8-level walk-up reaches the user's home directory, which may itself
  // contain a package.json for something entirely unrelated (a global tool,
  // an old `npm init`, anything). Without a genuine PCF signal, accepting
  // the first package.json found would suggest running the WRONG project's
  // npm scripts from the wrong directory entirely.
  const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-watch-unrelated-home-'));
  await fs.writeFile(path.join(fakeHome, 'package.json'), JSON.stringify({ scripts: { start: 'echo not-a-pcf-project' } }));

  const nested = path.join(fakeHome, 'AppData', 'Local', 'Temp', 'abc123');
  await fs.mkdir(nested, { recursive: true });
  const bundlePath = path.join(nested, 'bundle.js');
  await fs.writeFile(bundlePath, 'b');

  assert.equal(
    await findPcfProjectRoot(bundlePath, 8),
    null,
    'the unrelated home-directory package.json must not be mistaken for a PCF project'
  );
  await fs.rm(fakeHome, { recursive: true, force: true });
});

test('regression: a repo-level package.json above the real PCF project is not mistaken for the project root', async () => {
  // Reproduces the reported layout exactly:
  //   QOE-PCF-AddPartsManagement/        <- repo package.json, no pcf-scripts
  //     SOM_AddPartsManagement/
  //       AddPartsManagement/            <- real PCF project
  //         out/controls/X/bundle.js
  // Picking the repo root means "npm run start:watch" runs where that script
  // doesn't exist, which is exactly the failure that was reported.
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'QOE-PCF-'));
  await fs.writeFile(path.join(repoRoot, 'package.json'), JSON.stringify({
    name: 'repo-level', scripts: { lint: 'eslint .' }
  }));

  const projectRoot = path.join(repoRoot, 'SOM_AddPartsManagement', 'AddPartsManagement');
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'AddPartsManagement',
    scripts: { 'start:watch': 'pcf-scripts start watch' },
    devDependencies: { 'pcf-scripts': '^1.0.0' }
  }));
  await fs.writeFile(path.join(projectRoot, 'ControlManifest.Input.xml'), '<manifest/>');

  const bundleDir = path.join(projectRoot, 'out', 'controls', 'AddPartsManagement');
  await fs.mkdir(bundleDir, { recursive: true });
  const bundlePath = path.join(bundleDir, 'bundle.js');
  await fs.writeFile(bundlePath, 'b');

  const found = await findPcfProjectRoot(bundlePath);
  assert.equal(found, projectRoot, 'must find the nested PCF project, not the repo root above it');

  const detected = await detectWatchTarget(bundlePath);
  assert.equal(detected.suggested, 'start:watch', 'the suggested script must come from the PCF project package.json');

  await fs.rm(repoRoot, { recursive: true, force: true });
});

test('regression: a ControlManifest without a pcf-scripts package.json beside it is not accepted alone', async () => {
  // A stray manifest next to a package.json with no scripts is not a
  // runnable project - accepting it would suggest a script that can't run.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-stray-'));
  await fs.writeFile(path.join(dir, 'ControlManifest.Input.xml'), '<manifest/>');
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'no-scripts' }));

  const bundlePath = path.join(dir, 'bundle.js');
  await fs.writeFile(bundlePath, 'b');

  assert.equal(await findPcfProjectRoot(bundlePath), null);
  await fs.rm(dir, { recursive: true, force: true });
});


test('readNpmScripts returns {} for a missing or malformed package.json rather than throwing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-watch-bad-'));
  assert.deepEqual(await readNpmScripts(dir), {});

  await fs.writeFile(path.join(dir, 'package.json'), '{ not valid json');
  assert.deepEqual(await readNpmScripts(dir), {});
  await fs.rm(dir, { recursive: true, force: true });
});

test('pickWatchScript prefers start:watch, then watch, then dev, then start', () => {
  assert.equal(pickWatchScript({ start: 'x', 'start:watch': 'y', watch: 'z' }), 'start:watch');
  assert.equal(pickWatchScript({ start: 'x', watch: 'z' }), 'watch');
  assert.equal(pickWatchScript({ start: 'x', dev: 'z' }), 'dev');
  assert.equal(pickWatchScript({ start: 'x', build: 'y' }), 'start');
});

test('pickWatchScript returns null when nothing plausible is present', () => {
  assert.equal(pickWatchScript({ build: 'x', test: 'y' }), null);
  assert.equal(pickWatchScript({}), null);
});

test('detectWatchTarget returns the full picture for a real project layout', async () => {
  const { bundlePath, projectRoot } = await makeProject({
    build: 'pcf-scripts build',
    'start:watch': 'pcf-scripts start watch',
    start: 'pcf-scripts start'
  });

  const result = await detectWatchTarget(bundlePath);
  assert.equal(result.projectRoot, projectRoot);
  assert.equal(result.suggested, 'start:watch');
  assert.equal(result.scripts.build, 'pcf-scripts build');
  await fs.rm(projectRoot, { recursive: true, force: true });
});

test('detectWatchTarget reports no suggestion when no plausible script exists, without failing', async () => {
  const { bundlePath, projectRoot } = await makeProject({ test: 'jest' });
  const result = await detectWatchTarget(bundlePath);
  assert.equal(result.suggested, null);
  assert.deepEqual(result.scripts, { test: 'jest' });
  await fs.rm(projectRoot, { recursive: true, force: true });
});

test('detectWatchTarget handles no package.json anywhere in range gracefully', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-watch-none-'));
  const bundlePath = path.join(dir, 'bundle.js');
  await fs.writeFile(bundlePath, 'b');

  const result = await detectWatchTarget(bundlePath);
  assert.deepEqual(result, { projectRoot: null, scripts: {}, suggested: null });
  await fs.rm(dir, { recursive: true, force: true });
});
