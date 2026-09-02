import test from 'node:test';
import assert from 'node:assert/strict';
import { CdpClient } from '../helper/cdp.js';

test('registers a pending CDP command before sending it', async () => {
  const client = new CdpClient('ws://test');
  client.ws = {
    readyState: WebSocket.OPEN,
    send(raw) {
      const request = JSON.parse(raw);
      client.onMessage(JSON.stringify({ id: request.id, result: { ok: true } }));
    }
  };
  assert.deepEqual(await client.send('Page.enable'), { ok: true });
  assert.equal(client.pending.size, 0);
});

test('rejects all pending CDP commands when Chrome disconnects', async () => {
  const client = new CdpClient('ws://test');
  client.ws = { readyState: WebSocket.OPEN, send() {} };
  const response = client.send('Page.reload');
  client.onDisconnect();
  await assert.rejects(response, /disconnected/);
  assert.equal(client.pending.size, 0);
});

test('rejects a CDP command when socket is not connected', async () => {
  const client = new CdpClient('ws://test');
  await assert.rejects(client.send('Page.enable'), /not connected/);
});
