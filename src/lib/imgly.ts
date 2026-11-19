/**
 * Client wrapper around the IMG.LY worker.
 *
 * One worker per page, reused across runs so the model is downloaded and
 * warmed once. Any worker-level crash is reported as a normal Error, so the
 * caller keeps a single error path.
 */

import type { ImglyMessage, ImglyRequest } from '../workers/imgly.worker';

export const IMGLY_MODEL_PREFIX = 'imgly/';

/** Model list id → the library's `model` option. */
export function imglyModelFor(id: string): ImglyRequest['model'] {
  return id.endsWith('quint8') ? 'isnet_quint8' : 'isnet_fp16';
}

export interface ImglyResult {
  blob: Blob;
  ms: number;
}

let worker: Worker | null = null;
let nextId = 1;

const pending = new Map<
  number,
  {
    resolve: (result: ImglyResult) => void;
    reject: (error: Error) => void;
    onProgress: (message: Extract<ImglyMessage, { type: 'progress' }>) => void;
  }
>();

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('../workers/imgly.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<ImglyMessage>) => {
    const message = event.data;
    const entry = pending.get(message.id);
    if (!entry) return;
    if (message.type === 'progress') {
      entry.onProgress(message);
      return;
    }
    pending.delete(message.id);
    if (message.type === 'done') {
      entry.resolve({ blob: new Blob([message.buffer], { type: message.mime }), ms: message.ms });
    } else {
      entry.reject(new Error(message.message));
    }
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || 'IMG.LY worker crashed');
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

export function removeBackgroundImgly(
  file: Blob,
  model: ImglyRequest['model'] = 'isnet_quint8',
  onProgress?: (percent: number, label: string) => void,
): Promise<ImglyResult> {
  const active = ensureWorker();
  const id = nextId++;
  return new Promise<ImglyResult>((resolve, reject) => {
    pending.set(id, {
      resolve,
      reject,
      onProgress: (message) => {
        const percent = message.total ? Math.round((message.current / message.total) * 100) : 0;
        const label = message.key.includes('fetch') ? 'Model download' : 'Removing background';
        onProgress?.(percent, label);
      },
    });
    active.postMessage({ id, file, model } satisfies ImglyRequest);
  });
}

/** Drop the worker (and its ~40 MB of wasm/model state) when the page goes away. */
export function disposeImgly(): void {
  worker?.terminate();
  worker = null;
  pending.clear();
}
