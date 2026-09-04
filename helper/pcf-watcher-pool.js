import { PcfWatcher } from './pcf-watcher-process.js';

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

    return watcher.start(projectRoot, scriptName);
  }

  async stop(projectRoot) {
    const watcher = this.get(projectRoot);
    if (!watcher) return { stopped: false, reason: 'not-running' };

    const result = await watcher.stop();
    this.watchers.delete(this._key(projectRoot));
    return result;
  }

  /** Stops every running watch. Used when disconnecting or shutting down. */
  async stopAll() {
    const roots = [...this.watchers.keys()];
    await Promise.all(roots.map(async key => {
      const watcher = this.watchers.get(key);
      if (watcher) await watcher.stop().catch(() => {});
    }));
    this.watchers.clear();
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
