/**
 * Alpha matting: the second stage remove.bg never talks about.
 *
 * A segmentation model answers "which pixel belongs to the subject" at 1024² and
 * the answer is then stretched over a 12 MP photo — which is why hair reads as a
 * soft blur and glass as a hard hole. Matting answers "how much" per pixel using
 * the *original* pixels and a trimap, so strands survive.
 *
 * Model: ViTMatte (hustvl/vitmatte-base-composition-1k) through transformers.js,
 * ONNX, on-device. Quantised weights ~99 MB, downloaded once.
 */

import { AutoProcessor, RawImage, VitMatteForImageMatting } from '@huggingface/transformers';
import { trimap, type Plane } from './mask';

export const MATTE_MODEL_ID = 'Xenova/vitmatte-base-composition-1k';
export const MATTE_SIZE_MB = 99;

/** Keep the matting input phone-sized; edges are the only thing we need. */
const MATTE_LONG_SIDE = 1024;

type Libs = typeof import('@huggingface/transformers');
let libsPromise: Promise<Libs> | null = null;
const libs = (): Promise<Libs> => (libsPromise ??= import('@huggingface/transformers'));

interface Loaded {
  model: Awaited<ReturnType<typeof VitMatteForImageMatting.from_pretrained>>;
  processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>>;
}

let cache: { key: string; loaded: Loaded } | null = null;

async function loadModel(device: 'webgpu' | 'wasm', onStage: (message: string) => void): Promise<Loaded> {
  const key = `${MATTE_MODEL_ID}:${device}`;
  if (cache?.key === key) return cache.loaded;
  await libs();
  onStage(`Matting model load ho raha hai (${MATTE_SIZE_MB} MB pehli baar)…`);
  const processor = await AutoProcessor.from_pretrained(MATTE_MODEL_ID);
  const model = await VitMatteForImageMatting.from_pretrained(MATTE_MODEL_ID, {
    device,
    dtype: device === 'webgpu' ? 'fp16' : 'q8',
  });
  cache = { key, loaded: { model, processor } };
  return cache.loaded;
}

/** Size that needs no padding: long side ≤ 1024, both sides multiples of 32. */
function matteSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, MATTE_LONG_SIDE / Math.max(width, height));
  const snap = (value: number) => Math.max(32, Math.floor((value * scale) / 32) * 32);
  return { width: snap(width), height: snap(height) };
}

/**
 * Refine a segmentation plane with ViTMatte.
 * Returns a plane in matting resolution — the compositor stretches it back to
 * full size, exactly like the segmentation mask.
 */
export async function matteRefine(
  photo: HTMLCanvasElement,
  plane: Plane,
  device: 'webgpu' | 'wasm',
  onStage: (message: string) => void,
): Promise<{ plane: Plane; ms: number }> {
  const started = performance.now();
  const { processor, model } = await loadModel(device, onStage);

  const size = matteSize(photo.width, photo.height);

  // guide image at matting size
  const guide = document.createElement('canvas');
  guide.width = size.width;
  guide.height = size.height;
  const gctx = guide.getContext('2d');
  if (!gctx) throw new Error('Canvas 2D is unavailable in this browser');
  gctx.imageSmoothingQuality = 'high';
  gctx.drawImage(photo, 0, 0, size.width, size.height);

  // trimap at matting size, from the segmentation plane
  const tri = trimap(plane, 6);
  const trimapCanvas = document.createElement('canvas');
  trimapCanvas.width = size.width;
  trimapCanvas.height = size.height;
  const tctx = trimapCanvas.getContext('2d');
  if (!tctx) throw new Error('Canvas 2D is unavailable in this browser');

  const planeCanvas = document.createElement('canvas');
  planeCanvas.width = plane.width;
  planeCanvas.height = plane.height;
  const pctx = planeCanvas.getContext('2d');
  if (!pctx) throw new Error('Canvas 2D is unavailable in this browser');
  const image = pctx.createImageData(plane.width, plane.height);
  for (let i = 0, p = 0; i < tri.length; i++, p += 4) {
    image.data[p] = tri[i];
    image.data[p + 1] = tri[i];
    image.data[p + 2] = tri[i];
    image.data[p + 3] = 255;
  }
  pctx.putImageData(image, 0, 0);
  tctx.imageSmoothingEnabled = false;
  tctx.drawImage(planeCanvas, 0, 0, size.width, size.height);

  onStage('Alpha matting — baal aur kinare refine ho rahe hain…');
  const inputs = await processor(RawImage.fromCanvas(guide), RawImage.fromCanvas(trimapCanvas));
  const { alphas } = await model(inputs);

  const dims =
    (alphas as { dims?: number[] }).dims ??
    (alphas as unknown as { [k: string]: number[] }).dims ??
    [1, 1, size.height, size.width];
  const height = dims[dims.length - 2] ?? size.height;
  const width = dims[dims.length - 1] ?? size.width;
  const raw = (alphas as { data?: Float32Array | Uint8Array }).data;
  if (!raw) throw new Error('Matting model ne alpha nahi diya');

  const data = new Float32Array(width * height);
  for (let i = 0; i < data.length; i++) {
    const v = Number(raw[i] ?? 0);
    data[i] = Math.min(1, Math.max(0, v));
  }

  return { plane: { data, width, height }, ms: performance.now() - started };
}
