/**
 * Puter.js path — "user pays", no key, no backend.
 *
 * Puter has no matting endpoint; it exposes generative image models (Gemini
 * image, GPT image, FLUX…) that accept an input image. So this engine asks an
 * editing model to remove the background: it is the least accurate of the three
 * engines on hair and thin edges, and it can redraw the subject slightly. It is
 * here because it needs no signup on our side and no server at all — the visitor
 * signs in to Puter and their own credits pay for the call.
 *
 * Everything is loaded lazily: the SDK (an external script) only arrives when
 * this engine is actually chosen.
 */

export const PUTER_MODEL_ID = 'puter/image-edit';
const PUTER_SRC = 'https://js.puter.com/v2/';

/** Best available editing model; falls back to Puter's default on a rename. */
const PREFERRED_MODEL = 'gemini-2.5-flash-image';

const PROMPT =
  'Remove the background from this photo completely and return the exact same photo of the subject ' +
  'on a fully transparent background as a PNG. Keep the subject pixel-identical: same pose, same ' +
  'lighting, same colours, same crop. Do not add or invent anything.';

interface PuterImage {
  src: string;
}

type PuterGlobal = {
  auth: { isSignedIn: () => boolean; signIn: () => Promise<unknown> };
  ai: { txt2img: (prompt: string, options?: Record<string, unknown>) => Promise<PuterImage | string> };
};

declare global {
  interface Window {
    puter?: PuterGlobal;
  }
}

let sdkPromise: Promise<PuterGlobal> | null = null;

export function loadPuter(): Promise<PuterGlobal> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.puter) return Promise.resolve(window.puter);
  sdkPromise ??= new Promise<PuterGlobal>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${PUTER_SRC}"]`);
    const script = existing ?? document.createElement('script');
    script.addEventListener('load', () => {
      if (window.puter) resolve(window.puter);
      else reject(new Error('Puter.js loaded but window.puter is missing'));
    });
    script.addEventListener('error', () => reject(new Error('Puter.js load failed — network block?')));
    if (!existing) {
      script.src = PUTER_SRC;
      script.async = true;
      document.head.append(script);
    }
  });
  return sdkPromise;
}

export interface PuterResult {
  blob: Blob;
  width: number;
  height: number;
  /** Share of pixels that ended up fully transparent — how well it really cut out. */
  transparentPct: number;
  model: string;
}

/** Turn whatever the provider returned (URL or data URI) into a PNG blob. */
async function toPng(source: string): Promise<{ blob: Blob; width: number; height: number; transparentPct: number }> {
  const response = await fetch(source);
  if (!response.ok) throw new Error(`result download failed (HTTP ${response.status})`);
  const raw = await response.blob();
  const bitmap = await createImageBitmap(raw);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is unavailable in this browser');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();

  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] === 0) transparent++;
  const transparentPct = Math.round((transparent / (data.length / 4)) * 1000) / 10;

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
  if (!blob) throw new Error('Could not encode the PNG');

  return { blob, width: canvas.width, height: canvas.height, transparentPct };
}

export async function removeBackgroundPuter(
  file: Blob,
  onStage: (stage: { stage: 'load' | 'run' | 'done'; message: string }) => void,
): Promise<PuterResult> {
  onStage({ stage: 'load', message: 'Puter.js load kar raha hoon…' });
  const puter = await loadPuter();

  if (!puter.auth.isSignedIn()) {
    onStage({ stage: 'load', message: 'Puter sign-in — khuli window mein login karo (free account)…' });
    // A closed popup must not leave the app waiting forever.
    const signedIn = await Promise.race([
      puter.auth.signIn().then(() => puter.auth.isSignedIn()),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(puter.auth.isSignedIn()), 180_000)),
    ]);
    if (!signedIn) throw new Error('sign_in_required');
  }

  onStage({ stage: 'run', message: 'Puter ka image model background hata raha hai…' });

  const call = async (model?: string) =>
    puter.ai.txt2img(PROMPT, {
      ...(model ? { model } : {}),
      input_images: [file],
      input_image_mime_type: file.type || 'image/png',
    });

  let image: PuterImage | string;
  try {
    image = await call(PREFERRED_MODEL);
  } catch (error) {
    // A model rename must not break the engine: retry with Puter's default.
    const message = error instanceof Error ? error.message : String(error);
    if (/model|not found|unsupported|bad_request/i.test(message)) {
      onStage({ stage: 'run', message: 'Model badal kar dobara try kar raha hoon…' });
      image = await call();
    } else {
      throw error;
    }
  }

  const src = typeof image === 'string' ? image : image?.src;
  if (!src) throw new Error('Puter se koi image nahi aayi');

  onStage({ stage: 'run', message: 'Puter ka result laa raha hoon…' });
  const png = await toPng(src);
  onStage({ stage: 'done', message: 'Done' });

  return { ...png, model: PREFERRED_MODEL };
}

/** Readable sentences for the failures Puter actually produces. */
export function puterError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const code = (error as { errorCode?: string })?.errorCode ?? (error as { code?: string })?.code ?? '';

  if (/insufficient_funds|402|credit|balance/i.test(`${raw} ${code}`)) {
    return 'Puter account mein credits kam hain — Puter par free credits milte hain, sign-in karke try karo.';
  }
  if (/moderation_flagged/i.test(`${raw} ${code}`)) {
    return 'Puter ke model ne ye photo refuse kar di (content filter). Doosra model ya doosri photo try karo.';
  }
  if (/upstream_failed|upstream_/i.test(`${raw} ${code}`)) {
    return 'Puter ka provider fail hua — dobara try karo.';
  }
  if (/network|fetch|load failed|cors|blocked/i.test(raw)) {
    return 'Puter.js load nahi hua — internet check karo (ya ad-blocker ne js.puter.com block kiya ho).';
  }
  if (/sign[_ -]?in|auth/i.test(raw)) {
    return 'Puter sign-in poora nahi hua — dobara try karke popup mein login karo.';
  }
  return raw;
}
