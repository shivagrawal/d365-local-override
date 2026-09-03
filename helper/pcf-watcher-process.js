import { spawn, execFile } from 'node:child_process';

const MAX_LOG_LINES = 200;

function pgrepChildren(pid) {
 return new Promise(resolve => {
 execFile('pgrep', ['-P', String(pid)], (error, stdout) => {
 resolve(error ? [] : stdout.trim().split('\n').filter(Boolean).map(Number));
 });
 });
}

/**
 * Kill a process and everything it (transitively) spawned, without relying
 * on POSIX process groups. npm runs a script via a shell, so the actual
 * long-running build process is a GRANDCHILD of what we spawn - signaling
 * only the direct child leaves it orphaned. detached:true + signaling the
 * negative pid (the "normal" fix for this) was tested and found to be
 * unreliable in at least one sandboxed environment: it sometimes left the
 * target process alive and sometimes hung the caller entirely, with no
 * clear pattern. A plain pgrep -P walk needs no job-control/session
 * semantics at all - just parent/child pid relationships - and was verified
 * to kill the whole tree reliably.
 */
async function killTree(pid) {
 const children = await pgrepChildren(pid);
 await Promise.all(children.map(killTree));
 try {
 process.kill(pid, 'SIGKILL');
 } catch {
 // already gone
 }
}

/**
 * Wraps one long-running "npm run <script>" child process. At most one
 * instance runs at a time per Watcher - start() is a no-op (not a duplicate
 * spawn) if something is already running, since a second concurrent watch
 * process writing the same bundle.js would race our own file watcher.
 */
export class PcfWatcher {
 constructor({ command = 'npm', spawnFn = spawn } = {}) {
 this.command = command;
 this.spawnFn = spawnFn;
 this.child = null;
 this.log = [];
 this.startedAt = null;
 this.exit = null; // { code, signal, at } once the process has exited
 }

 get running() {
 return Boolean(this.child) && this.exit === null;
 }

 snapshot() {
 return {
 running: this.running,
 projectRoot: this.projectRoot ?? null,
 scriptName: this.scriptName ?? null,
 startedAt: this.startedAt,
 exit: this.exit,
 log: this.log.join('')
 };
 }

 _appendLog(chunk) {
 this.log.push(chunk.toString());
 // Bound memory: keep roughly the last MAX_LOG_LINES lines' worth of chunks.
 if (this.log.length > MAX_LOG_LINES) this.log = this.log.slice(-MAX_LOG_LINES);
 }

 start(projectRoot, scriptName) {
 if (this.running) {
 return { started: false, reason: 'already-running', snapshot: this.snapshot() };
 }
 if (!projectRoot || !scriptName) {
 throw new Error('A project root and script name are required to start the watch.');
 }

 this.projectRoot = projectRoot;
 this.scriptName = scriptName;
 this.log = [];
 this.exit = null;
 this.startedAt = Date.now();

 // Windows note: shell:true does NOT quote the `command` argument itself -
 // only the args array - so a command path containing a space (e.g. an
 // install under "Program Files") silently fails to spawn. It also trips
 // Node's own security warning about unescaped shell arguments. Spawning
 // cmd.exe directly (a real .exe, no shell needed to invoke it) with the
 // actual command as one array element sidesteps both: Node's spawn
 // quotes each array element correctly when shell is NOT used, and cmd's
 // own /c handles resolving and running npm.cmd exactly as shell:true did.
 if (process.platform === 'win32') {
 this.child = this.spawnFn('cmd.exe', ['/d', '/s', '/c', this.command, 'run', scriptName], {
 cwd: projectRoot
 });
 } else {
 this.child = this.spawnFn(this.command, ['run', scriptName], { cwd: projectRoot });
 }

 this.child.stdout?.on('data', chunk => this._appendLog(chunk));
 this.child.stderr?.on('data', chunk => this._appendLog(chunk));

 this.child.on('exit', (code, signal) => {
 this.exit = { code, signal, at: Date.now() };
 this.child = null;
 });

 this.child.on('error', error => {
 this._appendLog(`\n[failed to start: ${error.message}]\n`);
 this.exit = { code: null, signal: null, at: Date.now(), error: error.message };
 this.child = null;
 });

 return { started: true, snapshot: this.snapshot() };
 }

 async stop() {
 if (!this.running) return { stopped: false, reason: 'not-running' };
 const pid = this.child.pid;

 if (process.platform === 'win32') {
 // /T kills the whole process tree; without it only the top-level
 // npm.cmd process would die, leaving the actual build process running.
 await new Promise(resolve => {
 execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => resolve());
 });
 } else {
 await killTree(pid);
 }

 return { stopped: true };
 }
}