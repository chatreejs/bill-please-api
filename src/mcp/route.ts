import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Elysia } from 'elysia';

import type { Config } from '../config.ts';
import type { DependencyMonitor } from '../health.ts';
import type { ReceiptScanner } from '../scanners/index.ts';
import { createMcpServer } from './server.ts';

/**
 * Streamable HTTP MCP endpoint in stateless mode: every request gets a fresh
 * server + transport, so it scales horizontally without sticky sessions.
 */
export const mcpRoutes = (config: Config, scanner: ReceiptScanner, dependencies?: DependencyMonitor) =>
  new Elysia().all(
    '/mcp',
    async ({ request }) => {
      const server = createMcpServer(config, scanner, dependencies);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      try {
        await server.connect(transport);
        return await transport.handleRequest(request);
      } finally {
        await transport.close();
        await server.close();
      }
    },
    // Leave the body stream untouched for the MCP transport to read
    { parse: 'none' },
  );
