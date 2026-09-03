import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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

// Integration: a real OS-level process via a real npm project, not a fake -
// exercises the exact same code path production usage does (command:'npm',
// no overrides), so it would have caught the shell:true/space-in-path bug
// this file's regression test below documents.
test('integration: spawns a real process via a real npm project, captures its output, and can kill it', async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-watcher-project-'));
  const script = `process.stdout.write('watching...\\n'); setInterval(() => {}, 1000);`;
  await fs.writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    scripts: { 'test-watch': `node -e "${script.replace(/"/g, '\\"')}"` }
  }));

  const watcher = new PcfWatcher(); // real defaults, no test overrides
  watcher.start(projectRoot, 'test-watch');

  // npm's own cold-start (module resolution, npm itself) is slower than a
  // bare node process, especially the first run on a machine - give it room.
  await new Promise(r => setTimeout(r, 2500));

  assert.equal(watcher.running, true, `expected the watch to be running; log:\n${watcher.snapshot().log}`);
  assert.match(watcher.snapshot().log, /watching\.\.\./);

  await watcher.stop();
  await new Promise(r => setTimeout(r, 500));
  assert.equal(watcher.running, false);
});

test('regression: on Windows, spawns via cmd.exe with an array (not shell:true) so a command path containing a space is not silently mis-parsed', () => {
  // shell:true does not quote the `command` argument itself, only the args
  // array - a command path like "C:\Program Files\nodejs\npm.cmd" would be
  // split at the space and silently fail to spawn. Spawning cmd.exe directly
  // (a real .exe, no shell needed) with the command as one array element
  // lets Node's own argument quoting handle it correctly.
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

  try {
    let captured = null;
    const spawnFn = (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); };
    const watcher = new PcfWatcher({ command: 'C:\\Program Files\\nodejs\\npm.cmd', spawnFn });

    watcher.start('C:\\proj', 'start:watch');

    assert.equal(captured.cmd, 'cmd.exe', 'must spawn cmd.exe directly, not rely on shell:true');
    assert.deepEqual(
      captured.args,
      ['/d', '/s', '/c', 'C:\\Program Files\\nodejs\\npm.cmd', 'run', 'start:watch'],
      'the space-containing command must be its own array element, not concatenated into a string'
    );
    assert.notEqual(captured.opts.shell, true, 'shell:true must not be used - it is what caused the original bug');
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform);
  }
});

test('regression: on POSIX, spawns the command directly without cmd.exe wrapping', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

  try {
    let captured = null;
    const spawnFn = (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); };
    const watcher = new PcfWatcher({ command: 'npm', spawnFn });

    watcher.start('/proj', 'start:watch');

    assert.equal(captured.cmd, 'npm');
    assert.deepEqual(captured.args, ['run', 'start:watch']);
    assert.notEqual(captured.opts.shell, true);
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform);
  }
});

test('regression: stop() on Windows also runs a command-line-match kill, not just taskkill /T on the tracked pid', async () => {
  // taskkill /T walks the tree as of the moment it's called. If npm/cmd.exe
  // already exited by then (common - npm hands off and exits), the real
  // long-lived process (webpack-dev-server, Browsersync) can already be
  // orphaned from that tree, invisible to a PID-rooted kill. This is the
  // supplementary mechanism that catches what the tree-walk can miss.
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

  try {
    const execFileCalls = [];
    const execFileFn = (cmd, args, cb) => { execFileCalls.push({ cmd, args }); cb(); };
    const watcher = new PcfWatcher({ spawnFn: fakeChild, execFileFn });

    watcher.start('C:\\proj\\MyControl', 'start:watch');
    await watcher.stop();

    assert.equal(execFileCalls[0].cmd, 'taskkill');
    assert.equal(execFileCalls[1].cmd, 'powershell', 'a second, independent kill attempt by command-line match must also run');
    const script = execFileCalls[1].args.find(a => typeof a === 'string' && a.includes('Win32_Process'));
    assert.match(script, /CommandLine -like '\*C:\\proj\\MyControl\*'/, 'must search for the actual project root in the command line');
    assert.match(script, /Stop-Process -Id \$_\.ProcessId -Force/, 'must actually kill the matches, not just list them');
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform);
  }
});

test('command-line-match kill escapes single quotes in the project path to avoid breaking the PowerShell string', async () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

  try {
    const execFileCalls = [];
    const execFileFn = (cmd, args, cb) => { execFileCalls.push({ cmd, args }); cb(); };
    const watcher = new PcfWatcher({ spawnFn: fakeChild, execFileFn });

    watcher.start("C:\\proj\\Shiv's Control", 'start:watch');
    await watcher.stop();

    const script = execFileCalls[1].args.find(a => typeof a === 'string' && a.includes('Win32_Process'));
    assert.match(script, /Shiv''s Control/, "a literal single quote must be doubled for a PowerShell single-quoted string, or the script itself breaks");
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform);
  }
});

test('command-line-match kill is skipped cleanly when there is no project root to match on', async () => {
  const execFileCalls = [];
  const execFileFn = (cmd, args, cb) => { execFileCalls.push(cmd); cb(); };
  const watcher = new PcfWatcher({ spawnFn: fakeChild, execFileFn });
  // Directly exercise stop()'s win32 branch behavior at the unit level via
  // the exported class - projectRoot is always set by start() in practice,
  // this only guards the defensive null-check path itself.
  watcher.projectRoot = null;
  watcher.child = fakeChild();
  watcher.exit = null;

  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    await watcher.stop();
    assert.deepEqual(execFileCalls, ['taskkill'], 'no powershell call should be attempted with nothing to search for');
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform);
  }
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
