# unbg

Astro + Tailwind CSS 4 site, scaffolded in-sandbox with agent skills aur Astro Docs MCP.

## Stack

| Layer | Choice | Version |
|---|---|---|
| Framework | [Astro](https://docs.astro.build/) (static) | 7.4.13 |
| Styling | [Tailwind CSS](https://tailwindcss.com/) via `@tailwindcss/vite` | 4.3.5 |
| Design tokens | [`DESIGN.md`](./DESIGN.md) — Vercel design language (from opendesignmd.com) | alpha |
| Node | 26.13.1 LTS | — |

## Commands

```bash
npm install        # deps
npm run dev        # http://localhost:4321
npm run build      # → dist/
npm run preview    # preview build
```

## Project structure

```
unbg/
├── DESIGN.md                  # design language / tokens (Vercel)
├── .mcp.json                  # Astro Docs MCP (streamable HTTP)
├── .vscode/mcp.json           # same MCP, VS Code format
├── skills-lock.json           # installed agent skills (locked versions)
├── .claude/skills/
│   ├── web-design-guidelines/ # vercel-labs/agent-skills
│   └── tailwind-4-docs/       # lombiq/tailwind-agent-skills
├── astro.config.mjs           # tailwindcss vite plugin
└── src/
    ├── layouts/Base.astro     # head/meta/OG, skip link, Nav + Footer shell
    ├── components/            # Nav, Footer, Hero, CodeBlock, Faq
    ├── pages/index.astro      # home: hero, why, how, presets, use cases, API, compare, FAQ
    └── styles/global.css      # @theme tokens from DESIGN.md + base/components layer
```

## Run it (Termux / Android) — one command, then just `unbg`

```bash
# 1) once: install the launcher (repo is private, so the raw fetch needs the token)
TOK=<your-github-token>
curl -fsSL -H "Authorization: Bearer $TOK" \
  https://raw.githubusercontent.com/vishubizzonl-ship-it/unbg/main/scripts/termux-setup.sh \
  -o "$PREFIX/bin/unbg" && chmod +x "$PREFIX/bin/unbg" && UNBG_TOKEN=$TOK unbg

# 2) from now on, every time:
unbg
```

`unbg` fetches the latest `main` (fast-forward), reinstalls `node_modules` **only**
when `package.json` changed, starts the dev server **detached** in a restart loop,
and opens the browser. No `git pull`, no `npm install` by hand.

| Command | Does |
|---|---|
| `unbg` | setup + start (auto-update included) |
| `unbg status` | is the server up? |
| `unbg logs` | follow the server log |
| `unbg stop` / `unbg restart` | obvious |
| `unbg update` | pull + reinstall, no start |

### Live auto-update (no deploy needed)

`unbg` starts a **supervisor** (`scripts/unbg-watch.sh`), not a bare dev server:

```
unbg  ──▶  supervisor (nohup, detached)
             ├─ child: astro dev  (restarted automatically if it dies)
             └─ timer: every UNBG_CHECK_INTERVAL s (default 180)
                  git fetch origin main
                  ├─ new commit, code files only → fast-forward; Astro's HMR
                  │                               picks it up, server untouched
                  └─ package.json / lockfile / astro.config changed → npm install
                                                       + restart child
```

So the site stays **live on localhost the whole time** and follows `main` by itself —
no deploy, no manual `git pull`, no restart. Progress is logged to
`~/.unbg-server.log` (`unbg logs`).

```bash
UNBG_CHECK_INTERVAL=60 unbg restart    # check every minute instead of 3
```

### Something else is on port 4321?

Other background-remover projects can hold the same port, and a screenshot cannot
prove which codebase is serving. Two tools exist for this:

```bash
curl -s localhost:4321/version.json   # {"app":"unbg", ...} = the real thing
unbg doctor                           # folder, remote, commit, port, verdict
```

`unbg doctor` prints the app folder, git remote, HEAD, supervisor pid/port, then
fetches `/version.json` from the port and tells you whether it is unbg or a
foreign app (including its `<title>`), so the fix is one line:

```bash
unbg stop && unbg
```

The launcher also refuses to clone into a folder that already holds another
project, and points at `UNBG_DIR=$HOME/unbg-live unbg` instead of overwriting it.

### Poll rate — down to one second

```bash
unbg live 1      # near real-time (≈86,400 GitHub requests/day)
unbg live 10     # sensible balance
unbg live 180    # calm
```

Default is **1 second** (`~/.unbg-interval`). The supervisor never runs a full `git fetch` on every tick. It first does a single
`git ls-remote` (one tiny request, no objects) and compares the commit SHA with
`HEAD`; only a genuine difference triggers the fetch + fast-forward. That is what
makes a 1-second poll survivable at all.

Honest cost of `unbg live 1`: ~1 request/second while the server runs — battery,
mobile data, and a real chance of GitHub throttling the connection. 10–30 s feels
instant in practice for a dev loop.

### Zero-command mode (Termux:Boot + widget)

`unbg` installs two extra entry points on Termux, so after the one-time setup you
never type anything:

| Trigger | File installed | Needs |
|---|---|---|
| **Phone boot** → server starts by itself | `~/.termux/boot/70-unbg` | the [Termux:Boot](https://f-droid.org/packages/com.termux.boot/) add-on app (open it once after installing) |
| **Home screen tap** → server + browser | `~/.shortcuts/unbg` | the [Termux:Widget](https://f-droid.org/packages/com.termux.widget/) add-on; long-press home → Widgets → Termux |
| A notification appears when it's live | `termux-notification` | termux-api package (`pkg install termux-api`) |

Both scripts take a wake-lock first, so Android doesn't freeze the server while
the screen is off. Re-run `unbg autostart` any time to rewrite them.

Environment overrides: `UNBG_DIR` (default `~/unbg`), `UNBG_PORT` (default `4321`),
`UNBG_TOKEN` (saved once to `~/.unbg-token`, `chmod 600`).

**Why `--ignore-scripts`:** `onnxruntime-node`'s postinstall downloads a Linux/CUDA
binary that has no Android build. `stubs/` replaces `onnxruntime-node` and `sharp`
with empty packages via npm `overrides`, so the install is ~342 MB instead of ~700 MB
and skips the native download entirely. The browser path is unaffected — it uses
`onnxruntime-web`.

**Phone reality check:** the heavy models (BiRefNet, RMBG-1.4) need 100 MB+ of weights
and a GPU. On a mid-range phone start with **MODNet** (7 MB), then try RMBG-1.4.

## When the browser says "localhost refused to connect"

That message always means one thing: nothing is listening on port 4321 on *that* device.
The app is not deployed — it lives in Termux on your phone, so the server has to be running.

```bash
unbg status     # is it up? prints the last log line when it is not
unbg            # start (pulls the latest commit, then opens Chrome)
unbg logs       # what the server is saying
```

Why it can stop on its own, and what is now done about it:

| cause | fix |
|---|---|
| Termux closed / Android killed it | `unbg` — and install Termux:Boot so `unbg` runs at boot (`unbg` does this for you on Termux) |
| battery optimisation | `unbg` takes a `termux-wake-lock`; also exempt Termux from battery optimisation in Android settings |
| dev server wedged (process alive, port dead) | the supervisor now probes `/version.json` every 15 s and recycles the child after 4 misses (~60 s) |
| another app squatting on 4321 | `unbg fix`, or `unbg port 4322 && unbg restart` |

## On-device models (Phase 2)

Everything runs in the browser via `@huggingface/transformers` → `onnxruntime-web`
(WebGPU when an adapter exists, quantised/WASM on CPU). No upload, no API key.

| Model | Size | License | Commercial | Notes |
|---|---|---|---|---|
| **BEN2** (`onnx-community/BEN2-ONNX`) | 209 MB | MIT | ✅ | new default on WebGPU — best hair/fur/transparent edges |
| **ormbg** (`onnx-community/ormbg-ONNX`) | 84 MB | Apache-2.0 | ✅ | new default on CPU-only devices |
| BiRefNet lite 512 (`onnx-community/BiRefNet_lite-ONNX`) | 109 MB | MIT | ✅ | balanced |
| MVANet (`onnx-community/MVANet-ONNX`) | 202 MB | MIT | ✅ | fine structures, WebGPU |
| BiRefNet lite 1024 (`jiabins0303/birefnet-lite-1024-webgpu`) | 115 MB | MIT | ✅ | higher resolution, WebGPU |
| RMBG-1.4 (`kittypdf/RMBG-1.4-transformersjs`) | 44 MB | Non-commercial (BRIA) | ❌ | fastest general model — testing only |
| BiRefNet full (`onnx-community/BiRefNet-ONNX`) | 470 MB | MIT | ✅ | heaviest |
| IS-Net (`onnx-community/ISNet-ONNX`) | 176 MB | AGPL-3.0 | ❌ | strong on complex scenes |
| MODNet (`Xenova/modnet`) | 7 MB | Apache-2.0 | ✅ | portraits only, lightest |

The UI picks the strongest model the device can actually run: **BEN2** when a
WebGPU adapter exists, **ormbg** otherwise.

### Mask cleanup (`src/lib/mask.ts`)

Raw segmentation output has three kinds of junk — stray blobs, interior holes and
mushy edges. `cleanMask()` fixes all three on the low-res plane (pure functions,
unit-tested with `npm test`):

1. `smoothstep` sharpens the 0.35–0.65 probability ramp,
2. `keepLargest` drops disconnected blobs smaller than 2 % of the subject
   (a genuinely large second object is kept),
3. `fillHoles` floods from the border and promotes anything unreached,
4. `feather` softens the edge by one pixel.

On a MODNet portrait this cut partial-alpha pixels from 4.4 % → 1.4 % and removed
98 px of stray mask. Toggle it with the **Clean up** checkbox.

Registry lives in `src/lib/models.ts`; the engine is `src/lib/remove-bg.ts`.
The library is dynamically imported, so the page ships **9 KB JS** until someone
actually drops an image.

CPU is the slow path: on a GPU-less laptop the 99 MB+ models can take minutes or
run out of memory. The UI warns and points at MODNet when it detects CPU.

## Agent skills

Installed with [`skills`](https://www.skills.sh):

```bash
npx skills add https://github.com/vercel-labs/agent-skills \
  --skill web-design-guidelines --copy -a claude-code
npx skills add https://github.com/lombiq/tailwind-agent-skills \
  --skill tailwind-4-docs --copy -a claude-code
```

- **web-design-guidelines** — audits UI code against Vercel's Web Interface Guidelines
  (pulls fresh rules from `raw.githubusercontent.com/vercel-labs/web-interface-guidelines`).
- **tailwind-4-docs** — Tailwind v4 docs navigator. Needs a one-time local docs snapshot:

  ```bash
  python skills/tailwind-4-docs/scripts/sync_tailwind_docs.py --accept-docs-license
  ```

  (Snapshot initialized 2026-11-19 — 199 docs, local-only, gitignored. Refresh if older than a week.)
  pulls a local, private snapshot. `references/gotchas.md` is the fallback until then.)

## Astro Docs MCP

Server: `https://mcp.docs.astro.build/mcp` (streamable HTTP, remote — nothing to install).

```json
{ "mcpServers": { "astro-docs": { "type": "http", "url": "https://mcp.docs.astro.build/mcp" } } }
```

- Claude Code: `claude mcp add --transport http astro-docs https://mcp.docs.astro.build/mcp`
- Config already committed: `.mcp.json` (generic) and `.vscode/mcp.json` (VS Code / Copilot).
- Exposes `search_astro_docs` for up-to-date Astro documentation.

## Notes

- Tailwind 4 uses CSS-first config — koi `tailwind.config.js` nahi. Theme tokens
  `src/styles/global.css` ke `@theme` block mein add karo.
- Design tokens (colors, type scale, spacing) `DESIGN.md` mein documented hain —
  naya UI banate waqt wahin se values lo.

### Two cloud engines, both free

| option in the model list | what it costs | key |
| --- | --- | --- |
| `Cloud · Hugging Face BiRefNet — free token, no card` | free account, rate-limited GPU quota | `hf_…` from huggingface.co/settings/tokens |
| `Cloud · remove.bg — free 50/month, best edges` | 50 images / month | remove.bg/api |

Both go through the same local proxy (`POST /api/remove?provider=…`); the key is
read from localStorage, sent as a header, and never stored by the server. The
Hugging Face path uploads to the BiRefNet demo Space, queues the named endpoint,
reads the SSE stream and downloads the PNG — every failure has its own sentence
(401 bad token, quota/queue error, no output, network).

### Puter.js — no key, the visitor pays

`Puter.js — no key, user pays` loads `https://js.puter.com/v2/` lazily and asks one
of Puter's image-editing models to remove the background (`puter.ai.txt2img` with
`input_images`). The visitor signs in to Puter once and their own credits cover
the call: no key on our side, no backend, nothing to configure.

Trade-offs stated plainly in the UI: it is a *generative* edit, so it is the
weakest of the three engines on hair and thin edges, it can redraw the subject
slightly, and transparency is not guaranteed — the status line reports the share
of pixels that really became transparent so the result is never oversold. When
that share is low, the app says to use the on-device or remove.bg engine.

### The three headline models

| model | size | when to pick it |
| --- | --- | --- |
| `BEN2 — best edges` | ~209 MB | hair, fur, transparent edges; needs WebGPU |
| `BRIA RMBG 2.0 — best on people` | ~366 MB | portraits, cleanest skin/hair boundary; heavy, WiFi + WebGPU |
| `BiRefNet lite 512` | ~109 MB | the balance point — good edges, runs on GPU or CPU |

RMBG 2.0's official repo (`briaai/RMBG-2.0`) is gated behind a licence click and
its free tier is non-commercial, so the app loads the ungated ONNX re-upload
`kn4666/bria-rmbg-2.0-web` (same BiRefNet architecture, `model_type: birefnet`,
which transformers.js maps to image segmentation). The entry is marked
⚠ non-commercial in the picker; commercial use needs a BRIA licence.

### IMG.LY — the worker engine

`@imgly/background-removal` (v1.7.0) is in the model list as
`IMG.LY isnet — Web Worker`. It runs its own ONNX model through
onnxruntime-web inside a Web Worker (`src/workers/imgly.worker.ts`), so the page
never blocks: the drop zone, scrolling and the model picker stay responsive
while a ~44 MB model downloads and runs on first use.

* Wrapper: `src/lib/imgly.ts` — one worker per page, reused, progress mapped to
  the status line (`Model download… 42%`, `Removing background… 100%`).
* License: the library is **AGPL-3.0** (the model is IS-Net). Running it locally
  is fine; if unbg is ever offered as a hosted service, the AGPL obliges you to
  publish the source of that service. `remove.bg` / Hugging Face options do not.
* First run downloads model + wasm from `staticimgly.com` (~44 MB), cached after
  that. Offline use needs those assets copied into the project.

## Optional local server (Phase 5) — full BiRefNet on your own machine

The browser engine is the default and stays the default. When you want
server-grade quality — full BiRefNet (972 MB), batch jobs, or an API for other
tools — run the inference service in `server/`:

```bash
cd server
python -m pip install --user -r requirements.txt
python scripts/fetch_models.py silueta               # 44 MB — the lightweight default
python scripts/selftest.py                           # proves it actually works
python -m uvicorn unbg_server.main:app --port 8000
```

Then pick **Server · BiRefNet Portrait** (or General / U²-Net-p) in the model
dropdown. The app pings `/api/health`, shows the URL it will use, and sends the
photo only to *that* address. There is no API key because there is no third
party — the server is yours.

What the server adds on top of the browser engine:

| | browser | local server |
|---|---|---|
| models | 9 on-device + 4 remote | **Silueta (44 MB default)** + BiRefNet General / Portrait / Matting / Lite / Lite-2K / HR / 512, U²-Net, U²-Net-p |
| weights | ≤ 366 MB, WebGPU-bound | 44 MB default; BiRefNet checkpoints up to 1.1 GB from the author's own ONNX release (MIT) |
| matting | ViTMatte (99 MB) | closed-form matting (pymatting) on the mask |
| big photos | one pass, downscaled | `detail=high` → tiled 1024 px crops, native detail |
| batch | one at a time | `POST /api/batch`, 8 files, per-file JSON |
| licence | MIT / Apache / AGPL mix | MIT + Apache-2.0 only |

Both paths feed the same result panel: before/after slider, transparent / white /
black / custom-colour preview (composited on canvas, so switching never re-runs a
model), and a full-resolution PNG download.

Full API, configuration table and model list: [`server/README.md`](server/README.md).

## Optional cloud path (bring your own key)

On-device stays the default — nothing leaves the phone unless you ask. For the
hard photos there is one cloud entry in the model list:

```
Cloud · remove.bg — free 50/month, best edges
```

1. Make a free key at <https://www.remove.bg/api> (50 images / month).
2. Choose the Cloud model in the app and paste the key into the box that appears.
3. Upload as usual. The key stays in this browser's localStorage; the local dev
   server forwards the file to remove.bg with it (`POST /api/remove`).

The proxy is dev middleware (`src/integrations/cloud-proxy.mjs`), so the static
build needs no adapter and no secret in the bundle. Errors are translated:
`402` → "free 50 credits khatam ho gaye is mahine", `401/403` → key galat,
`429` → too many requests, no key → where to get one.

### The port is pinned, on purpose

`unbg` serves on **4321** and stays there, because a URL that never changes is
worth more than a clever port picker — the browser should never have to guess.
If something else owns 4321, the launcher kills stray `astro dev` processes and
retries; if a foreign app still holds it, you get one sentence with two options
(close that app, or pin another port with `unbg port 4322`). It no longer walks
4321…4340 and quietly moves the URL underneath you.

### When the server will not come up

```bash
unbg fix     # kill leftovers, pull, install, then start on a free port
```

`unbg start` no longer trusts the port it was given. It asks `/version.json`
first, and if something else owns the port it walks 4321-4340 and saves the
first free one. If astro quietly moves to another port instead (Vite does that
when a port is taken), the log line `Local http://localhost:NNNN` is read back
and that port is adopted and saved. If the dev server still refuses to start,
the last 12 lines of the server log are printed right there, and two more ports
are tried before giving up.
