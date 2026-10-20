/** MCP SDK transport with an owned process group and bounded protocol frames. */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
const exec = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export class BotMcpStdioTransport {
  constructor({ command, args, env, cwd }) { Object.assign(this, { command, args, env, cwd }); this.buffer = new ReadBuffer({ maxBufferSize: 2 * 1024 * 1024 }); }
  async start() {
    if (this.child) throw new Error('MCP transport already started.');
    const child = this.child = spawn(this.command, this.args || [], { cwd: this.cwd, env: this.env, shell: false, stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32', windowsHide: true });
    child.on('error', () => this.onerror?.(new Error('The MCP program could not start.')));
    child.stdin.on('error', () => this.onerror?.(new Error('The MCP program disconnected.')));
    child.on('close', () => this.onclose?.());
    child.stdout.on('data', chunk => { try { this.buffer.append(chunk); for (let message; (message = this.buffer.readMessage()) !== null;) this.onmessage?.(message); } catch { this.onerror?.(new Error('The MCP program returned an invalid or oversized protocol frame.')); void this.close().catch(() => {}); } });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  }
  async send(message) { if (!this.child || this.child.stdin.destroyed) throw new Error('The MCP program is disconnected.'); await new Promise((resolve, reject) => this.child.stdin.write(serializeMessage(message), error => error ? reject(error) : resolve())); }
  async alive() {
    const child = this.child; if (!child?.pid) return false;
    if (process.platform === 'win32') return child.exitCode === null && child.signalCode === null;
    if (process.platform === 'darwin') {
      const { stdout } = await exec('/bin/ps', ['-axo', 'pgid=,stat='], { env: { PATH: '/usr/bin:/bin' }, timeout: 2000, maxBuffer: 2 * 1024 * 1024 });
      let matched = false;
      for (const line of stdout.trim().split('\n')) { const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(line); if (!match) throw new Error('Process cleanup could not be verified.'); if (Number(match[1]) === child.pid) { matched = true; if (!match[2].startsWith('Z')) return true; } }
      return false;
    }
    try { process.kill(-child.pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw new Error('Process cleanup could not be verified.'); }
  }
  close() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      const child = this.child; if (!child?.pid) return;
      const signal = name => { try { process.platform === 'win32' ? child.kill(name) : process.kill(-child.pid, name); } catch (e) { if (!['ESRCH', 'EPERM'].includes(e.code)) throw e; } };
      signal('SIGTERM'); const began = Date.now(); let escalated = false;
      while (await this.alive()) { if (!escalated && Date.now() - began >= 500) { signal('SIGKILL'); escalated = true; } if (Date.now() - began > 3000) throw new Error('MCP process cleanup is unconfirmed.'); await pause(25); }
      this.child = null; this.buffer.clear();
    })();
    this.closing.catch(() => {}); return this.closing;
  }
}
