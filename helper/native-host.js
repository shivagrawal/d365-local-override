#!/usr/bin/env node
// Chrome-spawned native messaging host. Chrome launches this process when the
// extension calls chrome.runtime.connectNative and pipes JSON messages over
// stdin/stdout using the framing in native-protocol.js. stdout is reserved
// entirely for that framing, so anything launch()/close() would normally log
// is redirected to stderr instead — Chrome ignores stderr, we don't need it.
import { launch } from './main.js';
import { pickPath } from './picker.js';
import { detectWatchTarget } from './pcf-watch.js';
import { PcfWatcher } from './pcf-watcher-process.js';
import { encodeMessage, createDecoder } from './native-protocol.js';

console.log = (...args) => console.error(...args);

let controller = null;
let server = null;
const watcher = new PcfWatcher();

const send = message => process.stdout.write(encodeMessage(message));

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
      send({ type: 'status', stage: 'started', snapshot: controller.snapshot() });
      return;
    }

    if (message.type === 'stop') {
      if (!controller) {
        send({ type: 'status', stage: 'not-running' });
        return;
      }
      await controller.close();
      controller = null;
      if (server) {
        await new Promise(resolve => server.close(resolve));
        server = null;
      }
      send({ type: 'status', stage: 'stopped' });
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
          const snapshot = await controller.setArtifact(chosen);
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
        const result = watcher.start(projectRoot, scriptName);
        send({ type: 'watch-status', ...result.snapshot, alreadyRunning: !result.started });
      } catch (error) {
        send({ type: 'error', message: error.message });
      }
      return;
    }

    if (message.type === 'watch-stop') {
      await watcher.stop();
      send({ type: 'watch-status', ...watcher.snapshot() });
      return;
    }

    if (message.type === 'watch-status') {
      send({ type: 'watch-status', ...watcher.snapshot() });
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
  await watcher.stop();
  if (controller) await controller.close().catch(() => {});
  if (server) await new Promise(resolve => server.close(resolve)).catch(() => {});
  process.exit(0);
});
