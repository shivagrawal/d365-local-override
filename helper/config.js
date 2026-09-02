import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const file = path.join(os.homedir(), '.pcf-local-override', 'config.json');
const key = root => path.resolve(root).toLowerCase();

export async function loadConfig() {
  try {
    return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (e) {
    if (e.code === 'ENOENT') return { version: 1, projects: {} };
    throw new Error(`Malformed helper config: ${e.message}`);
  }
}

export async function projectConfig(root) {
  return (await loadConfig()).projects[key(root)] || null;
}

export async function saveProject(root, project) {
  const config = await loadConfig();
  config.projects[key(root)] = project;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(config, null, 2));
  return project;
}
