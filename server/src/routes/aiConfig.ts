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
      const modelKey = (row.model_name || '').trim().toLowerCase();
      const providerKey = (row.provider || '').trim().toLowerCase();
      const compositeKey = `${modelKey}|${providerKey}`;
      const name = row.aliased_model_name?.trim();
      if (modelKey && name) {
        aliases[compositeKey] = name;
        // Also set bare model_name key as fallback for backwards compat
        if (!aliases[modelKey]) {
          aliases[modelKey] = name;
        }
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

/**
 * Resolves pricing for a model from the Litellm public registry.
 * Mirrors the lookup logic in handle_POST_ai_config_models_sync_pricing.
 * Returns { inputCost, outputCost, modality, billingUnit } or null if not found.
 */
async function resolvePricingFromRegistry(
  model_name: string,
  provider: string
): Promise<{ inputCost: number; outputCost: number; modality: string; billingUnit: string } | null> {
  try {
    const url = `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();

    // Load aliases
    const dbAliases = await loadPricingAliases();
    const providerCompositeKey = `${model_name.trim().toLowerCase()}|${(provider || '').trim().toLowerCase()}`;
    const bareModelKey = model_name.trim().toLowerCase();
    const aliasedName = dbAliases[providerCompositeKey] ?? dbAliases[bareModelKey];

    // Determine the name to search for
    const searchName = aliasedName ? aliasedName.trim().toLowerCase() : model_name.trim().toLowerCase();

    let modelKey: string | undefined;

    // Stage 1: exact match
    modelKey = Object.keys(data).find(k => k.toLowerCase() === searchName);

    // Stage 2: provider-prefixed exact match
    if (!modelKey) {
      modelKey = Object.keys(data).find(k => k.toLowerCase() === `${provider}/${searchName}`.toLowerCase());
    }

    // Stage 3: base-name fallback
    if (!modelKey) {
      modelKey = Object.keys(data).find(k => {
        const parts = k.split('/').map((p: string) => p.trim()).filter(Boolean);
        const base = (parts.length > 1 ? parts[parts.length - 1] : k).toLowerCase();
        return base === searchName;
      });
    }

    if (!modelKey) return null;

    const entry = data[modelKey];
    if (!entry) return null;

    // Pricing: image > character > token
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

    // Detect modality and billing unit
    const registryModality = entry.mode === 'image_generation' ? 'img'
      : entry.mode === 'audio_speech' ? 'tts'
      : 'llm';
    const registryBillingUnit = entry.mode === 'image_generation' ? 'image'
      : entry.mode === 'audio_speech' ? 'character'
      : 'token';

    return {
      inputCost: inputCost ?? 0,
      outputCost: outputCost ?? 0,
      modality: registryModality,
      billingUnit: registryBillingUnit,
    };
  } catch {
    return null;
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
    const { primary_model, primary_provider, backup_model, backup_provider, fallback_model, fallback_provider } = req.body;
    
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
    
    // Validate fallback if provided
    if (fallback_model && fallback_provider) {
      const fallbackCheck = await pg.queryP(
        "SELECT id FROM polis_ai_model_pricing WHERE model_name = $1 AND provider = $2",
        [fallback_model, fallback_provider]
      );
      if (fallbackCheck.length === 0) {
        res.status(400).json({ error: `Fallback model ${fallback_model}/${fallback_provider} not found` });
        return;
      }
    }
    
    const rows = await pg.queryP(
      `INSERT INTO polis_ai_use_case_config (use_case_key, primary_model, primary_provider, backup_model, backup_provider, fallback_model, fallback_provider, modality, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'llm', NOW())
       ON CONFLICT (use_case_key)
       DO UPDATE SET primary_model = $2, primary_provider = $3, backup_model = $4, backup_provider = $5, fallback_model = $6, fallback_provider = $7, updated_at = NOW()
       RETURNING *`,
      [useCaseKey, primary_model, primary_provider, backup_model ?? null, backup_provider ?? null, fallback_model ?? null, fallback_provider ?? null]
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
        const providerCompositeKey = `${model_name.trim().toLowerCase()}|${(provider || '').trim().toLowerCase()}`;
        const bareModelKey = model_name.trim().toLowerCase();
        const aliasedName = dbAliases[providerCompositeKey] ?? dbAliases[bareModelKey];

        let modelKey: string | undefined;

        if (aliasedName) {
          // Alias is set — search ONLY the aliased name, never the original
          const normalizedAlias = aliasedName.trim().toLowerCase();

          // Stage A1: exact match on aliased model name
          modelKey = Object.keys(data).find(k => k.toLowerCase() === normalizedAlias);

          // Stage A2: provider-prefixed exact match on aliased model name
          if (!modelKey) {
            modelKey = Object.keys(data).find(k => k.toLowerCase() === `${provider}/${normalizedAlias}`.toLowerCase());
          }

          // Stage A3: base-name fallback for aliased model name
          if (!modelKey) {
            modelKey = Object.keys(data).find(k => {
              const parts = k.split('/').map(p => p.trim()).filter(Boolean);
              const base = (parts.length > 1 ? parts[parts.length - 1] : k).toLowerCase();
              return base === normalizedAlias;
            });
          }

          // If alias set but aliased model not found — set error and return candidates
          if (!modelKey) {
            // Gather candidate registry keys: all keys whose base name starts with the alias
            // or whose provider prefix matches the alias (like Agora's aliasCandidates)
            const candidateKeys: string[] = [];
            const normalizedAlias2 = aliasedName.trim().toLowerCase();
            
            // Candidate set 1: keys whose base name contains the alias
            for (const k of Object.keys(data)) {
              const parts = k.split('/').map(p => p.trim()).filter(Boolean);
              const base = (parts.length > 1 ? parts[parts.length - 1] : k).toLowerCase();
              if (base.includes(normalizedAlias2) && !candidateKeys.includes(k)) {
                candidateKeys.push(k);
              }
            }
            
            // Candidate set 2: keys where the provider prefix matches the alias
            const prefix = normalizedAlias2 + '/';
            for (const k of Object.keys(data)) {
              if (k.toLowerCase().startsWith(prefix) && !candidateKeys.includes(k)) {
                candidateKeys.push(k);
              }
            }
            
            // Sort: shorter keys first (more generic models), then alphabetical
            candidateKeys.sort((a, b) => a.length - b.length || a.localeCompare(b));
            
            await pg.queryP(
              `UPDATE polis_ai_model_pricing
               SET last_pricing_sync_at = NOW(),
                   pricing_sync_error = $1,
                   auto_update_enabled = false
               WHERE model_name = $2 AND provider = $3`,
              [`Alias set but aliased model "${aliasedName}" not found in Litellm registry.`, model_name, provider]
            );
            const rows = await pg.queryP(
              "SELECT * FROM polis_ai_model_pricing WHERE model_name = $1 AND provider = $2 LIMIT 1",
              [model_name, provider]
            );
            res.json({
              model: rows[0],
              synced: false,
              note: `Alias set but aliased model "${aliasedName}" not found in Litellm registry. Keeping manual pricing.`,
              registryCandidates: candidateKeys.slice(0, 20) // Max 20 candidates
            });
            return;
          }
        } else {
          // No alias — search original model name
          const normalized = model_name.trim().toLowerCase();

          // Stage B1: exact match on model name
          modelKey = Object.keys(data).find(k => k.toLowerCase() === normalized);

          // Stage B2: provider-prefixed exact match
          if (!modelKey) {
            modelKey = Object.keys(data).find(k => k.toLowerCase() === `${provider}/${normalized}`.toLowerCase());
          }

          // Stage B3: base-name fallback
          if (!modelKey) {
            modelKey = Object.keys(data).find(k => {
              const parts = k.split('/').map(p => p.trim()).filter(Boolean);
              const base = (parts.length > 1 ? parts[parts.length - 1] : k).toLowerCase();
              return base === normalized;
            });
          }
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

// ── Model pricing resolve endpoint ───────────────────────────────────────────

export async function handle_POST_ai_config_models_resolve_pricing(req: Request, res: Response): Promise<void> {
  if (!checkInternalKey(req, res)) return;
  const { model_name, provider } = req.body;
  if (!model_name || !provider) {
    res.status(400).json({ error: "model_name and provider are required" });
    return;
  }

  try {
    // Load aliases from DB (composite-key aware)
    const dbAliases = await loadPricingAliases();
    const providerCompositeKey = `${model_name.trim().toLowerCase()}|${(provider || '').trim().toLowerCase()}`;
    const bareModelKey = model_name.trim().toLowerCase();
    const aliasedName = dbAliases[providerCompositeKey] ?? dbAliases[bareModelKey];

    // Fetch Litellm registry
    const url = `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`;
    const response = await fetch(url);
    if (!response.ok) {
      res.status(502).json({ error: "Failed to fetch Litellm registry" });
      return;
    }
    const data = await response.json();
    const allKeys = Object.keys(data);

    // Determine the search name (aliased or original)
    const searchName = aliasedName ? aliasedName.trim().toLowerCase() : model_name.trim().toLowerCase();
    const normalizedSearch = searchName;
    const normalizedProvider = (provider || '').trim().toLowerCase();

    let modelKey: string | undefined;
    let matchType = 'not_found';
    const aliasCandidates: string[] = [];
    const fuzzyEntries: any[] = [];
    let foundEntry: any = null;

    // Stage 1: exact match on search name
    modelKey = allKeys.find(k => k.toLowerCase() === normalizedSearch);
    if (modelKey) matchType = 'exact';

    // Stage 2: provider-prefixed exact match
    if (!modelKey) {
      modelKey = allKeys.find(k => k.toLowerCase() === `${normalizedProvider}/${normalizedSearch}`);
      if (modelKey) matchType = 'exact';
    }

    // Stage 3: base-name fallback (strip provider prefix from registry keys)
    if (!modelKey) {
      modelKey = allKeys.find(k => {
        const parts = k.split('/').map(p => p.trim()).filter(Boolean);
        const base = (parts.length > 1 ? parts[parts.length - 1] : k).toLowerCase();
        return base === normalizedSearch;
      });
      if (modelKey) matchType = 'provider_model_alias';
    }

    // Build aliasCandidates and fuzzyEntries (like Agora does)
    // Gather all registry keys whose base name contains the search name
    const candidateSeen = new Set<string>();
    for (const k of allKeys) {
      const lower = k.toLowerCase();
      const parts = k.split('/').map(p => p.trim()).filter(Boolean);
      const base = (parts.length > 1 ? parts[parts.length - 1] : k).toLowerCase();
      
      // Alias candidate: base name matches or contains the search name
      if ((base === normalizedSearch || base.includes(normalizedSearch) || lower.includes(normalizedSearch)) && !candidateSeen.has(k)) {
        candidateSeen.add(k);
        aliasCandidates.push(k);
      }

      // Fuzzy entry: same logic for richer data
      if ((base === normalizedSearch || base.includes(normalizedSearch)) && !fuzzyEntries.some(e => e.sourceModelName === k)) {
        const entry = data[k];
        if (entry) {
          fuzzyEntries.push({
            sourceModelName: k,
            provider: entry.litellm_provider || provider,
            inputCostPerMillion: entry.input_cost_per_token ? entry.input_cost_per_token * 1_000_000 : null,
            outputCostPerMillion: entry.output_cost_per_token ? entry.output_cost_per_token * 1_000_000 : null,
            currency: 'USD',
            mode: entry.mode || null,
            inputBillingUnit: entry.mode === 'image_generation' ? 'image' : 'token',
            outputBillingUnit: entry.mode === 'image_generation' ? 'image' : 'token',
          });
        }
      }
    }

    // Also add provider-prefix candidates (keys starting with searchName/)
    const prefix = normalizedSearch + '/';
    for (const k of allKeys) {
      if (k.toLowerCase().startsWith(prefix) && !candidateSeen.has(k)) {
        candidateSeen.add(k);
        aliasCandidates.push(k);
        const entry = data[k];
        if (entry && !fuzzyEntries.some(e => e.sourceModelName === k)) {
          fuzzyEntries.push({
            sourceModelName: k,
            provider: entry.litellm_provider || provider,
            inputCostPerMillion: entry.input_cost_per_token ? entry.input_cost_per_token * 1_000_000 : null,
            outputCostPerMillion: entry.output_cost_per_token ? entry.output_cost_per_token * 1_000_000 : null,
            currency: 'USD',
            mode: entry.mode || null,
            inputBillingUnit: entry.mode === 'image_generation' ? 'image' : 'token',
            outputBillingUnit: entry.mode === 'image_generation' ? 'image' : 'token',
          });
        }
      }
    }

    // Sort candidates: shorter keys first (more generic), then alphabetical
    aliasCandidates.sort((a, b) => a.length - b.length || a.localeCompare(b));
    fuzzyEntries.sort((a, b) => a.sourceModelName.length - b.sourceModelName.length || a.sourceModelName.localeCompare(b.sourceModelName));

    if (modelKey) {
      foundEntry = data[modelKey];
    }

    res.json({
      ok: !!modelKey,
      resolution: {
        found: !!modelKey,
        requestedModelName: model_name,
        requestedProvider: provider,
        matchType: matchType,
        sourceModelName: modelKey || null,
        provider: foundEntry?.litellm_provider || provider,
        inputCostPerMillion: foundEntry?.input_cost_per_token ? foundEntry.input_cost_per_token * 1_000_000 : null,
        outputCostPerMillion: foundEntry?.output_cost_per_token ? foundEntry.output_cost_per_token * 1_000_000 : null,
        currency: 'USD',
        contextWindowTokens: foundEntry?.max_input_tokens || null,
        maxInputTokens: foundEntry?.max_input_tokens || null,
        maxOutputTokens: foundEntry?.max_output_tokens || null,
        tokenMetadata: {},
        mode: foundEntry?.mode || null,
        inputBillingUnit: foundEntry?.mode === 'image_generation' ? 'image' : 'token',
        outputBillingUnit: foundEntry?.mode === 'image_generation' ? 'image' : 'token',
        aliasCandidates: aliasCandidates.slice(0, 30),
        fuzzyEntries: fuzzyEntries.slice(0, 30),
        errors: modelKey ? [] : [{
          code: 'pricing_not_found',
          message: aliasedName 
            ? `No registry pricing found for aliased model "${aliasedName}". Alias: ${model_name} → ${aliasedName}.`
            : `No registry pricing found for "${model_name}" (${provider}).`
        }],
      }
    });
  } catch (err: any) {
    logger.error("aiConfig POST /models/resolve-pricing", err);
    res.status(500).json({ error: "Internal server error" });
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
