// Chrome native messaging framing: each message is a 4-byte little-endian
// unsigned integer length followed by UTF-8 JSON bytes.

export function encodeMessage(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export function createDecoder(onMessage, onError = () => {}) {
  let buffer = Buffer.alloc(0);

  return chunk => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length > 1024 * 1024) {
        onError(new Error('Native message exceeds 1 MB.'));
        buffer = Buffer.alloc(0);
        return;
      }

      if (buffer.length < 4 + length) return;

      const body = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);

      try {
        onMessage(JSON.parse(body.toString('utf8')));
      } catch (error) {
        onError(error);
      }
    }
  };
}
