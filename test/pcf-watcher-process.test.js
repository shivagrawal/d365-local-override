import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { PcfWatcher } from '../helper/pcf-watcher-process.js';

function fakeChild(pid = 999999) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = pid;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    setImmediate(() => child.emit('exit', null, 'SIGTERM'));
  };
  return child;
}

test('start() is idempotent: a second start while running does not spawn a duplicate', () => {
  const spawned = [];
  const spawnFn = () => { const c = fakeChild(); spawned.push(c); return c; };
  const watcher = new PcfWatcher({ spawnFn });

  const first = watcher.start('/proj', 'start:watch');
  const second = watcher.start('/proj', 'start:watch');

  assert.equal(first.started, true);
  assert.equal(second.started, false);
  assert.equal(second.reason, 'already-running');
  assert.equal(spawned.length, 1, 'only one process should actually be spawned');
});

test('start() requires both a project root and a script name', () => {
  const watcher = new PcfWatcher({ spawnFn: fakeChild });
  assert.throws(() => watcher.start(null, 'start:watch'), /project root and script name/);
  assert.throws(() => watcher.start('/proj', null), /project root and script name/);
});

test('stdout/stderr chunks accumulate in the log and are exposed via snapshot', () => {
  let child;
  const spawnFn = () => { child = fakeChild(); return child; };
  const watcher = new PcfWatcher({ spawnFn });

  watcher.start('/proj', 'start:watch');
  child.stdout.emit('data', Buffer.from('compiling...\n'));
  child.stderr.emit('data', Buffer.from('warning: x\n'));

  const snap = watcher.snapshot();
  assert.match(snap.log, /compiling\.\.\./);
  assert.match(snap.log, /warning: x/);
  assert.equal(snap.running, true);
  assert.equal(snap.projectRoot, '/proj');
  assert.equal(snap.scriptName, 'start:watch');
});

test('exit is reflected in running state and snapshot, allowing a fresh start afterward', () => {
  let child;
  const spawnFn = () => { child = fakeChild(); return child; };
  const watcher = new PcfWatcher({ spawnFn });

  watcher.start('/proj', 'start:watch');
  child.emit('exit', 1, null);

  assert.equal(watcher.running, false);
  assert.deepEqual(watcher.snapshot().exit, { code: 1, signal: null, at: watcher.exit.at });

  const restart = watcher.start('/proj', 'start:watch');
  assert.equal(restart.started, true, 'a new start after exit must be allowed, not treated as a duplicate');
});

test('a spawn error is captured rather than thrown, and clears running state', () => {
  let child;
  const spawnFn = () => { child = fakeChild(); return child; };
  const watcher = new PcfWatcher({ spawnFn });

  watcher.start('/proj', 'start:watch');
  child.emit('error', new Error('ENOENT: npm not found'));

  assert.equal(watcher.running, false);
  assert.match(watcher.snapshot().log, /failed to start.*ENOENT/);
});

test('stop() on an idle watcher reports not-running rather than throwing', async () => {
  const watcher = new PcfWatcher({ spawnFn: fakeChild });
  assert.deepEqual(await watcher.stop(), { stopped: false, reason: 'not-running' });
});

test('stop() reports stopped:true for an active watcher', async () => {
  const spawnFn = () => fakeChild();
  const watcher = new PcfWatcher({ spawnFn });

  watcher.start('/proj', 'start:watch');
  const result = await watcher.stop();

  assert.equal(result.stopped, true);
  // The actual OS-level kill mechanism (tree-walk on POSIX, taskkill /T on
  // Windows) is verified against a REAL process below - a fake child has no
  // real OS process tree to kill, so there is nothing meaningful to assert
  // about *how* it was killed at this level.
});

test('log stays bounded even for a very chatty process', () => {
  let child;
  const spawnFn = () => { child = fakeChild(); return child; };
  const watcher = new PcfWatcher({ spawnFn });

  watcher.start('/proj', 'start:watch');
  for (let i = 0; i < 500; i++) child.stdout.emit('data', Buffer.from(`line ${i}\n`));

  assert.ok(watcher.log.length <= 200, `log should stay bounded, got ${watcher.log.length} entries`);
});

// Integration: a real OS-level process, not a fake, to prove actual spawn/kill works.
test('integration: spawns a real process, captures its output, and can kill it', async () => {
  const watcher = new PcfWatcher({ command: process.execPath }); // run node itself as the "npm" stand-in

  const script = `process.stdout.write('watching...\\n'); setInterval(() => {}, 1000);`;
  // Simulate "npm run <script>" by having node -e run something long-lived.
  const originalSpawn = watcher.spawnFn;
  watcher.spawnFn = (cmd, args, opts) => originalSpawn(cmd, ['-e', script], opts);

  watcher.start(os.tmpdir(), 'anything');
  await new Promise(r => setTimeout(r, 300));

  assert.equal(watcher.running, true);
  assert.match(watcher.snapshot().log, /watching\.\.\./);

  await watcher.stop();
  await new Promise(r => setTimeout(r, 300));
  assert.equal(watcher.running, false);
});

/**
 * Checks whether a process matching `marker` is genuinely still alive.
 * `pgrep -f` matches against every process's FULL command line - including
 * the very shell wrapper used to run the pgrep check itself, if that
 * wrapper's own argv happens to contain the marker text (it does, since the
 * marker is embedded literally in the pgrep command we run). Filtering out
 * lines mentioning pgrep/grep/sh -c removes that self-match without
 * requiring a differently-shaped marker.
 */
async function stillRunning(marker) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { stdout } = await promisify(execFile)(
    'sh', ['-c', `pgrep -af "${marker}" | grep -v pgrep | grep -v "sh -c" || true`]
  );
  return stdout.trim();
}

test('regression: stop() must kill the whole process tree, not just the direct child', {
  skip: process.platform === 'win32' ? 'POSIX tree-walk behavior only; Windows uses taskkill /T, tested separately' : false
}, async () => {
  // Reproduces a real bug found during manual testing: npm runs a script via
  // a shell, so the actual long-running process is a GRANDCHILD of what we
  // spawn. Signaling only the direct child used to leave the grandchild
  // orphaned - still running, still holding the file, still racing our own
  // watcher - even though watcher.running correctly reported false.
  const marker = `pcf-watch-regression-${Date.now()}-${process.pid}`;

  const watcher = new PcfWatcher({ command: 'sh' });
  const originalSpawn = watcher.spawnFn;
  watcher.spawnFn = (cmd, args, opts) => originalSpawn(
    cmd,
    ['-c', `${process.execPath} -e "process.stdout.write('${marker}\\n'); setInterval(()=>{},1000)"`],
    opts
  );

  watcher.start(os.tmpdir(), 'anything');
  await new Promise(r => setTimeout(r, 400));

  assert.notEqual(await stillRunning(marker), '', 'the marked process should be running before stop()');

  await watcher.stop();
  await new Promise(r => setTimeout(r, 500));

  const remaining = await stillRunning(marker);
  assert.equal(remaining, '', `expected the whole process tree to be gone after stop(), but found: ${remaining}`);
});
