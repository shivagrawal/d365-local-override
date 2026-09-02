import { EventEmitter } from 'node:events';

export class CdpClient extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.nextId = 0;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error('CDP WebSocket connection failed.')), { once: true });
    });
    this.ws.addEventListener('message', event => this.onMessage(event.data));
    this.ws.addEventListener('close', () => this.onDisconnect());
    return this;
  }

  onMessage(raw) {
    const message = JSON.parse(raw);
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      return message.error
        ? pending.reject(new Error(message.error.message))
        : pending.resolve(message.result);
    }
    this.emit('event', message.method, message.params || {}, message.sessionId);
  }

  onDisconnect() {
    const error = new Error('CDP WebSocket disconnected.');
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.emit('disconnect');
  }

  send(method, params = {}, sessionId) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('CDP WebSocket is not connected.'));
    }
    const id = ++this.nextId;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    const response = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    try {
      this.ws.send(JSON.stringify(message));
    } catch (error) {
      this.pending.delete(id);
      return Promise.reject(error);
    }
    return response;
  }

  close() { this.ws?.close(); }
}

export async function targets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error(`Chrome port ${port} returned HTTP ${response.status}`);
  return response.json();
}
