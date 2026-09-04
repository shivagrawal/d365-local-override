import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PcfWatcherPool } from '../helper/pcf-watcher-pool.js';

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
