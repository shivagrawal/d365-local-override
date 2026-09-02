import path from 'node:path';
import { createHash } from 'node:crypto';
import { CdpClient, targets } from './cdp.js';
import { createRule, interceptionPatterns, isCandidate, isDynamicsUrl, matchesRule } from '../shared/matcher.js';
import { saveProject } from './config.js';
import { stableRead, formatSize } from './utils.js';
import { watchBundle } from './watcher.js';

export class Controller {
  constructor({ root, port, bundles, config, resourceType = 'pcf' }) {
    Object.assign(this, { root, port, bundles, config, resourceType });
    if (this.config) this.config.enabled = false;
    this.status = { stage: 'idle' };
  }

  async dynamicsTabs() {
    return (await targets(this.port))
      .filter(target => target.type === 'page' && isDynamicsUrl(target.url))
      .map(target => ({ id: target.id, title: target.title, url: target.url }));
  }

  async target(id) {
    const target = (await targets(this.port)).find(item => item.id === id);
    if (!target) throw new Error('The selected Chrome tab is no longer available.');
    return target;
  }

  async scan(tabId, resourceType = this.resourceType, timeoutMs = 5000) {
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

    const localName = comparableName(this.bundles[0]);

    return [...found.values()].sort((left, right) => {
      const leftName = comparableName(new URL(left.url).pathname);
      const rightName = comparableName(new URL(right.url).pathname);

      return Number(rightName === localName) - Number(leftName === localName) ||
        Number(rightName.includes(localName)) - Number(leftName.includes(localName));
    });
  }

  async configure({ tabId, bundlePath, resourceUrl, autoReload = true }) {
    const resolved = path.resolve(bundlePath);
    if (!this.bundles.includes(resolved)) {
      throw new Error('The selected local file was not discovered by this helper.');
    }

    await stableRead(resolved);

    const target = await this.target(tabId);
    const targetHost = new URL(target.url).hostname;

    if (!isCandidate(resourceUrl, targetHost, this.resourceType)) {
      throw new Error('Resource URL must be a matching Dynamics web resource or PCF bundle from the selected tab.');
    }

    if (this.client) await this.disable();

    this.config = await saveProject(this.root, {
      tabId,
      bundlePath: resolved,
      rule: createRule(resourceUrl, this.resourceType),
      resourceType: this.resourceType,
      dynamicsHostname: targetHost,
      autoReload,
      enabled: false
    });

    this.startWatcher();
    return this.config;
  }

  async configureSession(client, sessionId) {
    await client.send('Network.enable', {}, sessionId);
    await client.send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId);
    await client.send('Network.setBypassServiceWorker', { bypass: true }, sessionId);

    const patterns = interceptionPatterns(this.config?.rule);
    if (!patterns.length) throw new Error('No configured resource interception pattern.');

    await client.send('Fetch.enable', { patterns }, sessionId);
  }

  async enable() {
    if (!this.config?.rule || !this.config?.bundlePath) {
      throw new Error('Select both the local file and Dynamics resource first.');
    }

    await this.disable();

    const target = await this.target(this.config.tabId);
    let client;

    try {
      client = await new CdpClient(target.webSocketDebuggerUrl).connect();
      this.client = client;

      client.on('disconnect', () => {
        if (this.client === client) {
          this.client = null;
          this.config.enabled = false;

          saveProject(this.root, this.config)
            .catch(error => console.error(`Config: ${error.message}`));

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

      this.config.enabled = true;
      await saveProject(this.root, this.config);

      this.status = {
        stage: 'attached',
        at: Date.now(),
        url: this.config.rule.selectedUrl
      };

      this.startWatcher();
      return this.snapshot();
    } catch (error) {
      if (this.client === client) this.client = null;
      client?.close();

      this.config.enabled = false;
      await saveProject(this.root, this.config).catch(() => {});

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
      if (!matchesRule(this.config.rule, url)) {
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
        target: sessionId ? 'iframe' : 'page'
      };

      const { data, stat } = await stableRead(this.config.bundlePath);
      const contentType = this.resourceType === 'html'
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
        hash
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

    if (this.config) {
      this.config.enabled = false;
      await saveProject(this.root, this.config);
    }

    this.status = { stage: 'off', at: Date.now() };
    return this.snapshot();
  }

  async reload(tabId) {
    if (!tabId || tabId === this.config?.tabId) {
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

  async setAutoReload(value) {
    if (!this.config) throw new Error('Configure the project first.');

    this.config.autoReload = Boolean(value);
    await saveProject(this.root, this.config);
    return this.snapshot();
  }

  startWatcher() {
    this.stopWatcher?.();

    if (!this.config?.bundlePath ||
        !this.bundles.includes(path.resolve(this.config.bundlePath))) return;

    this.stopWatcher = watchBundle(this.config.bundlePath, async ({ data }) => {
      this.status = {
        stage: 'bundle-changed',
        at: Date.now(),
        size: data.length
      };

      if (this.config.enabled && this.config.autoReload && this.client) {
        await this.reload();
      }
    });
  }

  snapshot() {
    return {
      projectRoot: this.root,
      chromePort: this.port,
      bundles: this.bundles,
      config: this.config,
      status: this.status,
      connected: Boolean(this.client),
      resourceType: this.resourceType
    };
  }

  async close() {
    this.stopWatcher?.();
    await this.disable();
  }
}
