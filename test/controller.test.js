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

async function targetsServer(targetList) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(targetList));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

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

const ruleEntry = (overrides = {}) => ({
  id: overrides.id || `rule-${Math.random().toString(36).slice(2)}`,
  tabId: 'a',
  bundlePath: '/tmp/p/bundle.js',
  resourceUrl: 'https://org.crm4.dynamics.com/x/webresources/cc_Control/bundle.js',
  rule: ruleFor('https://org.crm4.dynamics.com/x/webresources/cc_Control/bundle.js'),
  resourceType: 'pcf',
  dynamicsHostname: 'org.crm4.dynamics.com',
  autoReload: true,
  ...overrides
});

test('constructor always starts disabled regardless of what is passed in', () => {
  const controller = new Controller({
    root: '/tmp/project', port: 9222, bundles: [],
    rules: [ruleEntry()], resourceType: 'pcf'
  });
  assert.equal(controller.enabled, false, 'a restored session must not auto-attach on startup');
  assert.deepEqual(controller.status, { stage: 'idle' });
});

test('constructor defaults to an empty rule set when none is given', () => {
  const controller = new Controller({ root: '/tmp/p', port: 9222, bundles: [] });
  assert.deepEqual(controller.rules, []);
});

test('snapshot exposes the fields the extension popup renders', () => {
  const controller = new Controller({
    root: '/tmp/project', port: 9222, bundles: ['/tmp/project/bundle.js'],
    rules: [], resourceType: 'script'
  });

  assert.deepEqual(controller.snapshot(), {
    projectRoot: '/tmp/project',
    chromePort: 9222,
    bundles: ['/tmp/project/bundle.js'],
    rules: [],
    config: null,
    enabled: false,
    status: { stage: 'idle' },
    connected: false,
    resourceType: 'script',
    hasArtifact: true
  });
});

test('snapshot exposes the first rule as "config" for the existing single-rule extension UI', () => {
  const rule = ruleEntry();
  const controller = new Controller({ root: '/tmp/p', port: 9222, bundles: [], rules: [rule] });
  assert.deepEqual(controller.snapshot().config, rule);
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

test('setArtifact accepts a folder containing a bundle without moving the project root', async () => {
  const { dir, file } = await tempBundle();
  const controller = new Controller({ root: '/tmp/p', port: 9222, bundles: [] });
  const snapshot = await controller.setArtifact(dir);
  assert.equal(snapshot.resourceType, 'pcf');
  assert.deepEqual(snapshot.bundles, [file]);
  assert.equal(snapshot.projectRoot, '/tmp/p');
  controller.stopWatcher?.();
});

test('setArtifact rejects an unsupported file type', async () => {
  const { file } = await tempBundle('data', 'notes.txt');
  const controller = new Controller({ root: '/tmp/p', port: 9222, bundles: [] });
  await assert.rejects(() => controller.setArtifact(file), /Unsupported file type/);
});

test('setArtifact does not disturb an existing rule of a different resource type', async () => {
  const { file: htmlFile } = await tempBundle('<h1>x</h1>', 'dialog.html');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-root-'));
  const existingRule = ruleEntry({ resourceType: 'pcf', bundlePath: '/tmp/old/bundle.js' });

  const controller = new Controller({
    root, port: 9222, bundles: ['/tmp/old/bundle.js'], rules: [existingRule], resourceType: 'pcf'
  });

  const snapshot = await controller.setArtifact(htmlFile);

  assert.deepEqual(snapshot.rules, [existingRule], 'the existing PCF rule must survive staging an HTML artifact');
  assert.equal(snapshot.resourceType, 'html', 'the staging type updates for the NEXT rule to be added');

  controller.stopWatcher?.();
});

test('setArtifact does not touch an active CDP session or watcher', async () => {
  const { file } = await tempBundle();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-root-'));
  const controller = new Controller({ root, port: 9222, bundles: [], rules: [ruleEntry()] });
  controller.enabled = true;
  const client = fakeClient();
  controller.client = client;

  await controller.setArtifact(file);

  assert.deepEqual(client.sent, [], 'browsing for a new file to add must not touch the active session at all');
  assert.equal(controller.client, client, 'the active client must not be torn down');
  controller.stopWatcher?.();
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

test('configure rejects a resource URL that is not a candidate for the selected tab', async () => {
  const { file } = await tempBundle();
  const { server, port } = await targetsServer([
    { id: 'a', type: 'page', title: 'D365', url: 'https://org.crm4.dynamics.com/main.aspx',
      webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/a' }
  ]);

  try {
    const controller = new Controller({ root: '/tmp/p', port, bundles: [file], resourceType: 'pcf' });
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

test('configure persists exactly one rule and returns a snapshot matching the extension expectations', async () => {
  const { file } = await tempBundle();
  const { server, port } = await targetsServer([
    { id: 'a', type: 'page', title: 'D365', url: 'https://org.crm4.dynamics.com/main.aspx',
      webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/a' }
  ]);

  try {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-root-'));
    const controller = new Controller({ root, port, bundles: [file], resourceType: 'pcf' });

    const resourceUrl = 'https://org.crm4.dynamics.com/%7bABC%7d/webresources/cc_Control/bundle.js';
    const snapshot = await controller.configure({ tabId: 'a', bundlePath: file, resourceUrl });

    assert.equal(snapshot.rules.length, 1);
    const rule = snapshot.rules[0];
    assert.equal(rule.tabId, 'a');
    assert.equal(rule.bundlePath, file);
    assert.equal(rule.dynamicsHostname, 'org.crm4.dynamics.com');
    assert.equal(rule.resourceType, 'pcf');
    assert.equal(rule.autoReload, true, 'autoReload defaults on');
    assert.equal(rule.rule.selectedUrl, resourceUrl);
    assert.deepEqual(snapshot.config, rule, 'the back-compat config alias must match the first rule');
    assert.equal(snapshot.enabled, false, 'configure must not auto-enable the override');

    const onDisk = JSON.parse(await fs.readFile(path.join(fakeHome, '.pcf-local-override', 'config.json'), 'utf8'));
    const saved = onDisk.projects[path.resolve(root).toLowerCase()];
    assert.equal(saved.rules.length, 1);
    assert.equal(saved.rules[0].bundlePath, file);

    controller.stopWatcher?.();
  } finally {
    server.close();
  }
});

test('configure replaces the entire rule set rather than adding to it', async () => {
  const { file: fileA } = await tempBundle('a', 'a.js');
  const { file: fileB } = await tempBundle('b', 'b.js');
  const { server, port } = await targetsServer([
    { id: 'a', type: 'page', title: 'D365', url: 'https://org.crm4.dynamics.com/main.aspx',
      webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/a' }
  ]);

  try {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-root-'));
    const controller = new Controller({ root, port, bundles: [fileA], resourceType: 'script' });

    await controller.configure({
      tabId: 'a', bundlePath: fileA, resourceUrl: 'https://org.crm4.dynamics.com/webresources/cc_a'
    });
    controller.stopWatcher?.();

    controller.bundles = [fileB];
    const snapshot = await controller.configure({
      tabId: 'a', bundlePath: fileB, resourceUrl: 'https://org.crm4.dynamics.com/webresources/cc_b'
    });

    assert.equal(snapshot.rules.length, 1, 'configure() is a replace, not an add - matches the existing single-rule UI');
    assert.equal(snapshot.rules[0].bundlePath, fileB);

    controller.stopWatcher?.();
  } finally {
    server.close();
  }
});

test('enable refuses to attach with no rules configured', async () => {
  const controller = new Controller({ root: '/tmp/p', port: 9222, bundles: [] });
  await assert.rejects(() => controller.enable(), /Add at least one override rule first/);
});

test('configureSession refuses to attach with no interception patterns across any rule', async () => {
  const controller = new Controller({ root: '/tmp/p', port: 9222, bundles: [] });
  controller.rules = [ruleEntry({ rule: null })];
  await assert.rejects(
    () => controller.configureSession(fakeClient()),
    /No configured resource interception pattern/
  );
});

test('configureSession builds one combined pattern set covering every active rule', async () => {
  const controller = new Controller({ root: '/tmp/p', port: 9222, bundles: [] });
  controller.rules = [
    ruleEntry({ id: 'r1', resourceType: 'script', rule: ruleFor('https://org.crm4.dynamics.com/webresources/cc_a', 'script') }),
    ruleEntry({ id: 'r2', resourceType: 'html', rule: ruleFor('https://org.crm4.dynamics.com/webresources/cc_b.html', 'html') })
  ];

  const client = fakeClient();
  await controller.configureSession(client);

  const fetchEnable = client.sent.find(c => c.method === 'Fetch.enable');
  assert.ok(fetchEnable);
  assert.equal(fetchEnable.params.patterns.length, 2, 'both rules patterns must be present in one Fetch.enable call');
});

test('onEvent passes through a request that matches no rule', async () => {
  const { file } = await tempBundle();
  const controller = new Controller({ root: '/tmp/p', port: 9222, bundles: [file], resourceType: 'pcf' });
  controller.rules = [ruleEntry({ bundlePath: file, rule: ruleFor('https://org.crm4.dynamics.com/x/webresources/cc_Control/bundle.js') })];

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
  controller.rules = [ruleEntry({ bundlePath: file, rule: ruleFor(url) })];

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

test('onEvent dispatches to the correct rule when several are active at once', async () => {
  const { file: fileA } = await tempBundle('content-A', 'a.js');
  const { file: fileB } = await tempBundle('<h1>content-B</h1>', 'b.html');
  const urlA = 'https://org.crm4.dynamics.com/webresources/cc_a';
  const urlB = 'https://org.crm4.dynamics.com/webresources/cc_b.html';

  const controller = new Controller({ root: '/tmp/p', port: 9222, bundles: [fileA, fileB] });
  controller.rules = [
    ruleEntry({ id: 'rule-a', bundlePath: fileA, resourceType: 'script', rule: ruleFor(urlA, 'script') }),
    ruleEntry({ id: 'rule-b', bundlePath: fileB, resourceType: 'html', rule: ruleFor(urlB, 'html') })
  ];

  const client = fakeClient();
  await controller.onEvent(client, 'Fetch.requestPaused', { requestId: 'r1', request: { url: urlB } });

  const fulfil = client.sent.find(c => c.method === 'Fetch.fulfillRequest');
  assert.ok(fulfil, 'the request for urlB must be served');
  assert.equal(Buffer.from(fulfil.params.body, 'base64').toString(), '<h1>content-B</h1>', 'must serve rule B file, not rule A');
  assert.equal(controller.status.ruleId, 'rule-b');
});

test('onEvent serves HTML resources with an HTML content type', async () => {
  const { file } = await tempBundle('<h1>local</h1>', 'dialog.html');
  const url = 'https://org.crm4.dynamics.com/webresources/cc_/dialog.html';

  const controller = new Controller({ root: '/tmp/p', port: 9222, bundles: [file], resourceType: 'html' });
  controller.rules = [ruleEntry({ bundlePath: file, resourceType: 'html', rule: ruleFor(url, 'html') })];

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
  controller.rules = [ruleEntry({ bundlePath: file, rule: ruleFor(url) })];

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
  controller.rules = [ruleEntry({ bundlePath: file, rule: ruleFor(url) })];

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
  controller.rules = [ruleEntry({
    bundlePath: file,
    rule: ruleFor('https://org.crm4.dynamics.com/x/webresources/cc_Control/bundle.js')
  })];

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
  controller.rules = [ruleEntry({ rule: null })];

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
  const controller = new Controller({ root, port: 9222, bundles: [], rules: [ruleEntry()] });
  controller.enabled = true;

  const client = fakeClient();
  controller.client = client;

  const snapshot = await controller.disable();

  assert.ok(client.sent.some(c => c.method === 'Fetch.disable'));
  assert.ok(client.sent.some(c => c.method === '__closed__'), 'the CDP socket must be closed, not leaked');
  assert.equal(controller.client, null);
  assert.equal(controller.enabled, false);
  assert.equal(snapshot.connected, false);
  assert.equal(controller.status.stage, 'off');
});

test('reload requires an active override for the configured tab', async () => {
  const controller = new Controller({ root: '/tmp/p', port: 9222, bundles: [] });
  controller.rules = [ruleEntry({ tabId: 'a' })];
  await assert.rejects(() => controller.reload('a'), /not active/);
});

test('reload clears cache and hard-reloads the attached tab', async () => {
  const controller = new Controller({ root: '/tmp/p', port: 9222, bundles: [] });
  controller.rules = [ruleEntry({ tabId: 'a' })];
  const client = fakeClient();
  controller.client = client;

  await controller.reload('a');

  const reload = client.sent.find(c => c.method === 'Page.reload');
  assert.ok(client.sent.some(c => c.method === 'Network.clearBrowserCache'));
  assert.equal(reload.params.ignoreCache, true, 'a cached bundle would mask the local override');
});

test('setAutoReload requires configuration and sets it on the first rule', async () => {
  const bare = new Controller({ root: '/tmp/p', port: 9222, bundles: [] });
  await assert.rejects(() => bare.setAutoReload(true), /Configure the project first/);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-root-'));
  const controller = new Controller({ root, port: 9222, bundles: [], rules: [ruleEntry({ autoReload: true })] });

  const snapshot = await controller.setAutoReload(false);
  assert.equal(snapshot.rules[0].autoReload, false);
  assert.equal(snapshot.config.autoReload, false);
});

test('setRuleAutoReload targets a specific rule among several', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-root-'));
  const controller = new Controller({
    root, port: 9222, bundles: [],
    rules: [ruleEntry({ id: 'r1', autoReload: true }), ruleEntry({ id: 'r2', autoReload: true })]
  });

  await controller.setRuleAutoReload('r2', false);

  assert.equal(controller.rules.find(r => r.id === 'r1').autoReload, true, 'untouched rules must not change');
  assert.equal(controller.rules.find(r => r.id === 'r2').autoReload, false);
});

test('setRuleAutoReload rejects an unknown rule id', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-root-'));
  const controller = new Controller({ root, port: 9222, bundles: [], rules: [ruleEntry({ id: 'r1' })] });
  await assert.rejects(() => controller.setRuleAutoReload('nope', true), /No such override rule/);
});

test('startWatcher watches every active rule regardless of the currently staged artifact list', async () => {
  const { file } = await tempBundle();
  const controller = new Controller({
    root: '/tmp/p', port: 9222,
    bundles: ['/tmp/p/staged-for-next-rule.js'], // deliberately does not include the rule's own path
    rules: [ruleEntry({ bundlePath: file })]
  });

  controller.startWatcher();
  assert.notEqual(controller.stopWatcher, undefined, 'an existing rule must still be watched');
  controller.stopWatcher();
});

test('startWatcher does nothing when there are no rules', () => {
  const controller = new Controller({ root: '/tmp/p', port: 9222, bundles: [] });
  controller.startWatcher();
  assert.equal(controller.stopWatcher, undefined);
});

test('close stops the watcher and disables the override', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-root-'));
  const controller = new Controller({ root, port: 9222, bundles: [], rules: [ruleEntry()] });
  controller.enabled = true;

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
  controller.rules = [ruleEntry({ bundlePath: file, autoReload: true, tabId: 'a' })];
  controller.enabled = true;
  const client = fakeClient();
  controller.client = client;
  controller.startWatcher();

  await fs.writeFile(file, 'v2');
  await new Promise(r => setTimeout(r, 60));
  await fs.writeFile(file, 'v3');
  await new Promise(r => setTimeout(r, 60));
  await fs.writeFile(file, 'v4');

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
  controller.rules = [ruleEntry({ bundlePath: file, autoReload: false, tabId: 'a' })];
  controller.enabled = true;
  const client = fakeClient();
  controller.client = client;
  controller.startWatcher();

  await fs.writeFile(file, 'v2');
  await new Promise(r => setTimeout(r, 500));

  assert.equal(client.sent.filter(c => c.method === 'Page.reload').length, 0);
  controller.stopWatcher?.();
});

test('addRule adds alongside existing rules rather than replacing them', async () => {
  const { file: fileA } = await tempBundle('a', 'a.js');
  const { file: fileB } = await tempBundle('b', 'b.js');
  const { server, port } = await targetsServer([
    { id: 'a', type: 'page', title: 'D365', url: 'https://org.crm4.dynamics.com/main.aspx',
      webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/a' }
  ]);

  try {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-root-'));
    const controller = new Controller({ root, port, bundles: [fileA], resourceType: 'script' });

    await controller.addRule({ tabId: 'a', bundlePath: fileA, resourceUrl: 'https://org.crm4.dynamics.com/webresources/cc_a' });
    controller.bundles = [fileB];
    const snapshot = await controller.addRule({ tabId: 'a', bundlePath: fileB, resourceUrl: 'https://org.crm4.dynamics.com/webresources/cc_b' });

    assert.equal(snapshot.rules.length, 2, 'both rules must remain active');
    assert.deepEqual(snapshot.rules.map(r => r.bundlePath).sort(), [fileA, fileB].sort());

    controller.stopWatcher?.();
  } finally {
    server.close();
  }
});

test('addRule rejects a duplicate Dynamics resource', async () => {
  const { file } = await tempBundle('x', 'account-form.js');
  const { server, port } = await targetsServer([
    { id: 'a', type: 'page', title: 'D365', url: 'https://org.crm4.dynamics.com/main.aspx',
      webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/a' }
  ]);

  try {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-root-'));
    const controller = new Controller({ root, port, bundles: [file], resourceType: 'script' });
    const resourceUrl = 'https://org.crm4.dynamics.com/webresources/cc_a';

    await controller.addRule({ tabId: 'a', bundlePath: file, resourceUrl });
    await assert.rejects(
      () => controller.addRule({ tabId: 'a', bundlePath: file, resourceUrl }),
      /already has an active override/
    );

    controller.stopWatcher?.();
  } finally {
    server.close();
  }
});

test('addRule rejects a rule targeting a different tab than existing rules', async () => {
  const { file } = await tempBundle('x', 'account-form.js');
  const { server, port } = await targetsServer([
    { id: 'a', type: 'page', title: 'D365 A', url: 'https://org.crm4.dynamics.com/main.aspx',
      webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/a' },
    { id: 'b', type: 'page', title: 'D365 B', url: 'https://org.crm4.dynamics.com/other.aspx',
      webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/b' }
  ]);

  try {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-root-'));
    const controller = new Controller({ root, port, bundles: [file], resourceType: 'script' });

    await controller.addRule({ tabId: 'a', bundlePath: file, resourceUrl: 'https://org.crm4.dynamics.com/webresources/cc_a' });
    await assert.rejects(
      () => controller.addRule({ tabId: 'b', bundlePath: file, resourceUrl: 'https://org.crm4.dynamics.com/webresources/cc_b' }),
      /must target the same Dynamics tab/
    );

    controller.stopWatcher?.();
  } finally {
    server.close();
  }
});

test('addRule while enabled triggers a disable+enable cycle to refresh the live session', async () => {
  const { file: fileA } = await tempBundle('a', 'a.js');
  const { file: fileB } = await tempBundle('b', 'b.js');
  const { server, port } = await targetsServer([
    { id: 'a', type: 'page', title: 'D365', url: 'https://org.crm4.dynamics.com/main.aspx',
      webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/a' }
  ]);

  try {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-root-'));
    const controller = new Controller({ root, port, bundles: [fileA], resourceType: 'script' });
    controller.rules = [ruleEntry({ id: 'r1', bundlePath: fileA, resourceType: 'script', tabId: 'a', rule: ruleFor('https://org.crm4.dynamics.com/webresources/cc_a', 'script') })];
    controller.enabled = true;

    const calls = [];
    controller.disable = async () => { calls.push('disable'); controller.enabled = false; };
    controller.enable = async () => { calls.push('enable'); controller.enabled = true; };

    controller.bundles = [fileB];
    await controller.addRule({ tabId: 'a', bundlePath: fileB, resourceUrl: 'https://org.crm4.dynamics.com/webresources/cc_b' });

    assert.deepEqual(calls, ['disable', 'enable'], 'adding a rule while active must tear down and re-attach, in that order');
    assert.equal(controller.rules.length, 2);

    controller.stopWatcher?.();
  } finally {
    server.close();
  }
});

test('addRule while disabled does not touch enable/disable at all', async () => {
  const { file } = await tempBundle('x', 'account-form.js');
  const { server, port } = await targetsServer([
    { id: 'a', type: 'page', title: 'D365', url: 'https://org.crm4.dynamics.com/main.aspx',
      webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/a' }
  ]);

  try {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-root-'));
    const controller = new Controller({ root, port, bundles: [file], resourceType: 'script' });

    const calls = [];
    controller.disable = async () => { calls.push('disable'); };
    controller.enable = async () => { calls.push('enable'); };

    await controller.addRule({ tabId: 'a', bundlePath: file, resourceUrl: 'https://org.crm4.dynamics.com/webresources/cc_a' });

    assert.deepEqual(calls, [], 'adding the first rule while inactive must not trigger a session cycle');

    controller.stopWatcher?.();
  } finally {
    server.close();
  }
});

test('removeRule removes only the targeted rule, leaving others active', async () => {
  const { file: fileKeep } = await tempBundle('a', 'keep.js');
  const { file: fileRemove } = await tempBundle('b', 'remove.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-root-'));
  const controller = new Controller({
    root, port: 9222, bundles: [],
    rules: [ruleEntry({ id: 'keep', bundlePath: fileKeep }), ruleEntry({ id: 'remove', bundlePath: fileRemove })]
  });

  const snapshot = await controller.removeRule('remove');

  assert.equal(snapshot.rules.length, 1);
  assert.equal(snapshot.rules[0].id, 'keep');
  controller.stopWatcher?.();
});

test('removeRule rejects an unknown rule id', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-root-'));
  const controller = new Controller({ root, port: 9222, bundles: [], rules: [ruleEntry({ id: 'r1' })] });
  await assert.rejects(() => controller.removeRule('nope'), /No such override rule/);
});

test('regression: addRule derives type from the actual file, not whatever was last staged via setArtifact', async () => {
  // Reproduces the reported bug exactly: stage a PCF folder (setting the
  // controller-wide resourceType to 'pcf'), then try to add a plain
  // JavaScript override. The old code validated and stamped the new rule
  // using the STALE staged type, rejecting a perfectly valid JS override
  // because it didn't look like a PCF bundle pattern.
  const { file: jsFile } = await tempBundle('x', 'account-form.js');
  const { server, port } = await targetsServer([
    { id: 'a', type: 'page', title: 'D365', url: 'https://org.crm4.dynamics.com/main.aspx',
      webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/a' }
  ]);

  try {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-root-'));
    // resourceType: 'pcf' simulates a PCF folder having been staged last,
    // exactly as it would be after a real setArtifact() call for a PCF project.
    const controller = new Controller({ root, port, bundles: [jsFile], resourceType: 'pcf' });

    const snapshot = await controller.addRule({
      tabId: 'a', bundlePath: jsFile,
      resourceUrl: 'https://org.crm4.dynamics.com/webresources/cc_account_form'
    });

    assert.equal(snapshot.rules[0].resourceType, 'script', 'must derive script from the actual file, not inherit the stale pcf staging');

    controller.stopWatcher?.();
  } finally {
    server.close();
  }
});

test('regression: mixed-type rules can be active simultaneously (one PCF, one script)', async () => {
  const { file: pcfFile } = await tempBundle('a', 'bundle.js');
  const { file: jsFile } = await tempBundle('b', 'account-form.js');
  const { server, port } = await targetsServer([
    { id: 'a', type: 'page', title: 'D365', url: 'https://org.crm4.dynamics.com/main.aspx',
      webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/a' }
  ]);

  try {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-root-'));
    const controller = new Controller({ root, port, bundles: [pcfFile], resourceType: 'pcf' });

    await controller.addRule({ tabId: 'a', bundlePath: pcfFile, resourceUrl: 'https://org.crm4.dynamics.com/webresources/cc_Control/bundle.js' });
    controller.bundles = [jsFile]; // simulates staging a different file for the second add
    const snapshot = await controller.addRule({ tabId: 'a', bundlePath: jsFile, resourceUrl: 'https://org.crm4.dynamics.com/webresources/cc_account_form' });

    assert.equal(snapshot.rules.length, 2);
    assert.deepEqual(snapshot.rules.map(r => r.resourceType).sort(), ['pcf', 'script']);

    controller.stopWatcher?.();
  } finally {
    server.close();
  }
});


test('removeRule while enabled disables fully if it was the last rule', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-root-'));
  const controller = new Controller({ root, port: 9222, bundles: [], rules: [ruleEntry({ id: 'only' })] });
  controller.enabled = true;
  const client = fakeClient();
  controller.client = client;

  const snapshot = await controller.removeRule('only');

  assert.equal(snapshot.enabled, false);
  assert.equal(snapshot.rules.length, 0);
  assert.equal(controller.client, null);
});
