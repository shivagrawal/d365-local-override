import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { migrateStoredConfig } from '../helper/main.js';

const sampleOldRule = {
  hostname: 'org.crm4.dynamics.com',
  exactPath: '/webresources/wesco_somsalesordermain.js',
  normalized: '/webresources/:resource',
  control: 'wesco_somsalesordermain',
  selectedUrl: 'https://org.crm4.dynamics.com/%7bABC%7d/webresources/wesco_somsalesordermain',
  resourceType: 'script'
};

test('migrates a real single-rule config exactly like the one currently on disk', () => {
  // Mirrors what configure() persisted under the pre-multi-rule model.
  const bundlePath = path.resolve('repo', 'wesco_somsalesordermain.js');
  const oldSavedShape = {
    tabId: 'a',
    bundlePath,
    rule: sampleOldRule,
    resourceType: 'script',
    dynamicsHostname: 'org.crm4.dynamics.com',
    autoReload: true,
    enabled: true // must not survive into the new shape as a live flag
  };

  const result = migrateStoredConfig(oldSavedShape, 'script', [bundlePath]);

  assert.equal(result.length, 1);
  assert.equal(result[0].bundlePath, bundlePath);
  assert.equal(result[0].resourceUrl, sampleOldRule.selectedUrl);
  assert.deepEqual(result[0].rule, sampleOldRule);
  assert.equal(result[0].dynamicsHostname, 'org.crm4.dynamics.com');
  assert.equal(result[0].autoReload, true);
  assert.equal(result[0].tabId, 'a');
  assert.ok(result[0].id, 'a stable id must be assigned during migration');
});

test('passes through an already-current rules-array shape unchanged', () => {
  const bundlePath = path.resolve('a', 'bundle.js');
  const current = { rules: [{ id: 'x1', bundlePath, resourceType: 'pcf', autoReload: true }] };
  const result = migrateStoredConfig(current, 'pcf', [bundlePath]);
  assert.deepEqual(result, current.rules);
});

test('returns an empty list when nothing was ever saved', () => {
  assert.deepEqual(migrateStoredConfig(null, 'pcf', []), []);
  assert.deepEqual(migrateStoredConfig(undefined, 'pcf', []), []);
});

test('drops a migrated rule whose resource type no longer matches this launch', () => {
  const bundlePath = path.resolve('repo', 'script.js');
  const oldSavedShape = {
    tabId: 'a', bundlePath, rule: sampleOldRule,
    resourceType: 'script', dynamicsHostname: 'org.crm4.dynamics.com', autoReload: true
  };
  // Launched for PCF this time, not script - the old rule cannot be trusted.
  const result = migrateStoredConfig(oldSavedShape, 'pcf', [bundlePath]);
  assert.deepEqual(result, []);
});

test('drops a migrated rule whose bundle path is no longer among the discovered artifacts', () => {
  const oldSavedShape = {
    tabId: 'a', bundlePath: path.resolve('repo', 'deleted-file.js'), rule: sampleOldRule,
    resourceType: 'script', dynamicsHostname: 'org.crm4.dynamics.com', autoReload: true
  };
  const result = migrateStoredConfig(oldSavedShape, 'script', [path.resolve('repo', 'some-other-file.js')]);
  assert.deepEqual(result, []);
});

test('filters individual rules within an already-current array the same way', () => {
  const keepPath = path.resolve('a', 'still-here.js');
  const dropPath = path.resolve('a', 'gone-now.js');
  const current = {
    rules: [
      { id: 'keep', bundlePath: keepPath, resourceType: 'script', autoReload: true },
      { id: 'drop', bundlePath: dropPath, resourceType: 'script', autoReload: true }
    ]
  };
  const result = migrateStoredConfig(current, 'script', [keepPath]);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'keep');
});
