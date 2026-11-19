/**
 * On-device background removal.
 *
 * Runs entirely in the browser: transformers.js → onnxruntime-web
 * (WebGPU when available, WASM/CPU otherwise). The image never leaves the
 * device, which is the whole point of the product.
 *
 * The library is loaded lazily so the marketing page ships ~0 KB of AI code.
 */

import { MODELS, type BgModel } from './models';
import { cleanMask, type CleanupReport } from './mask';
import { decodeImage, DecodeError, formatLabel, isBrowserDecodable, type DecodedImage } from './decode';

export { decodeImage, DecodeError, type DecodedImage };

export interface Stage {
  stage: 'load' | 'run' | 'done';
  message: string;
  percent?: number;
}

export type OnStage = (s: Stage) => void;

export interface Removal {
  blob: Blob;
  width: number;
  height: number;
  loadMs: number;
  inferMs: number;
  device: string;
  modelLabel: string;
  cleanup: CleanupReport;
  /** True when the canvas was capped at 40 MP. */
  scaled: boolean;
}

type Libs = typeof import('@huggingface/transformers');
let libsPromise: Promise<Libs> | null = null;

/** Lazily import the AI stack (keeps the home page JS-free). */
function libs(): Promise<Libs> {
  libsPromise ??= import('@huggingface/transformers');
  return libsPromise;
}

/** Cheap capability check (no adapter request). */
export function hasWebGPU(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

/**
 * Real capability check: navigator.gpu can exist while no adapter is
 * available (headless, enterprise policy, software rendering). Requesting the
 * adapter once is the only honest test.
 */
export async function detectDevice(): Promise<'webgpu' | 'wasm'> {
  if (!hasWebGPU()) return 'wasm';
  try {
    const adapter = await (navigator as any).gpu.requestAdapter();
    return adapter ? 'webgpu' : 'wasm';
  } catch {
    return 'wasm';
  }
}

export function modelById(id: string): BgModel {
  return MODELS.find((m) => m.id === id) ?? MODELS[0];
}

interface Loaded {
  model: any;
  processor: any;
}

/** Cache loaded models per (id + device + dtype) inside the page session. */
const loaded = new Map<string, Promise<Loaded>>();

async function loadModel(m: BgModel, device: string, onStage: OnStage): Promise<Loaded> {
  const key = `${m.id}|${device}|${m.dtype}`;
  const existing = loaded.get(key);
  if (existing) return existing;

  const promise = (async () => {
    const { AutoModel, AutoProcessor, env } = await libs();
    env.allowLocalModels = false;
    env.useBrowserCache = true;

    // Run the CPU backend inside a worker: a big model that runs out of memory
    // then fails the *worker*, not the whole tab — so we can show an error
    // instead of a blank page.
    if (device === 'wasm') {
      env.backends.onnx.wasm.proxy = true;
      env.backends.onnx.wasm.numThreads = 1;
    }

    onStage({ stage: 'load', message: `Loading ${m.label}…`, percent: 0 });

    const onProgress = (p: any) => {
      if (p?.status === 'progress' && typeof p.progress === 'number') {
        onStage({
          stage: 'load',
          message: `Downloading ${m.label} — ${Math.round(p.progress)}%`,
          percent: Math.round(p.progress),
        });
      } else if (p?.status === 'ready') {
        onStage({ stage: 'load', message: `${m.label} ready`, percent: 100 });
      }
    };

    // Not every repo ships every precision. Try the preferred dtype, then
    // fall back down a list instead of throwing a 404 at the user.
    const candidates =
      device === 'webgpu'
        ? [m.dtype, 'fp16', 'fp32']
        : // fp16 on CPU/WASM is the usual cause of runtime traps — prefer the
          // quantised graph, then fp32, and only then fp16.
          ['q8', 'fp32', m.dtype].filter((d) => d !== 'fp16' || m.dtype === 'fp16' && false) as string[];
    const dtypes = [...new Set(candidates)] as string[];

    let lastError: unknown = null;
    for (const dtype of dtypes) {
      try {
        const model = await AutoModel.from_pretrained(m.id, {
          device,
          dtype: dtype as any,
          progress_callback: onProgress,
        });
        const processor = await AutoProcessor.from_pretrained(m.id, {
          progress_callback: onProgress,
        });
        return { model, processor };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`Could not load ${m.label} on ${device}`);
  })();

  loaded.set(key, promise);
  try {
    return await promise;
  } catch (error) {
    loaded.delete(key);
    throw error;
  }
}

/**
 * Some ONNX exports name their input `input` instead of `pixel_values`
 * (RMBG, MODNet). Instead of hardcoding a table per model, retry once with the
 * name the runtime asks for.
 */
async function runModel(model: any, inputs: Record<string, any>): Promise<Record<string, any>> {
  try {
    return await model(inputs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const missing = message.match(/Missing the following inputs:\s*([^."\]]+)/i);
    if (!missing) throw error;
    const names = missing[1]
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    const alt = inputs.pixel_values ?? Object.values(inputs)[0];
    const retry: Record<string, any> = {};
    for (const name of names) retry[name] = alt;
    return await model(retry);
  }
}

function firstTensor(output: Record<string, any>): any {
  for (const value of Object.values(output)) {
    if (value && typeof value === 'object' && 'dims' in value && 'data' in value) return value;
  }
  throw new Error('Model returned no mask tensor');
}

/** Turn model output into a normalised 0..1 alpha plane + its dimensions. */
function toAlphaPlane(tensor: any): { data: Float32Array; width: number; height: number } {
  const dims: number[] = tensor.dims;
  const height = dims[dims.length - 2];
  const width = dims[dims.length - 1];
  const plane = width * height;
  const channels = dims.length >= 3 ? dims[dims.length - 3] : 1;
  const raw = tensor.data as Float32Array | Uint8Array | number[];

  const out = new Float32Array(plane);
  // Multi-channel outputs (e.g. MODNet) put the matte on the last channel.
  const offset = (channels - 1) * plane;
  let min = Infinity;
  let max = -Infinity;

  for (let i = 0; i < plane; i++) {
    const v = Number(raw[offset + i] ?? 0);
    out[i] = v;
    if (v < min) min = v;
    if (v > max) max = v;
  }

  // Logits → probabilities when the model didn't apply sigmoid itself.
  if (min < 0 || max > 1) {
    for (let i = 0; i < plane; i++) out[i] = 1 / (1 + Math.exp(-out[i]));
  }

  // Safety: stretch whatever range we got into 0..1 so nothing renders flat.
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < plane; i++) {
    if (out[i] < lo) lo = out[i];
    if (out[i] > hi) hi = out[i];
  }
  if (hi - lo > 0.001) {
    const scale = 1 / (hi - lo);
    for (let i = 0; i < plane; i++) out[i] = (out[i] - lo) * scale;
  }

  return { data: out, width, height };
}


/** Composite the alpha plane over the photo → transparent PNG blob. */
/** Longest side fed to the network. Masks are upscaled, so nothing is lost. */
const MODEL_MAX_SIDE = 2048;

function modelInput(image: DecodedImage): HTMLCanvasElement {
  const { canvas } = image;
  const longest = Math.max(canvas.width, canvas.height);
  if (longest <= MODEL_MAX_SIDE) return canvas;
  const scale = MODEL_MAX_SIDE / longest;
  const small = document.createElement('canvas');
  small.width = Math.round(canvas.width * scale);
  small.height = Math.round(canvas.height * scale);
  const ctx = small.getContext('2d');
  if (!ctx) return canvas;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, small.width, small.height);
  return small;
}

async function composite(
  image: DecodedImage,
  plane: { data: Float32Array; width: number; height: number },
): Promise<{ blob: Blob; width: number; height: number; scaled: boolean }> {
  const { data, width, height } = plane;

  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = width;
  maskCanvas.height = height;
  const mctx = maskCanvas.getContext('2d');
  if (!mctx) throw new Error('Canvas 2D is unavailable in this browser');

  // The mask must live in the *alpha* channel: `destination-in` keeps the
  // photo only where the mask source is opaque. Putting the value in RGB with
  // a solid alpha (the obvious first attempt) cuts nothing.
  const maskImage = mctx.createImageData(width, height);
  for (let i = 0, p = 0; i < data.length; i++, p += 4) {
    const v = Math.min(255, Math.max(0, Math.round(data[i] * 255)));
    maskImage.data[p] = 255;
    maskImage.data[p + 1] = 255;
    maskImage.data[p + 2] = 255;
    maskImage.data[p + 3] = v;
  }
  mctx.putImageData(maskImage, 0, 0);

  // Full resolution is the product promise, but a 100 MP canvas makes phones
  // throw; past 40 MP we keep the aspect ratio and say so in the status line.
  const MAX_PIXELS = 40e6;
  const pixels = image.width * image.height;
  const shrink = pixels > MAX_PIXELS ? Math.sqrt(MAX_PIXELS / pixels) : 1;
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(image.width * shrink));
  out.height = Math.max(1, Math.round(image.height * shrink));
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is unavailable in this browser');

  ctx.drawImage(image.canvas, 0, 0, out.width, out.height);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(maskCanvas, 0, 0, out.width, out.height);

  const blob = await new Promise<Blob | null>((resolve) =>
    out.toBlob((b) => resolve(b), 'image/png'),
  );
  if (!blob) throw new Error('Could not encode the PNG');
  return { blob, width: out.width, height: out.height, scaled: shrink < 1 };
}

/** Turn runtime noise into something a human can act on. */
export function friendlyError(error: unknown, modelLabel?: string): string {
  if (error instanceof DecodeError) {
    const mb =
      error.bytes < 1024 * 1024
        ? `${Math.max(1, Math.round(error.bytes / 1024))} KB`
        : `${(error.bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (error.format === 'heic') {
      return `Ye ${formatLabel(error.format)} photo hai (${mb}) — Chrome ise khol hi nahi sakta, isliye samajh nahi paaya. Gallery mein photo kholo → share/convert se JPEG banao, ya camera setting "JPEG only" kar do. (PNG/JPG/WebP seedha chalte hain.)`;
    }
    if (!isBrowserDecodable(error.format)) {
      return `${formatLabel(error.format)} file browser decode nahi kar sakta (${mb}). PNG, JPG ya WebP use karein.`;
    }
    return `Image decode nahi hui (${formatLabel(error.format)}, ${mb}) — file kharab lagti hai. Dobara save karke ya screenshot le kar try karein.`;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/fetch|network|Failed to load resource|Could not locate file|404/i.test(message)) {
    return 'Model download failed — network blocked or unreachable. Is page ko normal browser tab mein kholein (in-app preview iframe mein network band hota hai).';
  }
  if (/out of memory|OOM|Aborted|RuntimeError|memory/i.test(message)) {
    const alreadySmallest = !!modelLabel && /modnet/i.test(modelLabel);
    const advice = alreadySmallest
      ? 'MODNet hi sabse chhota model hai, to: doosre Chrome tabs band karo, page reload karke dobara try karo, ya thodi chhoti photo daalo.'
      : 'Model chhota karo (MODNet ~7 MB), doosre tabs band karo, aur page reload karke dobara try karo.';
    return `Phone ka memory khatam ho gaya. ${advice}`;
  }
  if (/backend|adapter|webgpu/i.test(message)) {
    return 'WebGPU is not usable in this browser. Device detect hua CPU — chhota model chunein.';
  }
  return message;
}

export async function removeBackground(
  image: DecodedImage,
  modelId: string,
  onStage: OnStage,
  options: { device?: 'webgpu' | 'wasm'; clean?: boolean } = {},
): Promise<Removal> {
  const m = modelById(modelId);
  let device = options.device ?? (await detectDevice());

  if (m.webgpuOnly && device !== 'webgpu') {
    throw new Error(
      `${m.label} needs WebGPU. Is browser mein WebGPU nahi hai — doosra model chuno (BiRefNet lite 512 ya RMBG-1.4).`,
    );
  }

  const { RawImage } = await libs();
  // The photo was decoded once, up front — no second decode, no second chance
  // to fail halfway through. Only a capped copy goes to the network.
  const raw = RawImage.fromCanvas(modelInput(image));

  type Attempt = { model: Loaded['model']; output: unknown; loadMs: number; inferMs: number };

  const attempt = async (dev: 'webgpu' | 'wasm'): Promise<Attempt> => {
    const loadStart = performance.now();
    const { model, processor } = await loadModel(m, dev, onStage);
    const loadMs = performance.now() - loadStart;
    onStage({
      stage: 'run',
      message: `Removing background… (${dev === 'webgpu' ? 'GPU' : 'CPU'})`,
    });
    const inputs = await processor(raw);
    const inferStart = performance.now();
    const output = await runModel(model, inputs);
    return { model, output, loadMs, inferMs: performance.now() - inferStart };
  };

  let result: Attempt;
  try {
    result = await attempt(device);
  } catch (error) {
    // Phones hand out a WebGPU adapter and then run out of memory building the
    // session, or mid-inference. The same model on CPU usually works — and a
    // CPU answer beats an error screen.
    if (device === 'webgpu') {
      onStage({ stage: 'load', message: 'GPU par memory kam pad gayi — CPU par dobara try kar raha hoon…' });
      device = 'wasm';
      result = await attempt(device);
    } else {
      throw error;
    }
  }

  const { loadMs, inferMs, output } = result;
  const tensor = firstTensor(output);
  const plane = toAlphaPlane(tensor);

  // Sharpen the ramp, drop stray blobs, close holes, feather the edge.
  onStage({ stage: 'run', message: 'Cleaning up the mask…' });
  const cleanup = cleanMask(plane, { clean: options.clean ?? true, featherRadius: 1 });

  onStage({ stage: 'run', message: 'Compositing PNG…' });
  const { blob, width, height, scaled } = await composite(image, plane);

  onStage({ stage: 'done', message: 'Done' });

  return { blob, width, height, loadMs, inferMs, device, modelLabel: m.label, cleanup, scaled };
}
