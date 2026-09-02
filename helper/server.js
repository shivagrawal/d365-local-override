import http from 'node:http';

const HOST = '127.0.0.1';
const PORT = 32145;

const json = (res, status, value, origin) => {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(value));
};

const body = req => new Promise((resolve, reject) => {
  let v = '';
  req.on('data', c => {
    v += c;
    if (v.length > 1e6) req.destroy();
  });
  req.on('end', () => {
    try { resolve(v ? JSON.parse(v) : {}); }
    catch { reject(new Error('Invalid JSON request.')); }
  });
  req.on('error', reject);
});

export function startServer(controller) {
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin || '';
    if (origin && !origin.startsWith('chrome-extension://')) {
      return json(res, 403, { error: 'Extension origin required.' }, 'null');
    }
    if (req.method === 'OPTIONS') return json(res, 204, {}, origin);

    try {
      const url = new URL(req.url, `http://${HOST}:${PORT}`);
      const data = req.method === 'POST' ? await body(req) : {};
      let result;

      if (req.method === 'GET' && url.pathname === '/status') result = controller.snapshot();
      else if (req.method === 'GET' && url.pathname === '/tabs') result = await controller.dynamicsTabs();
      else if (req.method === 'POST' && url.pathname === '/scan') result = await controller.scan(data.tabId, data.resourceType);
      else if (req.method === 'POST' && url.pathname === '/configure') result = await controller.configure(data);
      else if (req.method === 'POST' && url.pathname === '/artifact') result = await controller.setArtifact(data.path);
      else if (req.method === 'POST' && url.pathname === '/enable') result = await controller.enable();
      else if (req.method === 'POST' && url.pathname === '/disable') result = await controller.disable();
      else if (req.method === 'POST' && url.pathname === '/reload') result = await controller.reload(data.tabId);
      else if (req.method === 'POST' && url.pathname === '/auto-reload') result = await controller.setAutoReload(data.enabled);
      else return json(res, 404, { error: 'Not found.' }, origin);

      json(res, 200, { result }, origin);
    } catch (e) {
      json(res, 400, { error: e.message }, origin);
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, () => resolve({ server, host: HOST, port: PORT }));
  });
}
