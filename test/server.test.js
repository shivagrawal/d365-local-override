import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import http from 'node:http';
import { startServer } from '../helper/server.js';

const fakeController = { snapshot: () => ({ status: 'ok' }) };

test('startServer works normally when the port is free', async () => {
  const { server, port } = await startServer(fakeController);
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/status`, { headers: { Origin: 'chrome-extension://test' } });
    assert.equal(resp.status, 200);
  } finally {
    server.close();
  }
});

test('regression: on Windows, self-heal builds the correct Get-NetTCPConnection / Stop-Process command', async () => {
  // Verified by construction, not execution - this sandbox has no PowerShell.
  // Blocks a real port first so the EADDRINUSE path is genuinely exercised.
  const blocker = http.createServer((req, res) => res.end('blocker'));
  await new Promise(resolve => blocker.listen(32145, '127.0.0.1', resolve));

  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

  const calls = [];
  const fakeExecFile = (cmd, args, cb) => { calls.push({ cmd, args }); cb(); };

  try {
    await assert.rejects(() => startServer(fakeController, fakeExecFile), /EADDRINUSE/,
      'the fake execFile does not actually free the port, so the retry is expected to fail - only the command construction is under test here');

    assert.equal(calls[0].cmd, 'powershell');
    const script = calls[0].args.find(a => typeof a === 'string' && a.includes('Get-NetTCPConnection'));
    assert.match(script, /-LocalPort 32145/);
    assert.match(script, /-State Listen/);
    assert.match(script, /Stop-Process -Id \$_ -Force/, 'must actually kill the match, not just list it');
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform);
    blocker.close();
  }
});

test('regression: self-heals from a real orphaned process genuinely holding the port (POSIX)', {
  skip: process.platform === 'win32' ? 'exercises the lsof/kill POSIX path; Windows path verified by construction above' : false
}, async () => {
  const blockerScript = `
    const http = require('node:http');
    http.createServer((req,res)=>res.end('blocker')).listen(32145,'127.0.0.1',()=>console.log('READY'));
  `;
  const blocker = spawn(process.execPath, ['-e', blockerScript], { stdio: ['ignore', 'pipe', 'ignore'] });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('blocker did not start')), 5000);
    blocker.stdout.on('data', d => {
      if (d.toString().includes('READY')) { clearTimeout(timeout); resolve(); }
    });
  });

  try {
    const { server, port } = await startServer(fakeController);
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/status`, { headers: { Origin: 'chrome-extension://test' } });
      assert.equal(resp.status, 200, 'must be OUR server responding, not the stale blocker');
    } finally {
      server.close();
    }
  } finally {
    blocker.kill('SIGKILL'); // in case anything survived
  }
});
