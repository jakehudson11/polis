import { Request, Response } from "express";
import Config from "../config";
import pg from "../db/pg-query";
import logger from "../utils/logger";
import { callAIProvider } from "../utils/aiModelRouter";
import { encrypt, decrypt } from "../utils/encryption";

async function loadPricingAliases(): Promise<Record<string, string>> {
  try {
    const rows = await pg.queryP(
      "SELECT model_name, provider, aliased_model_name FROM polis_ai_pricing_aliases"
    );
    const aliases: Record<string, string> = {};
    for (const row of rows) {
      const key = (row.model_name || '').trim().toLowerCase();
      if (key && row.aliased_model_name?.trim()) {
        aliases[key] = row.aliased_model_name.trim();
      }
    }
    return aliases;
  } catch (err) {
    logger.warn("Failed to load pricing aliases from DB", err);
    return {};
  }
}

// ── Auth helper ──────────────────────────────────────────────────────────────

function checkInternalKey(req: Request, res: Response): boolean {
  const key = req.header("x-polis-internal-key") || "";
  if (!Config.polisInternalProxySecret || key !== Config.polisInternalProxySecret) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

// ── Shared pricing resolution helper ─────────────────────────────────────────

interface ResolvedPricing {
  inputCost: number;
  outputCost: number;
  modality: string;
  billingUnit: string;
}

async function resolvePricingFromRegistry(
  modelName: string,
  provider: string,
): Promise<ResolvedPricing | null> {
  try {
    const url = `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();

    const dbAliases = await loadPricingAliases();
    const aliasedName = dbAliases[modelName.trim().toLowerCase()];

    let modelKey: string | undefined;

    // Stage 1: exact match on model name
    modelKey = Object.keys(data).find(k => k.toLowerCase() === modelName.toLowerCase());
    // Stage 2: provider-prefixed exact match
    if (!modelKey) {
      modelKey = Object.keys(data).find(k => k.toLowerCase() === `${provider}/${modelName}`.toLowerCase());
    }
    // Stage 3: DB alias lookup
    if (!modelKey && aliasedName) {
      modelKey = Object.keys(data).find(k => k.toLowerCase() === aliasedName.toLowerCase());
    }
    // Stage 4: smart base-name fallback
    if (!modelKey) {
      const normalized = modelName.trim().toLowerCase();
      modelKey = Object.keys(data).find(k => {
        const parts = k.split('/').map(p => p.trim()).filter(Boolean);
        const base = (parts.length > 1 ? parts[parts.length - 1] : k).toLowerCase();
        return base === normalized;
      });
    }
    // Stage 5: aliased name base-name fallback
    if (!modelKey && aliasedName) {
      const normalizedAlias = aliasedName.trim().toLowerCase();
      modelKey = Object.keys(data).find(k => {
        const parts = k.split('/').map(p => p.trim()).filter(Boolean);
        const base = (parts.length > 1 ? parts[parts.length - 1] : k).toLowerCase();
        return base === normalizedAlias;
      });
    }

    if (!modelKey) return null;
    const entry = data[modelKey];
    if (!entry) return null;

    // Litellm stores costs per single unit; our DB uses per-1M
    const inputCost = entry.input_cost_per_image
      ? entry.input_cost_per_image
      : entry.input_cost_per_image_token
        ? entry.input_cost_per_image_token * 1_000_000
        : entry.input_cost_per_token
          ? entry.input_cost_per_token * 1_000_000
          : entry.input_cost_per_character
            ? entry.input_cost_per_character * 1_000_000
            : null;

    const outputCost = entry.output_cost_per_image
      ? entry.output_cost_per_image
      : entry.output_cost_per_image_token
        ? entry.output_cost_per_image_token * 1_000_000
        : entry.output_cost_per_token
          ? entry.output_cost_per_token * 1_000_000
          : entry.output_cost_per_character
            ? entry.output_cost_per_character * 1_000_000
            : null;

    if (inputCost === null && outputCost === null) return null;

    const resolvedModality = entry.mode === 'image_generation' ? 'img'
      : entry.mode === 'audio_speech' ? 'tts'
      : 'llm';
    const resolvedBillingUnit = entry.mode === 'image_generation' ? 'image'
      : entry.mode === 'audio_speech' ? 'character'
      : 'token';

    return {
      inputCost: inputCost ?? 0,
      outputCost: outputCost ?? 0,
      modality: resolvedModality,
      billingUnit: resolvedBillingUnit,
    };
  } catch {
    return null;
  }
}

// ── Model pricing handlers ───────────────────────────────────────────────────

export async function handle_GET_ai_config_models(req: Request, res: Response): Promise<void> {
  if (!checkInternalKey(req, res)) return;
  try {
    const rows = await pg.queryP(
      "SELECT * FROM polis_ai_model_pricing ORDER BY provider, model_name"
    );
    res.json({ models: rows });
  } catch (err: any) {
    logger.error("aiConfig GET /models", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function handle_POST_ai_config_models(req: Request, res: Response): Promise<void> {
  if (!checkInternalKey(req, res)) return;
  try {
    const { model_name, provider, input_cost_per_million, output_cost_per_million, modality, context_window_tokens, max_output_tokens, auto_update_enabled, fetch_pricing } = req.body;
    if (!model_name || !provider) {
      res.status(400).json({ error: "model_name and provider are required" });
      return;
    }
    const existing = await pg.queryP(
      "SELECT id FROM polis_ai_model_pricing WHERE model_name = $1 AND provider = $2",
      [model_name, provider]
    );
    if (existing.length > 0) {
      res.status(409).json({ error: "Model with this name and provider already exists" });
      return;
    }
    const rows = await pg.queryP(
      `INSERT INTO polis_ai_model_pricing (model_name, provider, input_cost_per_million, output_cost_per_million, modality, context_window_tokens, max_output_tokens, auto_update_enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [model_name, provider, input_cost_per_million ?? 0, output_cost_per_million ?? 0, modality ?? "llm", context_window_tokens ?? null, max_output_tokens ?? null, auto_update_enabled ?? false]
    );

    // If fetch_pricing requested, resolve pricing from Litellm registry immediately
    if (fetch_pricing) {
      try {
        const resolved = await resolvePricingFromRegistry(model_name, provider);
        if (resolved) {
          await pg.queryP(
            `UPDATE polis_ai_model_pricing
             SET input_cost_per_million = $1, output_cost_per_million = $2,
                 modality = $3, billing_unit = $4,
                 last_pricing_sync_at = NOW(), pricing_sync_error = NULL,
                 auto_update_enabled = true
             WHERE id = $5`,
            [resolved.inputCost, resolved.outputCost, resolved.modality, resolved.billingUnit, rows[0].id]
          );
          rows[0].input_cost_per_million = resolved.inputCost;
          rows[0].output_cost_per_million = resolved.outputCost;
          rows[0].modality = resolved.modality;
          rows[0].billing_unit = resolved.billingUnit;
          rows[0].auto_update_enabled = true;
        } else {
          await pg.queryP(
            `UPDATE polis_ai_model_pricing
             SET last_pricing_sync_at = NOW(), pricing_sync_error = $1,
                 auto_update_enabled = false
             WHERE id = $2`,
            ['Model not found in Litellm registry. Keeping manual pricing.', rows[0].id]
          );
          rows[0].auto_update_enabled = false;
        }
      } catch { /* non-fatal — model still created */ }
    }

    res.status(201).json({ model: rows[0] });
  } catch (err: any) {
    logger.error("aiConfig POST /models", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function handle_PUT_ai_config_models(req: Request, res: Response): Promise<void> {
  if (!checkInternalKey(req, res)) return;
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    
    const fields: string[] = [];
    const values: any[] = [];
    let idx = 1;
    const settable = ["model_name", "provider", "input_cost_per_million", "output_cost_per_million", "modality", "context_window_tokens", "max_output_tokens", "auto_update_enabled"];
    for (const field of settable) {
      if (req.body[field] !== undefined) {
        fields.push(`${field} = $${idx++}`);
        values.push(req.body[field]);
      }
    }
    if (fields.length === 0) { res.status(400).json({ error: "No fields to update" }); return; }
    
    fields.push(`updated_at = NOW()`);
    values.push(id);
    
    const rows = await pg.queryP(
      `UPDATE polis_ai_model_pricing SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`,
      values
    );
    if (rows.length === 0) { res.status(404).json({ error: "Model not found" }); return; }
    res.json({ model: rows[0] });
  } catch (err: any) {
    logger.error("aiConfig PUT /models/:id", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function handle_DELETE_ai_config_models(req: Request, res: Response): Promise<void> {
  if (!checkInternalKey(req, res)) return;
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

    // Look up model by ID to get model_name and provider
    const modelRows = await pg.queryP(
      "SELECT model_name, provider FROM polis_ai_model_pricing WHERE id = $1",
      [id]
    );
    if (modelRows.length === 0) {
      res.status(404).json({ error: "Model not found" });
      return;
    }

    const { model_name, provider } = modelRows[0];

    // Check if any use cases reference this model
    const refRows = await pg.queryP(
      `SELECT use_case_key FROM polis_ai_use_case_config
       WHERE (primary_model = $1 AND primary_provider = $2)
          OR (backup_model = $1 AND backup_provider = $2)`,
      [model_name, provider]
    );

    if (refRows.length > 0) {
      const useCases = refRows.map((r: any) => r.use_case_key);
      res.status(409).json({
        error: "Model is referenced by use cases and cannot be deleted",
        use_cases: useCases,
      });
      return;
    }

    // No references — proceed with delete
    await pg.queryP("DELETE FROM polis_ai_model_pricing WHERE id = $1", [id]);
    res.json({ success: true });
  } catch (err: any) {
    logger.error("aiConfig DELETE /models/:id", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// ── Use case config handlers ─────────────────────────────────────────────────

export async function handle_GET_ai_config_use_cases(req: Request, res: Response): Promise<void> {
  if (!checkInternalKey(req, res)) return;
  try {
    const rows = await pg.queryP(
      "SELECT * FROM polis_ai_use_case_config ORDER BY use_case_key"
    );
    res.json({ configs: rows });
  } catch (err: any) {
    logger.error("aiConfig GET /use-cases", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function handle_PUT_ai_config_use_cases(req: Request, res: Response): Promise<void> {
  if (!checkInternalKey(req, res)) return;
  try {
    const { useCaseKey } = req.params;
    const { primary_model, primary_provider, backup_model, backup_provider } = req.body;
    
    if (!primary_model || !primary_provider) {
      res.status(400).json({ error: "primary_model and primary_provider are required" });
      return;
    }
    
    // Validate primary model exists
    const primaryCheck = await pg.queryP(
      "SELECT id FROM polis_ai_model_pricing WHERE model_name = $1 AND provider = $2",
      [primary_model, primary_provider]
    );
    if (primaryCheck.length === 0) {
      res.status(400).json({ error: `Model ${primary_model}/${primary_provider} not found` });
      return;
    }
    
    // Validate backup if provided
    if (backup_model && backup_provider) {
      const backupCheck = await pg.queryP(
        "SELECT id FROM polis_ai_model_pricing WHERE model_name = $1 AND provider = $2",
        [backup_model, backup_provider]
      );
      if (backupCheck.length === 0) {
        res.status(400).json({ error: `Backup model ${backup_model}/${backup_provider} not found` });
        return;
      }
    }
    
    const rows = await pg.queryP(
      `INSERT INTO polis_ai_use_case_config (use_case_key, primary_model, primary_provider, backup_model, backup_provider, modality, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'llm', NOW())
       ON CONFLICT (use_case_key)
       DO UPDATE SET primary_model = $2, primary_provider = $3, backup_model = $4, backup_provider = $5, updated_at = NOW()
       RETURNING *`,
      [useCaseKey, primary_model, primary_provider, backup_model ?? null, backup_provider ?? null]
    );
    
    res.json({ config: rows[0] });
  } catch (err: any) {
    logger.error("aiConfig PUT /use-cases/:useCaseKey", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// ── Model testing endpoint ───────────────────────────────────────────────────

export async function handle_POST_ai_config_models_test(req: Request, res: Response): Promise<void> {
  if (!checkInternalKey(req, res)) return;
  const { model_name, provider } = req.body;
  if (!model_name || !provider) {
    res.status(400).json({ error: "model_name and provider are required" });
    return;
  }

  const startedAt = Date.now();

  try {
    // Call the AI provider with a tiny smoke test
    const result = await callAIProvider(model_name, provider, [
      { role: 'user', content: 'Say "ok" and nothing else.' }
    ], { maxTokens: 16, temperature: 0 });

    const latencyMs = Date.now() - startedAt;

    // Update the DB with success
    await pg.queryP(
      `UPDATE polis_ai_model_pricing
       SET validation_status = 'valid', last_validated_at = NOW(), validation_error = NULL, validation_latency_ms = $1
       WHERE model_name = $2 AND provider = $3`,
      [latencyMs, model_name, provider]
    );

    res.json({
      tested: true,
      model_name,
      provider,
      status: 'valid',
      latency_ms: latencyMs,
      note: `Smoke test passed in ${latencyMs}ms. Response: "${result.content?.substring(0, 50) || 'ok'}"`
    });
  } catch (err: any) {
    const latencyMs = Date.now() - startedAt;
    const errorMsg = err?.message || String(err);

    // Update the DB with failure
    await pg.queryP(
      `UPDATE polis_ai_model_pricing
       SET validation_status = 'invalid', last_validated_at = NOW(), validation_error = $1, validation_latency_ms = $2
       WHERE model_name = $3 AND provider = $4`,
      [errorMsg, latencyMs, model_name, provider]
    ).catch(() => {}); // Don't fail if update fails

    res.status(422).json({
      tested: true,
      model_name,
      provider,
      status: 'invalid',
      latency_ms: latencyMs,
      error: errorMsg,
      note: `Smoke test failed: ${errorMsg}`
    });
  }
}

// ── Pricing aliases CRUD ─────────────────────────────────────────────────────

export async function handle_GET_ai_config_pricing_aliases(req: Request, res: Response): Promise<void> {
  if (!checkInternalKey(req, res)) return;
  try {
    const rows = await pg.queryP(
      "SELECT * FROM polis_ai_pricing_aliases ORDER BY provider, model_name"
    );
    res.json({ aliases: rows });
  } catch (err: any) {
    logger.error("aiConfig GET /pricing-aliases", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function handle_POST_ai_config_pricing_aliases(req: Request, res: Response): Promise<void> {
  if (!checkInternalKey(req, res)) return;
  try {
    const { model_name, provider, aliased_model_name } = req.body;
    if (!model_name || !provider || !aliased_model_name) {
      res.status(400).json({ error: "model_name, provider, and aliased_model_name are required" });
      return;
    }

    const rows = await pg.queryP(
      `INSERT INTO polis_ai_pricing_aliases (model_name, provider, aliased_model_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (model_name, provider)
       DO UPDATE SET aliased_model_name = EXCLUDED.aliased_model_name, updated_at = NOW()
       RETURNING *`,
      [model_name, provider, aliased_model_name]
    );
    res.status(201).json({ alias: rows[0] });
  } catch (err: any) {
    logger.error("aiConfig POST /pricing-aliases", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function handle_DELETE_ai_config_pricing_aliases(req: Request, res: Response): Promise<void> {
  if (!checkInternalKey(req, res)) return;
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const rows = await pg.queryP(
      "DELETE FROM polis_ai_pricing_aliases WHERE id = $1 RETURNING id",
      [id]
    );
    if (rows.length === 0) { res.status(404).json({ error: "Alias not found" }); return; }
    res.json({ success: true });
  } catch (err: any) {
    logger.error("aiConfig DELETE /pricing-aliases/:id", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// ── Model pricing sync endpoint ──────────────────────────────────────────────

export async function handle_POST_ai_config_models_sync_pricing(req: Request, res: Response): Promise<void> {
  if (!checkInternalKey(req, res)) return;
  const { model_name, provider } = req.body;
  if (!model_name || !provider) {
    res.status(400).json({ error: "model_name and provider are required" });
    return;
  }

  try {
    let updated = false;
    let newInputCost: number | null = null;
    let newOutputCost: number | null = null;

    // Try to fetch pricing from Litellm's public registry
    try {
      const url = `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`;
      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        // Try to find the model in Litellm's registry
        // Stage 1: Load aliases from DB
        const dbAliases = await loadPricingAliases();
        const aliasedName = dbAliases[model_name.trim().toLowerCase()];

        let modelKey: string | undefined;

        // Stage 1: exact match on model name
        modelKey = Object.keys(data).find(k => k.toLowerCase() === model_name.toLowerCase());

        // Stage 2: provider-prefixed exact match
        if (!modelKey) {
          modelKey = Object.keys(data).find(k => k.toLowerCase() === `${provider}/${model_name}`.toLowerCase());
        }

        // Stage 3: DB alias lookup
        if (!modelKey && aliasedName) {
          modelKey = Object.keys(data).find(k => k.toLowerCase() === aliasedName.toLowerCase());
        }

        // Stage 4: smart base-name fallback (strip provider prefix from registry keys)
        if (!modelKey) {
          const normalized = model_name.trim().toLowerCase();
          modelKey = Object.keys(data).find(k => {
            const parts = k.split('/').map(p => p.trim()).filter(Boolean);
            const base = (parts.length > 1 ? parts[parts.length - 1] : k).toLowerCase();
            return base === normalized;
          });
        }

        // Stage 5: aliased name base-name fallback
        if (!modelKey && aliasedName) {
          const normalizedAlias = aliasedName.trim().toLowerCase();
          modelKey = Object.keys(data).find(k => {
            const parts = k.split('/').map(p => p.trim()).filter(Boolean);
            const base = (parts.length > 1 ? parts[parts.length - 1] : k).toLowerCase();
            return base === normalizedAlias;
          });
        }
        if (modelKey) {
          const entry = data[modelKey];
          if (entry) {
            // Litellm stores costs per single unit; our DB uses per-1M
            // Priority: image-specific fields first, then token, then character.
            // per-image costs (input_cost_per_image) are stored as-is.
            // per-image-token costs (input_cost_per_image_token) are per-token —
            //   multiply by 1M for DB format (same as regular token costs).
            // Token/character costs are per-unit — multiply by 1M for DB format.
            const inputCost = entry.input_cost_per_image
              ? entry.input_cost_per_image
              : entry.input_cost_per_image_token
                ? entry.input_cost_per_image_token * 1_000_000
                : entry.input_cost_per_token
                  ? entry.input_cost_per_token * 1_000_000
                  : entry.input_cost_per_character
                    ? entry.input_cost_per_character * 1_000_000
                    : null;
            const outputCost = entry.output_cost_per_image
              ? entry.output_cost_per_image
              : entry.output_cost_per_image_token
                ? entry.output_cost_per_image_token * 1_000_000
                : entry.output_cost_per_token
                  ? entry.output_cost_per_token * 1_000_000
                  : entry.output_cost_per_character
                    ? entry.output_cost_per_character * 1_000_000
                    : null;

            // Detect modality and billing unit from the registry entry
            const registryModality = entry.mode === 'image_generation' ? 'img'
              : entry.mode === 'audio_speech' ? 'tts'
              : 'llm';
            const registryBillingUnit = entry.mode === 'image_generation' ? 'image'
              : entry.mode === 'audio_speech' ? 'character'
              : 'token';

            if (inputCost !== null || outputCost !== null) {
              await pg.queryP(
                `UPDATE polis_ai_model_pricing
                 SET input_cost_per_million = COALESCE($1, input_cost_per_million),
                     output_cost_per_million = COALESCE($2, output_cost_per_million),
                     modality = $5,
                     billing_unit = $6,
                     last_pricing_sync_at = NOW(),
                     pricing_sync_error = NULL,
                     auto_update_enabled = true
                 WHERE model_name = $3 AND provider = $4`,
                [inputCost ?? null, outputCost ?? null, model_name, provider, registryModality, registryBillingUnit]
              );
              newInputCost = inputCost;
              newOutputCost = outputCost;
              updated = true;
            }
          }
        }
      }
    } catch (fetchErr: any) {
      logger.warn(`Pricing sync fetch failed for ${model_name}/${provider}: ${fetchErr.message}`);
    }

    if (!updated) {
      // Mark as tried but not found — disable auto_update so UI shows Manual Pricing
      await pg.queryP(
        `UPDATE polis_ai_model_pricing
         SET last_pricing_sync_at = NOW(),
             pricing_sync_error = $1,
             auto_update_enabled = false
         WHERE model_name = $2 AND provider = $3`,
        ['Model not found in Litellm registry. Keeping manual pricing.', model_name, provider]
      );
    }

    // Return updated model
    const rows = await pg.queryP(
      "SELECT * FROM polis_ai_model_pricing WHERE model_name = $1 AND provider = $2 LIMIT 1",
      [model_name, provider]
    );

    res.json({
      model: rows[0],
      synced: updated,
      note: updated
        ? `Pricing synced from Litellm registry. Input: $${newInputCost?.toFixed(4) || 'N/A'}/1M, Output: $${newOutputCost?.toFixed(4) || 'N/A'}/1M`
        : 'Model not found in Litellm registry. Keeping manual pricing.'
    });
  } catch (err: any) {
    logger.error("sync-pricing error", err);
    res.status(500).json({ error: err.message || 'Sync failed' });
  }
}

// ── Providers CRUD ───────────────────────────────────────────────────────────

const VALID_API_MODES = ['openai', 'anthropic', 'gemini'];

export async function handle_GET_ai_config_providers(req: Request, res: Response): Promise<void> {
  if (!checkInternalKey(req, res)) return;
  try {
    const rows = await pg.queryP(
      "SELECT * FROM polis_ai_providers ORDER BY name"
    );
    res.json({ providers: rows });
  } catch (err: any) {
    logger.error("aiConfig GET /providers", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function handle_POST_ai_config_providers(req: Request, res: Response): Promise<void> {
  if (!checkInternalKey(req, res)) return;
  try {
    const { name, display_name, base_url, api_mode, custom_headers, is_active } = req.body;
    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    if (api_mode && !VALID_API_MODES.includes(api_mode)) {
      res.status(400).json({ error: `api_mode must be one of: ${VALID_API_MODES.join(', ')}` });
      return;
    }

    const existing = await pg.queryP(
      "SELECT id FROM polis_ai_providers WHERE name = $1",
      [name]
    );
    if (existing.length > 0) {
      res.status(409).json({ error: "Provider with this name already exists" });
      return;
    }

    const rows = await pg.queryP(
      `INSERT INTO polis_ai_providers (name, display_name, base_url, api_mode, custom_headers, is_active)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [name, display_name ?? null, base_url ?? null, api_mode ?? 'openai',
       JSON.stringify(custom_headers ?? {}), is_active ?? true]
    );
    res.status(201).json({ provider: rows[0] });
  } catch (err: any) {
    logger.error("aiConfig POST /providers", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function handle_PUT_ai_config_providers(req: Request, res: Response): Promise<void> {
  if (!checkInternalKey(req, res)) return;
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

    const fields: string[] = [];
    const values: any[] = [];
    let idx = 1;

    const settable: Record<string, (v: any) => any> = {
      display_name: (v: any) => v,
      base_url: (v: any) => v,
      api_mode: (v: any) => v,
      custom_headers: (v: any) => JSON.stringify(v),
      is_active: (v: any) => v,
    };

    for (const [field, transform] of Object.entries(settable)) {
      if (req.body[field] !== undefined) {
        if (field === 'api_mode' && !VALID_API_MODES.includes(req.body[field])) {
          res.status(400).json({ error: `api_mode must be one of: ${VALID_API_MODES.join(', ')}` });
          return;
        }
        fields.push(`${field} = $${idx++}`);
        values.push(transform(req.body[field]));
      }
    }

    if (fields.length === 0) { res.status(400).json({ error: "No fields to update" }); return; }

    fields.push(`updated_at = NOW()`);
    values.push(id);

    const rows = await pg.queryP(
      `UPDATE polis_ai_providers SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`,
      values
    );
    if (rows.length === 0) { res.status(404).json({ error: "Provider not found" }); return; }
    res.json({ provider: rows[0] });
  } catch (err: any) {
    logger.error("aiConfig PUT /providers/:id", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function handle_DELETE_ai_config_providers(req: Request, res: Response): Promise<void> {
  if (!checkInternalKey(req, res)) return;
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const rows = await pg.queryP("DELETE FROM polis_ai_providers WHERE id = $1 RETURNING id", [id]);
    if (rows.length === 0) { res.status(404).json({ error: "Provider not found" }); return; }
    res.json({ success: true });
  } catch (err: any) {
    logger.error("aiConfig DELETE /providers/:id", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// ── Provider API Keys CRUD ───────────────────────────────────────────────────

function maskApiKey(key: string): string {
  if (!key || key.length <= 8) return '****';
  return key.substring(0, 4) + '...' + key.substring(key.length - 4);
}

export async function handle_GET_ai_config_provider_api_keys(req: Request, res: Response): Promise<void> {
  if (!checkInternalKey(req, res)) return;
  try {
    const rows = await pg.queryP(
      `SELECT id, provider,
              CASE WHEN length(api_key) > 8
                   THEN left(api_key, 4) || '...' || right(api_key, 4)
                   ELSE '****'
              END AS masked_key,
              base_url, is_active, created_at, updated_at
       FROM polis_provider_api_keys
       ORDER BY provider`
    );
    res.json({ keys: rows });
  } catch (err: any) {
    logger.error("aiConfig GET /provider-api-keys", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function handle_POST_ai_config_provider_api_keys(req: Request, res: Response): Promise<void> {
  if (!checkInternalKey(req, res)) return;
  try {
    const rawProvider = req.body.provider;
    const provider = typeof rawProvider === 'string' ? rawProvider.toLowerCase().trim() : rawProvider;
    const { api_key, base_url } = req.body;
    if (!provider || !api_key) {
      res.status(400).json({ error: "provider and api_key are required" });
      return;
    }

    const encryptedKey = encrypt(api_key.trim());
    const rows = await pg.queryP(
      `INSERT INTO polis_provider_api_keys (provider, api_key, base_url)
       VALUES ($1, $2, $3)
       ON CONFLICT (provider)
       DO UPDATE SET api_key = EXCLUDED.api_key, base_url = EXCLUDED.base_url, updated_at = NOW()
       RETURNING id, provider, api_key, base_url, is_active, created_at, updated_at`,
      [provider, encryptedKey, base_url ?? null]
    );
    const result = rows[0];
    result.api_key = maskApiKey(result.api_key);
    res.status(201).json({ key: result });
  } catch (err: any) {
    logger.error("aiConfig POST /provider-api-keys", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function handle_DELETE_ai_config_provider_api_keys(req: Request, res: Response): Promise<void> {
  if (!checkInternalKey(req, res)) return;
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    // Soft-delete: deactivate rather than hard-delete to preserve referential integrity
    const rows = await pg.queryP(
      "UPDATE polis_provider_api_keys SET is_active = false, updated_at = NOW() WHERE id = $1 RETURNING id",
      [id]
    );
    if (rows.length === 0) { res.status(404).json({ error: "API key not found" }); return; }
    res.json({ success: true });
  } catch (err: any) {
    logger.error("aiConfig DELETE /provider-api-keys/:id", err);
    res.status(500).json({ error: "Internal server error" });
  }
}
