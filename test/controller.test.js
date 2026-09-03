import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// Redirect the helper's config file (~/.pcf-local-override/config.json) into a
// temp HOME before controller.js -> config.js resolves it at module load.
const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-home-'));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;

const { Controller } = await import('../helper/controller.js');

/** Minimal stand-in for Chrome's /json target list endpoint. */
async function targetsServer(targetList) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(targetList));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

/** Records every CDP command a Controller sends, without a real WebSocket. */
function fakeClient() {
  const sent = [];
  return {
    sent,
    send(method, params = {}, sessionId) {
      sent.push({ method, params, sessionId });
      return Promise.resolve({});
    },
    close() { sent.push({ method: '__closed__' }); }
  };
}

async function tempBundle(contents = 'console.log("local");', name = 'bundle.js') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-bundle-'));
  const file = path.join(dir, name);
  await fs.writeFile(file, contents);
  return { dir, file };
}

const ruleFor = (url, resourceType = 'pcf') => ({
  hostname: new URL(url).hostname,
  exactPath: new URL(url).pathname.toLowerCase(),
  normalized: null,
  control: null,
  selectedUrl: url,
  resourceType
});

test('constructor forces a restored config to start disabled', () => {
  const controller = new Controller({
    root: '/tmp/project',
    port: 9222,
    bundles: [],
    config: { enabled: true, bundlePath: '/tmp/project/bundle.js' },
    resourceType: 'pcf'
  });

  assert.equal(controller.config.enabled, false, 'a persisted enabled:true must not auto-attach on startup');
  assert.deepEqual(controller.status, { stage: 'idle' });
});

test('snapshot exposes the fields the extension popup renders', () => {
  const controller = new Controller({
    root: '/tmp/project', port: 9222, bundles: ['/tmp/project/bundle.js'],
    config: null, resourceType: 'script'
  });

  assert.deepEqual(controller.snapshot(), {
    projectRoot: '/tmp/project',
    chromePort: 9222,
    bundles: ['/tmp/project/bundle.js'],
    config: null,
    status: { stage: 'idle' },
    connected: false,
    resourceType: 'script',
    hasArtifact: true
  });
});

test('snapshot reports no artifact when the helper started bare', () => {
  const controller = new Controller({ root: '/tmp/project', port: 9222, bundles: [] });
  assert.equal(controller.snapshot().hasArtifact, false);
});

test('dynamicsTabs returns only Dynamics page targets', async () => {
  const { server, port } = await targetsServer([
    { id: 'a', type: 'page', title: 'Accounts', url: 'https://org.crm4.dynamics.com/main.aspx' },
    { id: 'b', type: 'page', title: 'Docs', url: 'https://example.com/' },
    { id: 'c', type: 'iframe', title: 'Nested', url: 'https://org.crm4.dynamics.com/frame' },
    { id: 'd', type: 'page', title: 'Other CRM', url: 'https://org.crm.dynamics.com/main.aspx' }
  ]);

  try {
    const controller = new Controller({ root: '/tmp/p', port, bundles: [] });
    const tabs = await controller.dynamicsTabs();

    assert.deepEqual(tabs.map(t => t.id), ['a', 'd'], 'non-Dynamics hosts and non-page types are excluded');
    assert.equal(tabs[0].title, 'Accounts');
  } finally {
    server.close();
  }
});

test('target throws a clear error when the tab is gone', async () => {
  const { server, port } = await targetsServer([]);
  try {
    const controller = new Controller({ root: '/tmp/p', port, bundles: [] });
    await assert.rejects(() => controller.target('missing'), /no longer available/);
  } finally {
    server.close();
  }
});

test('configure rejects a local file the helper did not discover', async () => {
  const controller = new Controller({
    root: '/tmp/p', port: 9222, bundles: ['/tmp/p/out/bundle.js'], resourceType: 'pcf'
  });

  await assert.rejects(
    () => controller.configure({
      tabId: 'a',
      bundlePath: '/tmp/p/somewhere-else/bundle.js',
      resourceUrl: 'https://org.crm.dynamics.com/x/webresources/cc_C/bundle.js'
    }),
    /was not discovered by this helper/
  );
});

test('configure asks for an artifact before anything is selected', async () => {
  const controller = new Controller({ root: '/tmp/p', port: 9222, bundles: [] });

  await assert.rejects(
    () => controller.configure({
      tabId: 'a',
      bundlePath: '/tmp/p/out/bundle.js',
      resourceUrl: 'https://org.crm.dynamics.com/x/webresources/cc_C/bundle.js'
    }),
    /Select a local bundle, JavaScript, or HTML file first/
  );
});

test('setArtifact rejects an empty selection', async () => {
  const controller = new Controller({ root: '/tmp/p', port: 9222, bundles: [] });
  await assert.rejects(() => controller.setArtifact(''), /Select a local bundle/);
  await assert.rejects(() => controller.setArtifact('   '), /Select a local bundle/);
  await assert.rejects(() => controller.setArtifact(null), /Select a local bundle/);
});

test('setArtifact rejects a path that does not exist', async () => {
  const controller = new Controller({ root: '/tmp/p', port: 9222, bundles: [] });
  await assert.rejects(
    () => controller.setArtifact(path.join(os.tmpdir(), 'pcf-definitely-missing-xyz')),
    /does not exist/
  );
});

test('setArtifact derives pcf from a bundle file and populates the allowlist', async () => {
  const { file } = await tempBundle();
  const controller = new Controller({ root: '/tmp/p', port: 9222, bundles: [] });

  const snapshot = await controller.setArtifact(file);

  assert.equal(snapshot.resourceType, 'pcf');
  assert.deepEqual(snapshot.bundles, [file]);
  assert.equal(snapshot.hasArtifact, true);
  assert.equal(snapshot.status.stage, 'artifact-selected');

  controller.stopWatcher?.();
});

test('setArtifact derives script from a non-bundle JavaScript file', async () => {
  const { file } = await tempBundle('function onLoad() {}', 'account-form.js');
  const controller = new Controller({ root: '/tmp/p', port: 9222, bundles: [] });

  const snapshot = await controller.setArtifact(file);
  assert.equal(snapshot.resourceType, 'script');
  assert.deepEqual(snapshot.bundles, [file]);

  controller.stopWatcher?.();
});

test('setArtifact derives html from an HTML file', async () => {
  const { file } = await tempBundle('<h1>x</h1>', 'dialog.html');
  const controller = new Controller({ root: '/tmp/p', port: 9222, bundles: [] });

  const snapshot = await controller.setArtifact(file);
  assert.equal(snapshot.resourceType, 'html');

  controller.stopWatcher?.();
});

test('setArtifact accepts a folder containing a bundle', async () => {
  const { dir, file } = await tempBundle();
  const controller = new Controller({ root: '/tmp/p', port: 9222, bundles: [] });

  const snapshot = await controller.setArtifact(dir);
  assert.equal(snapshot.resourceType, 'pcf');
  assert.deepEqual(snapshot.bundles, [file]);
  assert.equal(snapshot.projectRoot, dir, 'project root follows the selected artifact');

  controller.stopWatcher?.();
});

test('setArtifact rejects an unsupported file type', async () => {
  const { file } = await tempBundle('data', 'notes.txt');
  const controller = new Controller({ root: '/tmp/p', port: 9222, bundles: [] });
  await assert.rejects(() => controller.setArtifact(file), /Unsupported file type/);
});

test('setArtifact discards a stale rule from a different resource type', async () => {
  const { file: htmlFile } = await tempBundle('<h1>x</h1>', 'dialog.html');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-root-'));

  const controller = new Controller({
    root,
    port: 9222,
    bundles: ['/tmp/old/bundle.js'],
    config: {
      bundlePath: '/tmp/old/bundle.js',
      resourceType: 'pcf',
      rule: ruleFor('https://org.crm4.dynamics.com/x/webresources/cc_C/bundle.js')
    },
    resourceType: 'pcf'
  });

  const snapshot = await controller.setArtifact(htmlFile);

  assert.equal(snapshot.config, null, 'a PCF rule must not survive switching to an HTML artifact');
  assert.equal(snapshot.resourceType, 'html');

  controller.stopWatcher?.();
});

test('setArtifact tears down an active override before switching', async () => {
  const { file } = await tempBundle();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-root-'));
  const controller = new Controller({ root, port: 9222, bundles: [], config: { enabled: true } });

  const client = fakeClient();
  controller.client = client;

  await controller.setArtifact(file);

  assert.ok(client.sent.some(c => c.method === 'Fetch.disable'), 'the previous interception must be released');
  assert.equal(controller.client, null);

  controller.stopWatcher?.();
});

test('configure rejects a resource URL that is not a candidate for the selected tab', async () => {
  const { file } = await tempBundle();
  const { server, port } = await targetsServer([
    { id: 'a', type: 'page', title: 'D365', url: 'https://org.crm4.dynamics.com/main.aspx',
      webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/a' }
  ]);

  try {
    const controller = new Controller({ root: '/tmp/p', port, bundles: [file], resourceType: 'pcf' });

    // Right shape, wrong host - must not be accepted just because it looks like a bundle.
    await assert.rejects(
      () => controller.configure({
        tabId: 'a',
        bundlePath: file,
        resourceUrl: 'https://attacker.example.com/webresources/cc_C/bundle.js'
      }),
      /must be a matching Dynamics web resource/
    );
  } finally {
    server.close();
  }
});

test('configure persists a rule and returns the saved config', async () => {
  const { file } = await tempBundle();
  const { server, port } = await targetsServer([
    { id: 'a', type: 'page', title: 'D365', url: 'https://org.crm4.dynamics.com/main.aspx',
      webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/a' }
  ]);

  try {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-root-'));
    const controller = new Controller({ root, port, bundles: [file], resourceType: 'pcf' });

    const resourceUrl = 'https://org.crm4.dynamics.com/%7bABC%7d/webresources/cc_Control/bundle.js';
    const config = await controller.configure({ tabId: 'a', bundlePath: file, resourceUrl });

    assert.equal(config.tabId, 'a');
    assert.equal(config.bundlePath, file);
    assert.equal(config.dynamicsHostname, 'org.crm4.dynamics.com');
    assert.equal(config.resourceType, 'pcf');
    assert.equal(config.enabled, false, 'configure must not auto-enable the override');
    assert.equal(config.autoReload, true, 'autoReload defaults on');
    assert.equal(config.rule.selectedUrl, resourceUrl);

    // Written through to the redirected config file, not just held in memory.
    const onDisk = JSON.parse(await fs.readFile(path.join(fakeHome, '.pcf-local-override', 'config.json'), 'utf8'));
    assert.equal(onDisk.projects[path.resolve(root).toLowerCase()].bundlePath, file);

    // configure() starts a real file watcher; release it or the test process will not exit.
    controller.stopWatcher?.();
  } finally {
    server.close();
  }
});

test('enable refuses to attach before a rule and local file are chosen', async () => {
  const controller = new Controller({ root: '/tmp/p', port: 9222, bundles: [] });
  await assert.rejects(() => controller.enable(), /Select both the local file and Dynamics resource/);
});

test('configureSession refuses to attach with no interception pattern', async () => {
  const controller = new Controller({ root: '/tmp/p', port: 9222, bundles: [] });
  controller.config = { rule: null };
  await assert.rejects(
    () => controller.configureSession(fakeClient()),
    /No configured resource interception pattern/
  );
});

test('onEvent passes through a request that does not match the rule', async () => {
  const { file } = await tempBundle();
  const controller = new Controller({ root: '/tmp/p', port: 9222, bundles: [file], resourceType: 'pcf' });
  controller.config = {
    bundlePath: file,
    rule: ruleFor('https://org.crm4.dynamics.com/x/webresources/cc_Control/bundle.js')
  };

  const client = fakeClient();
  await controller.onEvent(client, 'Fetch.requestPaused', {
    requestId: 'r1',
    request: { url: 'https://org.crm4.dynamics.com/some/other/script.js' }
  });

  assert.deepEqual(client.sent.map(c => c.method), ['Fetch.continueRequest']);
  assert.notEqual(controller.status.stage, 'served', 'a non-matching request must never be served locally');
});

test('onEvent serves the local file for a matching request', async () => {
  const contents = 'console.log("served from disk");';
  const { file } = await tempBundle(contents);
  const url = 'https://org.crm4.dynamics.com/%7bABC%7d/webresources/cc_Control/bundle.js';

  const controller = new Controller({ root: '/tmp/p', port: 9222, bundles: [file], resourceType: 'pcf' });
  controller.config = { bundlePath: file, rule: ruleFor(url) };

  const client = fakeClient();
  await controller.onEvent(client, 'Fetch.requestPaused', { requestId: 'r1', request: { url } });

  const fulfil = client.sent.find(c => c.method === 'Fetch.fulfillRequest');
  assert.ok(fulfil, 'a matching request must be fulfilled, not continued');
  assert.equal(fulfil.params.responseCode, 200);
  assert.equal(Buffer.from(fulfil.params.body, 'base64').toString(), contents);

  const headers = Object.fromEntries(fulfil.params.responseHeaders.map(h => [h.name, h.value]));
  assert.match(headers['Content-Type'], /javascript/);
  assert.match(headers['Cache-Control'], /no-store/, 'stale caching would defeat the override');
  assert.equal(headers['Content-Length'], String(Buffer.byteLength(contents)));
  assert.match(headers['X-PCF-Local-Override-Hash'], /^[0-9a-f]{12}$/);

  assert.equal(controller.status.stage, 'served');
  assert.equal(controller.status.size, Buffer.byteLength(contents));
  assert.equal(controller.status.target, 'page');
});

test('onEvent serves HTML resources with an HTML content type', async () => {
  const { file } = await tempBundle('<h1>local</h1>', 'dialog.html');
  const url = 'https://org.crm4.dynamics.com/webresources/cc_/dialog.html';

  const controller = new Controller({ root: '/tmp/p', port: 9222, bundles: [file], resourceType: 'html' });
  controller.config = { bundlePath: file, rule: ruleFor(url, 'html') };

  const client = fakeClient();
  await controller.onEvent(client, 'Fetch.requestPaused', { requestId: 'r1', request: { url } });

  const fulfil = client.sent.find(c => c.method === 'Fetch.fulfillRequest');
  const headers = Object.fromEntries(fulfil.params.responseHeaders.map(h => [h.name, h.value]));
  assert.match(headers['Content-Type'], /text\/html/);
});

test('onEvent tags iframe-served requests distinctly from page requests', async () => {
  const { file } = await tempBundle();
  const url = 'https://org.crm4.dynamics.com/x/webresources/cc_Control/bundle.js';

  const controller = new Controller({ root: '/tmp/p', port: 9222, bundles: [file], resourceType: 'pcf' });
  controller.config = { bundlePath: file, rule: ruleFor(url) };

  const client = fakeClient();
  await controller.onEvent(client, 'Fetch.requestPaused', { requestId: 'r1', request: { url } }, 'session-9');

  const fulfil = client.sent.find(c => c.method === 'Fetch.fulfillRequest');
  assert.equal(fulfil.sessionId, 'session-9', 'the fulfil must go back on the originating session');
  assert.equal(controller.status.target, 'iframe');
});

test('onEvent falls back to continueRequest when the local file cannot be read', async () => {
  const { dir, file } = await tempBundle();
  const url = 'https://org.crm4.dynamics.com/x/webresources/cc_Control/bundle.js';

  const controller = new Controller({ root: '/tmp/p', port: 9222, bundles: [file], resourceType: 'pcf' });
  controller.config = { bundlePath: file, rule: ruleFor(url) };

  await fs.rm(dir, { recursive: true, force: true });

  const client = fakeClient();
  await controller.onEvent(client, 'Fetch.requestPaused', { requestId: 'r1', request: { url } });

  assert.ok(
    client.sent.some(c => c.method === 'Fetch.continueRequest'),
    'a failed local read must let the real Dynamics resource through rather than hang the request'
  );
  assert.equal(controller.status.stage, 'error');
  assert.equal(controller.status.url, url);
});

test('onEvent configures interception for attached iframe targets', async () => {
  const { file } = await tempBundle();
  const controller = new Controller({ root: '/tmp/p', port: 9222, bundles: [file], resourceType: 'pcf' });
  controller.config = {
    bundlePath: file,
    rule: ruleFor('https://org.crm4.dynamics.com/x/webresources/cc_Control/bundle.js')
  };

  const client = fakeClient();
  await controller.onEvent(client, 'Target.attachedToTarget', {
    sessionId: 'iframe-1',
    targetInfo: { type: 'iframe' }
  });

  const methods = client.sent.filter(c => c.sessionId === 'iframe-1').map(c => c.method);
  assert.ok(methods.includes('Fetch.enable'), 'iframes must get their own Fetch interception');
  assert.ok(methods.includes('Network.setCacheDisabled'));
  assert.ok(methods.includes('Runtime.runIfWaitingForDebugger'), 'the paused target must always be released');
});

test('onEvent always releases a waiting target even when session setup fails', async () => {
  const controller = new Controller({ root: '/tmp/p', port: 9222, bundles: [] });
  controller.config = { rule: null }; // forces configureSession to throw

  const client = fakeClient();
  await assert.rejects(
    () => controller.onEvent(client, 'Target.attachedToTarget', {
      sessionId: 'iframe-2',
      targetInfo: { type: 'iframe' }
    })
  );

  assert.ok(
    client.sent.some(c => c.method === 'Runtime.runIfWaitingForDebugger' && c.sessionId === 'iframe-2'),
    'a failed setup must not leave the iframe hung waiting for the debugger'
  );
});

test('handleEvent swallows benign stale-session CDP errors', async () => {
  const controller = new Controller({ root: '/tmp/p', port: 9222, bundles: [] });
  controller.onEvent = async () => { throw new Error('No session with given id found'); };

  await controller.handleEvent(fakeClient(), 'Fetch.requestPaused', {});
  assert.notEqual(controller.status.stage, 'error', 'a closed tab is expected, not a reportable failure');
});

test('handleEvent records genuine failures as error status', async () => {
  const controller = new Controller({ root: '/tmp/p', port: 9222, bundles: [] });
  controller.onEvent = async () => { throw new Error('something actually broke'); };

  await controller.handleEvent(fakeClient(), 'Fetch.requestPaused', {});
  assert.equal(controller.status.stage, 'error');
  assert.equal(controller.status.message, 'something actually broke');
});

test('disable detaches the client and marks the override off', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-root-'));
  const controller = new Controller({ root, port: 9222, bundles: [], config: { enabled: true } });

  const client = fakeClient();
  controller.client = client;

  const snapshot = await controller.disable();

  assert.ok(client.sent.some(c => c.method === 'Fetch.disable'));
  assert.ok(client.sent.some(c => c.method === '__closed__'), 'the CDP socket must be closed, not leaked');
  assert.equal(controller.client, null);
  assert.equal(controller.config.enabled, false);
  assert.equal(snapshot.connected, false);
  assert.equal(controller.status.stage, 'off');
});

test('reload requires an active override for the configured tab', async () => {
  const controller = new Controller({ root: '/tmp/p', port: 9222, bundles: [] });
  controller.config = { tabId: 'a' };
  await assert.rejects(() => controller.reload('a'), /not active/);
});

test('reload clears cache and hard-reloads the attached tab', async () => {
  const controller = new Controller({ root: '/tmp/p', port: 9222, bundles: [] });
  controller.config = { tabId: 'a' };
  const client = fakeClient();
  controller.client = client;

  await controller.reload('a');

  const reload = client.sent.find(c => c.method === 'Page.reload');
  assert.ok(client.sent.some(c => c.method === 'Network.clearBrowserCache'));
  assert.equal(reload.params.ignoreCache, true, 'a cached bundle would mask the local override');
});

test('setAutoReload requires configuration and persists the flag', async () => {
  const bare = new Controller({ root: '/tmp/p', port: 9222, bundles: [] });
  await assert.rejects(() => bare.setAutoReload(true), /Configure the project first/);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-root-'));
  const controller = new Controller({ root, port: 9222, bundles: [], config: { autoReload: true } });

  const snapshot = await controller.setAutoReload(false);
  assert.equal(snapshot.config.autoReload, false);
});

test('startWatcher ignores a configured path outside the discovered bundle list', () => {
  const controller = new Controller({
    root: '/tmp/p', port: 9222, bundles: ['/tmp/p/out/bundle.js']
  });
  controller.config = { bundlePath: '/tmp/p/elsewhere/bundle.js' };

  controller.startWatcher();
  assert.equal(controller.stopWatcher, undefined, 'must not watch a file the helper never discovered');
});

test('close stops the watcher and disables the override', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-root-'));
  const controller = new Controller({ root, port: 9222, bundles: [], config: { enabled: true } });

  let watcherStopped = false;
  controller.stopWatcher = () => { watcherStopped = true; };
  const client = fakeClient();
  controller.client = client;

  await controller.close();

  assert.equal(watcherStopped, true);
  assert.equal(controller.client, null);
  assert.equal(controller.status.stage, 'off');
});

test('reload settle window coalesces a burst of rebuilds into one reload', async () => {
  const { file } = await tempBundle('v1');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-root-'));

  const controller = new Controller({
    root, port: 9222, bundles: [file], resourceType: 'pcf', reloadSettleMs: 30
  });
  // The constructor intentionally forces enabled:false on any config passed
  // at construction time (verified above by "constructor forces a restored
  // config to start disabled"). Simulating an already-active override means
  // setting config directly afterward, same as the other reload tests do.
  controller.config = { bundlePath: file, autoReload: true, enabled: true, tabId: 'a' };
  const client = fakeClient();
  controller.client = client;
  controller.startWatcher();

  // Simulate three rapid recompiles landing inside the settle window, the way
  // editor autosave firing on consecutive keystrokes would.
  await fs.writeFile(file, 'v2');
  await new Promise(r => setTimeout(r, 60));
  await fs.writeFile(file, 'v3');
  await new Promise(r => setTimeout(r, 60));
  await fs.writeFile(file, 'v4');

  // Wait past the debounce + stableRead settle + reload settle window.
  await new Promise(r => setTimeout(r, 800));

  const reloads = client.sent.filter(c => c.method === 'Page.reload').length;
  assert.equal(reloads, 1, `expected exactly one coalesced reload, got ${reloads}`);

  controller.stopWatcher?.();
});

test('reload settle window does not fire when autoReload is off', async () => {
  const { file } = await tempBundle('v1');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-root-'));

  const controller = new Controller({
    root, port: 9222, bundles: [file], resourceType: 'pcf', reloadSettleMs: 30
  });
  controller.config = { bundlePath: file, autoReload: false, enabled: true, tabId: 'a' };
  const client = fakeClient();
  controller.client = client;
  controller.startWatcher();

  await fs.writeFile(file, 'v2');
  await new Promise(r => setTimeout(r, 500));

  assert.equal(client.sent.filter(c => c.method === 'Page.reload').length, 0);
  controller.stopWatcher?.();
});
