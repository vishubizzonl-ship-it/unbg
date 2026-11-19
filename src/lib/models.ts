/**
 * Model registry for the on-device background remover.
 *
 * Everything here runs in the browser (transformers.js → onnxruntime-web,
 * WebGPU with WASM fallback). No server, no API key, no upload.
 *
 * `licenseOk` = safe for a commercial product. Models flagged false are
 * included so they can be compared side by side — the UI marks them and they
 * must not ship in the final product.
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
  /** Needs WebGPU (no usable CPU graph) */
  webgpuOnly?: boolean;
  /**
   * Which runtime serves this entry. `imgly` runs @imgly/background-removal in a
   * Web Worker (its own ONNX + wasm bundle). `server` talks to the self-hosted
   * FastAPI + BiRefNet API in `server/` — still open source, still no keys.
   */
  engine?: 'transformers' | 'imgly' | 'puter' | 'server';
}

export const MODELS: BgModel[] = [
  {
    id: 'onnx-community/BEN2-ONNX',
    label: 'BEN2 — best edges',
    note: '2025 state of the art on hair, fur and transparent edges. Needs WebGPU',
    license: 'MIT',
    licenseOk: true,
    sizeMb: 209,
    speed: 'slow',
    scope: 'general',
    dtype: 'fp16',
    webgpuOnly: true,
  },
  {
    id: 'kn4666/bria-rmbg-2.0-web',
    label: 'BRIA RMBG 2.0 — best on people',
    note: 'BRIA ka naya model — portraits par sabse saaf, par 366 MB aur bhari (WiFi + WebGPU)',
    license: 'BRIA RMBG-2.0 (free non-commercial)',
    licenseOk: false,
    sizeMb: 366,
    speed: 'slow',
    scope: 'portrait',
    dtype: 'q8',
  },
  {
    id: 'onnx-community/BiRefNet_lite-ONNX',
    label: 'BiRefNet lite 512',
    note: 'Balanced: clean edges for its size, runs on GPU or CPU',
    license: 'MIT',
    licenseOk: true,
    sizeMb: 109,
    speed: 'balanced',
    scope: 'general',
    dtype: 'fp16',
  },
  {
    id: 'onnx-community/ormbg-ONNX',
    label: 'ormbg — best on CPU',
    note: 'Strong general-purpose cutout that also runs without a GPU',
    license: 'Apache-2.0',
    licenseOk: true,
    sizeMb: 84,
    speed: 'balanced',
    scope: 'general',
    dtype: 'fp16',
  },
  {
    id: 'onnx-community/MVANet-ONNX',
    label: 'MVANet',
    note: 'Excellent on fine structures (wires, glasses, mesh). Heavy',
    license: 'MIT',
    licenseOk: true,
    sizeMb: 202,
    speed: 'slow',
    scope: 'general',
    dtype: 'fp16',
    webgpuOnly: true,
  },
  {
    id: 'jiabins0303/birefnet-lite-1024-webgpu',
    label: 'BiRefNet lite 1024',
    note: 'Higher-resolution variant — finer detail, 4× slower',
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
    note: 'Full-size BiRefNet — heavy, best on difficult subjects',
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
    note: 'Strong on complex scenes; AGPL — only if unbg itself is open source',
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
  {
    id: 'imgly/isnet-fp16',
    label: 'IMG.LY isnet fp16 — better edges',
    note: 'IMG.LY library, half precision — baal aur kinare theek, worker mein chalta hai',
    license: 'AGPL-3.0 (library)',
    licenseOk: true,
    sizeMb: 88,
    speed: 'balanced',
    scope: 'general',
    dtype: 'fp16',
    engine: 'imgly',
  },
  {
    id: 'imgly/isnet-quint8',
    label: 'IMG.LY isnet quint8 — fastest',
    note: 'IMG.LY library, quantised — sabse halka, par edges par background reh jaata hai',
    license: 'AGPL-3.0 (library)',
    licenseOk: true,
    sizeMb: 44,
    speed: 'fast',
    scope: 'general',
    dtype: 'uint8',
    engine: 'imgly',
  },
  {
    id: 'puter/image-edit',
    label: 'Puter.js — no key, user pays',
    note: 'Puter ke image model se edit — sign-in ek baar, aapke credits; edges par baaki models se kamzor',
    license: 'Puter terms',
    licenseOk: true,
    sizeMb: 0,
    speed: 'slow',
    scope: 'general',
    dtype: 'uint8',
    engine: 'puter',
  },
  {
    id: 'api/birefnet-portrait',
    label: 'Server · BiRefNet Portrait — best on people',
    note: 'Apne local server par full BiRefNet (972 MB, MIT) — portrait aur baal par sabse saaf; server/ chalu hona chahiye',
    license: 'MIT',
    licenseOk: true,
    sizeMb: 0,
    speed: 'fast',
    scope: 'portrait',
    dtype: 'fp32',
    engine: 'server',
  },
  {
    id: 'api/birefnet-matting',
    label: 'Server · BiRefNet Matting — softest hair',
    note: 'Local server par matting checkpoint — baal, fur, ghunghat par sabse honest alpha',
    license: 'MIT',
    licenseOk: true,
    sizeMb: 0,
    speed: 'fast',
    scope: 'portrait',
    dtype: 'fp32',
    engine: 'server',
  },
  {
    id: 'api/birefnet-general',
    label: 'Server · BiRefNet General — products & objects',
    note: 'Local server par general BiRefNet — products, janwar aur mixed scene par best',
    license: 'MIT',
    licenseOk: true,
    sizeMb: 0,
    speed: 'fast',
    scope: 'general',
    dtype: 'fp32',
    engine: 'server',
  },
  {
    id: 'api/u2netp',
    label: 'Server · U²-Net-p — 5 MB fallback',
    note: 'Local server ka sabse halka model — CPU par bhi fast, edges BiRefNet se kam saaf',
    license: 'Apache-2.0',
    licenseOk: true,
    sizeMb: 0,
    speed: 'fast',
    scope: 'general',
    dtype: 'fp32',
    engine: 'server',
  },
];

export const DEFAULT_MODEL_ID = 'onnx-community/ormbg-ONNX';

/**
 * Best default for the device we actually detected: the SOTA model needs a
 * GPU, so CPU-only visitors start with the strongest graph that runs on CPU.
 */
export function recommendedModelId(device: 'webgpu' | 'wasm'): string {
  return device === 'webgpu' ? 'onnx-community/BEN2-ONNX' : DEFAULT_MODEL_ID;
}
