import { agoraQuery } from '../db/agora-pg';

// ─── Types ─────────────────────────────────────────────────

interface LogAiUsageParams {
  use_case: string;
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  deliberation_id?: string;
  admin_user_id?: number;
}

interface ModelConfig {
  primaryModel: string;
  primaryProvider: string;
  backupModel: string | null;
  backupProvider: string | null;
}

// ─── Public API ────────────────────────────────────────────

/**
 * Insert a row into agora_ai_usage_log with auto-calculated cost.
 * Never throws — errors are logged to console.error.
 */
export async function logAiUsage(params: LogAiUsageParams): Promise<void> {
  try {
    const { use_case, model, provider, input_tokens, output_tokens, deliberation_id, admin_user_id } = params;

    // Look up pricing
    const pricingResult = await agoraQuery(
      `SELECT input_cost_per_million, output_cost_per_million
       FROM agora_ai_model_pricing
       WHERE model_name = $1 AND provider = $2
       LIMIT 1`,
      [model, provider],
    );

    let cost = 0;
    if (pricingResult && pricingResult.rows.length > 0) {
      const { input_cost_per_million, output_cost_per_million } = pricingResult.rows[0];
      cost =
        (input_tokens * Number(input_cost_per_million)) / 1_000_000 +
        (output_tokens * Number(output_cost_per_million)) / 1_000_000;
    } else {
      console.warn(`[aiUsageLogger] no pricing found for model=${model} provider=${provider}, logging with cost=0`);
    }

    await agoraQuery(
      `INSERT INTO agora_ai_usage_log
         (use_case, model, provider, input_tokens, output_tokens, cost, deliberation_id, admin_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [use_case, model, provider, input_tokens, output_tokens, cost, deliberation_id ?? null, admin_user_id ?? null],
    );
  } catch (error) {
    console.error('[aiUsageLogger] failed to log AI usage', error);
  }
}

/**
 * Get the model configuration for a given use-case key.
 * Returns null if no config exists. Never throws.
 */
export async function getModelConfig(useCaseKey: string): Promise<ModelConfig | null> {
  try {
    const result = await agoraQuery(
      `SELECT primary_model, primary_provider, backup_model, backup_provider
       FROM agora_ai_use_case_config
       WHERE use_case_key = $1
       LIMIT 1`,
      [useCaseKey],
    );

    if (!result || result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      primaryModel: row.primary_model,
      primaryProvider: row.primary_provider,
      backupModel: row.backup_model ?? null,
      backupProvider: row.backup_provider ?? null,
    };
  } catch (error) {
    console.error('[aiUsageLogger] failed to get model config', error);
    return null;
  }
}

/**
 * Map a Polis zid to an Agora deliberation_id.
 * Returns the deliberation_id string or null. Never throws.
 */
export async function mapConversationToDeliberation(zid: number): Promise<string | null> {
  try {
    const result = await agoraQuery(
      `SELECT deliberation_id
       FROM agora_deliberations
       WHERE polis_zid = $1
       LIMIT 1`,
      [zid],
    );

    if (!result || result.rows.length === 0) return null;
    return result.rows[0].deliberation_id;
  } catch (error) {
    console.error('[aiUsageLogger] failed to map zid to deliberation', error);
    return null;
  }
}

/**
 * Look up the admin user who created a deliberation.
 * Returns the agora_auth_users id or null. Never throws.
 */
export async function getAdminForDeliberation(deliberationId: string): Promise<number | null> {
  try {
    const result = await agoraQuery(
      `SELECT created_by_agora_user_id
       FROM agora_deliberations
       WHERE deliberation_id = $1
       LIMIT 1`,
      [deliberationId],
    );

    if (!result || result.rows.length === 0) return null;
    return result.rows[0].created_by_agora_user_id;
  } catch (error) {
    console.error('[aiUsageLogger] failed to get admin for deliberation', error);
    return null;
  }
}
