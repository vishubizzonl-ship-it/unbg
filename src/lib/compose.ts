/**
 * Client-side backgrounds: the cutout already has real alpha, so white / any
 * colour is a canvas composite — instant, no second inference, works for every
 * engine (on-device, server, cloud).
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export const NAMED_BACKGROUNDS: Record<string, Rgb | null> = {
  transparent: null,
  white: { r: 255, g: 255, b: 255 },
  black: { r: 0, g: 0, b: 0 },
  gray: { r: 128, g: 128, b: 128 },
  blue: { r: 37, g: 99, b: 235 },
  green: { r: 22, g: 163, b: 74 },
};

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** `transparent` → null, `#0af` → {r:0,g:170,b:255}. Throws on junk. */
export function parseBackground(value: string): Rgb | null {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw || raw === 'none' || raw === 'alpha') return null;
  if (raw in NAMED_BACKGROUNDS) return NAMED_BACKGROUNDS[raw];
  const match = HEX.exec(raw);
  if (!match) throw new Error(`Background samajh nahi aaya: ${value}`);
  let digits = match[1];
  if (digits.length === 3) digits = digits.split('').map((c) => c + c).join('');
  const n = Number.parseInt(digits, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function backgroundCss(value: string): string {
  const rgb = parseBackground(value);
  return rgb ? `rgb(${rgb.r} ${rgb.g} ${rgb.b})` : 'transparent';
}

/** True when the blob is already the plain cutout (alpha preserved). */
export function isTransparent(value: string): boolean {
  return parseBackground(value) === null;
}

/**
 * Composite a transparent PNG onto a flat colour.
 * `transparent` returns the input unchanged — no re-encode, no quality loss.
 */
export async function compositeBlob(source: Blob, background: string): Promise<Blob> {
  const colour = parseBackground(background);
  if (!colour) return source;

  const bitmap = await createImageBitmap(source);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas available nahi hai is browser mein.');
  ctx.fillStyle = `rgb(${colour.r} ${colour.g} ${colour.b})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Composite fail ho gaya.');
  return blob;
}

/** Percentage of fully transparent pixels — a quick sanity signal in the UI. */
export async function transparentShare(blob: Blob): Promise<number> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height));
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return 0;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let clear = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 8) clear += 1;
  return clear / (data.length / 4);
}
