import pgQuery from '../db/pg-query';
import Config from '../config';

// ─── Config ────────────────────────────────────────────────

const agoraBackendUrl = Config.agoraBackendUrl || process.env.AGORA_BACKEND_URL || 'http://agora-backend:3000';
const polisInternalProxySecret = Config.polisInternalProxySecret || process.env.POLIS_INTERNAL_PROXY_SECRET || '';

// ─── Types ─────────────────────────────────────────────────

interface LogAiUsageParams {
  use_case: string;
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  deliberation_id?: string;
  admin_user_id?: number;
  origin?: string;
  error_type?: string;
}

interface ModelConfig {
  primaryModel: string;
  primaryProvider: string;
  backupModel: string | null;
  backupProvider: string | null;
  fallbackModel: string | null;
  fallbackProvider: string | null;
}

// ─── Public API ────────────────────────────────────────────

/**
 * POST AI usage to Agora's internal API endpoint.
 * Fire-and-forget — errors are logged to console.error, never throws.
 */
export async function logAiUsage(params: LogAiUsageParams): Promise<void> {
  try {
    const { use_case, model, provider, input_tokens, output_tokens, deliberation_id, admin_user_id, origin, error_type } = params;

    const response = await fetch(`${agoraBackendUrl}/api/v1/internal/ai-usage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-polis-internal-key': polisInternalProxySecret,
      },
      body: JSON.stringify({ use_case, model, provider, input_tokens, output_tokens, deliberation_id, admin_user_id, origin, error_type }),
    });
    if (!response.ok) {
      console.error(`[aiUsageLogger] Agora returned ${response.status}: ${await response.text().catch(() => '')}`);
    }
  } catch (error) {
    console.error('[aiUsageLogger] failed to log AI usage', error);
  }
}

/**
 * Get the model configuration for a given use-case key from Polis's own database.
 * Returns null if no config exists. Never throws.
 */
export async function getModelConfig(useCaseKey: string): Promise<ModelConfig | null> {
  try {
    const rows = await pgQuery.queryP(
      `SELECT primary_model, primary_provider, backup_model, backup_provider, fallback_model, fallback_provider
       FROM polis_ai_use_case_config
       WHERE use_case_key = $1
       LIMIT 1`,
      [useCaseKey],
    );

    if (!rows || rows.length === 0) return null;

    const row = rows[0];
    return {
      primaryModel: row.primary_model,
      primaryProvider: row.primary_provider,
      backupModel: row.backup_model ?? null,
      backupProvider: row.backup_provider ?? null,
      fallbackModel: row.fallback_model ?? null,
      fallbackProvider: row.fallback_provider ?? null,
    };
  } catch (error) {
    console.error('[aiUsageLogger] failed to get model config', error);
    return null;
  }
}

/**
 * Map a Polis zid to an Agora deliberation_id.
 * Calls Agora's internal GET /api/v1/internal/deliberation-by-zid/:zid endpoint.
 */
export async function mapConversationToDeliberation(zid: number): Promise<string | null> {
  try {
    const response = await fetch(
      `${agoraBackendUrl}/api/v1/internal/deliberation-by-zid/${zid}`,
      { headers: { 'x-polis-internal-key': polisInternalProxySecret } }
    );
    if (!response.ok) {
      console.warn(`[aiUsageLogger] Agora returned ${response.status} for zid=${zid}`);
      return null;
    }
    const data = await response.json();
    return data.deliberation_id ?? null;
  } catch (error) {
    console.error('[aiUsageLogger] failed to map zid to deliberation', error);
    return null;
  }
}

/**
 * Look up the admin user who created a deliberation.
 * Calls Agora's internal GET /api/v1/internal/deliberations/:deliberationId/admin endpoint.
 */
export async function getAdminForDeliberation(deliberationId: string): Promise<number | null> {
  try {
    const response = await fetch(
      `${agoraBackendUrl}/api/v1/internal/deliberations/${encodeURIComponent(deliberationId)}/admin`,
      { headers: { 'x-polis-internal-key': polisInternalProxySecret } }
    );
    if (!response.ok) {
      console.warn(`[aiUsageLogger] Agora returned ${response.status} for deliberation=${deliberationId}`);
      return null;
    }
    const data = await response.json();
    return data.admin_user_id ?? null;
  } catch (error) {
    console.error('[aiUsageLogger] failed to get admin for deliberation', error);
    return null;
  }
}
