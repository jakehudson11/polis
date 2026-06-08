import { Request, Response } from "express";
import Config from "../config";
import pg from "../db/pg-query";
import logger from "../utils/logger";
import { callAIProvider } from "../utils/aiModelRouter";

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
    const { model_name, provider, input_cost_per_million, output_cost_per_million, modality, context_window_tokens, max_output_tokens } = req.body;
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
      `INSERT INTO polis_ai_model_pricing (model_name, provider, input_cost_per_million, output_cost_per_million, modality, context_window_tokens, max_output_tokens)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [model_name, provider, input_cost_per_million ?? 0, output_cost_per_million ?? 0, modality ?? "llm", context_window_tokens ?? null, max_output_tokens ?? null]
    );
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
    const settable = ["model_name", "provider", "input_cost_per_million", "output_cost_per_million", "modality", "context_window_tokens", "max_output_tokens"];
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
    const rows = await pg.queryP("DELETE FROM polis_ai_model_pricing WHERE id = $1 RETURNING id", [id]);
    if (rows.length === 0) { res.status(404).json({ error: "Model not found" }); return; }
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
      // Mark as tried but not found
      await pg.queryP(
        `UPDATE polis_ai_model_pricing
         SET last_pricing_sync_at = NOW(), pricing_sync_error = $1
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
