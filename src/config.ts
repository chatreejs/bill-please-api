import { parseLogLevel } from './logger.ts';

const int = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const float = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
};

const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const url = (value: string | undefined, fallback: string) => (value || fallback).replace(/\/+$/, '');

export const config = {
  port: int(Bun.env.PORT, 3001),
  corsOrigins: list(Bun.env.CORS_ORIGINS ?? 'http://localhost:3000'),
  maxImageBytes: int(Bun.env.MAX_IMAGE_BYTES, 5 * 1024 * 1024),
  rateLimitPerMinute: int(Bun.env.RATE_LIMIT_PER_MINUTE, 30),
  trustProxy: Bun.env.TRUST_PROXY === 'true',
  ocrUrl: url(Bun.env.OCR_URL, 'http://localhost:8000'),
  ocrTimeoutMs: int(Bun.env.OCR_TIMEOUT_MS, 20000),
  ocrMinConfidence: float(Bun.env.OCR_MIN_CONFIDENCE, 0.6),
  llmUrl: url(Bun.env.LLM_URL, 'http://localhost:8080/v1'),
  llmModel: Bun.env.LLM_MODEL ?? 'qwen3-4b-instruct-2507',
  llmApiKey: Bun.env.LLM_API_KEY || undefined,
  llmTimeoutMs: int(Bun.env.LLM_TIMEOUT_MS, 45000),
  // Sent as reasoning_effort. none stops thinking models from reasoning before they answer.
  // Empty omits the field, because some APIs reject it on models without reasoning.
  llmReasoningEffort: Bun.env.LLM_REASONING_EFFORT ?? 'none',
  // gbnf sends a compact grammar that only llama.cpp accepts. json_schema works with any OpenAI compatible API.
  llmOutputFormat: Bun.env.LLM_OUTPUT_FORMAT === 'json_schema' ? ('json_schema' as const) : ('gbnf' as const),
  // Cloudflare Turnstile secret key. Empty turns the check on POST /api/receipts/scan off
  turnstileSecretKey: Bun.env.TURNSTILE_SECRET_KEY || undefined,
  turnstileHostnames: list(Bun.env.TURNSTILE_HOSTNAMES),
  turnstileTimeoutMs: int(Bun.env.TURNSTILE_TIMEOUT_MS, 10000),
  logLevel: parseLogLevel(Bun.env.LOG_LEVEL),
};

export type Config = typeof config;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "*" inside an origin matches one hostname label part, e.g. Vercel preview deploys:
// https://bill-please-*-chatreejs-projects.vercel.app
export const corsOrigin = (origin: string): string | RegExp =>
  origin === '*' || !origin.includes('*')
    ? origin
    : new RegExp(`^${origin.split('*').map(escapeRegExp).join('[a-z0-9-]+')}$`);
