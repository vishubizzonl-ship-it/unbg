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

const REMOVEBG = 'https://api.remove.bg/v1.0/removebg';
/**
 * Hugging Face's BiRefNet demo space. Free to call with a free HF token (no
 * card); the token authorises the ZeroGPU quota, which is why anonymous calls
 * answer with a bare 'error' event.
 */
const HF_SPACE = process.env.UNBG_HF_SPACE || 'https://not-lain-background-removal.hf.space';
const HF_API = 'image';

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

const sendPng = (res, png) => {
  res.statusCode = 200;
  res.setHeader('content-type', 'image/png');
  res.setHeader('cache-control', 'no-store');
  res.end(png);
};

/**
 * Hugging Face path: upload → queue the named endpoint → read the SSE stream →
 * fetch the produced PNG. Gradio's API is three calls, so all three failures
 * need their own sentence.
 */
async function viaHuggingFace(res, body, token) {
  const auth = { authorization: `Bearer ${token}` };
  try {
    const form = new FormData();
    form.append('files', new Blob([body]), 'photo.jpg');
    const uploaded = await fetch(`${HF_SPACE}/gradio_api/upload?upload_id=unbg${Date.now()}`, {
      method: 'POST',
      headers: auth,
      body: form,
    });
    if (!uploaded.ok) {
      return json(res, uploaded.status === 401 ? 401 : 502, {
        error: 'UPLOAD',
        status: uploaded.status,
        message:
          uploaded.status === 401
            ? 'Hugging Face token galat lag raha hai.'
            : `Hugging Face upload fail hua (HTTP ${uploaded.status}) — space busy ho sakta hai, thodi der baad try karo.`,
      });
    }
    const paths = await uploaded.json();
    const path = Array.isArray(paths) ? paths[0] : paths;

    const queued = await fetch(`${HF_SPACE}/gradio_api/call/${HF_API}`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        data: [{ path, orig_name: 'photo.jpg', mime_type: 'image/jpeg', meta: { _type: 'gradio.FileData' } }],
      }),
    });
    if (!queued.ok) {
      return json(res, 502, {
        error: 'QUEUE',
        message: `Hugging Face ne request queue nahi ki (HTTP ${queued.status}).`,
      });
    }
    const { event_id: eventId } = await queued.json();

    const stream = await fetch(`${HF_SPACE}/gradio_api/call/${HF_API}/${eventId}`, { headers: auth });
    const text = await stream.text();

    if (/event:\s*error/.test(text)) {
      return json(res, 429, {
        error: 'HF_QUOTA',
        message:
          'Hugging Face space ne error diya — free GPU quota khatam ya queue full. Thodi der baad try karo, ya remove.bg model chuno.',
      });
    }

    // The final "complete" event carries the output images; take the last one.
    const lines = text.split('\n').filter((line) => line.startsWith('data: '));
    let fileUrl = null;
    for (const line of lines) {
      const payload = line.slice(6).trim();
      if (!payload || payload === 'null') continue;
      try {
        const parsed = JSON.parse(payload);
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          const url = item?.url ?? (item?.path ? `${HF_SPACE}/gradio_api/file=${item.path}` : null);
          if (url && /image|\.png|\.webp|\.jpe?g|file=/.test(url)) fileUrl = url;
        }
      } catch {
        /* keep scanning the stream */
      }
    }

    if (!fileUrl) {
      return json(res, 502, {
        error: 'NO_OUTPUT',
        message: 'Hugging Face se PNG nahi aaya — dobara try karo.',
      });
    }

    const png = await fetch(fileUrl, { headers: auth });
    if (!png.ok) {
      return json(res, 502, { error: 'DOWNLOAD', message: `Result download fail hua (HTTP ${png.status}).` });
    }
    return sendPng(res, Buffer.from(await png.arrayBuffer()));
  } catch (error) {
    return json(res, 502, {
      error: 'NETWORK',
      message: `Hugging Face tak nahi pahunch paya (${error instanceof Error ? error.message : 'unknown'}).`,
    });
  }
}

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
          const provider = String(url.searchParams.get('provider') ?? 'removebg');
          if (!key) {
            return json(res, 400, {
              error: 'NO_KEY',
              message:
                provider === 'huggingface'
                  ? 'Hugging Face token chahiye — huggingface.co/settings/tokens par free account banao (card nahi chahiye), token copy karke box mein paste karo.'
                  : 'remove.bg API key chahiye — remove.bg/api se free key (50 images/month) lo, aur box mein paste karo.',
            });
          }

          try {
            if (provider === 'huggingface') {
              return await viaHuggingFace(res, body, key);
            }

            const endpoint = process.env.UNBG_CLOUD_URL || REMOVEBG;
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

            return sendPng(res, Buffer.from(await upstream.arrayBuffer()));
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
