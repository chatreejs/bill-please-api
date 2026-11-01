import { getLogger } from './logger.ts';

const log = getLogger('turnstile');

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Action that bill-please web passes to the widget for receipt scans */
export const RECEIPT_SCAN_ACTION = 'receipt_scan';

export interface TurnstileOptions {
  secretKey?: string;
  /** Hostnames the token must come from. Empty accepts any hostname on the widget */
  hostnames: string[];
  timeoutMs: number;
}

/** Subset of the siteverify response that the check reads */
interface SiteverifyResponse {
  success: boolean;
  'error-codes'?: string[];
  hostname?: string;
  action?: string;
  metadata?: { result_with_testing_key?: boolean };
}

export type TurnstileOutcome =
  | { ok: true }
  /** 403: the token is missing or Cloudflare rejected it. 503: siteverify could not be reached */
  | { ok: false; status: 403 | 503; reason: string };

export type TurnstileVerifier = (
  token: string | undefined,
  remoteIp: string,
  expectedAction: string,
) => Promise<TurnstileOutcome>;

/**
 * Builds a verifier that checks single-use Turnstile tokens with Cloudflare's
 * siteverify API. Returns undefined when no secret key is set, which turns the
 * check off, the same way bill-please web skips the widget without a site key.
 */
export const createTurnstileVerifier = (
  options: TurnstileOptions,
  fetchFn: typeof fetch = fetch,
): TurnstileVerifier | undefined => {
  const { secretKey, hostnames, timeoutMs } = options;
  if (!secretKey) return undefined;

  return async (token, remoteIp, expectedAction) => {
    if (!token) return { ok: false, status: 403, reason: 'missing token' };

    const form = new FormData();
    form.append('secret', secretKey);
    form.append('response', token);
    if (remoteIp) form.append('remoteip', remoteIp);

    let result: SiteverifyResponse;
    try {
      const res = await fetchFn(SITEVERIFY_URL, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`siteverify answered ${res.status}`);
      result = (await res.json()) as SiteverifyResponse;
    } catch (error) {
      log.error('Turnstile siteverify failed', error);
      return { ok: false, status: 503, reason: 'siteverify unavailable' };
    }

    if (!result.success) {
      const codes = result['error-codes']?.join(',') || 'unknown';
      return { ok: false, status: 403, reason: `rejected (${codes})` };
    }
    // Cloudflare's test secret keys answer with hostname example.com and no action
    if (result.metadata?.result_with_testing_key) {
      log.debug('Turnstile test key result, skipping the action and hostname checks');
      return { ok: true };
    }
    if (result.action !== expectedAction) {
      return { ok: false, status: 403, reason: `unexpected action "${result.action ?? ''}"` };
    }
    if (hostnames.length > 0 && !hostnames.includes(result.hostname ?? '')) {
      return { ok: false, status: 403, reason: `unexpected hostname "${result.hostname ?? ''}"` };
    }
    return { ok: true };
  };
};
