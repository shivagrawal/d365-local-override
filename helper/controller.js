import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CdpClient, targets } from './cdp.js';
import { resolveArtifact, deriveResourceType } from './bundles.js';
import { createRule, interceptionPatterns, isCandidate, isDynamicsUrl, matchesRule } from '../shared/matcher.js';
import { saveProject } from './config.js';
import { stableRead, formatSize } from './utils.js';
import { watchBundle } from './watcher.js';

export class Controller {
  constructor({ root, port, bundles, rules, resourceType = 'pcf', reloadSettleMs = 150 }) {
    Object.assign(this, { root, port, bundles, resourceType, reloadSettleMs });
    this.rules = Array.isArray(rules) ? rules : [];
    // Never auto-attach on startup, regardless of what was persisted - the
    // developer must explicitly re-enable each session.
    this.enabled = false;
    this.status = { stage: 'idle' };
  }

  async persist() {
    await saveProject(this.root, { rules: this.rules });
  }

  async dynamicsTabs() {
    return (await targets(this.port))
      .filter(target => target.type === 'page' && isDynamicsUrl(target.url))
      .map(target => ({ id: target.id, title: target.title, url: target.url }));
  }

  /**
   * Select the local artifact to stage for the NEXT override rule to be
   * added. Deliberately has no effect on already-active rules, the running
   * CDP session, or file watchers - browsing for one more file to override
   * must not disturb overrides that are already working.
   */
  async setArtifact(inputPath) {
    if (!inputPath || typeof inputPath !== 'string' || !inputPath.trim()) {
      throw new Error('Select a local bundle, JavaScript, or HTML file.');
    }

    const { bundles, resourceType } = await resolveArtifact(inputPath.trim());

    this.bundles = bundles;
    this.resourceType = resourceType;

    this.status = { stage: 'artifact-selected', at: Date.now(), count: bundles.length };
    return this.snapshot();
  }

  async target(id) {
    const target = (await targets(this.port)).find(item => item.id === id);
    if (!target) throw new Error('The selected Chrome tab is no longer available.');
    return target;
  }

  async scan(tabId, bundlePath, timeoutMs = 5000) {
    const resourceType = bundlePath ? deriveResourceType(bundlePath) : this.resourceType;
    const target = await this.target(tabId);
    const host = new URL(target.url).hostname;
    const client = await new CdpClient(target.webSocketDebuggerUrl).connect();
    const found = new Map();

    client.on('event', (method, params) => {
      if (method === 'Target.attachedToTarget') {
        Promise.all([
          client.send('Network.enable', {}, params.sessionId),
          client.send('Debugger.enable', {}, params.sessionId),
          client.send('Runtime.runIfWaitingForDebugger', {}, params.sessionId)
        ]).catch(() => {});
        return;
      }

      if (resourceType === 'script' && method !== 'Debugger.scriptParsed') return;
      if (resourceType === 'html' && method !== 'Network.requestWillBeSent') return;

      const url = method === 'Debugger.scriptParsed'
        ? params.url
        : method === 'Network.requestWillBeSent'
          ? params.request?.url
          : null;

      if (url && isCandidate(url, host, resourceType)) {
        found.set(url, {
          url,
          source: method === 'Debugger.scriptParsed' ? 'Sources' : 'Network'
        });
      }
    });

    await client.send('Network.enable');
    await client.send('Debugger.enable');
    await client.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true
    });

    if (resourceType === 'html') {
      const addFrameResources = frameTree => {
        const urls = [
          frameTree?.frame?.url,
          ...(frameTree?.resources || []).map(resource => resource.url)
        ];

        for (const url of urls) {
          if (url && isCandidate(url, host, resourceType)) {
            found.set(url, { url, source: 'Loaded frame' });
          }
        }

        for (const child of frameTree?.childFrames || []) addFrameResources(child);
      };

      await client.send('Page.enable');
      const tree = await client.send('Page.getResourceTree').catch(() => null);
      if (tree?.frameTree) addFrameResources(tree.frameTree);
    }

    await new Promise(resolve => setTimeout(resolve, timeoutMs));
    client.close();

    const comparableName = value =>
      decodeURIComponent(path.basename(value))
        .toLowerCase()
        .replace(/\.(?:js|html?)$/, '');

    // Sort by similarity to the SPECIFIC file being scanned for, not just
    // whichever bundle happened to be discovered first - those can differ
    // whenever more than one file was found in the selected folder.
    const localName = bundlePath ? comparableName(bundlePath)
      : this.bundles.length ? comparableName(this.bundles[0]) : null;

    return [...found.values()].sort((left, right) => {
      if (!localName) return 0;
      const leftName = comparableName(new URL(left.url).pathname);
      const rightName = comparableName(new URL(right.url).pathname);

      return Number(rightName === localName) - Number(leftName === localName) ||
        Number(rightName.includes(localName)) - Number(leftName.includes(localName));
    });
  }

  /**
   * Add one override rule alongside any that are already active. If the
   * session was already enabled, the CDP interception is refreshed to cover
   * the new rule set automatically - no separate re-enable step needed.
   */
  async addRule({ tabId, bundlePath, resourceUrl, autoReload = true }) {
    if (!this.bundles.length) {
      throw new Error('Select a local bundle, JavaScript, or HTML file first.');
    }

    const resolved = path.resolve(bundlePath);
    if (!this.bundles.includes(resolved)) {
      throw new Error('The selected local file was not discovered by this helper.');
    }

    // Derive from the actual file being added, not this.resourceType (which
    // only reflects whatever was LAST staged via setArtifact and goes stale
    // the moment a different kind of file is selected for this specific add).
    const resourceType = deriveResourceType(resolved) || this.resourceType;

    await stableRead(resolved);

    const target = await this.target(tabId);
    const targetHost = new URL(target.url).hostname;

    if (!isCandidate(resourceUrl, targetHost, resourceType)) {
      throw new Error('Resource URL must be a matching Dynamics web resource or PCF bundle from the selected tab.');
    }

    if (this.rules.length && this.rules.some(existing => existing.tabId !== tabId)) {
      // Re-point rather than reject. Closing and reopening the Dynamics tab
      // is completely ordinary browser use - the old tabId these rules
      // reference is simply gone, not evidence the developer deliberately
      // switched to a second, unrelated tab. Assume continuity.
      for (const existing of this.rules) existing.tabId = tabId;
    }

    if (this.rules.some(existing => existing.resourceUrl === resourceUrl)) {
      throw new Error('That Dynamics resource already has an active override.');
    }

    const newRule = {
      id: randomUUID(),
      tabId,
      bundlePath: resolved,
      resourceUrl,
      rule: createRule(resourceUrl, resourceType),
      resourceType,
      dynamicsHostname: targetHost,
      autoReload
    };

    this.rules.push(newRule);
    await this.persist();

    const wasEnabled = this.enabled;
    if (wasEnabled) {
      await this.disable();
      await this.enable();
    } else {
      this.startWatcher();
    }

    return this.snapshot();
  }

  /**
   * Remove one override rule. If the session was enabled, interception is
   * refreshed to drop that rule's pattern (or fully disabled if none remain).
   */
  async removeRule(ruleId) {
    const index = this.rules.findIndex(existing => existing.id === ruleId);
    if (index === -1) throw new Error('No such override rule.');

    const wasEnabled = this.enabled;
    if (wasEnabled) await this.disable();

    this.rules.splice(index, 1);
    await this.persist();
    this.startWatcher();

    if (wasEnabled && this.rules.length) {
      await this.enable();
    }

    return this.snapshot();
  }

  /**
   * Compatibility wrapper matching the original single-rule API: replaces
   * the entire rule set with exactly this one rule. Existing UI built
   * against the single-override model keeps working unchanged; addRule/
   * removeRule are the primitives for genuine multi-rule use.
   */
  async configure({ tabId, bundlePath, resourceUrl, autoReload = true }) {
    if (this.enabled) await this.disable();
    this.rules = [];
    return this.addRule({ tabId, bundlePath, resourceUrl, autoReload });
  }

  async configureSession(client, sessionId) {
    await client.send('Network.enable', {}, sessionId);
    await client.send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId);
    await client.send('Network.setBypassServiceWorker', { bypass: true }, sessionId);

    const patterns = this.rules.flatMap(r => interceptionPatterns(r.rule));
    if (!patterns.length) throw new Error('No configured resource interception pattern.');

    await client.send('Fetch.enable', { patterns }, sessionId);
  }

  /** Finds a currently open Dynamics tab matching a hostname, for recovering
   * when the tab a session was pointed at has been closed. Returns the raw
   * target (with webSocketDebuggerUrl), not the mapped dynamicsTabs() shape. */
  async _findReplacementTab(hostname) {
    const pages = (await targets(this.port)).filter(t => t.type === 'page' && isDynamicsUrl(t.url));
    return pages.find(t => new URL(t.url).hostname === hostname) || pages[0] || null;
  }

  async enable() {
    if (!this.rules.length) {
      throw new Error('Add at least one override rule first.');
    }

    await this.disable();

    let tabId = this.rules[0].tabId;
    let target;
    try {
      target = await this.target(tabId);
    } catch {
      // The tab these rules were pointed at is gone - closing and reopening
      // the Dynamics tab is ordinary browser use, not something a developer
      // should have to manually recover from. Look for another currently
      // open Dynamics tab with the same hostname and re-point everything to it.
      const replacement = await this._findReplacementTab(this.rules[0].dynamicsHostname);
      if (!replacement) {
        throw new Error('The Dynamics tab for these overrides was closed. Open Dynamics again, then try Enable overrides once more.');
      }
      tabId = replacement.id;
      for (const rule of this.rules) rule.tabId = tabId;
      await this.persist();
      target = replacement;
    }

    let client;

    try {
      client = await new CdpClient(target.webSocketDebuggerUrl).connect();
      this.client = client;

      client.on('disconnect', () => {
        if (this.client === client) {
          this.client = null;
          this.enabled = false;

          this.persist().catch(error => console.error(`Config: ${error.message}`));

          this.status = {
            stage: 'disconnected',
            message: 'Chrome tab disconnected.',
            at: Date.now()
          };
        }
      });

      client.on('event', (method, params, sessionId) => {
        void this.handleEvent(client, method, params, sessionId);
      });

      await this.configureSession(client);
      await client.send('Page.enable');
      await client.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true
      });

      this.enabled = true;
      await this.persist();

      this.status = {
        stage: 'attached',
        at: Date.now(),
        rules: this.rules.length
      };

      this.startWatcher();
      return this.snapshot();
    } catch (error) {
      if (this.client === client) this.client = null;
      client?.close();

      this.enabled = false;
      await this.persist().catch(() => {});

      this.status = {
        stage: 'error',
        message: error.message,
        at: Date.now()
      };

      throw error;
    }
  }

  async handleEvent(client, method, params, sessionId) {
    try {
      await this.onEvent(client, method, params, sessionId);
    } catch (error) {
      if (/session with given id not found|no session with given id|target closed/i.test(error.message)) return;

      this.status = {
        stage: 'error',
        at: Date.now(),
        message: error.message
      };

      console.error(`CDP event: ${error.message}`);
    }
  }

  async onEvent(client, method, params, sessionId) {
    if (method === 'Target.attachedToTarget') {
      try {
        if (params.targetInfo?.type === 'iframe') {
          await this.configureSession(client, params.sessionId);
        }
      } finally {
        await client.send(
          'Runtime.runIfWaitingForDebugger',
          {},
          params.sessionId
        ).catch(() => {});
      }
      return;
    }

    if (method !== 'Fetch.requestPaused') return;

    const id = params.requestId;
    const url = params.request.url;

    try {
      const matched = this.rules.find(r => matchesRule(r.rule, url));

      if (!matched) {
        return await client.send(
          'Fetch.continueRequest',
          { requestId: id },
          sessionId
        );
      }

      this.status = {
        stage: 'matched',
        at: Date.now(),
        url,
        target: sessionId ? 'iframe' : 'page',
        ruleId: matched.id
      };

      const { data, stat } = await stableRead(matched.bundlePath);
      const contentType = matched.resourceType === 'html'
        ? 'text/html; charset=utf-8'
        : 'application/javascript; charset=utf-8';

      const hash = createHash('sha256')
        .update(data)
        .digest('hex')
        .slice(0, 12);

      await client.send(
        'Fetch.fulfillRequest',
        {
          requestId: id,
          responseCode: 200,
          responseHeaders: [
            { name: 'Content-Type', value: contentType },
            { name: 'Cache-Control', value: 'no-store, no-cache, must-revalidate' },
            { name: 'Pragma', value: 'no-cache' },
            { name: 'Expires', value: '0' },
            { name: 'X-PCF-Local-Override-Hash', value: hash },
            { name: 'Content-Length', value: String(data.length) }
          ],
          body: data.toString('base64')
        },
        sessionId
      );

      this.status = {
        stage: 'served',
        at: Date.now(),
        url,
        target: sessionId ? 'iframe' : 'page',
        size: data.length,
        modified: stat.mtimeMs,
        hash,
        ruleId: matched.id
      };

      console.log(
        `${new Date().toLocaleTimeString()} served ${formatSize(data.length)} hash ${hash} ${url}`
      );
    } catch (error) {
      await client.send(
        'Fetch.continueRequest',
        { requestId: id },
        sessionId
      ).catch(() => {});

      this.status = {
        stage: 'error',
        at: Date.now(),
        url,
        message: error.message
      };
    }
  }

  async disable() {
    if (this.client) {
      const client = this.client;
      this.client = null;

      await client.send('Fetch.disable').catch(() => {});
      client.close();
    }

    this.enabled = false;
    await this.persist();

    this.status = { stage: 'off', at: Date.now() };
    return this.snapshot();
  }

  async reload(tabId) {
    if (!tabId || tabId === this.rules[0]?.tabId) {
      if (!this.client) throw new Error('Override is not active.');

      await this.client.send('Network.clearBrowserCache').catch(() => {});
      await this.client.send('Page.reload', { ignoreCache: true });
      return;
    }

    const target = await this.target(tabId);
    const client = await new CdpClient(target.webSocketDebuggerUrl).connect();

    try {
      await client.send('Page.enable');
      await client.send('Network.enable');
      await client.send('Network.clearBrowserCache').catch(() => {});
      await client.send('Page.reload', { ignoreCache: true });
    } finally {
      client.close();
    }
  }

  /**
   * Compatibility wrapper: sets autoReload on the first/only rule, matching
   * the existing single-rule UI's single auto-reload checkbox.
   */
  async setAutoReload(value) {
    if (!this.rules.length) throw new Error('Configure the project first.');

    this.rules[0].autoReload = Boolean(value);
    await this.persist();
    return this.snapshot();
  }

  /** Per-rule auto-reload control, for genuine multi-rule use. */
  async setRuleAutoReload(ruleId, value) {
    const rule = this.rules.find(existing => existing.id === ruleId);
    if (!rule) throw new Error('No such override rule.');

    rule.autoReload = Boolean(value);
    await this.persist();
    return this.snapshot();
  }

  startWatcher() {
    this.stopWatcher?.();
    clearTimeout(this._reloadTimer);

    if (!this.rules.length) {
      this.stopWatcher = undefined;
      return;
    }

    const stops = this.rules.map(r => watchBundle(r.bundlePath, async ({ data }) => {
      this.status = {
        stage: 'bundle-changed',
        at: Date.now(),
        size: data.length,
        ruleId: r.id
      };

      if (!(this.enabled && r.autoReload && this.client)) return;

      // A single edit can produce several rapid recompiles (editor autosave,
      // webpack's own multi-pass writes). Reload once after changes settle
      // rather than once per intermediate rebuild. One shared timer covers
      // all rules: they're all served into the same page, so a burst of
      // changes across several overridden files still only needs one reload.
      clearTimeout(this._reloadTimer);
      this._reloadTimer = setTimeout(() => {
        this.reload().catch(error => {
          this.status = { stage: 'error', message: error.message, at: Date.now() };
        });
      }, this.reloadSettleMs);
    }));

    this.stopWatcher = () => {
      clearTimeout(this._reloadTimer);
      stops.forEach(stop => stop());
    };
  }

  snapshot() {
    return {
      projectRoot: this.root,
      chromePort: this.port,
      bundles: this.bundles,
      rules: this.rules,
      config: this.rules[0] || null, // back-compat alias for the existing single-rule extension UI
      enabled: this.enabled,
      status: this.status,
      connected: Boolean(this.client),
      resourceType: this.resourceType,
      hasArtifact: this.bundles.length > 0
    };
  }

  async close() {
    this.stopWatcher?.();
    await this.disable();
  }
}
