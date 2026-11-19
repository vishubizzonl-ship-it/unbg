/**
 * Mask post-processing.
 *
 * Raw segmentation output is a soft probability map that usually contains
 * three kinds of junk:
 *   1. stray blobs detached from the subject (a logo, a reflection, a poster),
 *   2. small holes punched inside the subject (shadowed fabric, dark hair),
 *   3. mushy edges that read as a halo once composited.
 *
 * These are cheap morphological fixes on the low-res plane — not a second
 * neural network — and they make every model look markedly better.
 *
 * Pure functions, no DOM: unit-testable in Node.
 */

export interface Plane {
  data: Float32Array;
  width: number;
  height: number;
}

/** Sharpen the probability ramp so soft predictions become decisive edges. */
export function smoothstep(plane: Plane, lo = 0.35, hi = 0.65): void {
  const { data } = plane;
  const span = Math.max(1e-6, hi - lo);
  for (let i = 0; i < data.length; i++) {
    const t = Math.min(1, Math.max(0, (data[i] - lo) / span));
    data[i] = t * t * (3 - 2 * t);
  }
}

/** Binary mask at the given alpha threshold. */
export function binarize(plane: Plane, threshold = 0.5): Uint8Array {
  const { data } = plane;
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] >= threshold ? 1 : 0;
  return out;
}

interface Components {
  labels: Int32Array;
  sizes: number[];
  count: number;
}

/**
 * 4-connected component labelling with an explicit stack (no recursion — a
 * 1024² mask would blow the call stack).
 */
export function labelComponents(bin: Uint8Array, width: number, height: number): Components {
  const labels = new Int32Array(width * height).fill(-1);
  const sizes: number[] = [];
  const stack = new Int32Array(width * height);

  for (let start = 0; start < bin.length; start++) {
    if (bin[start] === 0 || labels[start] !== -1) continue;

    const label = sizes.length;
    let size = 0;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = label;

    while (sp > 0) {
      const index = stack[--sp];
      size++;
      const x = index % width;
      const y = (index - x) / width;

      if (x > 0) {
        const n = index - 1;
        if (bin[n] === 1 && labels[n] === -1) {
          labels[n] = label;
          stack[sp++] = n;
        }
      }
      if (x < width - 1) {
        const n = index + 1;
        if (bin[n] === 1 && labels[n] === -1) {
          labels[n] = label;
          stack[sp++] = n;
        }
      }
      if (y > 0) {
        const n = index - width;
        if (bin[n] === 1 && labels[n] === -1) {
          labels[n] = label;
          stack[sp++] = n;
        }
      }
      if (y < height - 1) {
        const n = index + width;
        if (bin[n] === 1 && labels[n] === -1) {
          labels[n] = label;
          stack[sp++] = n;
        }
      }
    }

    sizes.push(size);
  }

  return { labels, sizes, count: sizes.length };
}

/** Drop blobs smaller than `minRatio` of the biggest subject. */
export function keepLargest(plane: Plane, minRatio = 0.02): number {
  const bin = binarize(plane);
  const { labels, sizes, count } = labelComponents(bin, plane.width, plane.height);
  if (count === 0) return 0;

  let largest = 0;
  for (const size of sizes) if (size > largest) largest = size;
  const cutoff = Math.max(8, largest * minRatio);

  let dropped = 0;
  const { data } = plane;
  for (let i = 0; i < data.length; i++) {
    const label = labels[i];
    if (label === -1) continue;
    if (sizes[label] < cutoff) {
      data[i] = 0;
      dropped++;
    }
  }
  return dropped;
}

/**
 * Fill enclosed holes: flood the background from the border, then anything
 * left unvisited is an interior hole and gets promoted to subject.
 */
export function fillHoles(plane: Plane, threshold = 0.5): number {
  const { width, height, data } = plane;
  const total = width * height;
  const outside = new Uint8Array(total);
  const stack = new Int32Array(total);
  let sp = 0;

  const push = (index: number) => {
    if (index < 0 || index >= total) return;
    if (outside[index] === 1) return;
    if (data[index] >= threshold) return;
    outside[index] = 1;
    stack[sp++] = index;
  };

  for (let x = 0; x < width; x++) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    push(y * width);
    push(y * width + width - 1);
  }

  while (sp > 0) {
    const index = stack[--sp];
    const x = index % width;
    const y = (index - x) / width;
    if (x > 0) push(index - 1);
    if (x < width - 1) push(index + 1);
    if (y > 0) push(index - width);
    if (y < height - 1) push(index + width);
  }

  let filled = 0;
  for (let i = 0; i < total; i++) {
    if (data[i] < threshold && outside[i] === 0) {
      data[i] = 1;
      filled++;
    }
  }
  return filled;
}

/** Horizontal + vertical box blur on a float plane (edge feather). */
export function feather(plane: Plane, radius = 1): void {
  if (radius < 1) return;
  const { width, height, data } = plane;
  const temp = new Float32Array(data.length);
  const window = radius * 2 + 1;

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let dx = -radius; dx <= radius; dx++) {
        const xx = Math.min(width - 1, Math.max(0, x + dx));
        sum += data[row + xx];
      }
      temp[row + x] = sum / window;
    }
  }

  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let sum = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = Math.min(height - 1, Math.max(0, y + dy));
        sum += temp[yy * width + x];
      }
      data[y * width + x] = sum / window;
    }
  }
}

export interface CleanupOptions {
  /** Remove disconnected blobs (default on) */
  clean?: boolean;
  /** Edge feather radius in mask pixels (0 = off) */
  featherRadius?: number;
  /** Ramp used to sharpen probabilities */
  ramp?: [number, number];
}

export interface CleanupReport {
  blobsRemoved: number;
  holesFilled: number;
}

/** Full pipeline: sharpen → keep main subject → fill holes → feather. */
export function cleanMask(plane: Plane, options: CleanupOptions = {}): CleanupReport {
  const { clean = true, featherRadius = 1, ramp = [0.35, 0.65] } = options;

  smoothstep(plane, ramp[0], ramp[1]);

  let blobsRemoved = 0;
  let holesFilled = 0;

  if (clean) {
    blobsRemoved = keepLargest(plane, 0.02);
    holesFilled = fillHoles(plane, 0.5);
  }

  if (featherRadius > 0) feather(plane, featherRadius);

  return { blobsRemoved, holesFilled };
}
