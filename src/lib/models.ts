/**
 * Model registry for the on-device background remover.
 *
 * Everything here runs in the browser (transformers.js → onnxruntime-web,
 * WebGPU with WASM fallback). No server, no API key, no upload.
 *
 * `licenseOk` = safe for a commercial product. Models flagged false are
 * included because the user asked to test them side by side — the UI marks
 * them clearly and they must not ship in the final product.
 */

export type Dtype = 'fp32' | 'fp16' | 'q8' | 'int8' | 'uint8';

export interface BgModel {
  /** Hugging Face repo id */
  id: string;
  /** Short name shown in the UI */
  label: string;
  /** One-line description of the trade-off */
  note: string;
  /** Model card license */
  license: string;
  /** Commercially usable? */
  licenseOk: boolean;
  /** Approx. download in MB for the chosen precision */
  sizeMb: number;
  /** Expected feel on a modern laptop GPU */
  speed: 'fast' | 'balanced' | 'slow';
  /** Subject coverage */
  scope: 'general' | 'portrait';
  /** Precision requested from transformers.js */
  dtype: Dtype;
  /** Only works on WebGPU (hits storage-buffer limits on WASM) */
  webgpuOnly?: boolean;
}

export const MODELS: BgModel[] = [
  {
    id: 'onnx-community/BiRefNet_lite-ONNX',
    label: 'BiRefNet lite 512',
    note: 'Balanced default — cleanest edges for its size, runs on GPU or CPU',
    license: 'MIT',
    licenseOk: true,
    sizeMb: 99,
    speed: 'balanced',
    scope: 'general',
    dtype: 'fp16',
  },
  {
    id: 'jiabins0303/birefnet-lite-1024-webgpu',
    label: 'BiRefNet lite 1024',
    note: 'Highest detail on hair, fur and thin edges — 4× slower',
    license: 'MIT',
    licenseOk: true,
    sizeMb: 115,
    speed: 'slow',
    scope: 'general',
    dtype: 'fp16',
    webgpuOnly: true,
  },
  {
    id: 'kittypdf/RMBG-1.4-transformersjs',
    label: 'RMBG-1.4',
    note: 'The popular open cutout model — very fast, decent on products',
    license: 'Non-commercial (BRIA)',
    licenseOk: false,
    sizeMb: 44,
    speed: 'fast',
    scope: 'general',
    dtype: 'fp16',
  },
  {
    id: 'onnx-community/BiRefNet-ONNX',
    label: 'BiRefNet full',
    note: 'Full-size BiRefNet — best quality, heaviest. May fall back to CPU',
    license: 'MIT',
    licenseOk: true,
    sizeMb: 470,
    speed: 'slow',
    scope: 'general',
    dtype: 'fp16',
  },
  {
    id: 'onnx-community/ISNet-ONNX',
    label: 'IS-Net',
    note: 'Strong on complex scenes; AGPL — only usable if unbg itself is open source',
    license: 'AGPL-3.0',
    licenseOk: false,
    sizeMb: 176,
    speed: 'balanced',
    scope: 'general',
    dtype: 'fp16',
  },
  {
    id: 'Xenova/modnet',
    label: 'MODNet',
    note: 'Portraits only, tiny download, fastest of all',
    license: 'Apache-2.0',
    licenseOk: true,
    sizeMb: 7,
    speed: 'fast',
    scope: 'portrait',
    dtype: 'q8',
  },
];

export const DEFAULT_MODEL_ID = MODELS[0].id;
