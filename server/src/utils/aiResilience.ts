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

// ─── callWithFallback ──────────────────────────────────────

export async function callWithFallback<T>(options: {
  label: string;
  primaryModel: string;
  primaryProvider: string;
  backupModel?: string;
  backupProvider?: string;
  primaryFn: (model: string, provider: string) => Promise<T>;
  backupFn?: (model: string, provider: string) => Promise<T>;
  timeout?: number;
  maxRetries?: number;
  priority?: number;
}): Promise<T> {
  const {
    label,
    primaryModel,
    primaryProvider,
    backupModel,
    backupProvider,
    primaryFn,
    backupFn,
    timeout,
    maxRetries,
    priority,
  } = options;

  const primaryBreaker = getCircuitBreaker(primaryProvider);
  let primaryError: unknown;

  try {
    return await enqueueAiCall(
      primaryProvider,
      () => retryWithBackoff(
        () => primaryBreaker.fire(() => primaryFn(primaryModel, primaryProvider)) as Promise<T>,
        { maxRetries: maxRetries ?? 2, timeout },
      ),
      priority,
    );
  } catch (err) {
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

  try {
    return await enqueueAiCall(
      backupProvider,
      () => retryWithBackoff(
        () => backupBreaker.fire(() => backupCall(backupModel, backupProvider)) as Promise<T>,
        { maxRetries: 3, timeout },
      ),
      priority,
    );
  } catch (backupError) {
    console.error(
      `[ai-fallback] Backup ${backupProvider}/${backupModel} also failed for ${label}`
    );
    const primaryMsg = (primaryError as { message?: string })?.message ?? String(primaryError);
    const backupMsg = (backupError as { message?: string })?.message ?? String(backupError);
    throw new Error(
      `AI call failed for ${label}: primary (${primaryProvider}/${primaryModel}): ${primaryMsg}; backup (${backupProvider}/${backupModel}): ${backupMsg}`
    );
  }
}
