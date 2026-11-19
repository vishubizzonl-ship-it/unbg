/**
 * Edge polish: the part of a cutout people actually judge.
 *
 * A segmentation model answers at 512 or 1024 px and that answer is then
 * stretched over the whole photo. Two artefacts come out of that stretch, and
 * both are cheap to fix without a single extra model byte:
 *
 * 1. The ramp is soft again — bilinear upscaling turns a 1-pixel transition into
 *    a 4-pixel haze, so hair and product edges look "smudged".
 * 2. The colour is contaminated. A pixel that is 40 % subject still holds 60 %
 *    of the old background, which is the white or green fringe around hair. The
 *    fix is the standard unmix: F = (C − (1−α)·B) / α, with B estimated from the
 *    pixels the mask threw away.
 *
 * Everything here is pure and unit-tested: typed arrays in, typed arrays out, no
 * canvas, no DOM. It runs on the decoded image, which on a phone is already
 * capped at 2048 px, and is skipped above `MAX_PIXELS` so a 40 MP desktop photo
 * cannot wedge a low-end device.
 */

import type { Plane } from './mask';

export const MAX_PIXELS = 8e6;

export interface PolishResult {
  /** Alpha at image resolution, 0..1. */
  alpha: Float32Array;
  /** RGB with the background's colour pulled out of the edge band. */
  rgb: Uint8ClampedArray;
  /** Pixels that were inside the transition band. */
  bandPixels: number;
}

/** Bilinear upsample of the model's plane onto the photo. */
export function upsamplePlane(plane: Plane, width: number, height: number): Float32Array {
  const { data, width: pw, height: ph } = plane;
  const out = new Float32Array(width * height);
  const sx = pw / width;
  const sy = ph / height;
  for (let y = 0; y < height; y++) {
    const fy = Math.min(ph - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(ph - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(pw - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(pw - 1, x0 + 1);
      const wx = fx - x0;
      const top = data[y0 * pw + x0] * (1 - wx) + data[y0 * pw + x1] * wx;
      const bottom = data[y1 * pw + x0] * (1 - wx) + data[y1 * pw + x1] * wx;
      out[y * width + x] = top * (1 - wy) + bottom * wy;
    }
  }
  return out;
}

/** Hermite ramp — what turns a hazy 4-pixel transition back into an edge. */
export function smoothstep(low: number, high: number, value: number): number {
  if (high <= low) return value >= high ? 1 : 0;
  const t = Math.min(1, Math.max(0, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
}

export type BackgroundGrid = { cols: number; rows: number; rgb: Float32Array };

/**
 * Coarse map of "what the background looked like", sampled only from pixels the
 * mask is sure about (α < 0.02). Bilinear-sampled later, so one grid costs
 * almost nothing and still follows a gradient wall or a floor.
 */
export function backgroundGrid(
  rgba: Uint8ClampedArray,
  alpha: Float32Array,
  width: number,
  height: number,
  cells = 16,
): BackgroundGrid {
  const cols = Math.max(1, cells);
  const rows = Math.max(1, cells);
  const sums = new Float32Array(cols * rows * 4);
  for (let y = 0; y < height; y++) {
    const gy = Math.min(rows - 1, Math.floor((y * rows) / height));
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (alpha[i] >= 0.02) continue;
      const g = (gy * cols + Math.min(cols - 1, Math.floor((x * cols) / width))) * 4;
      const p = i * 4;
      sums[g] += rgba[p];
      sums[g + 1] += rgba[p + 1];
      sums[g + 2] += rgba[p + 2];
      sums[g + 3] += 1;
    }
  }
  const rgb = new Float32Array(cols * rows * 3);
  let fallbackR = 255;
  let fallbackG = 255;
  let fallbackB = 255;
  let total = 0;
  for (let g = 0; g < cols * rows; g++) {
    const n = sums[g * 4 + 3];
    if (n > 0) {
      rgb[g * 3] = sums[g * 4] / n;
      rgb[g * 3 + 1] = sums[g * 4 + 1] / n;
      rgb[g * 3 + 2] = sums[g * 4 + 2] / n;
      fallbackR = rgb[g * 3];
      fallbackG = rgb[g * 3 + 1];
      fallbackB = rgb[g * 3 + 2];
      total += n;
    } else {
      rgb[g * 3] = -1; // filled in below
    }
  }
  // Cells with nothing transparent in them inherit the nearest real background
  // colour instead of guessing white.
  for (let g = 0; g < cols * rows; g++) {
    if (rgb[g * 3] >= 0) continue;
    rgb[g * 3] = total > 0 ? fallbackR : 255;
    rgb[g * 3 + 1] = total > 0 ? fallbackG : 255;
    rgb[g * 3 + 2] = total > 0 ? fallbackB : 255;
  }
  return { cols, rows, rgb };
}

function sampleGrid(grid: BackgroundGrid, x: number, y: number, width: number, height: number) {
  const fx = Math.min(grid.cols - 1, Math.max(0, (x * grid.cols) / width - 0.5));
  const fy = Math.min(grid.rows - 1, Math.max(0, (y * grid.rows) / height - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(grid.cols - 1, x0 + 1);
  const y1 = Math.min(grid.rows - 1, y0 + 1);
  const wx = fx - x0;
  const wy = fy - y0;
  const out: number[] = [];
  for (let c = 0; c < 3; c++) {
    const a = grid.rgb[(y0 * grid.cols + x0) * 3 + c];
    const b = grid.rgb[(y0 * grid.cols + x1) * 3 + c];
    const d = grid.rgb[(y1 * grid.cols + x0) * 3 + c];
    const e = grid.rgb[(y1 * grid.cols + x1) * 3 + c];
    out.push(a * (1 - wx) * (1 - wy) + b * wx * (1 - wy) + d * (1 - wx) * wy + e * wx * wy);
  }
  return out;
}

/**
 * The whole polish in one pass.
 *
 * `rgb` is copied, never mutated, so the caller keeps the original pixels — the
 * mask toggle and the before/after slider still show the truth.
 */
export function polishEdges(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  plane: Plane,
  options: { alphaLow?: number; alphaHigh?: number; strength?: number } = {},
): PolishResult {
  const low = options.alphaLow ?? 0.18;
  const high = options.alphaHigh ?? 0.82;
  const strength = options.strength ?? 1;

  const alpha = upsamplePlane(plane, width, height);
  const rgb = new Uint8ClampedArray(rgba); // copy: same pixels, our own buffer
  const grid = backgroundGrid(rgba, alpha, width, height);
  let bandPixels = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const a = alpha[i];
      if (a <= 0.004 || a >= 0.996) continue;

      // 1. Re-crisp the ramp that bilinear upscaling smeared.
      alpha[i] = a + (smoothstep(low, high, a) - a) * strength;

      // 2. Pull the background colour out of the edge.
      if (a > 0.05 && a < 0.98) {
        bandPixels++;
        const [br, bg, bb] = sampleGrid(grid, x, y, width, height);
        const p = i * 4;
        const aSafe = Math.max(a, 0.25);
        for (let c = 0; c < 3; c++) {
          const observed = rgba[p + c];
          const b = c === 0 ? br : c === 1 ? bg : bb;
          const unmixed = (observed - (1 - aSafe) * b) / aSafe;
          rgb[p + c] = Math.min(255, Math.max(0, Math.round(unmixed)));
        }
      }
    }
  }

  return { alpha, rgb, bandPixels };
}
