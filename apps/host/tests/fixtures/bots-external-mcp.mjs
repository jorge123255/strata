/** Isolated MCP server. Never contacts an account, model, browser or production host. */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const server = new Server({ name: 'strata-test-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'echo', description: 'Echo a harmless fixture marker.', inputSchema: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'] } }] }));
server.setRequestHandler(CallToolRequestSchema, async request => ({ content: [{ type: 'text', text: JSON.stringify({ marker: request.params.arguments.marker, explicitEnvironment: process.env.STRATA_MCP_FIXTURE === 'STRATA_EXPLICIT_ENVIRONMENT_FIXTURE', leakedParentSecret: process.env.STRATA_MCP_PARENT_SECRET !== undefined }) }] }));
if (process.argv[2]) {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); });
  writeFileSync(process.argv[2], String(child.pid));
}
await server.connect(new StdioServerTransport());
