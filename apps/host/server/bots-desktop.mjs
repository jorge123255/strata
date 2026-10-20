/** Opens the bundled native Bots feature window. It starts no bot or virtual machine. */
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
export function createBotsDesktop({ platform = process.platform, exists = existsSync, run = execFile, port }) {
  const candidates = [new URL('../../bots/StrataBots.app', import.meta.url), new URL('../../bots-macos/build/StrataBots.app', import.meta.url)].map(url => fileURLToPath(url));
  const app = () => platform === 'darwin' ? candidates.find(path => exists(`${path}/Contents/MacOS/StrataBots`)) : null;
  return {
    status() { return { available: !!app(), name: 'Strata Bots', native: true }; },
    async open() {
      const path = app(); if (!path) throw Object.assign(new Error('Build or install the native Strata Bots component first.'), { status: 503 });
      const origin = `http://127.0.0.1:${typeof port === 'function' ? port() : port}`;
      await new Promise((resolve, reject) => run('/usr/bin/open', ['-a', path, '--args', '--strata-host', origin], { timeout: 10000, env: { PATH: '/usr/bin:/bin', HOME: homedir() } }, error => error ? reject(new Error('The native Bots window could not open.')) : resolve()));
      return { opened: true };
    },
  };
}
