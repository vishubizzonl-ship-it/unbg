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
    ├── layouts/Layout.astro
    ├── pages/index.astro
    └── styles/global.css      # @import "tailwindcss";
```

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
