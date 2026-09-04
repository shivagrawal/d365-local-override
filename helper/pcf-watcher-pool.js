import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { PcfWatcher } from './pcf-watcher-process.js';

// Records project roots we have started a watch for. If this process is
// KILLED rather than shut down cleanly (crash, Task Manager, machine sleep),
// none of the in-process cleanup runs and the watch is orphaned forever -
// exactly how a stale watch can end up running for days. Persisting the
// roots lets a later session find and kill precisely what WE started, and
// never a watch the developer launched themselves in their own terminal.
const registryFile = path.join(os.homedir(), '.pcf-local-override', 'active-watches.json');

function readRegistry() {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    return Array.isArray(parsed.roots) ? parsed.roots : [];
  } catch {
    return [];
  }
}

function writeRegistry(roots) {
  try {
    fs.mkdirSync(path.dirname(registryFile), { recursive: true });
    fs.writeFileSync(registryFile, JSON.stringify({ roots }, null, 2));
  } catch {
    // A registry write failure must never block starting or stopping a watch.
  }
}

function recordRoot(root) {
  const roots = readRegistry();
  if (!roots.includes(root)) writeRegistry([...roots, root]);
}

function forgetRoot(root) {
  writeRegistry(readRegistry().filter(existing => existing !== root));
}

/** Kills any process whose command line references one of the given roots. */
function killByRoot(root, execFileFn = execFile) {
  return new Promise(resolve => {
    if (!root) return resolve();
    if (process.platform === 'win32') {
      const escaped = root.replace(/'/g, "''");
      const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${escaped}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
      execFileFn('powershell', ['-NoProfile', '-Command', script], () => resolve());
    } else {
      execFileFn('sh', ['-c', `pkill -f ${JSON.stringify(root)} || true`], () => resolve());
    }
  });
}

/**
 * Kills watches left behind by a previous session that didn't shut down
 * cleanly. Only touches roots this tool recorded as having started.
 */
export async function sweepOrphanedWatches(execFileFn = execFile) {
  const roots = readRegistry();
  if (!roots.length) return { swept: 0 };
  for (const root of roots) await killByRoot(root, execFileFn);
  writeRegistry([]);
  return { swept: roots.length, roots };
}

/**
 * Manages one PcfWatcher per project root, so several PCF overrides can each
 * run their own build watch at the same time.
 *
 * Keyed by project root rather than by override rule: two overrides pointing
 * at different bundles from the SAME project share one npm watch (running it
 * twice would have two processes writing the same build output, racing each
 * other and our own file watcher). Two overrides from different projects get
 * genuinely independent watches.
 */
export class PcfWatcherPool {
  constructor(options = {}) {
    this.options = options;
    this.watchers = new Map(); // projectRoot -> PcfWatcher
  }

  /** Normalizes so the same project isn't tracked twice under path variants. */
  _key(projectRoot) {
    return String(projectRoot || '').replace(/[\\/]+$/, '').toLowerCase();
  }

  get(projectRoot) {
    return this.watchers.get(this._key(projectRoot)) || null;
  }

  start(projectRoot, scriptName) {
    if (!projectRoot || !scriptName) {
      throw new Error('A project root and script name are required to start the watch.');
    }

    const key = this._key(projectRoot);
    let watcher = this.watchers.get(key);
    if (!watcher) {
      watcher = new PcfWatcher(this.options);
      this.watchers.set(key, watcher);
    }

    const result = watcher.start(projectRoot, scriptName);
    if (result.started) recordRoot(projectRoot);
    return result;
  }

  async stop(projectRoot) {
    const watcher = this.get(projectRoot);
    if (!watcher) return { stopped: false, reason: 'not-running' };

    const actualRoot = watcher.projectRoot || projectRoot;
    const result = await watcher.stop();
    this.watchers.delete(this._key(projectRoot));
    forgetRoot(actualRoot);
    return result;
  }

  /** Stops every running watch. Used when disconnecting or shutting down. */
  async stopAll() {
    const roots = [...this.watchers.keys()];
    const actualRoots = [...this.watchers.values()].map(w => w.projectRoot).filter(Boolean);

    await Promise.all(roots.map(async key => {
      const watcher = this.watchers.get(key);
      if (watcher) await watcher.stop().catch(() => {});
    }));
    this.watchers.clear();

    for (const root of actualRoots) forgetRoot(root);
    return { stopped: roots.length };
  }

  /** One snapshot per tracked project, for rendering the whole set. */
  snapshots() {
    return [...this.watchers.values()].map(watcher => watcher.snapshot());
  }

  get runningCount() {
    return [...this.watchers.values()].filter(watcher => watcher.running).length;
  }
}
