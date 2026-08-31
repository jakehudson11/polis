import CircuitBreaker from 'opossum';
import Config from '../config';
import { enqueueAiCall } from './aiProviderQueues';
import { AgoraProxyError, callViaAgoraProxy, isAgoraProxyConfigured } from './agoraLlmProxyClient';

// ─── Timeout Constants ─────────────────────────────────────

export const AI_TIMEOUTS = {
  STANDARD: 45_000,
  REPORT: 120_000,
} as const;

// ─── retryWithBackoff ──────────────────────────────────────

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options?: { maxRetries?: number; baseDelayMs?: number; retryableStatuses?: number[]; timeout?: number }
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 1000;
  const retryableStatuses = options?.retryableStatuses ?? [429, 500, 502, 503];
  const retryableNetworkCodes = new Set(['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND']);
  const timeout = options?.timeout;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      let result: T;
      if (timeout) {
        result = await Promise.race([
          fn(),
          new Promise<never>((_, reject) => {
            setTimeout(() => {
              const err = new Error(`AI call timed out after ${timeout}ms`);
              (err as any).status = 408;
              (err as any).code = 'ETIMEDOUT';
              reject(err);
            }, timeout);
          }),
        ]);
      } else {
        result = await fn();
      }
      return result;
    } catch (err: unknown) {
      lastError = err;

      if (attempt === maxRetries) break;

      const status = (err as { status?: number }).status;
      const code = (err as { code?: string }).code;
      const isRetryableStatus = status !== undefined && retryableStatuses.includes(status);
      const isRetryableNetwork = code !== undefined && retryableNetworkCodes.has(code);

      if (!isRetryableStatus && !isRetryableNetwork) break;

      let delayMs = baseDelayMs * Math.pow(2, attempt);

      if (status === 429) {
        const headers = (err as { headers?: { get?: (k: string) => string | null; 'retry-after'?: string } }).headers;
        let retryAfter: string | null | undefined;
        if (headers) {
          retryAfter = typeof headers.get === 'function'
            ? headers.get('retry-after')
            : headers['retry-after'];
        }
        if (retryAfter) {
          const parsed = Number(retryAfter);
          if (!Number.isNaN(parsed) && parsed > 0) {
            delayMs = parsed * 1000;
          }
        }
      }

      const reason = (err as { message?: string }).message ?? String(err);
      console.warn(
        `[ai-retry] Attempt ${attempt + 1}/${maxRetries + 1} failed: ${reason}, retrying in ${delayMs}ms`
      );

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

// ─── Circuit Breakers ──────────────────────────────────────

const breakers = new Map<string, CircuitBreaker>();

function createBreaker(provider: string): CircuitBreaker {
  const breaker = new CircuitBreaker(
    async <T>(fn: () => Promise<T>): Promise<T> => fn(),
    {
      timeout: false,
      errorThresholdPercentage: 50,
      resetTimeout: 60_000,
      rollingCountTimeout: 60_000,
      volumeThreshold: 5,
      errorFilter: (err: any) => {
        // Return true to NOT count as error (filtered out)
        // Don't count 429s as circuit errors — they are transient rate limits
        return err?.status === 429;
      },
    },
  );

  breaker.on('open', () => {
    console.warn(`[circuit-breaker] ${provider} circuit OPENED — requests will be short-circuited`);
  });
  breaker.on('halfOpen', () => {
    console.info(`[circuit-breaker] ${provider} circuit HALF-OPEN — testing next request`);
  });
  breaker.on('close', () => {
    console.info(`[circuit-breaker] ${provider} circuit CLOSED — back to normal`);
  });

  return breaker;
}

export function getCircuitBreaker(provider: string): CircuitBreaker {
  let breaker = breakers.get(provider);
  if (!breaker) {
    breaker = createBreaker(provider);
    breakers.set(provider, breaker);
  }
  return breaker;
}

// ─── Inline metrics logging ─────────────────────────────

function classifyError(err: unknown): string {
  const status = (err as { status?: number }).status;
  const code = (err as { code?: string }).code;
  if (status === 429) return 'rate_limit';
  if (status === 408 || code === 'ETIMEDOUT') return 'timeout';
  if (status && status >= 500) return 'server_error';
  if (code === 'ECONNRESET' || code === 'ENOTFOUND') return 'network_error';
  if ((err as Error)?.message?.includes('circuit')) return 'circuit_open';
  return 'unknown';
}

function logMetrics(provider: string, latencyMs: number, success: boolean, errorType?: string): void {
  console.log(`[ai-metrics] ${provider} call: ${latencyMs}ms, success: ${success}${errorType ? `, error: ${errorType}` : ''}`);
}

// ─── FallbackResult type ───────────────────────────────────

export interface FallbackResult<T> {
  result: T;
  usedModel: string;
  usedProvider: string;
  usedTier: 'primary' | 'backup' | 'fallback';
  /**
   * True when the result came from Agora's proxy layer rather than Polis's
   * local stack. Agora already logged AI usage server-side, so call sites
   * MUST skip their own logAiUsage when this flag is set (prevents
   * double-logging). Undefined for local-path results.
   */
  proxied?: boolean;
}

// ─── Agora proxy options ──────────────────────────────────

export interface AgoraChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Messages and per-call options for the Agora proxy tier. When provided
 * (and the proxy is enabled), callWithFallback first tries
 * callViaAgoraProxy before running the local primary/backup/fallback chain.
 */
export interface AgoraProxyOptions {
  /** Chat messages forwarded to Agora's internal LLM proxy endpoint. */
  messages: AgoraChatMessage[];
  /** Requested max output tokens (passed through to Agora). */
  maxTokens?: number;
  /** Sampling temperature (passed through to Agora). */
  temperature?: number;
  /** Ask the provider for a JSON-shaped completion. */
  jsonMode?: boolean;
  /** Agora use-case key, used for DB tier fallback + usage logging. */
  useCase?: string;
  /** Passed through so Agora can enforce per-deliberation budget checks. */
  deliberationId?: string;
  /** Passed through so Agora can enforce per-admin budget checks. */
  adminUserId?: number;
  /** Agora queue priority (its BACKGROUND default applies when omitted). */
  priority?: number;
}

// ─── callWithFallback ──────────────────────────────────────

export async function callWithFallback<T>(options: {
  label: string;
  primaryModel: string;
  primaryProvider: string;
  backupModel?: string;
  backupProvider?: string;
  fallbackModel?: string;
  fallbackProvider?: string;
  primaryFn: (model: string, provider: string) => Promise<T>;
  backupFn?: (model: string, provider: string) => Promise<T>;
  /** Per-attempt timeout (ms) passed through to retryWithBackoff. */
  timeout?: number;
  maxRetries?: number;
  priority?: number;
  /** Wall-clock timeout (ms) for the entire fallback chain (primary +
   *  backup + fallback tiers combined).  Defaults to 180 s to stay
   *  under the Agora proxy timeout. */
  totalTimeoutMs?: number;
  /**
   * When true (default) and `agoraProxy.messages` is provided, the call
   * first tries Agora's resilience layer via callViaAgoraProxy (queues,
   * retries, circuit breakers, tier cascade) and only falls through to the
   * local primary/backup/fallback chain on 502/network/timeout failures.
   * Genuine auth mismatches (401 / unauthorized with the secret set) rethrow
   * instead; a missing POLIS_INTERNAL_PROXY_SECRET skips the proxy silently
   * (standalone). Also gated by POLIS_USE_AGORA_PROXY (default 'true') and
   * by the integration being configured (backend URL + secret).
   */
  useAgoraProxy?: boolean;
  /**
   * Messages + options for the Agora proxy tier. When omitted, the proxy is
   * skipped entirely and only the local fallback chain runs.
   */
  agoraProxy?: AgoraProxyOptions;
}): Promise<FallbackResult<T>> {
  const {
    label,
    primaryModel,
    primaryProvider,
    backupModel,
    backupProvider,
    fallbackModel,
    fallbackProvider,
    primaryFn,
    backupFn,
    timeout,
    maxRetries,
    priority,
    totalTimeoutMs = 180_000,
    useAgoraProxy,
    agoraProxy,
  } = options;

  // ─── Agora proxy gate ────────────────────────────────────
  // The proxy tier runs first only when every gate passes: the caller did
  // not disable it (useAgoraProxy defaults to true), the env var
  // POLIS_USE_AGORA_PROXY is not 'false', the integration is configured
  // (backend URL + POLIS_INTERNAL_PROXY_SECRET), and the caller supplied
  // messages. A missing secret means Polis runs fully standalone — the
  // proxy is skipped silently (no log spam) and the existing local chain
  // below runs (exact pre-proxy behavior).
  const agoraProxyEnabled =
    useAgoraProxy !== false &&
    process.env.POLIS_USE_AGORA_PROXY !== 'false' &&
    isAgoraProxyConfigured() &&
    Boolean(agoraProxy && agoraProxy.messages.length > 0);

  async function runFallbackChain(): Promise<FallbackResult<T>> {
    const primaryBreaker = getCircuitBreaker(primaryProvider);
    let primaryError: unknown;
    let backupError: unknown;

    const startTime = Date.now();

    // Set when the proxy tier was attempted but failed and the local chain
    // is running as fallback. Carried into the final aggregate error so
    // callers can distinguish "proxy attempted and failed" from "no proxy
    // attempt at all" (e.g. the seed-comments route must not report a
    // missing local API key when the real cause was the proxy).
    let proxyFailureNote: string | null = null;

    // ─── Agora proxy tier (before the local chain) ─────────
    // Budget: callViaAgoraProxy aborts itself at 170 s, which is strictly
    // shorter than the default totalTimeoutMs of 180 s, so the local chain
    // below still has its full wall-clock window if the proxy fails.
    if (agoraProxyEnabled && agoraProxy) {
      const proxyStart = Date.now();
      try {
        const proxyResult = await callViaAgoraProxy({
          messages: agoraProxy.messages,
          temperature: agoraProxy.temperature,
          maxTokens: agoraProxy.maxTokens,
          jsonMode: agoraProxy.jsonMode,
          useCase: agoraProxy.useCase,
          deliberationId: agoraProxy.deliberationId,
          adminUserId: agoraProxy.adminUserId,
          priority: agoraProxy.priority ?? priority,
        });

        if (typeof proxyResult.content !== 'string') {
          // Defensive — callViaAgoraProxy already validates that content is
          // a string; treat a non-string as failure and fall through locally.
          console.warn(
            `[agora-proxy] ${label}: proxy returned unexpected shape ` +
            `(content=${typeof proxyResult.content}, inputTokens=${typeof proxyResult.inputTokens}, ` +
            `outputTokens=${typeof proxyResult.outputTokens}), falling back to local stack`
          );
        } else {
          logMetrics('agora-proxy', Date.now() - proxyStart, true);
          // The proxy result is a full NormalizedAIResponse-shaped object
          // (content string + input/output token counts), not a raw string.
          // Returning only proxyResult.content here broke callers that read
          // result.content / result.inputTokens / result.outputTokens off the
          // result (seedCommentGenerator, collectiveStatement, reportNarrative).
          return {
            result: proxyResult as unknown as T,
            usedModel: proxyResult.model,
            usedProvider: proxyResult.provider,
            usedTier: proxyResult.tier,
            proxied: true,
          };
        }
      } catch (proxyErr) {
        logMetrics('agora-proxy', Date.now() - proxyStart, false, classifyError(proxyErr));

        // 'not_configured' (or the legacy 'missing_secret') means the
        // integration was never set up — the gate normally prevents the
        // proxy from running at all, so this is just a defensive note; the
        // proxy is skipped silently and the local chain below runs.
        //
        // Genuine rejections rethrow — do NOT mask them with the local
        // stack, matching the documented intent of AgoraProxyError (see the
        // taxonomy in agoraLlmProxyClient.ts):
        //  - 401/'unauthorized' → secret IS set but Agora rejected it
        //    (config mismatch).
        //  - 400 (incl. 'missing_or_invalid_budget_context') → request
        //    validation failed. A budget-context 400 typically means the
        //    running polis-api build predates the signed
        //    x-agora-budget-context header (audit F-801); falling back
        //    locally would fail the same way and hide the real cause.
        //  - 402 → Agora budget exceeded for this deliberation/admin user;
        //    falling back locally would circumvent the agora-side gate.
        // Everything else (502 all_tiers_failed, other 4xx/5xx, network,
        // timeout, unexpected errors) warns and falls through locally.
        if (
          proxyErr instanceof AgoraProxyError &&
          (proxyErr.code === 'not_configured' || proxyErr.code === 'missing_secret')
        ) {
          console.info(
            `[agora-proxy] ${label}: proxy not configured (${proxyErr.code}), running local stack`
          );
        } else if (
          proxyErr instanceof AgoraProxyError &&
          (proxyErr.status === 400 ||
            proxyErr.status === 401 ||
            proxyErr.status === 402 ||
            proxyErr.code === 'unauthorized' ||
            proxyErr.code === 'missing_or_invalid_budget_context')
        ) {
          console.error(
            `[agora-proxy] ${label}: proxy rejected request (status=${proxyErr.status}, ` +
            `code=${proxyErr.code}) "${proxyErr.message}" — NOT falling back to local stack`
          );
          // Re-throw with a stable, greppable marker so downstream error
          // mapping (e.g. the seed-comments route) can identify proxy
          // rejections regardless of the original Agora body shape.
          throw new AgoraProxyError(
            proxyErr.status,
            proxyErr.code,
            `Agora LLM proxy rejected request (status=${proxyErr.status}, code=${proxyErr.code}): ${proxyErr.message}`,
            proxyErr.details,
          );
        }

        const proxyStatus = proxyErr instanceof AgoraProxyError ? proxyErr.status : 'unknown';
        const proxyCode = proxyErr instanceof AgoraProxyError ? proxyErr.code : 'unknown';
        proxyFailureNote = `Agora LLM proxy failed (status=${proxyStatus}, code=${proxyCode})`;
        console.warn(
          `[agora-proxy] ${label}: proxy call failed (status=${proxyStatus}, code=${proxyCode}), ` +
          `falling back to local stack: ${proxyErr instanceof Error ? proxyErr.message : String(proxyErr)}`
        );
      }
    }

    try {
      const result = await enqueueAiCall(
        primaryProvider,
        () => retryWithBackoff(
          () => primaryBreaker.fire(() => primaryFn(primaryModel, primaryProvider)) as Promise<T>,
          { maxRetries: maxRetries ?? 2, timeout },
        ),
        priority,
      );
      logMetrics(primaryProvider, Date.now() - startTime, true);
      return { result, usedModel: primaryModel, usedProvider: primaryProvider, usedTier: 'primary' };
    } catch (err) {
      logMetrics(primaryProvider, Date.now() - startTime, false, classifyError(err));
      primaryError = err;
      console.warn(
        `[ai-fallback] Primary ${primaryProvider}/${primaryModel} failed for ${label}, trying backup`
      );
    }

    if (!backupModel || !backupProvider) {
      throw primaryError;
    }

    const backupBreaker = getCircuitBreaker(backupProvider);
    const backupCall = backupFn ?? primaryFn;

    const backupStart = Date.now();
    try {
      const result = await enqueueAiCall(
        backupProvider,
        () => retryWithBackoff(
          () => backupBreaker.fire(() => backupCall(backupModel, backupProvider)) as Promise<T>,
          { maxRetries: 3, timeout },
        ),
        priority,
      );
      logMetrics(backupProvider, Date.now() - backupStart, true);
      return { result, usedModel: backupModel, usedProvider: backupProvider, usedTier: 'backup' };
    } catch (err) {
      backupError = err;
      logMetrics(backupProvider, Date.now() - backupStart, false, classifyError(err));
      console.error(
        `[ai-fallback] Backup ${backupProvider}/${backupModel} also failed for ${label}`
      );
    }

    // ─── Fallback tier ──────────────────────────────────────
    if (fallbackModel && fallbackProvider) {
      console.warn(
        `[ai-fallback] Both primary and backup failed for ${label}, trying fallback ${fallbackProvider}/${fallbackModel}`
      );

      const fallbackBreaker = getCircuitBreaker(fallbackProvider);
      const fallbackStart = Date.now();
      try {
        const fallbackCallFn = backupCall ?? primaryFn;
        const result = await enqueueAiCall(
          fallbackProvider,
          () => retryWithBackoff(
            () => fallbackBreaker.fire(() => fallbackCallFn(fallbackModel!, fallbackProvider!)) as Promise<T>,
            { maxRetries: 3, timeout },
          ),
          priority,
        );
        logMetrics(fallbackProvider, Date.now() - fallbackStart, true);
        console.log(`[ai-fallback] Fallback ${fallbackProvider}/${fallbackModel} succeeded for ${label}`);
        return { result, usedModel: fallbackModel!, usedProvider: fallbackProvider!, usedTier: 'fallback' };
      } catch (fallbackError) {
        logMetrics(fallbackProvider, Date.now() - fallbackStart, false, classifyError(fallbackError));
        console.error(
          `[ai-fallback] Fallback ${fallbackProvider}/${fallbackModel} also failed for ${label}`
        );
      }
    }

    const primaryMsg = (primaryError as { message?: string })?.message ?? String(primaryError);
    const backupMsg = (backupError as { message?: string })?.message ?? String(backupError);
    const fallbackTag = fallbackModel && fallbackProvider
      ? `; fallback (${fallbackProvider}/${fallbackModel})`
      : '';
    throw new Error(
      `${proxyFailureNote ? `${proxyFailureNote}; ` : ''}AI call failed for ${label}: ` +
      `primary (${primaryProvider}/${primaryModel}): ${primaryMsg}; ` +
      `backup (${backupProvider}/${backupModel}): ${backupMsg}${fallbackTag}`
    );
  }

  const totalTimeoutPromise = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(
        `callWithFallback total timeout: ${label} exceeded ${totalTimeoutMs / 1000}s across all tiers`
      );
      (err as any).code = 'FALLBACK_TOTAL_TIMEOUT';
      reject(err);
    }, totalTimeoutMs);
    if (timer.unref) timer.unref();
  });

  return Promise.race([runFallbackChain(), totalTimeoutPromise]);
}
