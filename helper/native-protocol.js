// Chrome native messaging framing: each message is a 4-byte little-endian
// length prefix followed by that many bytes of UTF-8 JSON.
// https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging

export function encodeMessage(message) {
  const json = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

/**
 * Returns a function you feed raw stdin chunks into. Calls `onMessage(value, error)`
 * once per complete frame: `value` set on success, `error` set (value undefined) if a
 * frame's body isn't valid JSON. Buffers partial frames across chunks.
 */
export function createDecoder(onMessage) {
  let buffer = Buffer.alloc(0);

  return chunk => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) return;

      const body = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);

      try {
        onMessage(JSON.parse(body.toString('utf8')));
      } catch (error) {
        onMessage(undefined, error);
      }
    }
  };
}
