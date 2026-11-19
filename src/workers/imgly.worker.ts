/**
 * IMG.LY background removal, off the main thread.
 *
 * @imgly/background-removal runs an ONNX model through onnxruntime-web and
 * downloads ~40 MB of model + wasm on first use. Doing that on the main thread
 * freezes scrolling and the drop zone, so the whole thing lives in a worker:
 * the page only ever sends a Blob and receives progress numbers.
 */

import { removeBackground } from '@imgly/background-removal';

export interface ImglyRequest {
  id: number;
  file: Blob;
  model: 'isnet' | 'isnet_fp16' | 'isnet_quint8';
}

export type ImglyMessage =
  | { id: number; type: 'progress'; key: string; current: number; total: number }
  | { id: number; type: 'done'; buffer: ArrayBuffer; mime: string; ms: number }
  | { id: number; type: 'error'; message: string };

const post = (message: ImglyMessage, transfer?: Transferable[]) => {
  (self as unknown as Worker).postMessage(message, transfer ?? []);
};

self.onmessage = async (event: MessageEvent<ImglyRequest>) => {
  const { id, file, model } = event.data;
  const started = performance.now();
  try {
    const blob = await removeBackground(file, {
      model,
      // CPU is the honest default: the GPU path needs a WebGPU adapter that
      // many phones do not expose, and it fails after a 40 MB download.
      device: 'cpu',
      output: { format: 'image/png' },
      progress: (key: string, current: number, total: number) => {
        post({ id, type: 'progress', key, current, total });
      },
    });
    const buffer = await blob.arrayBuffer();
    post({ id, type: 'done', buffer, mime: blob.type || 'image/png', ms: performance.now() - started }, [buffer]);
  } catch (error) {
    post({ id, type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
