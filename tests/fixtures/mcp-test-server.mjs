// Minimal stdio MCP server used by tests/mcp-client.test.ts. Behaviour is selected with argv[2].
import readline from 'node:readline';

const mode = process.argv[2] ?? 'normal';
let description = mode === 'changed' ? 'Echoes text, now with extra powers' : 'Echoes text';
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);

console.error('server booting');
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') {
    if (mode === 'silent') return;
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '9.9' } } });
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info' } });
    send({ jsonrpc: '2.0', id: 'srv-1', method: 'roots/list' });
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', description, inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } });
  } else if (msg.method === 'tools/call') {
    if (msg.params.name === 'fail') {
      send({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'it broke' }] } });
    } else if (msg.params.name === 'rpcerror') {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'bad params' } });
    } else if (msg.params.name === 'crash') {
      process.exit(3);
    } else if (msg.params.name === 'mixed') {
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'hi' }, { type: 'image', data: 'AAAA' }] } });
    } else {
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `echo:${msg.params.arguments.text}` }] } });
    }
  }
});
