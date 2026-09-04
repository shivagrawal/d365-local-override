import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sleep } from './utils.js';
import { targets } from './cdp.js';

const candidates = () => process.platform === 'win32'
  ? [
      path.join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google/Chrome/Application/chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
      path.join(process.env.PROGRAMFILES || '', 'Microsoft/Edge/Application/msedge.exe')
    ]
  : process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : ['google-chrome', 'chromium'];

export async function ensureChrome(port) {
  try {
    await targets(port);
    return { reused: true };
  } catch {}

  const executable = candidates().find(item => !item.includes('/') || fs.existsSync(item));
  if (!executable) throw new Error('Chrome or Edge executable was not found.');

  const profile = path.join(os.homedir(), '.pcf-local-override', 'chrome-profile');
  const child = spawn(executable, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run'
  ], { detached: true, stdio: 'ignore', windowsHide: true });

  child.unref();

  // Check immediately, then poll quickly. The old loop always slept before
  // the first check, adding latency even when Chrome came up fast.
  for (let i = 0; i < 75; i++) {
    try {
      await targets(port);
      return { reused: false, executable, profile };
    } catch {}
    await sleep(100);
  }
  throw new Error(`Development Chrome did not open on port ${port}.`);
}
