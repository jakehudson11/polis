/**
 * Google Vertex AI plumbing.
 *
 * Shared foundation for calling Vertex AI (`aiplatform.googleapis.com`,
 * service-account / ADC OAuth) instead of the Gemini Developer API
 * (`generativelanguage.googleapis.com`, API-key auth). It provides:
 *
 *  - credential / project / location resolution
 *  - the cached `@google/genai` client in Vertex mode
 *  - OAuth bearer-token minting for raw REST call sites
 *  - an endpoint URL builder for `generateContent`
 *
 * Nothing here rewires an existing call site by itself: the API-key path in
 * utils/aiClients.ts is untouched and callers opt in via isGoogleVertexEnabled().
 *
 * Verified SDK facts this module depends on (installed locally):
 *  - `@google/genai` 1.8.0 `GoogleGenAIOptions` has `vertexai`, `project`,
 *    `location`, `apiKey`, `apiVersion` and `httpOptions`. It has NO
 *    `enterprise` flag (that is 2.7.0+), so this module uses `vertexai: true`,
 *    which both 1.8.0 and 2.7.0 accept.
 *  - The SDK THROWS when `project`/`location` and `apiKey` are both supplied
 *    explicitly ('Project/location and API key are mutually exclusive in the
 *    client initializer.'), so this module never passes an API key.
 *  - Vertex base URL selection: `global` uses the bare
 *    `https://aiplatform.googleapis.com` host; the multi-regional locations
 *    `us`/`eu` use `https://aiplatform.{location}.rep.googleapis.com`;
 *    anything else uses `https://{location}-aiplatform.googleapis.com`.
 *  - `google-auth-library` 9.15.1 must be constructed WITH the cloud-platform
 *    scope: a client created without scopes fails token minting with
 *    `invalid_scope`. `getClient()` takes no arguments in this version.
 *
 * LOCAL TYPING CONSTRAINT: this project ships a hand-written ambient stub at
 * types/google-genai.d.ts whose `GoogleGenAI` constructor only accepts
 * `{ apiKey?: string }`. That stub is narrower than the real installed SDK
 * (dist/node/node.d.ts declares `vertexai`, `project`, `location`), and because
 * tsconfig.json uses `moduleResolution: "node"` the stub is what the compiler
 * checks against. The single `as unknown as` cast in getGoogleGenAIClient()
 * bridges that gap; the runtime entry point (@google/genai -> dist/node/index.cjs)
 * accepts these options natively.
 */

import { existsSync, readFileSync } from 'fs';
import { GoogleAuth } from 'google-auth-library';
import { GoogleGenAI } from '@google/genai';

const LOG_PREFIX = '[aiGoogleVertex]';

/** Scope required by aiplatform.googleapis.com. */
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/**
 * Container path the compose files hardcode for the Google service-account JSON.
 * Only used as a last resort, and only when the file actually exists on disk, so
 * local dev without GOOGLE_APPLICATION_CREDENTIALS still falls through to ADC.
 */
const DEFAULT_CONTAINER_CREDENTIAL_PATH = '/run/secrets/google-tts-service-account.json';

/** Location served by the bare (region-prefix-free) aiplatform host. */
const GLOBAL_LOCATION = 'global';

/** Multi-regional locations use the rep.googleapis.com host (mirrors the SDK's
 *  own MULTI_REGIONAL_LOCATIONS set). */
const MULTI_REGIONAL_LOCATIONS: ReadonlySet<string> = new Set(['us', 'eu']);

/**
 * REST version for the raw generateContent call sites. generateContent is GA on
 * both v1 and v1beta1 (the SDK itself defaults to v1beta1 for Vertex); callers
 * can override per call via the `opts.apiVersion` argument.
 */
const GENERATE_CONTENT_API_VERSION = 'v1';

/** Minimal structural view of google-auth-library's AuthClient, declared
 *  locally so this module does not depend on the library's union internals. */
interface VertexAuthClient {
  getAccessToken(): Promise<{ token?: string | null }>;
}

/**
 * Vertex-mode options passed to the `@google/genai` constructor. Declared
 * explicitly (rather than inlined) so the intent stays readable and the
 * cast in getGoogleGenAIClient() is the only place that touches the stub.
 */
interface VertexGenAIClientOptions {
  vertexai: true;
  project: string;
  location: string;
}

/** Cached `@google/genai` Vertex client (stateless once constructed). */
let vertexGenAIClient: GoogleGenAI | null = null;

/** Cached AuthClient promise. Only successful construction is cached, so a
 *  failed credential resolution is retried on the next call. */
let vertexAuthClientPromise: Promise<VertexAuthClient> | null = null;

/** `project_id` read out of the service-account JSON. `undefined` = not read
 *  yet, `null` = read and unavailable. */
let credentialProjectId: string | null | undefined;

/**
 * True when Vertex AI is the intended Google path for this process.
 *
 * Opt-in via `GOOGLE_VERTEX_ENABLED=true` (also accepts `1` / `yes`). Polis
 * currently talks to Google through the API-key path in utils/aiClients.ts, so
 * the default here is OFF: enabling Vertex is an explicit operator decision and
 * nothing changes behaviour until it is set.
 */
export function isGoogleVertexEnabled(): boolean {
  return readBooleanEnv('GOOGLE_VERTEX_ENABLED') === true;
}

/**
 * Resolved GCP project id, in precedence order:
 *  1. `GOOGLE_VERTEX_PROJECT` (explicit operator override, normally unset)
 *  2. `project_id` inside the service-account JSON
 *  3. `GOOGLE_CLOUD_PROJECT`
 *
 * Steps 2 then 3 mirror Agora's services/stt/googleSttProvider.ts: the
 * credentials determine which project is actually reachable, with the env var
 * as fallback.
 */
export function getGoogleVertexProject(): string | undefined {
  const explicit = readEnv('GOOGLE_VERTEX_PROJECT');
  if (explicit) return explicit;

  const fromCredentials = readProjectIdFromCredentialFile();
  if (fromCredentials) return fromCredentials;

  return readEnv('GOOGLE_CLOUD_PROJECT');
}

/**
 * Resolved location, in precedence order:
 *  1. `GOOGLE_VERTEX_LOCATION`
 *  2. `GOOGLE_CLOUD_LOCATION`
 *  3. `global` (the bare aiplatform host, and the only location that also
 *     serves cross-region model endpoints such as Deep Research)
 */
export function getGoogleVertexLocation(): string {
  return readEnv('GOOGLE_VERTEX_LOCATION') ?? readEnv('GOOGLE_CLOUD_LOCATION') ?? GLOBAL_LOCATION;
}

/**
 * Resolved service-account JSON path, in precedence order:
 *  1. `GOOGLE_VERTEX_CREDENTIALS_FILE` (explicit override)
 *  2. `GOOGLE_APPLICATION_CREDENTIALS` (the standard ADC pointer)
 *  3. the compose-hardcoded container path, when that file exists
 *
 * `undefined` means "no file". Credentials themselves are resolved by ADC
 * (google-auth-library reads GOOGLE_APPLICATION_CREDENTIALS, the GCE metadata
 * server, or a workload identity federation config automatically); this
 * function reports which file the operator pointed at, and is also what lets
 * project resolution read `project_id` without an env var.
 */
export function getGoogleVertexCredentialPath(): string | undefined {
  const explicit = readEnv('GOOGLE_VERTEX_CREDENTIALS_FILE');
  if (explicit) return explicit;

  const fromAdcEnv = readEnv('GOOGLE_APPLICATION_CREDENTIALS');
  if (fromAdcEnv) return fromAdcEnv;

  if (existsSync(DEFAULT_CONTAINER_CREDENTIAL_PATH)) return DEFAULT_CONTAINER_CREDENTIAL_PATH;

  return undefined;
}

/**
 * Shared `@google/genai` client in Vertex mode.
 *
 * project/location are passed EXPLICITLY rather than relying on the SDK's
 * `GOOGLE_GENAI_USE_*` env flags: a stray global flag would silently flip other
 * `{ apiKey }` clients into express mode. No API key is ever passed -- the SDK
 * rejects `project`/`location` combined with an explicit `apiKey`.
 *
 * A failed construction is not cached, so the next call retries.
 */
export function getGoogleGenAIClient(): GoogleGenAI {
  if (!vertexGenAIClient) {
    const project = requireGoogleVertexProject();
    const location = getGoogleVertexLocation();

    // `vertexai: true` is the option both @google/genai 1.8.0 and 2.7.0 accept
    // (2.7.0's `enterprise` alias does not exist in 1.8.0). See the LOCAL TYPING
    // CONSTRAINT note in the file header for why this cast is required.
    const vertexOptions: VertexGenAIClientOptions = { vertexai: true, project, location };
    vertexGenAIClient = new GoogleGenAI(
      vertexOptions as unknown as ConstructorParameters<typeof GoogleGenAI>[0],
    );

    console.info(
      `${LOG_PREFIX} Vertex client initialised (project=${project}, location=${location})`,
    );
  }

  return vertexGenAIClient;
}

/**
 * Mints (or reuses) an OAuth bearer token for aiplatform.googleapis.com.
 *
 * The underlying AuthClient caches its credentials and refreshes eagerly once
 * the token is within its expiry threshold, so repeated calls are cheap and a
 * long-lived process keeps a valid token without any extra bookkeeping here.
 */
export async function getGoogleVertexAccessToken(): Promise<string> {
  const client = await getVertexAuthClient();
  const response = await client.getAccessToken();
  const token = response?.token;

  if (!token) {
    throw new Error(
      'Google Vertex AI auth returned no access token. Check GOOGLE_APPLICATION_CREDENTIALS ' +
      '(or the container-mounted service-account JSON) and that the service account has ' +
      'roles/aiplatform.user.',
    );
  }

  return token;
}

/** `Authorization` header for raw REST calls against aiplatform.googleapis.com. */
export async function getGoogleVertexAuthHeaders(): Promise<Record<string, string>> {
  const token = await getGoogleVertexAccessToken();
  return { Authorization: `Bearer ${token}` };
}

/**
 * Config-presence probe: Vertex is switched on AND a GCP project can be
 * resolved. This is deliberately NOT a live credential test -- use
 * getGoogleVertexAccessToken() when you need to prove auth actually works.
 */
export function isGoogleVertexConfigured(): boolean {
  if (!isGoogleVertexEnabled()) return false;
  return Boolean(getGoogleVertexProject());
}

/**
 * Full URL for a Vertex `generateContent` call:
 * `https://aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent`
 *
 * Accepts a bare model id (`gemini-2.5-pro`), a `<publisher>/<model>` shorthand
 * (`google/gemini-2.5-pro`), a partial resource name (`publishers/google/models/...`)
 * or a fully-qualified `projects/...` resource name.
 */
export function buildVertexGenerateContentUrl(model: string, opts?: { apiVersion?: string }): string {
  const project = requireGoogleVertexProject();
  const location = getGoogleVertexLocation();
  const apiVersion = opts?.apiVersion ?? GENERATE_CONTENT_API_VERSION;
  const modelPath = normalizeGoogleModelPath(model, project, location);

  return `${resolveVertexHost(location)}/${apiVersion}/${modelPath}:generateContent`;
}

/** Vertex host for a location: bare host for `global`, the `rep` host for the
 *  multi-regional locations, and a region-prefixed host otherwise. */
function resolveVertexHost(location: string): string {
  if (!location || location === GLOBAL_LOCATION) return 'https://aiplatform.googleapis.com';
  if (MULTI_REGIONAL_LOCATIONS.has(location)) return `https://aiplatform.${location}.rep.googleapis.com`;
  return `https://${location}-aiplatform.googleapis.com`;
}

/** Expands a model argument into a `projects/.../locations/...` resource path. */
function normalizeGoogleModelPath(model: string, project: string, location: string): string {
  const trimmed = model.trim();

  // Already fully qualified -- pass through untouched (the caller owns it).
  if (trimmed.startsWith('projects/')) return trimmed;

  // Partial resource name, publisher downwards.
  if (trimmed.startsWith('publishers/')) {
    return `projects/${project}/locations/${location}/${trimmed}`;
  }

  // `<publisher>/<model>` shorthand.
  const slashIndex = trimmed.indexOf('/');
  if (slashIndex > 0) {
    const publisher = trimmed.slice(0, slashIndex);
    const modelId = trimmed.slice(slashIndex + 1);
    return `projects/${project}/locations/${location}/publishers/${publisher}/models/${modelId}`;
  }

  // Bare model id -- the Google publisher is the default.
  return `projects/${project}/locations/${location}/publishers/google/models/${trimmed}`;
}

/** Project id for URL builders, or a fail-fast error naming the fix. */
function requireGoogleVertexProject(): string {
  const project = getGoogleVertexProject();
  if (!project) {
    throw new Error(
      'Google Vertex AI is enabled but no GCP project id could be resolved. Set GOOGLE_CLOUD_PROJECT ' +
      '(or GOOGLE_VERTEX_PROJECT), or point GOOGLE_APPLICATION_CREDENTIALS at a service-account JSON ' +
      'that contains project_id.',
    );
  }
  return project;
}

/** AuthClient for the service account / ADC, constructed once per process. */
function getVertexAuthClient(): Promise<VertexAuthClient> {
  if (!vertexAuthClientPromise) {
    vertexAuthClientPromise = createVertexAuthClient().catch((error) => {
      // Do not cache a failed construction -- the next call retries.
      vertexAuthClientPromise = null;
      throw error;
    });
  }
  return vertexAuthClientPromise;
}

async function createVertexAuthClient(): Promise<VertexAuthClient> {
  // No keyFilename / projectId here on purpose: the path resolved by
  // getGoogleVertexCredentialPath() is normally GOOGLE_APPLICATION_CREDENTIALS
  // itself, which google-auth-library picks up through ADC. The scope MUST be
  // set on the constructor -- omitting it fails token minting with
  // `invalid_scope`.
  const auth = new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] });
  return (await auth.getClient()) as unknown as VertexAuthClient;
}

/** `project_id` from the service-account JSON, cached for the process lifetime. */
function readProjectIdFromCredentialFile(): string | null {
  if (credentialProjectId !== undefined) return credentialProjectId;

  const credentialPath = getGoogleVertexCredentialPath();
  if (!credentialPath) {
    credentialProjectId = null;
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(credentialPath, 'utf-8')) as { project_id?: unknown };
    const projectId =
      typeof parsed.project_id === 'string' && parsed.project_id.trim() ? parsed.project_id.trim() : null;
    credentialProjectId = projectId;
    return projectId;
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} Could not read project_id from ${credentialPath}: ${(error as Error).message}`,
    );
    credentialProjectId = null;
    return null;
  }
}

/** Trimmed env var, or `undefined` when unset/blank. */
function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/** Tri-state boolean env parse: `true`/`1`/`yes` -> true, `false`/`0`/`no` ->
 *  false, anything else (including unset) -> undefined. */
function readBooleanEnv(name: string): boolean | undefined {
  const value = readEnv(name)?.toLowerCase();
  if (value === undefined) return undefined;
  if (value === 'true' || value === '1' || value === 'yes') return true;
  if (value === 'false' || value === '0' || value === 'no') return false;
  return undefined;
}
