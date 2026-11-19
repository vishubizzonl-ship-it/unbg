import type { APIRoute } from 'astro';
import { MODELS } from '../lib/models';

/**
 * Identity endpoint.
 *
 * Several background-remover UIs can end up on the same port, and a screenshot
 * cannot prove which codebase is serving. This answers it in one request:
 *
 *   curl -s localhost:4321/version.json
 */
import { execSync } from 'node:child_process';

function buildId(): string {
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

export const GET: APIRoute = () =>
  new Response(
    JSON.stringify(
      {
        app: 'unbg',
        tagline: 'remove the background. keep every pixel.',
        version: '0.3.1',
        build: buildId(),
        theme: 'ink-on-canvas (Vercel design language)',
        models: {
          count: MODELS.length,
          default_at_runtime: 'device-aware — BEN2 on WebGPU, ormbg on CPU',
          labels: MODELS.map((m) => m.label),
        },
        device_runtime: 'transformers.js + onnxruntime-web (WebGPU / WASM)',
        uploads: 'none — inference runs in the browser',
      },
      null,
      2,
    ),
    { headers: { 'content-type': 'application/json; charset=utf-8' } },
  );
