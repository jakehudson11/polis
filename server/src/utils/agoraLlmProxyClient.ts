import crypto from 'crypto';

import Config from '../config';

// ─── Constants ─────────────────────────────────────────────

/**
 * Total wall-clock budget for the proxy round-trip, in milliseconds.
 *
 * Agora's internal /llm endpoint runs a max tier chain of 3 tiers × 45 s
 * per-attempt timeout = 135 s plus queue-wait/overhead, and Polis's own local
 * fallback chain (callWithFallback) runs on a 180 s totalTimeoutMs — the proxy
 * must give up BEFORE that so the local fallback still has time to run.
 */
const PROXY_TIMEOUT_MS = 170_000;

/** Delay before the single network-level retry, in milliseconds. */
const NETWORK_RETRY_DELAY_MS = 1_000;

/** Maximum attempts for network-level failures (1 initial + 1 retry). */
const MAX_NETWORK_ATTEMPTS = 2;

// ─── Types ─────────────────────────────────────────────────

export interface AgoraLlmProxyParams {
  /** Chat messages, same shape Agora's /api/v1/internal/llm expects. */
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  /**
   * Optional explicit override for Agora's primary tier. When omitted,
   * Agora resolves all three tiers (primary/backup/fallback) from its own
   * agora_ai_use_case_config using `useCase`. At least one of `useCase` or
   * `model`+`provider` must be supplied (enforced before the fetch).
   */
  model?: string;
  provider?: string;
  /** Second tier of Agora's cascade (optional). */
  backupModel?: string;
  backupProvider?: string;
  /** Third tier of Agora's cascade (optional). */
  fallbackModel?: string;
  fallbackProvider?: string;
  temperature?: number;
  maxTokens?: number;
  /** Ask the provider for a JSON-shaped completion. */
  jsonMode?: boolean;
  /** Agora use-case key, used for DB tier fallback + usage logging. */
  useCase?: string;
  /** Passed through so Agora can enforce budget checks. */
  deliberationId?: string;
  adminUserId?: number;
  /** Agora queue priority (its BACKGROUND default applies when omitted). */
  priority?: number;
}

export interface AgoraLlmProxyResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  finishReason: 'stop' | 'length' | 'other';
  model: string;
  provider: string;
  tier: 'primary' | 'backup' | 'fallback';
}

// ─── Error taxonomy ────────────────────────────────────────

/**
 * Error thrown by callViaAgoraProxy. `status` classifies the failure so
 * callers can decide whether to fall back to Polis's local LLM stack:
 *
 *  - 401       → Agora rejected the shared secret (auth mismatch, config
 *                problem). Do NOT fall back locally — retrying would just
 *                fail again. Exception: `code === 'not_configured'` means
 *                the secret was never set — callers treat that as "skip the
 *                proxy" and run Polis's local stack silently.
 *  - 400       → request validation failed. Do NOT fall back locally.
 *  - 402       → Agora budget exceeded for this deliberation/admin user.
 *  - 502       → all Agora tiers failed (its own retries are exhausted).
 *                Fall back locally.
 *  - other     → unexpected HTTP status. Treat like 502.
 *  - 'timeout' → the proxy gave up on its 170 s budget. Fall back locally.
 *  - 'network' → fetch failed (ECONNRESET/ENOTFOUND/ETIMEDOUT) and the single
 *                retry also failed. Fall back locally.
 *
 * `code` is Agora's `error` field when the body is JSON, else `http_<status>`.
 * `details` carries the raw Agora body (e.g. the 502 tier list) when parseable.
 */
export class AgoraProxyError extends Error {
  readonly status: number | 'network' | 'timeout';
  readonly code: string;
  readonly details?: unknown;

  constructor(
    status: number | 'network' | 'timeout',
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = 'AgoraProxyError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// ─── Helpers ───────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toFiniteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function toFinishReason(value: unknown): AgoraLlmProxyResult['finishReason'] {
  return value === 'stop' || value === 'length' ? value : 'other';
}

function toTier(value: unknown): AgoraLlmProxyResult['tier'] {
  return value === 'backup' || value === 'fallback' ? value : 'primary';
}

/**
 * Build the `x-agora-budget-context` header value:
 * `<deliberationId>|<adminUserId>|<hex-hmac-sha256>`.
 *
 * The HMAC input is `<deliberationId>|<adminUserId>` joined with a single
 * `|` pipe — empty strings when either attribution is absent — keyed with
 * the same shared secret used for `x-polis-internal-key`
 * (POLIS_INTERNAL_PROXY_SECRET). Agora validates the signature and derives
 * budget attribution ONLY from this header (audit F-801); the body's
 * deliberation_id/admin_user_id fields are client-attested and ignored for
 * trust. The header is always sent, even for unattributed calls.
 */
function buildBudgetContextHeader(
  deliberationId: string | undefined,
  adminUserId: number | undefined,
  secret: string,
): string {
  const input = `${deliberationId ?? ''}|${adminUserId ?? ''}`;
  const hmac = crypto.createHmac('sha256', secret).update(input).digest('hex');
  return `${input}|${hmac}`;
}

/**
 * Validate and shape a 200 response body. Throws AgoraProxyError when the
 * body is not JSON or `content` is not a string.
 */
async function parseSuccessResponse(response: Response): Promise<AgoraLlmProxyResult> {
  let data: unknown;
  try {
    data = await response.json();
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      // The 170 s abort fired while the body was still streaming.
      throw new AgoraProxyError(
        'timeout',
        'proxy_timeout',
        `Agora LLM proxy did not respond within ${PROXY_TIMEOUT_MS / 1000}s`,
      );
    }
    throw new AgoraProxyError(
      200,
      'invalid_response',
      'Agora LLM proxy returned a non-JSON or empty body on HTTP 200',
    );
  }

  const record =
    data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : null;
  if (record === null || typeof record.content !== 'string') {
    throw new AgoraProxyError(
      200,
      'invalid_response',
      'Agora LLM proxy response is missing string field "content"',
    );
  }

  return {
    content: record.content,
    inputTokens: toFiniteNumber(record.inputTokens),
    outputTokens: toFiniteNumber(record.outputTokens),
    finishReason: toFinishReason(record.finishReason),
    model: typeof record.model === 'string' ? record.model : 'unknown',
    provider: typeof record.provider === 'string' ? record.provider : 'unknown',
    tier: toTier(record.tier),
  };
}

/**
 * Parse an HTTP error response into an AgoraProxyError. Attempts to read the
 * JSON body for Agora's `error`/`message`/`details` fields; falls back to a
 * status-only message when the body is empty or not JSON.
 */
async function handleHttpError(response: Response): Promise<never> {
  let errorBody: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await response.json();
    if (parsed !== null && typeof parsed === 'object') {
      errorBody = parsed as Record<string, unknown>;
    }
  } catch {
    // Non-JSON or empty body — the status alone still identifies the failure.
  }

  const errorCode =
    typeof errorBody?.error === 'string' ? errorBody.error : `http_${response.status}`;

  let message =
    typeof errorBody?.message === 'string'
      ? errorBody.message
      : `Agora LLM proxy returned HTTP ${response.status} (${errorCode})`;

  if (typeof errorBody?.details === 'string') {
    message = `${message} — ${errorBody.details}`;
  }

  if (response.status === 401) {
    throw new AgoraProxyError(401, errorCode, message, errorBody ?? undefined);
  }
  if (response.status === 402) {
    throw new AgoraProxyError(402, errorCode, message, errorBody ?? undefined);
  }
  if (response.status === 502) {
    throw new AgoraProxyError(502, errorCode, message, errorBody ?? undefined);
  }
  throw new AgoraProxyError(response.status, errorCode, message, errorBody ?? undefined);
}

/**
 * One POST to Agora's internal LLM proxy endpoint with the 170 s abort
 * timeout. Throws AgoraProxyError for every failure mode; never returns a
 * malformed result.
 */
async function attemptProxyCall(
  endpoint: string,
  secret: string,
  body: Record<string, unknown>,
  budgetContextHeader: string,
): Promise<AgoraLlmProxyResult> {
  const controller = new AbortController();
  const timeoutTimer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
  // Do not let the timeout timer hold the Node.js event loop open after the
  // fetch completes.
  timeoutTimer.unref?.();

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-polis-internal-key': secret,
        'x-agora-budget-context': budgetContextHeader,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AgoraProxyError(
        'timeout',
        'proxy_timeout',
        `Agora LLM proxy did not respond within ${PROXY_TIMEOUT_MS / 1000}s`,
      );
    }
    // Network-level failure (ECONNRESET/ENOTFOUND/ETIMEDOUT, DNS, TLS, ...).
    throw new AgoraProxyError(
      'network',
      'fetch_failed',
      `Agora LLM proxy fetch failed: ${errorMessage(err)}`,
    );
  } finally {
    clearTimeout(timeoutTimer);
  }

  if (response.status === 200) {
    return parseSuccessResponse(response);
  }

  return handleHttpError(response);
}

// ─── Public API ────────────────────────────────────────────

/**
 * True when the Agora LLM proxy integration is fully configured: both the
 * backend URL and POLIS_INTERNAL_PROXY_SECRET are set. When this is false
 * Polis runs fully standalone — callers must skip the proxy tier silently
 * and use the local fallback stack.
 */
export function isAgoraProxyConfigured(): boolean {
  return Boolean(Config.agoraBackendUrl) && Boolean(Config.polisInternalProxySecret);
}

/**
 * Call Agora's internal LLM proxy (POST /api/v1/internal/llm), giving Polis
 * traffic access to Agora's resilience layer (p-queues, retries, circuit
 * breakers, 429 gates, tier cascade) over a plain HTTP call.
 *
 * Polis stays standalone: on failure this throws AgoraProxyError — it never
 * falls back locally itself; callers decide based on `err.status` whether to
 * run Polis's own stack (typically yes for 502/network/timeout, no for 401).
 */
export async function callViaAgoraProxy(params: AgoraLlmProxyParams): Promise<AgoraLlmProxyResult> {
  const secret = Config.polisInternalProxySecret;
  if (!secret) {
    // Defensive — callers are expected to gate on isAgoraProxyConfigured()
    // first, so this should be unreachable. `code: 'not_configured'` (never
    // a plain 401 auth rejection) ensures callers treat this as "integration
    // not configured" and skip the proxy silently.
    throw new AgoraProxyError(
      401,
      'not_configured',
      'Agora LLM proxy secret is not configured (POLIS_INTERNAL_PROXY_SECRET)',
    );
  }

  const baseUrl = (Config.agoraBackendUrl || 'http://agora-backend:3000').replace(/\/+$/, '');
  const endpoint = `${baseUrl}/api/v1/internal/llm`;

  // Agora trusts ONLY this signed header for budget attribution (audit
  // F-801): the body's deliberation_id/admin_user_id are client-attested and
  // ignored for trust. The header is ALWAYS sent — even for unattributed
  // calls, where empty strings are still signed — keyed with the same shared
  // secret as `x-polis-internal-key`.
  const budgetContextHeader = buildBudgetContextHeader(
    params.deliberationId,
    params.adminUserId,
    secret,
  );

  // Client-side guard: Agora resolves tiers from its own use-case config when
  // `use_case` is present; the explicit model+provider pair is the legacy
  // alternative. Refuse to send a request that supplies neither (safety net
  // for future callers that forget both).
  if (!params.useCase && !(params.model && params.provider)) {
    throw new AgoraProxyError(
      400,
      'missing_model_or_use_case',
      'Agora proxy requires either use_case or model+provider',
    );
  }

  const body: Record<string, unknown> = {
    messages: params.messages,
    temperature: params.temperature,
    max_tokens: params.maxTokens,
    json_mode: params.jsonMode,
    use_case: params.useCase,
    deliberation_id: params.deliberationId,
    admin_user_id: params.adminUserId,
    priority: params.priority,
  };

  // Model-selection keys are sent ONLY when explicitly supplied: with
  // `use_case` present, Agora is the single source of truth and derives the
  // primary/backup/fallback tiers from agora_ai_use_case_config itself.
  if (params.model) {
    body.model = params.model;
  }
  if (params.provider) {
    body.provider = params.provider;
  }
  if (params.backupModel) {
    body.backup_model = params.backupModel;
  }
  if (params.backupProvider) {
    body.backup_provider = params.backupProvider;
  }
  if (params.fallbackModel) {
    body.fallback_model = params.fallbackModel;
  }
  if (params.fallbackProvider) {
    body.fallback_provider = params.fallbackProvider;
  }

  // ONE network-level retry with a 1 s delay. Only fetch throwing
  // (ECONNRESET/ENOTFOUND/ETIMEDOUT) qualifies; HTTP error responses are never
  // retried here because Agora already exhausted its own retries internally
  // (a 502 means all tiers failed — fall back locally instead). Our own 170 s
  // abort (AbortError → 'timeout') is not retried either: the budget is
  // consumed, and a second attempt would blow past callWithFallback's 180 s
  // local window, defeating the fail-open design.
  for (let attempt = 1; attempt <= MAX_NETWORK_ATTEMPTS; attempt += 1) {
    try {
      return await attemptProxyCall(endpoint, secret, body, budgetContextHeader);
    } catch (err) {
      const isRetryableNetworkFailure =
        err instanceof AgoraProxyError &&
        err.status === 'network' &&
        attempt < MAX_NETWORK_ATTEMPTS;

      if (!isRetryableNetworkFailure) {
        const proxyErr = err instanceof AgoraProxyError ? err : null;
        console.error(
          `[agoraLlmProxyClient] call failed (attempt ${attempt}/${MAX_NETWORK_ATTEMPTS}): ` +
          `status=${proxyErr ? proxyErr.status : 'unknown'} ` +
          `code=${proxyErr ? proxyErr.code : 'unknown'} error="${errorMessage(err)}"`,
        );
        throw err;
      }

      console.warn(
        `[agoraLlmProxyClient] network failure (attempt ${attempt}/${MAX_NETWORK_ATTEMPTS}), ` +
        `retrying in ${NETWORK_RETRY_DELAY_MS}ms: ${errorMessage(err)}`,
      );
      await sleep(NETWORK_RETRY_DELAY_MS);
    }
  }

  // Unreachable: the loop above returns or throws on every iteration.
  throw new AgoraProxyError('network', 'fetch_failed', 'Agora LLM proxy call failed');
}
