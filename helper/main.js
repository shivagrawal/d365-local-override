import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureChrome } from './chrome.js';
import { discoverBundles, resolveBundle, resolveHtml, resolveScript } from './bundles.js';
import { projectConfig } from './config.js';
import { Controller } from './controller.js';
import { startServer } from './server.js';

/**
 * Converts whatever was persisted under a project into the current
 * rules-array shape, and drops any rule that can no longer be trusted for
 * this launch (wrong resource type, or a bundle path no longer among the
 * discovered/explicit artifacts - keeping it would risk silently
 * intercepting the wrong request). Pure and side-effect free so the
 * migration itself is directly testable without a real Chrome/CDP session.
 */
export function migrateStoredConfig(stored, resourceType, bundles) {
  let rules = [];

  if (stored) {
    if (Array.isArray(stored.rules)) {
      rules = stored.rules;
    } else if (stored.bundlePath) {
      // Saved by the previous single-rule model: bundlePath sits at the top
      // level instead of inside a rules array. Wrap it rather than discard it.
      rules = [{
        id: randomUUID(),
        tabId: stored.tabId,
        bundlePath: stored.bundlePath,
        resourceUrl: stored.rule?.selectedUrl,
        rule: stored.rule,
        resourceType: stored.resourceType || resourceType,
        dynamicsHostname: stored.dynamicsHostname,
        autoReload: stored.autoReload !== false
      }];
    }
  }

  return rules.filter(r =>
    (r.resourceType || 'pcf') === resourceType &&
    bundles.includes(path.resolve(r.bundlePath || ''))
  );
}

export async function launch({ root, bundle, script, html, chromePort = 9222 } = {}) {
  let bundles;
  const explicit = Boolean(html || script || bundle || root);
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

  // Only hard-fail when the developer explicitly named an artifact or project root.
  // A bare start is legitimate: the extension selects the artifact afterwards.
  if (!bundles.length && explicit) {
    throw new Error(`No bundle.js found under out, dist, or build in:\n${root}\n\nPass an explicit path from any terminal:\npcf-local-override launch --bundle "C:\\path\\to\\bundle-folder"`);
  }

  const chrome = await ensureChrome(chromePort);
  const stored = await projectConfig(root);
  const rules = migrateStoredConfig(stored, resourceType, bundles);

  const controller = new Controller({
    root,
    port: chromePort,
    bundles,
    rules,
    resourceType
  });

  if (rules.length) controller.startWatcher();

  const api = await startServer(controller);
  const localLabel = resourceType === 'pcf' ? 'bundle' : resourceType;
  const modeLabel = resourceType === 'script'
    ? 'Model-Driven JavaScript'
    : resourceType === 'html'
      ? 'Model-Driven HTML'
      : 'PCF bundle';

  const artifactLine = bundles.length
    ? `  ${localLabel}   ${bundles[0]}${bundles.length > 1 ? `\n  bundles  ${bundles.length}` : ''}`
    : '  artifact none yet — select one from the extension';

  console.log(`\nPCF Local Override helper\n  mode     ${modeLabel}\n  project  ${root}\n  Chrome   :${chromePort} (${chrome.reused ? 'reused' : 'launched'})\n  helper   http://${api.host}:${api.port}\n${artifactLine}\n\nOpen Dynamics in the development Chrome, then use the extension.`);

  const cleanup = async () => {
    await controller.close();
    api.server.close();
    process.exit(0);
  };

  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);

  return { controller, ...api };
}
