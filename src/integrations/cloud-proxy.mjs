/**
 * Local proxy for the optional cloud path.
 *
 * The browser cannot call remove.bg directly (no CORS, and the API key must not
 * sit in a public bundle), so the dev server — which is this app's whole runtime
 * in Termux — forwards the request. The key arrives per request from the page
 * (localStorage) or from UNBG_REMOVEBG_KEY in the environment; it is never
 * written to disk by this proxy and never logged.
 *
 * Dev-only by design: the on-device engine stays the default, and no adapter is
 * needed for a static build.
 */

const ENDPOINT = 'https://api.remove.bg/v1.0/removebg';

const json = (res, status, payload) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
};

const readBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
};

export default function cloudProxy() {
  return {
    name: 'unbg-cloud-proxy',
    hooks: {
      'astro:server:setup': ({ server }) => {
        server.middlewares.use(async (req, res, next) => {
          const url = new URL(req.url ?? '/', 'http://localhost');
          if (url.pathname !== '/api/remove') return next();

          if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });

          let body;
          try {
            body = await readBody(req);
          } catch {
            return json(res, 400, { error: 'Could not read the upload' });
          }
          if (!body.length) return json(res, 400, { error: 'Empty upload' });
          if (body.length > 30 * 1024 * 1024) return json(res, 413, { error: 'Image is larger than 30 MB' });

          const key = String(req.headers['x-unbg-key'] ?? process.env.UNBG_REMOVEBG_KEY ?? '').trim();
          if (!key) {
            return json(res, 400, {
              error: 'NO_KEY',
              message: 'remove.bg API key chahiye — remove.bg/api se free key (50 images/month) lo, aur box mein paste karo.',
            });
          }

          const endpoint = process.env.UNBG_CLOUD_URL || ENDPOINT;

          try {
            const form = new FormData();
            form.append('image_file', new Blob([body]), 'image');
            form.append('size', 'auto');
            form.append('format', 'png');

            const upstream = await fetch(endpoint, {
              method: 'POST',
              headers: { 'X-Api-Key': key },
              body: form,
            });

            if (!upstream.ok) {
              const detail = await upstream.text().catch(() => '');
              // 402 = out of credits, 403 = bad key, 429 = rate limited.
              const message =
                upstream.status === 402
                  ? 'remove.bg ke free 50 credits khatam ho gaye is mahine.'
                  : upstream.status === 403 || upstream.status === 401
                    ? 'API key galat lag rahi hai.'
                    : upstream.status === 429
                      ? 'Bahut zyada requests — thodi der baad try karo.'
                      : `remove.bg ne error diya (HTTP ${upstream.status}).`;
              return json(res, upstream.status, { error: 'UPSTREAM', status: upstream.status, message, detail: detail.slice(0, 300) });
            }

            const png = Buffer.from(await upstream.arrayBuffer());
            res.statusCode = 200;
            res.setHeader('content-type', 'image/png');
            res.setHeader('cache-control', 'no-store');
            res.end(png);
          } catch (error) {
            return json(res, 502, {
              error: 'NETWORK',
              message: `Cloud service tak nahi pahunch paya (${error instanceof Error ? error.message : 'unknown'}).`,
            });
          }
        });
      },
    },
  };
}
