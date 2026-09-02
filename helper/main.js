import path from 'node:path';
import { ensureChrome } from './chrome.js';
import { discoverBundles, resolveBundle, resolveHtml, resolveScript } from './bundles.js';
import { projectConfig } from './config.js';
import { Controller } from './controller.js';
import { startServer } from './server.js';

export async function launch({ root, bundle, script, html, chromePort = 9222 } = {}) {
  let bundles;
  const resourceType = html ? 'html' : script ? 'script' : 'pcf';

  if (html || script) {
    const resolvedFile = html ? await resolveHtml(html) : await resolveScript(script);
    bundles = [resolvedFile];
    root = root ? path.resolve(root) : path.dirname(resolvedFile);
  } else if (bundle) {
    const resolvedBundle = await resolveBundle(bundle);
    bundles = [resolvedBundle];
    root = root ? path.resolve(root) : path.dirname(resolvedBundle);
  } else {
    root = path.resolve(root || process.cwd());
    bundles = await discoverBundles(root);
  }

  if (!bundles.length) {
    throw new Error(`No bundle.js found under out, dist, or build in:\n${root}\n\nPass an explicit path from any terminal:\npcf-local-override launch --bundle "C:\\path\\to\\bundle-folder"`);
  }

  const chrome = await ensureChrome(chromePort);
  let config = await projectConfig(root);

  if (config &&
      ((config.resourceType || 'pcf') !== resourceType ||
       !bundles.includes(path.resolve(config.bundlePath || '')))) {
    config = null;
  }

  const controller = new Controller({
    root,
    port: chromePort,
    bundles,
    config,
    resourceType
  });

  if (config?.bundlePath && bundles.includes(path.resolve(config.bundlePath))) {
    controller.startWatcher();
  }

  const api = await startServer(controller);
  const localLabel = resourceType === 'pcf' ? 'bundle' : resourceType;
  const modeLabel = resourceType === 'script'
    ? 'Model-Driven JavaScript'
    : resourceType === 'html'
      ? 'Model-Driven HTML'
      : 'PCF bundle';

  console.log(`\nPCF Local Override helper\n  mode     ${modeLabel}\n  project  ${root}\n  Chrome   :${chromePort} (${chrome.reused ? 'reused' : 'launched'})\n  helper   http://${api.host}:${api.port}\n  ${localLabel}   ${bundles[0]}${bundles.length > 1 ? `\n  bundles  ${bundles.length}` : ''}\n\nOpen Dynamics in the development Chrome, then use the extension.`);

  const cleanup = async () => {
    await controller.close();
    api.server.close();
    process.exit(0);
  };

  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);

  return { controller, ...api };
}
