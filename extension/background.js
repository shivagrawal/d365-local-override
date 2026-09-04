const HOST_NAME = 'com.pcf_local_override.native_host';

let port = null;
let lastMessage = { type: 'idle' };

function broadcast(message) {
  lastMessage = message;
  // No popup may be listening right now; that's fine, it reads lastMessage on open.
  chrome.runtime.sendMessage({ source: 'pcf-native-host', ...message }).catch(() => {});
}

function ensurePort() {
  if (port) return port;

  port = chrome.runtime.connectNative(HOST_NAME);

  port.onMessage.addListener(message => broadcast(message));

  port.onDisconnect.addListener(() => {
    const reason = chrome.runtime.lastError?.message || 'Native host disconnected.';
    port = null;
    broadcast({ type: 'error', message: reason });
  });

  return port;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'pcf-native-host') return;

  if (message.type === 'get-last') {
    sendResponse(lastMessage);
    return;
  }

  try {
    ensurePort().postMessage({
      type: message.type,
      options: message.options,
      mode: message.mode,
      title: message.title,
      resourceType: message.resourceType
    });
    sendResponse({ ok: true });
  } catch (error) {
    port = null;
    sendResponse({ ok: false, error: error.message });
  }
});
