# unbg inference API

A production-shaped background remover you run yourself: **FastAPI + ONNX Runtime + BiRefNet**,
with **U²-Net** as an optional lightweight fallback. No paid API, no API keys anywhere, no
proprietary weights. Every model is MIT or Apache-2.0.

This sits *next to* the browser app in `../` — the on-device engine stays the default for
unbg; this service is for when you want server-grade quality, batch jobs, or an API for
other tools.

```
server/
  unbg_server/
    main.py            FastAPI app: /api/remove, /api/batch, /api/models, /api/health
    pipeline.py        bytes in → transparent PNG + metadata out (no FastAPI in here)
    io_images.py       magic-byte validation, EXIF, pixel caps, PNG encode
    refine.py          smoothstep → closed-form matting (pymatting) → feather
    backgrounds.py     transparent / white / #rrggbb compositing
    config.py          every knob, from env only
    errors.py          one JSON error shape with correct status codes
    engines/
      base.py          Engine contract + tiled full-resolution prediction
      birefnet.py      BiRefNet General / Portrait / 512-fp16 / Lite
      u2net.py         U²-Net / U²-Net-p (drop-in ONNX)
      registry.py      the model registry — add a model here, nothing else changes
      _ort.py          ONNX Runtime session, provider chain, memory settings
  scripts/
    fetch_models.py    resumable downloads from the HF Hub (and rembg for U²-Net)
    selftest.py        runs a real model end to end and tells you if it worked
  tests/               28 tests: validation, colours, refinement, every endpoint
```

## Quick start

```bash
cd server
python -m pip install --user -r requirements.txt      # --user if the venv is not yours
python scripts/fetch_models.py --list
python scripts/fetch_models.py birefnet-512           # 473 MB — good default
python scripts/fetch_models.py birefnet-portrait      # 972 MB — best on people
python scripts/selftest.py                            # proves it works
python -m uvicorn unbg_server.main:app --host 127.0.0.1 --port 8000
```

Then open <http://127.0.0.1:8000/docs>, or:

```bash
curl -F "file=@photo.jpg" "http://127.0.0.1:8000/api/remove?model=birefnet-portrait&background=transparent" -o cutout.png
```

## Models

| id | weights | size | licence | use it for |
|---|---|---|---|---|
| `birefnet-general` | `onnx-community/BiRefNet-ONNX` | 972 MB | MIT | products, objects, animals, mixed scenes |
| `birefnet-portrait` | `onnx-community/BiRefNet-portrait-ONNX` | 972 MB | MIT | people, hair, skin, glasses |
| `birefnet-512` | `onnx-community/BiRefNet_512x512-ONNX` | 473 MB | MIT | full BiRefNet quality at half the RAM |
| `birefnet-lite` | `onnx-community/BiRefNet_lite-ONNX` | 224 MB | MIT | fast CPU, thumbnails, batch |
| `u2net` | any U²-Net ONNX you trust | 176 MB | Apache-2.0 | CPU-only servers |
| `u2netp` | `u2netp.onnx` (rembg release) | 5 MB | Apache-2.0 | tiny boxes, high throughput |

`model=auto` (the default) picks `birefnet-portrait` when it is installed and the request says
`subject=person`, otherwise the configured default. Nothing is downloaded behind your back:
an uninstalled model answers `503 model_unavailable` with the exact command to fix it.

## API

| method | path | what it does |
|---|---|---|
| `GET` | `/api/health` | version, providers, threads, loaded models |
| `GET` | `/api/models` | registry with availability, licences, sizes |
| `POST` | `/api/remove` | one image → PNG (query: `model`, `background`, `matte`, `detail`, `subject`, `store`) |
| `POST` | `/api/batch` | up to `UNBG_MAX_BATCH` images → per-file JSON with result URLs |
| `GET` | `/api/results/{name}.png` | a stored result (expires after `UNBG_RESULT_TTL`) |
| `DELETE` | `/api/results/{name}.png` | drop a stored result early |

`/api/remove` returns the PNG itself, with the interesting numbers in headers:
`X-Unbg-Model`, `X-Unbg-Meta` (JSON: size, coverage, timings, matting path), and
`X-Unbg-Result` when `store=true`.

Errors are always `{"error": "<code>", "message": "<what to do>"}` —
`unsupported_media` 415, `too_large` 413, `unreadable_image` 422, `unknown_model` 404,
`model_unavailable` 503, `result_expired` 410.

## Quality pipeline

1. **BiRefNet** predicts a mask at 1024² (or its native size) — sigmoid, resized back to the
   source resolution.
2. **smoothstep** remap tightens the 0.4–0.6 band so edges are not muddy.
3. **closed-form matting** (`pymatting`) re-solves alpha inside an unknown band built from the
   mask — this is what makes hair and fur survive. Skipped above `UNBG_MATTE_MAX_PIXELS`.
4. **feather** removes the last stair-step (three box passes, no scipy).
5. **composite** on transparent / white / any `#rrggbb`, or return the RGBA PNG untouched.

`detail=high` switches step 1 to tiled inference: overlapping 1024 px crops blended with a
raised-cosine window, so a 24 MP photo keeps native edge detail instead of a 1024 px upscale.

## Performance and memory

- **One ONNX session per model, cached** — loading a 972 MB graph per request would be slow.
- **`UNBG_MAX_CONCURRENCY` (default 1)** caps simultaneous passes with a semaphore; batch of 8
  is queued, not 8 graphs in RAM at once.
- **CPU memory arena off by default** (`UNBG_ORT_ARENA=1` to enable) so peak RSS stays
  predictable — a BiRefNet pass at 1024² needs roughly 1.5–2 GB.
- **GPU with automatic fallback**: the provider chain is TensorRT → CUDA → ROCm → DirectML →
  CPU, so `onnxruntime-gpu` is used when present and CPU quietly takes over when it is not.
- Measured in this repo's test box (2 threads, CPU): U²-Net-p **0.6 s** for a 500×625 photo
  (320² inference), plus **0.7–1.9 s** for closed-form matting depending on size. BiRefNet
  timings are not published here because this box cannot run them — measure yours with
  `scripts/selftest.py` before sizing a server.
- **Large images**: anything over `UNBG_MAX_PIXELS` (60 MP default) is downscaled with the
  original dimensions reported in the metadata; `detail=high` keeps full-resolution detail.
- **Results are swept** on startup and expiry, so `/api/results` cannot fill the disk.

## Configuration

Everything is an env var; nothing is a secret.

| var | default | meaning |
|---|---|---|
| `UNBG_MODEL_DIR` | `./models` | where weights live |
| `UNBG_RESULT_DIR` | `./results` | where `store=true` output lands |
| `UNBG_DEFAULT_MODEL` | `birefnet-lite` | used by `model=auto` |
| `UNBG_INPUT_SIZE` | `1024` | inference long side (static exports override it) |
| `UNBG_THREADS` | half the cores | ONNX Runtime intra-op threads |
| `UNBG_MAX_CONCURRENCY` | `1` | simultaneous inference passes |
| `UNBG_USE_GPU` | `1` | build a GPU provider chain when available |
| `UNBG_MATTE` | `1` | closed-form matting on by default |
| `UNBG_MATTE_MAX_PIXELS` | `2500000` | skip matting above this, use the network mask |
| `UNBG_MAX_UPLOAD_BYTES` | `20971520` | 20 MB per file |
| `UNBG_MAX_PIXELS` | `60000000` | downscale above this |
| `UNBG_MAX_BATCH` | `8` | files per `/api/batch` call |
| `UNBG_ALLOWED_ORIGINS` | `localhost:4321, …` | CORS allowlist for the web app |
| `UNBG_RESULT_TTL` | `3600` | seconds a stored result lives |
| `UNBG_ONNX_VARIANT` | – | force `model_fp16.onnx` when your runtime likes fp16 |

## Adding a model later

```python
# unbg_server/engines/mymodel.py
from .base import Engine, EngineInfo

class MyEngine(Engine):
    def __init__(self):
        super().__init__()
        self.info = EngineInfo(id="mymodel", label="My Model", family="…",
                               license="Apache-2.0", size_mb=42, best_for="…")
    def available(self): return self.path().exists()
    def load(self): ...
    def _infer(self, rgb):  # float32 HxWx3 in 0..1 → alpha HxW in 0..1
        ...
```

Then one line in `engines/registry.py`. `/api/models`, validation, the provider chain, the
batch endpoint and the frontend dropdown pick it up automatically.

## Tests

```bash
cd server && python -m pytest -q          # 28 tests, no weights needed
```

The suite uses a fake engine so it runs in ~3 s, and it covers the things that actually break
in production: mislabelled uploads, truncated PNGs, 60 MP phone photos, path traversal on
`/api/results`, batch limits, and a missing-model 503.

## Verified here vs. not

Checked in this sandbox: 28/28 tests, U²-Net-p real inference end to end (0.3 s, 360 MB peak,
hair preserved, transparent and `#ff8800` outputs written), model downloads, registry,
`/api/*` responses.

**Not checked here:** a full BiRefNet pass. This box has 2 GB of RAM and a 1024² BiRefNet graph
needs 1.5–2 GB, so the process is OOM-killed (both the fp32 and fp16 builds, at 1024² and
512²). Run `python scripts/selftest.py photo.jpg --model birefnet-512` on your own machine —
it prints timings, mask statistics, and writes the cutout next to your photo.
