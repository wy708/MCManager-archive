import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ArchiveApi, configuration } from './api.mjs';
import { createServer } from './tools.mjs';

try {
  const server = createServer(new ArchiveApi(configuration()));
  await server.connect(new StdioServerTransport());
} catch (error) {
  // stdout belongs exclusively to MCP. Configuration errors never interpolate secrets.
  process.stderr.write(`MCManager MCP startup failed: ${error instanceof Error ? error.message.replace(/mcmagent\.[^\s]+/g, '[redacted]') : 'unknown error'}\n`);
  process.exitCode = 1;
}
