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
