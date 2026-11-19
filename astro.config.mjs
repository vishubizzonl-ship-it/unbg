// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import cloudProxy from './src/integrations/cloud-proxy.mjs';

// https://astro.build/config
export default defineConfig({
  // Optional cloud path: /api/remove forwards to remove.bg with the user's own
  // key. Dev-only middleware, so the static build needs no adapter.
  integrations: [cloudProxy()],
  server: { host: true, port: 4321 },
  vite: {
    plugins: [tailwindcss()],
    server: { allowedHosts: true },
  },
});
