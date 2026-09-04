#!/usr/bin/env node
// Chrome-spawned native messaging host. Chrome launches this process when the
// extension calls chrome.runtime.connectNative and pipes JSON messages over
// stdin/stdout using the framing in native-protocol.js. stdout is reserved
// entirely for that framing, so anything launch()/close() would normally log
// is redirected to stderr instead — Chrome ignores stderr, we don't need it.
import { launch } from './main.js';
import { pickPath } from './picker.js';
import { detectWatchTarget } from './pcf-watch.js';
import { PcfWatcherPool } from './pcf-watcher-pool.js';
import { encodeMessage, createDecoder } from './native-protocol.js';

console.log = (...args) => console.error(...args);

let controller = null;
let server = null;
const watchers = new PcfWatcherPool();

const send = message => process.stdout.write(encodeMessage(message));

// Without these, any uncaught error kills this process silently and Chrome
// reports only "Native host has exited" with no cause. Report the real error
// over the protocol first so it's visible in the popup.
function reportFatal(label) {
  return error => {
    try {
      send({ type: 'error', message: `${label}: ${error?.message || error}` });
    } catch {
      // stdout may already be unusable; stderr still reaches Chrome's logs
    }
    console.error(`[PatchPilot native host] ${label}:`, error);
  };
}
process.on('uncaughtException', reportFatal('Uncaught exception'));
process.on('unhandledRejection', reportFatal('Unhandled rejection'));

async function handle(message) {
  try {
    if (message.type === 'start') {
      if (controller) {
        send({ type: 'status', stage: 'already-running', snapshot: controller.snapshot() });
        return;
      }
      const result = await launch(message.options || {});
      controller = result.controller;
      server = result.server;
      // Lets /shutdown (reachable from any browser window over HTTP) perform
      // the same full teardown as a native-messaging 'stop'.
      controller.onShutdown = async () => {
        await watchers.stopAll().catch(() => {});
        await controller?.close().catch(() => {});
        controller = null;
        if (server) { server.close(); server = null; }
        send({ type: 'status', stage: 'stopped' });
      };
      send({ type: 'status', stage: 'started', snapshot: controller.snapshot() });
      return;
    }

    if (message.type === 'stop') {
      // Stop watches FIRST and unconditionally. Each browser window has its
      // own native host process, so the window you click Disconnect in may
      // never have started the helper - but it may still own build watches.
      // Returning early when there's no controller left those running.
      await watchers.stopAll();

      if (!controller) {
        send({ type: 'status', stage: 'not-running' });
        send({ type: 'watch-status', watches: watchers.snapshots() });
        return;
      }
      await controller.close();
      controller = null;
      if (server) {
        await new Promise(resolve => server.close(resolve));
        server = null;
      }
      send({ type: 'status', stage: 'stopped' });
      send({ type: 'watch-status', watches: watchers.snapshots() });
      return;
    }

    if (message.type === 'pick') {
      const chosen = await pickPath(message.mode || 'folder', { title: message.title });
      if (!chosen) {
        send({ type: 'picked', cancelled: true });
        return;
      }

      // If the helper is already running, apply the selection in the same step
      // so the developer does not have to confirm the path a second time.
      if (controller) {
        try {
          const snapshot = await controller.setArtifact(chosen, message.resourceType || null);
          send({ type: 'picked', path: chosen, applied: true, snapshot });
        } catch (error) {
          send({ type: 'picked', path: chosen, applied: false, message: error.message });
        }
        return;
      }

      send({ type: 'picked', path: chosen, applied: false });
      return;
    }

    if (message.type === 'watch-detect') {
      const bundlePath = message.options?.bundlePath;
      if (!bundlePath) {
        send({ type: 'error', message: 'watch-detect requires a bundlePath.' });
        return;
      }
      const detected = await detectWatchTarget(bundlePath);
      send({ type: 'watch-detected', ...detected });
      return;
    }

    if (message.type === 'watch-start') {
      const { projectRoot, scriptName } = message.options || {};
      try {
        const result = watchers.start(projectRoot, scriptName);
        send({
          type: 'watch-status',
          watches: watchers.snapshots(),
          alreadyRunning: !result.started
        });
      } catch (error) {
        send({ type: 'error', message: error.message });
      }
      return;
    }

    if (message.type === 'watch-stop') {
      const projectRoot = message.options?.projectRoot;
      // No projectRoot means "stop everything" - used when disconnecting.
      if (projectRoot) await watchers.stop(projectRoot);
      else await watchers.stopAll();
      send({ type: 'watch-status', watches: watchers.snapshots() });
      return;
    }

    if (message.type === 'watch-status') {
      send({ type: 'watch-status', watches: watchers.snapshots() });
      return;
    }

    if (message.type === 'ping') {
      send({ type: 'pong', running: Boolean(controller) });
      return;
    }

    send({ type: 'error', message: `Unknown message type: ${message.type}` });
  } catch (error) {
    controller = null;
    send({ type: 'error', message: error.message });
  }
}

process.stdin.on('data', createDecoder((message, error) => {
  if (error) {
    send({ type: 'error', message: `Malformed message: ${error.message}` });
    return;
  }
  void handle(message);
}));

// Chrome closes stdin when the extension's native port disconnects
// (background service worker unloaded, extension disabled/removed, browser
// closing). Stop the helper and any running PCF build watch cleanly rather
// than leaving Chrome/CDP attached or an orphaned webpack process behind.
process.stdin.on('end', async () => {
  await watchers.stopAll();
  if (controller) await controller.close().catch(() => {});
  if (server) await new Promise(resolve => server.close(resolve)).catch(() => {});
  process.exit(0);
});
