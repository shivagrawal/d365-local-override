#!/usr/bin/env node
// Chrome-spawned native messaging host. Chrome launches this process when the
// extension calls chrome.runtime.connectNative and pipes JSON messages over
// stdin/stdout using the framing in native-protocol.js. stdout is reserved
// entirely for that framing, so anything launch()/close() would normally log
// is redirected to stderr instead — Chrome ignores stderr, we don't need it.
import { launch } from './main.js';
import { pickPath } from './picker.js';
import { encodeMessage, createDecoder } from './native-protocol.js';

console.log = (...args) => console.error(...args);

let controller = null;

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
// closing). Stop the helper cleanly rather than leaving Chrome/CDP attached.
process.stdin.on('end', async () => {
  if (controller) await controller.close().catch(() => {});
  process.exit(0);
});
