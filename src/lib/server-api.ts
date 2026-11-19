/**
 * Talk to the self-hosted `server/` inference API (FastAPI + BiRefNet).
 *
 * Why this exists: the browser engine tops out around 366 MB of weights and a
 * laptop GPU. The local server runs full BiRefNet (972 MB, MIT) on the user's
 * own machine — still no paid API, still nothing uploaded to a third party.
 * It is opt-in: pick an `api/…` model in the dropdown and the app needs a
 * server on 127.0.0.1:8000 (see `server/README.md`).
 *
 * No keys. There is nothing to keep secret — the server is yours.
 */

export const SERVER_PREFIX = 'api/';
export const SERVER_URL_KEY = 'unbg.api.url';
export const DEFAULT_SERVER_URL = 'http://127.0.0.1:8000';

/** Model ids served by the local box, mirrored from server/unbg_server/engines. */
export const SERVER_MODEL_IDS = [
  'api/birefnet-portrait',
  'api/birefnet-general',
  'api/birefnet-lite',
  'api/u2netp',
] as const;

export type ServerModelId = (typeof SERVER_MODEL_IDS)[number];

export interface ServerMeta {
  model: string;
  model_label?: string;
  license?: string;
  width: number;
  height: number;
  coverage?: number;
  background?: string;
  timings?: Record<string, unknown>;
}

export interface ServerResult {
  blob: Blob;
  meta: ServerMeta;
  ms: number;
}

export interface ServerOptions {
  background?: string;
  matte?: boolean;
  detail?: 'normal' | 'high';
  subject?: 'auto' | 'person' | 'object';
  signal?: AbortSignal;
}

export class ServerError extends Error {
  constructor(
    message: string,
    readonly code: string = 'server_error',
    readonly status = 0,
  ) {
    super(message);
    this.name = 'ServerError';
  }
}

export function isServerModel(id: string): boolean {
  return id.startsWith(SERVER_PREFIX);
}

/** `api/birefnet-portrait` → `birefnet-portrait` */
export function serverModelId(id: string): string {
  return isServerModel(id) ? id.slice(SERVER_PREFIX.length) : id;
}

export function serverBase(override?: string): string {
  let stored = override ?? '';
  if (!stored && typeof localStorage !== 'undefined') {
    stored = localStorage.getItem(SERVER_URL_KEY) ?? '';
  }
  const base = (stored || DEFAULT_SERVER_URL).trim();
  return base.replace(/\/+$/, '');
}

export function saveServerUrl(url: string): void {
  if (typeof localStorage === 'undefined') return;
  const trimmed = url.trim();
  if (trimmed) localStorage.setItem(SERVER_URL_KEY, trimmed.replace(/\/+$/, ''));
  else localStorage.removeItem(SERVER_URL_KEY);
}

/** Build the /api/remove URL. Pure, so it can be unit-tested. */
export function removeUrl(modelId: string, options: ServerOptions = {}, base = DEFAULT_SERVER_URL): string {
  const params = new URLSearchParams({ model: serverModelId(modelId) });
  params.set('background', options.background ?? 'transparent');
  params.set('matte', String(options.matte ?? true));
  params.set('detail', options.detail ?? 'normal');
  params.set('subject', options.subject ?? 'auto');
  return `${base.replace(/\/+$/, '')}/api/remove?${params.toString()}`;
}

/** Turn a failed response body into something a person can act on. */
export function describeServerError(status: number, body: unknown): ServerError {
  const payload = (body ?? {}) as { error?: string; message?: string; detail?: unknown };
  const code = payload.error ?? `http_${status}`;
  const detail =
    payload.message ??
    (typeof payload.detail === 'string' ? payload.detail : '') ??
    '';
  const messages: Record<string, string> = {
    unknown_model: 'Server par ye model registered nahi hai — /api/models dekho.',
    model_unavailable:
      'Model download nahi hua. Server par chalाओ: python scripts/fetch_models.py birefnet-portrait',
    unsupported_media: 'Server sirf JPG, PNG ya WEBP leta hai.',
    too_large: 'File server ki limit se badi hai (default 20 MB).',
    unreadable_image: 'Image server par khul nahi paayi — file kharab lagti hai.',
    result_expired: 'Result expire ho gaya — dobara chalao.',
    bad_background: 'Background colour samajh nahi aaya — transparent, white ya #rrggbb do.',
  };
  return new ServerError(
    messages[code] ?? (detail || `Server ne ${status} lauta diya.`),
    code,
    status,
  );
}

export function networkError(error: unknown): ServerError {
  const raw = error instanceof Error ? error.message : String(error);
  return new ServerError(
    `Local server se baat nahi hui (${raw}). Terminal mein chalao: ` +
      'cd server && python -m uvicorn unbg_server.main:app --port 8000',
    'unreachable',
  );
}

function parseMeta(header: string | null): ServerMeta | null {
  if (!header) return null;
  try {
    return JSON.parse(header) as ServerMeta;
  } catch {
    return null;
  }
}

/**
 * Send the photo to the local server and get a full-resolution PNG back.
 * The blob is a cutout with real alpha; backgrounds are composited client-side
 * so switching white/colour never costs another inference.
 */
export async function removeBackgroundServer(
  file: Blob,
  modelId: ServerModelId | string,
  options: ServerOptions = {},
  onStage: (stage: { message: string }) => void = () => {},
): Promise<ServerResult> {
  const base = serverBase();
  const started = performance.now();
  onStage({ message: 'Local server ko bhej raha hoon…' });

  const body = new FormData();
  body.append('file', file, (file as File).name || 'photo.png');

  let response: Response;
  try {
    response = await fetch(removeUrl(modelId, options, base), {
      method: 'POST',
      body,
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw new ServerError('Cancel ho gaya.', 'aborted');
    throw networkError(error);
  }

  if (!response.ok) {
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    throw describeServerError(response.status, payload);
  }

  const blob = await response.blob();
  const meta = parseMeta(response.headers.get('X-Unbg-Meta')) ?? {
    model: serverModelId(modelId),
    width: 0,
    height: 0,
  };
  return { blob, meta, ms: performance.now() - started };
}

export interface ServerHealth {
  ok: boolean;
  message: string;
  models?: string[];
  providers?: string[];
  defaultModel?: string;
}

/** Ping /api/health so the UI can say "server mila" before a 970 MB request. */
export async function serverHealth(base = serverBase()): Promise<ServerHealth> {
  try {
    const response = await fetch(`${base}/api/health`, { method: 'GET' });
    if (!response.ok) {
      return {
        ok: false,
        message: `Server ne ${response.status} lauta diya — version ya port check karo.`,
      };
    }
    const body = (await response.json()) as {
      ready?: boolean;
      default_model?: string;
      models_installed?: string[];
      runtime?: { providers?: string[] };
    };
    const installed = body.models_installed ?? [];
    return {
      ok: true,
      message: installed.length
        ? `Server chal raha hai · ${installed.length} model ready (${installed.join(', ')})`
        : 'Server chal raha hai par koi model download nahi hua — scripts/fetch_models.py chalao.',
      models: installed,
      providers: body.runtime?.providers ?? [],
      defaultModel: body.default_model,
    };
  } catch (error) {
    return { ok: false, message: networkError(error).message };
  }
}
