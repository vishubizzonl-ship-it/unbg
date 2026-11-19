# unbg inference API

A production-shaped background remover you run yourself: **FastAPI + ONNX Runtime**, with
**Silueta (44 MB) as the default** and **BiRefNet** available when you want the heavier,
higher-resolution checkpoints. No paid API, no API keys anywhere, no proprietary weights.
Licences: MIT and Apache-2.0 only.

Why Silueta is the default: it is a 44 MB, 320×320 CPU graph that handles **both people and
products**, loads in ~100 ms, and keeps peak RSS around 570 MB — measured, see
[Benchmarks](#benchmarks). BiRefNet stays one `?model=` away for the photos that deserve it.

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
      silueta.py       Silueta — the lightweight default (320x320, 44 MB, zoom refine)
      birefnet.py      BiRefNet General / Portrait / Matting / Lite / Lite-2K / HR / 512
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
python scripts/fetch_models.py silueta                # 44 MB — the default
python scripts/fetch_models.py birefnet-portrait      # optional: 972 MB, best on people
python scripts/selftest.py                            # proves it works
python -m uvicorn unbg_server.main:app --host 127.0.0.1 --port 8000
```

Then open <http://127.0.0.1:8000/docs>, or:

```bash
curl -F "file=@photo.jpg" "http://127.0.0.1:8000/api/remove?model=birefnet-portrait&background=transparent" -o cutout.png
```

## Models

`silueta` is the default and the only model you need for a lightweight deployment.
Every BiRefNet row is the **author's own ONNX export** — `ZhengPeng7/BiRefNet` release `v1`,
MIT, no third-party conversion and no gated repo:

| id | weights | input | size | licence | use it for |
|---|---|---|---|---|---|
| **`silueta`** | `silueta.onnx` (rembg release) | 320² | **44 MB** | Apache-2.0 | **default** — portraits and products, CPU-only, ~1 s |
| `birefnet-general` | `BiRefNet-general-epoch_244.onnx` | 1024² | 972 MB | MIT | products, objects, animals, mixed scenes |
| `birefnet-portrait` | `BiRefNet-portrait-epoch_150.onnx` | 1024² | 972 MB | MIT | people, hair, skin, glasses |
| `birefnet-matting` | `BiRefNet-matting-epoch_100.onnx` | 1024² | 972 MB | MIT | soft alpha: hair, fur, veils, glass |
| `birefnet-lite` | `BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx` | 1024² | 224 MB | MIT | fast CPU, thumbnails, batch |
| `birefnet-lite-2k` | `BiRefNet_lite-general-2K-epoch_232.onnx` | 2560×1440 | 331 MB | MIT | big photos, more edge detail on a small budget |
| `birefnet-hr` | `BiRefNet_HR-general-epoch_130.onnx` | 2048² | 1099 MB | MIT | 2K+ photos and print |
| `birefnet-512` | onnx-community fp16 export | 512² | 473 MB | MIT | low-RAM machines |
| `u2net` | any U²-Net ONNX you trust | 320² | 176 MB | Apache-2.0 | CPU-only servers |
| `u2netp` | `u2netp.onnx` (rembg release) | 320² | 5 MB | Apache-2.0 | tiny boxes, high throughput |

The 1024/2048/2560 columns are the exported, fixed input sizes; the engine reads them from the
graph and pads/resizes to match, so you never have to tell it. Output is `1x1xHxW` logits →
sigmoid → alpha, normalised with the author's ImageNet mean/std.

`model=auto` (the default) resolves to `UNBG_DEFAULT_MODEL`, which is `silueta`. Aliases
`light`, `fast`, `default` and `photo` all point at Silueta. Nothing is downloaded behind your
back: an uninstalled model answers `503 model_unavailable` with the exact command to fix it.

**One model in memory at a time.** `UNBG_SINGLE_MODEL=1` (default) evicts the previous engine
before loading another one, so asking for a 972 MB BiRefNet never leaves it sitting next to a
second graph. Set it to `0` only on a box with RAM to spare.

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

1. **the engine predicts a mask** — Silueta at 320² (BiRefNet at 1024²/2048² when chosen) —
   sigmoid/min-max, then resized back to the **source resolution** with bicubic, so the PNG you
   get out has the same pixels in as the JPG you put in.
2. **smoothstep** remap tightens the 0.4–0.6 band so edges are not muddy.
3. **closed-form matting** (`pymatting`) re-solves alpha inside an unknown band built from the
   mask — this is what makes hair and fur survive. The solve is cropped to that band, so it uses
   ~3.4x less peak memory than solving the whole photo (measured: 273 MB vs 730 MB at 1.5 MP,
   identical alpha). Skipped above `UNBG_MATTE_MAX_PIXELS`.
4. **feather** removes the last stair-step (three box passes, no scipy).
5. **foreground decontamination** — BiRefNet's own `refine_foreground` (blur-fusion from
   Photoroom's fast-foreground-estimation): the background colour is un-mixed out of the
   semi-transparent pixels, so hair stops carrying a white rim onto a coloured page.
6. **composite** on transparent / white / any `#rrggbb`, or return the RGBA PNG untouched.

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

## Benchmarks

Measured on this repo's test box — **2 vCPU, 2 GB RAM, ONNX Runtime 1.32 CPU, no GPU**, threads
set with `UNBG_THREADS`. Numbers from `python scripts/benchmark.py`; reproduce them on your own
hardware before sizing anything.

| model | weights | load | inference¹ | peak RSS² | IoU³ | αMAE³ (after refine) |
|---|---|---|---|---|---|---|
| **silueta** (1 thread) | 44 MB | 102 ms | **1857 ms** | 571 MB | 0.975 | 0.006 |
| **silueta** (2 threads) | 44 MB | 98 ms | **1130 ms** | 570 MB | 0.975 | 0.006 |
| u2netp (2 threads) | 5 MB | 49 ms | **326 ms** | 420 MB | 0.960 | 0.009 |
| BiRefNet *any* | 224–1099 MB | — | **not runnable here** | >1.5 GB needed | — | — |

¹ one `engine.predict()` on a 500×625 portrait, median of 3, mask upscaled to source resolution.
² whole process, model alone in its own subprocess (that is why a 44 MB model shows 570 MB — most
of it is ONNX Runtime, numpy and Pillow, not weights).
³ against a generated test card with known alpha (soft-edged subject + hair-like strands over a
textured background): IoU at α>0.5, mean absolute alpha error.

What the numbers say, plainly:

- **Silueta beats u2netp on quality at ~3.5x the time.** IoU 0.976 vs 0.960, αMAE 0.006 vs 0.009 —
  the extra 39 MB buys visibly better edges, and a second still beats every cloud round-trip.
- **Threads matter more than anything.** 1 → 2 threads cut 1857 ms to 1130 ms on a 2-core box.
  On an 8-core phone or server set `UNBG_THREADS=8` and expect another large step.
- **Both stay under 600 MB of RAM**, which is the whole point of replacing BiRefNet as the default:
  a 972 MB fp32 BiRefNet graph needs 1.5–2 GB per pass and OOMs a 2 GB box (verified — the
  process is killed at 1024² and at 512²).
- **Refinement is cheap and honest**: smoothstep + feather + decontamination cost 25–135 ms and
  keep αMAE at 0.006. Closed-form matting adds 200–2000 ms and is the one knob to turn off
  (`?matte=false`) when throughput matters more than hair.
- **Zoom refine (`?second_pass=true`) is off by default because it did not earn its place**:
  against the ground-truth card it scored *worse* than a single pass at 0.10 padding (IoU 0.966 vs
  0.975) and reached parity at 0.40, for ~2x the time. It is still there for small-subject photos.

```bash
python scripts/benchmark.py                                   # silueta vs u2netp on the test card
python scripts/benchmark.py photo.jpg product.jpg --runs 5    # your own images
```

## Configuration

Everything is an env var; nothing is a secret.

| var | default | meaning |
|---|---|---|
| `UNBG_MODEL_DIR` | `./models` | where weights live |
| `UNBG_RESULT_DIR` | `./results` | where `store=true` output lands |
| `UNBG_DEFAULT_MODEL` | `silueta` | used by `model=auto` |
| `UNBG_SINGLE_MODEL` | `1` | keep exactly one model resident |
| `UNBG_SECOND_PASS` | `0` | Silueta zoom refine (opt-in, ~2x time) |
| `UNBG_INPUT_SIZE` | `1024` | inference long side (static exports override it) |
| `UNBG_THREADS` | half the cores | ONNX Runtime intra-op threads |
| `UNBG_MAX_CONCURRENCY` | `1` | simultaneous inference passes |
| `UNBG_USE_GPU` | `1` | GPU chain for BiRefNet; **Silueta is CPU-only by design** |
| `UNBG_MATTE` | `1` | closed-form matting on by default |
| `UNBG_MATTE_MAX_PIXELS` | `2500000` | skip matting above this, use the network mask |
| `UNBG_DECONTAMINATE` | `1` | un-mix background colour out of the alpha edge |
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

Checked here: **35/35 tests**, and **Silueta really runs** — real weights, real ONNX Runtime,
real numbers in the table above, original resolution preserved (800×600 JPG in → 800×600 RGBA PNG
out, verified over HTTP with `x-unbg-model: silueta`). Also verified: single-model eviction,
band-limited matting memory (273 MB vs 730 MB at 1.5 MP), foreground decontamination, the
official BiRefNet asset's I/O contract `input_image [1,3,1024,1024]` → `output_image
[1,1,1024,1024]`, downloads, registry, every `/api/*` route.

**Not checked here:** a full BiRefNet pass — this box has 2 GB of RAM and a 1024² BiRefNet graph
needs 1.5–2 GB, so the process is OOM-killed (fp32 and fp16, 1024² and 512² alike).

Honest quality note: on a curly-hair portrait shot against a dark background, neither Silueta nor
U²-Net recovers the hair volume — 320² masks are coarse and dark-on-dark is the hard case. Silueta
keeps more of it than u2netp, and `?model=birefnet-portrait` (or `birefnet-matting`) is the answer
when hair is the whole point and you have ~2 GB of RAM to give.

**Not checked here:** a full BiRefNet pass. This box has 2 GB of RAM and a 1024² BiRefNet graph
needs 1.5–2 GB, so the process is OOM-killed (both the fp32 and fp16 builds, at 1024² and
512²). Run `python scripts/selftest.py photo.jpg --model birefnet-512` on your own machine —
it prints timings, mask statistics, and writes the cutout next to your photo.
