import http from 'node:http';
import { execFile } from 'node:child_process';

const HOST = '127.0.0.1';
const PORT = 32145;

/**
 * Port 32145 is exclusively this tool's by design - nothing else should ever
 * bind it. If something already holds it, it's almost certainly an orphaned
 * instance of this same server from a prior session that didn't shut down
 * cleanly (Chrome killed abruptly, extension reloaded/disabled without a
 * clean Stop - native messaging doesn't always deliver a clean disconnect).
 * Safe to clear and retry, unlike an arbitrary shared port on a real server.
 */
function killPortOwner(port, execFileFn = execFile) {
  return new Promise(resolve => {
    if (process.platform === 'win32') {
      const script = `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }`;
      execFileFn('powershell', ['-NoProfile', '-Command', script], () => resolve());
    } else {
      execFileFn('sh', ['-c', `lsof -ti tcp:${port} | xargs -r kill -9`], () => resolve());
    }
  });
}

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

export async function startServer(controller, execFileFn = execFile) {
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
      else if (req.method === 'POST' && url.pathname === '/scan') result = await controller.scan(data.tabId, data.bundlePath);
      else if (req.method === 'POST' && url.pathname === '/configure') result = await controller.configure(data);
      else if (req.method === 'POST' && url.pathname === '/rules') result = await controller.addRule(data);
      else if (req.method === 'POST' && url.pathname === '/remove-rule') result = await controller.removeRule(data.ruleId);
      else if (req.method === 'POST' && url.pathname === '/rule-auto-reload') result = await controller.setRuleAutoReload(data.ruleId, data.enabled);
      else if (req.method === 'POST' && url.pathname === '/enable') result = await controller.enable();
      else if (req.method === 'POST' && url.pathname === '/disable') result = await controller.disable();
      else if (req.method === 'POST' && url.pathname === '/reload') result = await controller.reload(data.tabId);
      else if (req.method === 'POST' && url.pathname === '/artifact') result = await controller.setArtifact(data.path);
      else if (req.method === 'POST' && url.pathname === '/auto-reload') result = await controller.setAutoReload(data.enabled);
      else return json(res, 404, { error: 'Not found.' }, origin);

      json(res, 200, { result }, origin);
    } catch (e) {
      json(res, 400, { error: e.message }, origin);
    }
  });

  const attempt = () => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, () => resolve({ server, host: HOST, port: PORT }));
  });

  try {
    return await attempt();
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    await killPortOwner(PORT, execFileFn);
    await new Promise(resolve => setTimeout(resolve, 300));
    return await attempt();
  }
}
