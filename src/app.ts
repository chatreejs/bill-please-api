import { cors } from '@elysiajs/cors';
import { Elysia } from 'elysia';
import { rateLimit } from 'elysia-rate-limit';

import { type Config, corsOrigin } from './config.ts';
import { mcpRoutes } from './mcp/route.ts';
import { clientIp, requestLogger } from './request-logger.ts';
import { receiptRoutes } from './routes/receipts.ts';
import type { ReceiptScanner } from './scanners/index.ts';
import { createTurnstileVerifier, type TurnstileVerifier } from './turnstile.ts';

export const createApp = (
  config: Config,
  scanner: ReceiptScanner,
  verifyTurnstile: TurnstileVerifier | undefined = createTurnstileVerifier({
    secretKey: config.turnstileSecretKey,
    hostnames: config.turnstileHostnames,
    timeoutMs: config.turnstileTimeoutMs,
  }),
) =>
  new Elysia()
    .use(requestLogger(config))
    .use(cors({ origin: config.corsOrigins.map(corsOrigin) }))
    .get('/health', () => ({ status: 'ok' }))
    .use(
      rateLimit({
        duration: 60_000,
        max: config.rateLimitPerMinute,
        skip: (request) => new URL(request.url).pathname === '/health',
        generator: (request, server) => clientIp(request, server, config.trustProxy),
      }),
    )
    .use(receiptRoutes(config, scanner, verifyTurnstile))
    .use(mcpRoutes(config, scanner));
