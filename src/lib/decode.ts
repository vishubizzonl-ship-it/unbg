/**
 * Image decoding: sniff the real format, then decode with every mechanism the
 * browser has, and if all of them fail say *what* the file actually is.
 *
 * Why this exists: phones hand over HEIC/HEIF photos and the odd 50 MP JPEG
 * that Chrome refuses with "The source image could not be decoded." — a
 * message that tells the user nothing and used to appear only after the AI
 * model had already been downloaded. Here the image is decoded once, first,
 * into a canvas; the model and the PNG compositor both reuse it.
 */

export type ImageFormat =
  | 'jpeg'
  | 'png'
  | 'webp'
  | 'gif'
  | 'avif'
  | 'heic'
  | 'tiff'
  | 'bmp'
  | 'svg'
  | 'pdf'
  | 'unknown';

const LABEL: Record<ImageFormat, string> = {
  jpeg: 'JPEG',
  png: 'PNG',
  webp: 'WebP',
  gif: 'GIF',
  avif: 'AVIF',
  heic: 'HEIC/HEIF',
  tiff: 'TIFF',
  bmp: 'BMP',
  svg: 'SVG',
  pdf: 'PDF',
  unknown: 'unrecognised',
};

export const formatLabel = (f: ImageFormat): string => LABEL[f];

/** Browsers that can be expected to decode the format without help. */
export function isBrowserDecodable(format: ImageFormat): boolean {
  return format !== 'heic' && format !== 'tiff' && format !== 'pdf';
}

const ascii = (bytes: Uint8Array, offset: number, length: number): string => {
  let out = '';
  for (let i = offset; i < offset + length && i < bytes.length; i++) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
};

/** Read the format from the first bytes — the only honest test of a phone file. */
export function sniffImage(bytes: Uint8Array): ImageFormat {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG') return 'png';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp';
  if (ascii(bytes, 0, 4) === 'GIF8') return 'gif';
  if (ascii(bytes, 0, 4) === '%PDF') return 'pdf';
  if (ascii(bytes, 0, 2) === 'BM') return 'bmp';
  if (ascii(bytes, 0, 2) === 'II' && bytes[2] === 0x2a && bytes[3] === 0x00) return 'tiff';
  if (ascii(bytes, 0, 2) === 'MM' && bytes[2] === 0x00 && bytes[3] === 0x2a) return 'tiff';

  // ISO-BMFF container: "....ftyp<brand>" — AVIF and HEIC live here.
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brands = [ascii(bytes, 8, 4).toLowerCase(), ascii(bytes, 16, 4).toLowerCase()];
    if (brands.some((b) => b === 'avif' || b === 'avis')) return 'avif';
    if (
      brands.some((b) =>
        ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'mif2', 'msf1'].includes(b),
      )
    ) {
      return 'heic';
    }
  }

  // SVG is text; look for the root element in the first bytes.
  const head = ascii(bytes, 0, Math.min(bytes.length, 512)).trim().toLowerCase();
  if (head.startsWith('<?xml') || head.startsWith('<svg') || head.includes('<svg')) return 'svg';

  return 'unknown';
}

export interface DecodedImage {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  format: ImageFormat;
  /** Small JPEG of the same picture, for the "before" tile. */
  preview: Blob;
  /** True when the browser could only decode a reduced copy (huge photos). */
  downscaled: boolean;
}

/** A decode failure that knows what the file was, so the UI can be specific. */
export class DecodeError extends Error {
  readonly format: ImageFormat;
  readonly bytes: number;
  readonly attempts: string;

  constructor(format: ImageFormat, bytes: number, attempts: string) {
    super(`The source image could not be decoded (${formatLabel(format)})`);
    this.name = 'DecodeError';
    this.format = format;
    this.bytes = bytes;
    this.attempts = attempts;
  }
}

const PREVIEW_MAX = 480;

function canvasFrom(source: ImageBitmap | HTMLImageElement): HTMLCanvasElement {
  const width = 'naturalWidth' in source ? source.naturalWidth || source.width : source.width;
  const height = 'naturalHeight' in source ? source.naturalHeight || source.height : source.height;
  if (!width || !height) throw new Error('decoded image has no size');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is unavailable in this browser');
  ctx.drawImage(source, 0, 0, width, height);
  return canvas;
}

async function viaImageElement(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    // `decode()` is the fast path but is not implemented everywhere.
    if (typeof img.decode === 'function') {
      await img.decode();
    } else {
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('img onerror'));
      });
    }
    if (!img.naturalWidth) throw new Error('img decoded to 0×0');
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Full-resolution canvas + a cheap preview. Never mutates the input blob, and
 * tries every decoder before giving up.
 */
export async function decodeImage(blob: Blob): Promise<DecodedImage> {
  const head = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
  const format = sniffImage(head);
  const notes: string[] = [];

  let canvas: HTMLCanvasElement | null = null;

  // 1. createImageBitmap — off the main thread, honours EXIF orientation.
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' } as ImageBitmapOptions);
      canvas = canvasFrom(bitmap);
      bitmap.close?.();
    } catch (error) {
      notes.push(`createImageBitmap: ${(error as Error).message}`);
    }
  } else {
    notes.push('createImageBitmap: unavailable');
  }

  // 2. <img> — different code path inside the browser, sometimes more lenient.
  if (!canvas) {
    try {
      canvas = canvasFrom(await viaImageElement(blob));
    } catch (error) {
      notes.push(`<img>: ${(error as Error).message}`);
    }
  }

  // 3. Last resort for very large photos: a downscaling decode is a different
  // path inside Chrome and can succeed where the full-size decode runs out of
  // memory. The result is honest about its size in the status line.
  let downscaled = false;
  if (!canvas) {
    try {
      const bitmap = await createImageBitmap(blob, {
        resizeWidth: 2048,
        resizeQuality: 'high',
        imageOrientation: 'from-image',
      } as ImageBitmapOptions);
      canvas = canvasFrom(bitmap);
      bitmap.close?.();
      downscaled = true;
      notes.push('decoded at 2048px');
    } catch (error) {
      notes.push(`downscaled: ${(error as Error).message}`);
    }
  }

  if (!canvas) throw new DecodeError(format, blob.size, notes.join(' | '));

  const scale = Math.min(1, PREVIEW_MAX / Math.max(canvas.width, canvas.height));
  const preview = document.createElement('canvas');
  preview.width = Math.max(1, Math.round(canvas.width * scale));
  preview.height = Math.max(1, Math.round(canvas.height * scale));
  const pctx = preview.getContext('2d');
  const previewBlob = await new Promise<Blob | null>((resolve) => {
    if (!pctx) return resolve(null);
    pctx.drawImage(canvas, 0, 0, preview.width, preview.height);
    preview.toBlob((b) => resolve(b), 'image/jpeg', 0.82);
  });

  return {
    canvas,
    width: canvas.width,
    height: canvas.height,
    format,
    preview: previewBlob ?? blob,
    downscaled,
  };
}
