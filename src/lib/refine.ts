/**
 * Post-process a cutout that another engine produced.
 *
 * IMG.LY hands back a finished PNG, so the mask never reaches our cleanup
 * pipeline: stray spots stay, holes stay, and a one-pixel rim of background
 * survives around hair. This takes the alpha channel out of that PNG, runs the
 * same morphology the on-device engine uses, and puts the alpha back.
 */

import { cleanMask, coverage, erode, invert, looksInverted, type CleanupReport } from './mask';

export interface RefineOptions {
  clean?: boolean;
  /** Pixels of halo to eat. 1 is a good default, 0 disables. */
  erodePx?: number;
  featherRadius?: number;
}

export interface Refined {
  blob: Blob;
  coverage: number;
  cleanup: CleanupReport;
  inverted: boolean;
  width: number;
  height: number;
}

export async function refineCutout(blob: Blob, options: RefineOptions = {}): Promise<Refined> {
  const { clean = true, erodePx = 1, featherRadius = 1 } = options;

  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is unavailable in this browser');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();

  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const plane = {
    data: new Float32Array(canvas.width * canvas.height),
    width: canvas.width,
    height: canvas.height,
  };
  for (let i = 0, p = 3; i < plane.data.length; i++, p += 4) plane.data[i] = image.data[p] / 255;

  const inverted = looksInverted(plane);
  if (inverted) invert(plane);

  const cleanup = cleanMask(plane, { clean, featherRadius, ramp: [0.25, 0.75] });
  erode(plane, erodePx);
  if (erodePx > 0) cleanMask(plane, { clean: false, featherRadius: 1 });

  for (let i = 0, p = 3; i < plane.data.length; i++, p += 4) {
    image.data[p] = Math.round(Math.min(1, Math.max(0, plane.data[i])) * 255);
  }
  ctx.putImageData(image, 0, 0);

  const out = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
  if (!out) throw new Error('Could not encode the PNG');

  return {
    blob: out,
    coverage: coverage(plane),
    cleanup,
    inverted,
    width: canvas.width,
    height: canvas.height,
  };
}
