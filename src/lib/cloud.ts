/**
 * Optional cloud path.
 *
 * The on-device engine stays the default — privacy is the product. Cloud is a
 * deliberate choice for the hard photos: the browser posts the file to the
 * local dev server, which forwards it to the chosen provider with the user's own
 * free key. Keys live in this browser's localStorage and travel as a request
 * header; nothing secret reaches the bundle.
 */

export type CloudProvider = 'removebg' | 'huggingface';

export interface ProviderInfo {
  provider: CloudProvider;
  label: string;
  keyLabel: string;
  keyPlaceholder: string;
  hint: string;
}

export const PROVIDERS: Record<CloudProvider, ProviderInfo> = {
  huggingface: {
    provider: 'huggingface',
    label: 'Cloud · Hugging Face BiRefNet — free token, no card',
    keyLabel: 'Hugging Face token — free at huggingface.co/settings/tokens',
    keyPlaceholder: 'hf_…',
    hint: 'Free account, card ki zaroorat nahi. BiRefNet model unke GPU par chalta hai; free quota khatam ho to thodi der baad try karo.',
  },
  removebg: {
    provider: 'removebg',
    label: 'Cloud · remove.bg — free 50/month, best edges',
    keyLabel: 'remove.bg API key — free 50 images/month at remove.bg/api',
    keyPlaceholder: 'paste key here',
    hint: 'remove.bg ke 50 free images har mahine.',
  },
};

const keyStore = (provider: CloudProvider): string => `unbg.cloud.key.${provider}`;

export const isCloudModel = (id: string): boolean => id.startsWith('cloud:');

export const cloudProvider = (id: string): CloudProvider =>
  id === 'cloud:huggingface' ? 'huggingface' : 'removebg';

export const cloudKey = (provider: CloudProvider): string => {
  try {
    return (
      localStorage.getItem(keyStore(provider)) ??
      (provider === 'removebg' ? localStorage.getItem('unbg.removebg.key') : null) ??
      ''
    );
  } catch {
    return '';
  }
};

export const saveCloudKey = (provider: CloudProvider, key: string): void => {
  try {
    if (key) localStorage.setItem(keyStore(provider), key.trim());
    else localStorage.removeItem(keyStore(provider));
  } catch {
    /* private mode — the key just will not persist */
  }
};

export class CloudError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CloudError';
    this.code = code;
  }
}

export interface CloudResult {
  blob: Blob;
  width: number;
  height: number;
}

export async function removeBackgroundCloud(
  file: Blob,
  provider: CloudProvider,
  onStage: (stage: { stage: 'run' | 'done'; message: string }) => void,
): Promise<CloudResult> {
  const key = cloudKey(provider);
  if (!key) {
    throw new CloudError(
      'NO_KEY',
      provider === 'huggingface'
        ? 'Hugging Face token chahiye — huggingface.co/settings/tokens par free account (card nahi chahiye), token copy karke box mein paste karo.'
        : 'Cloud ke liye remove.bg ki free API key chahiye — remove.bg/api par free account (50 images/month), key neeche box mein paste karo.',
    );
  }

  onStage({
    stage: 'run',
    message: provider === 'huggingface' ? 'Hugging Face BiRefNet ko bhej raha hoon…' : 'remove.bg ko bhej raha hoon…',
  });

  const response = await fetch(`/api/remove?provider=${provider}`, {
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
