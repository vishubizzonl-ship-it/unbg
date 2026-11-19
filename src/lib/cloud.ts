/**
 * Optional cloud path.
 *
 * The on-device engine stays the default — privacy is the product. Cloud is a
 * deliberate choice for the hard photos: the browser posts the file to the
 * local dev server, which forwards it to remove.bg with the user's own API key.
 * Nothing about the key lives in the bundle; it stays in localStorage on this
 * device and travels as a request header.
 */

export const CLOUD_MODEL_ID = 'cloud:removebg';
export const CLOUD_KEY_STORAGE = 'unbg.removebg.key';

export class CloudError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CloudError';
    this.code = code;
  }
}

export const isCloudModel = (id: string): boolean => id.startsWith('cloud:');

export const cloudKey = (): string => {
  try {
    return localStorage.getItem(CLOUD_KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
};

export const saveCloudKey = (key: string): void => {
  try {
    if (key) localStorage.setItem(CLOUD_KEY_STORAGE, key.trim());
    else localStorage.removeItem(CLOUD_KEY_STORAGE);
  } catch {
    /* private mode — the key just will not persist */
  }
};

export interface CloudResult {
  blob: Blob;
  width: number;
  height: number;
}

export async function removeBackgroundCloud(
  file: Blob,
  onStage: (stage: { stage: 'run' | 'done'; message: string }) => void,
): Promise<CloudResult> {
  const key = cloudKey();
  if (!key) {
    throw new CloudError(
      'NO_KEY',
      'Cloud ke liye remove.bg ki free API key chahiye — remove.bg/api par free account (50 images/month), key neeche box mein paste karo.',
    );
  }

  onStage({ stage: 'run', message: 'Cloud AI ko bhej raha hoon…' });
  const response = await fetch('/api/remove', {
    method: 'POST',
    headers: { 'x-unbg-key': key, 'content-type': file.type || 'application/octet-stream' },
    body: file,
  });

  if (!response.ok) {
    let message = `Cloud service ne HTTP ${response.status} diya.`;
    try {
      const body = (await response.json()) as { message?: string; error?: string };
      message = body.message ?? message;
    } catch {
      /* not JSON — keep the generic sentence */
    }
    throw new CloudError('UPSTREAM', message);
  }

  const blob = await response.blob();
  onStage({ stage: 'run', message: 'Cloud ka PNG aaya — finalize kar raha hoon…' });

  let width = 0;
  let height = 0;
  try {
    const bitmap = await createImageBitmap(blob);
    width = bitmap.width;
    height = bitmap.height;
    bitmap.close?.();
  } catch {
    /* the PNG is still downloadable even without the measurement */
  }

  return { blob, width, height };
}
