import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

// Redirect the on-disk watch registry into a temp HOME before the pool
// module resolves its path at import time.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-home-'));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;

const { PcfWatcherPool, sweepOrphanedWatches } = await import('../helper/pcf-watcher-pool.js');

const registryPath = path.join(fakeHome, '.pcf-local-override', 'active-watches.json');
const readRegistry = () => {
  try { return JSON.parse(fs.readFileSync(registryPath, 'utf8')).roots; }
  catch { return []; }
};
// All tests in this file share one on-disk registry, so registry-specific
// tests must start from a known-empty state rather than inheriting whatever
// earlier tests recorded.
const clearRegistry = () => { try { fs.rmSync(registryPath); } catch {} };

function fakeChild(pid = 999999) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = pid;
  child.kill = () => setImmediate(() => child.emit('exit', null, 'SIGTERM'));
  return child;
}

function poolWithSpies() {
  const spawned = [];
  const execFileCalls = [];
  const pool = new PcfWatcherPool({
    spawnFn: (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return fakeChild(spawned.length + 1000); },
    execFileFn: (cmd, args, cb) => { execFileCalls.push({ cmd, args }); cb(); }
  });
  return { pool, spawned, execFileCalls };
}

test('two different projects each get their own independent watch', () => {
  const { pool, spawned } = poolWithSpies();

  pool.start('/proj/AddPartsManagement', 'start:watch');
  pool.start('/proj/PcfGrid', 'start:watch');

  assert.equal(spawned.length, 2, 'both projects must actually spawn their own process');
  assert.equal(pool.runningCount, 2);
  assert.deepEqual(
    pool.snapshots().map(s => s.projectRoot).sort(),
    ['/proj/AddPartsManagement', '/proj/PcfGrid']
  );
});

test('starting the same project twice does not spawn a duplicate', () => {
  const { pool, spawned } = poolWithSpies();

  pool.start('/proj/AddPartsManagement', 'start:watch');
  const second = pool.start('/proj/AddPartsManagement', 'start:watch');

  assert.equal(spawned.length, 1, 'two processes writing the same build output would race each other');
  assert.equal(second.started, false);
  assert.equal(second.reason, 'already-running');
});

test('project keys are normalized so path variants are not tracked twice', () => {
  const { pool, spawned } = poolWithSpies();

  pool.start('C:\\proj\\MyControl', 'start:watch');
  pool.start('C:\\proj\\MyControl\\', 'start:watch');   // trailing separator
  pool.start('c:\\PROJ\\mycontrol', 'start:watch');     // different casing

  assert.equal(spawned.length, 1, 'the same project under path variants must resolve to one watch');
});

test('stopping one project leaves the other running', async () => {
  const { pool } = poolWithSpies();

  pool.start('/proj/A', 'start:watch');
  pool.start('/proj/B', 'start:watch');

  await pool.stop('/proj/A');

  assert.equal(pool.get('/proj/A'), null, 'the stopped project is no longer tracked');
  assert.ok(pool.get('/proj/B'), 'the other project must be untouched');
  assert.equal(pool.runningCount, 1);
});

test('stopping a project that was never started reports not-running rather than throwing', async () => {
  const { pool } = poolWithSpies();
  assert.deepEqual(await pool.stop('/proj/never-started'), { stopped: false, reason: 'not-running' });
});

test('stopAll stops every watch and clears tracking', async () => {
  const { pool } = poolWithSpies();

  pool.start('/proj/A', 'start:watch');
  pool.start('/proj/B', 'start:watch');
  pool.start('/proj/C', 'start:watch');

  const result = await pool.stopAll();

  assert.equal(result.stopped, 3);
  assert.equal(pool.runningCount, 0);
  assert.deepEqual(pool.snapshots(), []);
});

test('stopAll on an empty pool is safe', async () => {
  const { pool } = poolWithSpies();
  assert.deepEqual(await pool.stopAll(), { stopped: 0 });
});

test('start requires both a project root and a script name', () => {
  const { pool } = poolWithSpies();
  assert.throws(() => pool.start(null, 'start:watch'), /project root and script name/);
  assert.throws(() => pool.start('/proj/A', null), /project root and script name/);
});

test('snapshots carry per-project detail so the UI can render each watch separately', () => {
  const { pool } = poolWithSpies();

  pool.start('/proj/A', 'start:watch');
  pool.start('/proj/B', 'build:watch');

  const byRoot = Object.fromEntries(pool.snapshots().map(s => [s.projectRoot, s]));
  assert.equal(byRoot['/proj/A'].scriptName, 'start:watch');
  assert.equal(byRoot['/proj/B'].scriptName, 'build:watch');
  assert.equal(byRoot['/proj/A'].running, true);
});


test('starting a watch records its project root on disk', () => {
  clearRegistry();
  const { pool } = poolWithSpies();
  pool.start('/proj/RecordMe', 'start:watch');
  assert.ok(readRegistry().includes('/proj/RecordMe'), 'the root must be persisted so a crashed session can be cleaned up later');
});

test('stopping a watch removes its root from the registry', async () => {
  const { pool } = poolWithSpies();
  pool.start('/proj/ForgetMe', 'start:watch');
  await pool.stop('/proj/ForgetMe');
  assert.ok(!readRegistry().includes('/proj/ForgetMe'), 'a cleanly stopped watch must not be swept later');
});

test('stopAll clears every recorded root', async () => {
  clearRegistry();
  const { pool } = poolWithSpies();
  pool.start('/proj/A1', 'start:watch');
  pool.start('/proj/B1', 'start:watch');
  await pool.stopAll();
  assert.deepEqual(readRegistry(), [], 'no roots should remain recorded after a full stop');
});

test('regression: sweepOrphanedWatches kills roots left behind by a crashed session', async () => {
  // Reproduces a real orphan: a watch started by a session that was killed
  // rather than shut down cleanly kept running indefinitely, because none of
  // the in-process cleanup ever ran.
  clearRegistry();
  const { pool } = poolWithSpies();
  pool.start('/proj/Orphaned', 'start:watch');
  pool.watchers.clear(); // simulate the process dying without cleanup

  assert.ok(readRegistry().includes('/proj/Orphaned'), 'precondition: the root is still recorded');

  const killed = [];
  const fakeExecFile = (cmd, args, cb) => { killed.push({ cmd, args }); cb(); };
  const result = await sweepOrphanedWatches(fakeExecFile);

  assert.equal(result.swept, 1);
  assert.equal(killed.length, 1, 'the orphaned root must actually be killed');
  assert.deepEqual(readRegistry(), [], 'the registry must be cleared after sweeping');
});

test('sweepOrphanedWatches is a no-op when nothing was left behind', async () => {
  clearRegistry();
  const killed = [];
  const result = await sweepOrphanedWatches((cmd, args, cb) => { killed.push(cmd); cb(); });
  assert.equal(result.swept, 0);
  assert.deepEqual(killed, [], 'must never kill anything when the registry is empty');
});
