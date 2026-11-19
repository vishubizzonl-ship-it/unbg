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

async function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Composite the alpha plane over the photo → transparent PNG blob. */
async function composite(
  image: HTMLImageElement,
  plane: { data: Float32Array; width: number; height: number },
): Promise<{ blob: Blob; width: number; height: number }> {
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

  const out = document.createElement('canvas');
  out.width = image.naturalWidth || image.width;
  out.height = image.naturalHeight || image.height;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is unavailable in this browser');

  ctx.drawImage(image, 0, 0);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(maskCanvas, 0, 0, out.width, out.height);

  const blob = await new Promise<Blob | null>((resolve) =>
    out.toBlob((b) => resolve(b), 'image/png'),
  );
  if (!blob) throw new Error('Could not encode the PNG');
  return { blob, width: out.width, height: out.height };
}

/** Turn runtime noise into something a human can act on. */
export function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/fetch|network|Failed to load resource|Could not locate file|404/i.test(message)) {
    return 'Model download failed — network blocked or unreachable. Is page ko normal browser tab mein kholein (in-app preview iframe mein network band hota hai).';
  }
  if (/out of memory|OOM|Aborted|RuntimeError|memory/i.test(message)) {
    return 'Device ran out of memory for this model. Chhota model (MODNet) try karein, ya WebGPU wale browser/device par kholein.';
  }
  if (/backend|adapter|webgpu/i.test(message)) {
    return 'WebGPU is not usable in this browser. Device detect hua CPU — chhota model chunein.';
  }
  return message;
}

export async function removeBackground(
  file: Blob,
  modelId: string,
  onStage: OnStage,
  options: { device?: 'webgpu' | 'wasm' } = {},
): Promise<Removal> {
  const m = modelById(modelId);
  let device = options.device ?? (await detectDevice());

  if (m.webgpuOnly && device !== 'webgpu') {
    throw new Error(
      `${m.label} needs WebGPU. Is browser mein WebGPU nahi hai — doosra model chuno (BiRefNet lite 512 ya RMBG-1.4).`,
    );
  }

  const loadStart = performance.now();
  let loadedModel: Loaded;
  try {
    loadedModel = await loadModel(m, device, onStage);
  } catch (error) {
    // GPU present but unusable (no adapter / driver / flag) → retry on CPU.
    if (device === 'webgpu') {
      onStage({ stage: 'load', message: 'GPU unavailable — switching to CPU…' });
      device = 'wasm';
      loadedModel = await loadModel(m, device, onStage);
    } else {
      throw error;
    }
  }
  const { model, processor } = loadedModel;
  const loadMs = performance.now() - loadStart;

  const { RawImage } = await libs();
  onStage({ stage: 'run', message: 'Removing background…' });

  const image = await RawImage.fromBlob(file);
  const inputs = await processor(image);

  const inferStart = performance.now();
  const output = await runModel(model, inputs);
  const inferMs = performance.now() - inferStart;

  const tensor = firstTensor(output);
  const plane = toAlphaPlane(tensor);

  onStage({ stage: 'run', message: 'Compositing PNG…' });
  const domImage = await blobToImage(file);
  const { blob, width, height } = await composite(domImage, plane);

  onStage({ stage: 'done', message: 'Done' });

  return { blob, width, height, loadMs, inferMs, device, modelLabel: m.label };
}
