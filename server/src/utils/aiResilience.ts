import CircuitBreaker from 'opossum';
import { enqueueAiCall } from './aiProviderQueues';

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
  timeout?: number;
  maxRetries?: number;
  priority?: number;
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
  } = options;

  const primaryBreaker = getCircuitBreaker(primaryProvider);
  let primaryError: unknown;
  let backupError: unknown;

  const startTime = Date.now();
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
    `AI call failed for ${label}: primary (${primaryProvider}/${primaryModel}): ${primaryMsg}; backup (${backupProvider}/${backupModel}): ${backupMsg}${fallbackTag}`
  );
}
