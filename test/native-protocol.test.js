import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeMessage, createDecoder } from '../helper/native-protocol.js';

test('encodes and decodes a single framed message', () => {
  const received = [];
  const decode = createDecoder(value => received.push(value));
  decode(encodeMessage({ type: 'ping' }));
  assert.deepEqual(received, [{ type: 'ping' }]);
});

test('handles multiple messages split arbitrarily across chunks', () => {
  const received = [];
  const decode = createDecoder(value => received.push(value));
  const encoded = Buffer.concat([
    encodeMessage({ a: 1 }),
    encodeMessage({ b: 2 }),
    encodeMessage({ c: 3 })
  ]);

  // Split at an awkward byte offset that lands mid-frame, not on a message boundary.
  decode(encoded.subarray(0, 5));
  decode(encoded.subarray(5, 9));
  decode(encoded.subarray(9));

  assert.deepEqual(received, [{ a: 1 }, { b: 2 }, { c: 3 }]);
});

test('reports malformed frame bodies via the error callback, not a throw', () => {
  const received = [];
  const decode = createDecoder((value, error) => received.push({ value, error: error?.message }));

  const header = Buffer.alloc(4);
  header.writeUInt32LE(4, 0);
  assert.doesNotThrow(() => decode(Buffer.concat([header, Buffer.from('nope')])));

  assert.equal(received[0].value, undefined);
  assert.match(received[0].error, /JSON|Unexpected token/);
});

test('round-trips a realistic start/stop message shape', () => {
  const received = [];
  const decode = createDecoder(value => received.push(value));
  decode(encodeMessage({ type: 'start', options: { bundle: 'C:\\proj\\out\\Control' } }));
  decode(encodeMessage({ type: 'stop' }));
  assert.deepEqual(received, [
    { type: 'start', options: { bundle: 'C:\\proj\\out\\Control' } },
    { type: 'stop' }
  ]);
});
