# unbg — Plan

> Background remover for the web. Competitor: **remove.bg**. Design language: **`DESIGN.md`** (Vercel tokens). Stack: **Astro 7 + Tailwind CSS 4**.
> Ye document research + plan hai. Code iske approval ke baad likhunga.

---

## 0. Sabse pehle: ek badi khabar (research se mila)

remove.bg khud band ho raha hai. Unki site ke har page par banner hai:

> "remove.bg's background removal is moving to Canva. The standalone website will no longer be available from **1 December 2026, 9:00am CET**."

FAQ page (`/faq`) ke hisaab se:
- remove.bg 2021 se Canva ka part hai, ab functionality Canva platform mein merge ho rahi hai
- **API users ko Leonardo.ai par bheja ja raha hai** ("Go to Leonardo.ai for API Pricing")
- Desktop app, Photoshop/Figma/GIMP/Sketch plugins, Zapier/Make integrations — sab affected
- FAQ mein literally ek sawaal hai: *"Is there an alternative to remove.bg?"*

**Matlab:** aaj **19 Nov 2026** hai — sirf **12 din** baaki hain jab ek 100M+ users wala, top-ranking tool apni site band kar raha hai. Uske users (especially **API/developer + bulk/ecommerce** users) ko naya ghar chahiye. Ye normal competition nahi hai — ye ek **timing window** hai.

**Isliye strategy badalti hai:** hum "thoda better remove.bg" nahi ban rahe. Hum ban rahe hain **"remove.bg ka replacement, jo zyada fast, zyada private aur zyada sasta hai — bina login."** Positioning, copy, SEO pages — sab isi angle se.

---

## 1. remove.bg par kya kya hai (feature audit)

Maine unki home, pricing, integrations aur FAQ pages padhi hain. Ye unka feature set hai:

| Area | remove.bg ke paas kya hai |
|---|---|
| **Core tool** | Upload box — drag & drop, file picker, **paste from clipboard**, **URL se import** |
| | 5 sample images (people / product / animal / car / graphics) — "no image? try these" |
| | Transparent PNG output, "stunning quality" demos |
| | **Magic Brush** — result ko manually refine karna |
| | **AI background generator** — custom backdrop, "no prompt needed" |
| **Bulk** | Bulk editing, **up to 500 images/minute** (paid tier) |
| **Integrations** | Photoshop, Figma, GIMP, Sketch, PowerPoint, desktop app (Win/Mac/Linux), **CLI**, Zapier/Make (2,000+ apps), Shopify, Google Drive, Gmail, LinkedIn, RSS, SFTP/FTP, Flickr |
| **Developer** | REST API (docs, credits, rate limit), enterprise 100k+ images/yr, premium support |
| **Commercial** | Credits model: subscription + pay-as-you-go; free tier; refunds on shutdown |
| **Trust** | GDPR compliance, ToS/privacy/cookie policies, "contribute image to improve AI" opt-in dialog |
| **Content/SEO** | Big blog, help center, sample-images gallery, success stories, testimonials (Sony Music, TechCrunch, Bosch, Audi, eBay, Douglas) |
| **Use-case landings** | Individuals, photographers, marketing, developers, e commerce, media, car dealerships, enterprise + `remove.bg/g/<vertical>` style pages |
| **Platform** | Mobile apps, email newsletter, multi-language |

**Unki kamiyaab (jo hum exploit karenge):** credit system confusing hai (FAQ mein hi 7 sawaal credits par), signup/login wall result ke aage, free output resolution par limit, bulk sirf paid, API pricing opaque, aur ab shutdown confusion.

---

## 2. Hum kaise better banenge — ideas (impact ke hisaab se ranked)

### P0 — MVP mein hi chahiye (yehi "better than remove.bg" ka proof hai)

| # | Idea | Kyun jeetega |
|---|---|---|
| 1 | **Bina login, bina watermark, full resolution** — pehla result turant download | remove.bg ka sabse bada friction point. Hum ise marketing headline banayenge. |
| 2 | **On-device mode (privacy)** — browser mein hi segmentation (ONNX / WebGPU), image device se bahar nahi jaati | Koi competitor strong claim nahi karta. Photographers, lawyers, HR, medical, govt users ke liye killer. Server mode fallback rahega. |
| 3 | **Batch queue** — 50 images ek saath drag, per-file progress, **ZIP download** + CSV manifest | remove.bg bulk ko paid rakhta hai; hum free tier mein bhi batch (limit ke saath) denge. |
| 4 | **Real editor, sirf "remove" nahi** — undo/redo history, before-after slider, brush/eraser + feather edge refine, mask zoom | Magic Brush parity + better UX. History ke bina editing painful hoti hai. |
| 5 | **Output presets** — transparent PNG, white bg (ecommerce), brand color, gradient, AI background prompt, aur marketplace sizes (Amazon 2000px, Etsy, Instagram 1080, passport photo 35×45mm) | User ko "background remove karke main kya karunga" ka answer turant milta hai — ek hi jagah. |
| 6 | **Format + size control** — PNG / JPG / **WebP / AVIF**, quality slider, target file-size | Real pain: marketplaces ka file-size limit. |
| 7 | **API jo actually developer-friendly ho** — open docs, **live playground (bina signup)**, curl/JS/Python snippets, clear pricing, rate-limit headers, webhooks | remove.bg API users ab Leonardo par ja rahe hain. Hum unhe 1 hafte mein capture kar sakte hain. |
| 8 | **Zero-JS-first, ultra-fast site** — Astro static, uploader ek hi island, Lighthouse 95+ | remove.bg heavy hai. Speed khud ek feature hai — aur hero copy bhi. |

### P1 — launch ke 2–4 hafte baad

| # | Idea | Note |
|---|---|---|
| 9 | **SEO engine**: content collections se 100+ intent pages — "remove background from logo / signature / car photo / saree photo / passport photo / product photo", pain-wise + language-wise | Ye market **search** se jeeta jaata hai. Programmatic pages = free traffic. |
| 10 | **Hinglish + regional languages** (hi, mr, ta, te, bn) | remove.bg India-first nahi hai; hum Patna se hain, ye natural edge hai. |
| 11 | **Transparent pricing calculator** — slider: kitni images/month → total cost, side-by-side vs Canva/Leonardo | Pricing opacity unki weak spot hai. |
| 12 | **Compare pages** — "unbg vs Canva background remover", "vs PhotoRoom", "vs Leonardo" — honest table | High-intent SEO + trust. |
| 13 | **No-attribution + auto-delete policy** — "images 24h mein delete, on-device mode mein kabhi upload nahi" | Privacy page ko marketing asset banao. |
| 14 | **Browser extension + Figma plugin + Zapier app** | remove.bg ke plugins band ho rahe hain — gap turant Bhar sakta hai. |

### P2 — nice to have (abhi nahi)

| # | Idea |
|---|---|
| 15 | Batch API + webhook automation (ecommerce catalog pipelines) |
| 16 | Team workspaces, shared brand presets, audit log |
| 17 | Upscale + shadow/reflection generator (product shots ke liye) |
| 18 | Public status page + p95 latency dashboard (developer trust) |
| 19 | Magic-link accounts — sirf history/saved presets ke liye, tool ke liye nahi |
| 20 | White-label embeddable widget (`<script>` se kisi bhi site par) |

**Anti-copy rule (aapka instruction follow):** remove.bg ka UI/design copy *nahi* karenge — na unka green accent, na unka checkerboard-hero layout, na unka card style. Hume sirf **features/behaviour** ka pata hona chahiye. Visual language 100% `DESIGN.md` (Vercel) se aayegi: near-white canvas, ink black CTAs, hairline borders, mono eyebrows, mesh gradient **sirf hero scale par**.

---

## 3. Site map (Phase 1)

```
/                     Home — hero + uploader + "how it works" + use cases + API teaser
/remove-background    Tool page (deep-linkable state, ?mode=on-device)
/batch                Batch uploader (queue + ZIP)
/api                  API landing (playground, snippets, pricing table)
/pricing              Pricing + calculator
/use-cases            Index  →  /use-cases/ecommerce, /photographers, /passport-photo, /developers
/blog                 Content collections (SEO engine)
/help                 Help center (FAQ accordions)
/privacy, /terms      Legal (privacy-led copy)
/404
```

Nav: `Tool · Batch · API · Pricing · Use cases · Blog` + right side `GitHub` (ghost) + `Start free` (black pill 100px).
Footer: product / use cases / developers / legal + mono `built with astro` line.

---

## 4. Design system → Tailwind 4 mapping (from `DESIGN.md`)

Tailwind 4 mein `tailwind.config.js` nahi hota — tokens `src/styles/global.css` ke `@theme` block mein jaate hain.

```css
@import "tailwindcss";

@theme {
  /* colors — DESIGN.md */
  --color-ink: #171717;         /* primary / headings */
  --color-body: #4d4d4d;        /* body copy */
  --color-mute: #888888;        /* captions, eyebrows */
  --color-hairline: #ebebeb;    /* borders, dividers */
  --color-hairline-strong: #a1a1a1;
  --color-canvas: #ffffff;
  --color-canvas-soft: #fafafa; /* alternating bands */
  --color-canvas-soft-2: #f5f5f5;
  --color-link: #0070f3;
  --color-success: #0070f3;
  --color-error: #ee0000;

  /* gradient stack — hero scale ONLY */
  --color-grad-develop-start: #007cf0;  --color-grad-develop-end: #00dfd8;
  --color-grad-preview-start: #7928ca;  --color-grad-preview-end: #ff0080;
  --color-grad-ship-start:    #ff4d4d;  --color-grad-ship-end:    #f9cb28;

  /* radius */
  --radius-sm: 6px;    /* nav-scale buttons */
  --radius-md: 8px;    /* cards */
  --radius-lg: 12px;   /* large cards */
  --radius-pill: 100px;/* marketing CTAs */

  /* spacing scale */
  --spacing-xxs: 4px; --spacing-xs: 8px;  --spacing-sm: 12px; --spacing-md: 16px;
  --spacing-lg: 24px; --spacing-xl: 32px; --spacing-2xl: 40px; --spacing-3xl: 48px;
  --spacing-4xl: 64px;--spacing-5xl: 96px;--spacing-6xl: 128px;--spacing-section: 192px;

  /* type — Geist/Inter + mono (display ceiling 600) */
  --font-sans: "Geist", "Inter", system-ui, -apple-system, sans-serif;
  --font-mono: "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace;
  --text-display-xl: 48px;  --text-display-xl--line-height: 48px;  --text-display-xl--letter-spacing: -2.4px;
  --text-display-lg: 32px;  --text-display-lg--line-height: 40px;  --text-display-lg--letter-spacing: -1.28px;
  --text-display-md: 24px;  --text-display-md--line-height: 32px;  --text-display-md--letter-spacing: -0.96px;
}
```

**Rules jo code review mein enforce honge (`DESIGN.md` Do's & Don'ts):**

- CTAs: marketing = black `pill` (100px), nav = `sm` (6px) — **ek screen par dono scale mix nahi**
- Headlines: sentence-case, weight **600 max**, aggressive negative tracking, often period-terminated
- Buttons/eyebrows/code: mono jahan technical ho
- Cards: **stacked soft shadows + inset hairline ring**, kabhi ek heavy drop-shadow nahi
- Mesh gradient: hero scale only — icon par nahi, single color mein nahi
- Bands alternate canvas-soft → canvas → ink (dark band = depth cue)
- Koi 6th accent color nahi

**Layout shell:** max-w 1200px container, nav 64px hairline-bottom, `section` spacing 192px desktop / 96px mobile, 3-up feature grids on 1px hairline gap grid, footer dark band.

**Accessibility / quality bar (`web-design-guidelines` skill se):** icon buttons par `aria-label`, uploader keyboard+paste support, `focus-visible` rings, `aria-live="polite"` progress announcements, `prefers-reduced-motion` respect, `alt` text, semantic headings + skip link, form `label`s, `transform/opacity`-only animation.

---

## 5. Tech architecture (Astro 7 + Tailwind 4)

```
src/
├─ layouts/Base.astro            # nav + footer + skip link + meta/OG
├─ components/
│  ├─ Nav.astro  Footer.astro
│  ├─ Hero.astro                 # mesh gradient, hero-scale only
│  ├─ Uploader.astro             # ← the ONE client island
│  ├─ CompareSlider.astro        # before/after (progressive enhancement)
│  ├─ PricingTable.astro  FeatureGrid.astro  Faq.astro  CodeBlock.astro
├─ pages/
│  ├─ index.astro  remove-background.astro  batch.astro
│  ├─ api/index.astro  pricing.astro
│  ├─ use-cases/[slug].astro     # content collection
│  ├─ blog/[slug].astro          # content collection
│  └─ legal/[slug].astro
├─ actions/index.ts              # Astro Actions: removeBackground, batchRemove
├─ lib/                          # model call, validation, image utils
├─ content/                      # use-cases/, blog/, legal/ (collections)
└─ styles/global.css             # @theme tokens (upar wala)
```

**Decisions (Astro Docs MCP se verify kiye points):**
- **Default static**; sirf uploader island hydrate (`client:load` / `client:visible`)
- File upload → **Astro Actions** (zero-JS form fallback milta hai) — *"Pages must be on-demand rendered when calling actions using a form action"* → `/remove-background` par `export const prerender = false`
- Blog/use-case pages → **Content Collections** (type-safe, SEO pages programmatically)
- Images → `astro:assets` (`<Image>`), AVIF/WebP, LCP hero image priority
- Privacy mode → browser-side model; server mode → same API behind action (fallback)
- No client framework needed for v1 (vanilla TS in island) — Astro ke saath sabse fast

**Removal engine options (decide karna hai):**

| Option | Pros | Cons |
|---|---|---|
| A. Client-side ONNX/WebGPU (e.g. RMBG-1.4 / BiRefNet) | free, private, zero server cost, "never uploaded" claim | first load ~20–50MB model, slow devices |
| B. Hosted API (Replicate / fal / Leonardo) | instant, best quality | per-image cost, privacy claim kamzor |
| C. Self-hosted (GPU/CPU worker) | control + privacy in server mode | ops overhead |

**Recommendation:** **A + B hybrid** — default "Private mode (on-device)", toggle "Best quality (cloud)". Model weights lazily load with progress bar; agar WebGPU nahi hai to cloud par switch.

---

## 6. Phases (approval ke baad)

| Phase | Deliverable | Verification (RULES.md ke mutabik) |
|---|---|---|
| **P1 — Shell (is hafte)** | `global.css` @theme tokens, `Base/Nav/Footer`, home hero + hairline feature grid + use-case cards + API teaser + footer | `npm run build` pass, Lighthouse ≥95, mobile 375px screenshot, `file:line` audit against web-design-guidelines |
| **P2 — Uploader MVP** | drag/drop + paste + URL, transparent PNG download, before/after slider, progress `aria-live`, error states | real image par end-to-end run, downloaded PNG ka alpha channel verify, keyboard-only flow |
| **P3 — Editor + presets** | brush refine, undo/redo, bg presets (white/brand/AI), format+size control | 3 sample images par real output, output size/format assertions |
| **P4 — Batch + API page** | queue, ZIP, docs playground, snippets | 10 images batch → ZIP content count check |
| **P5 — SEO + pricing + legal** | use-case & blog collections, pricing calculator, privacy/terms | `sitemap.xml`, meta/OG per page, internal links audit |

Har phase ke baad: `git commit` + `git push`, real output proof (curl/preview + file checks), phir hi "ho gaya".

---

## 7. Success metrics (kya "better" matlab)

- First removal: **< 3s** end-to-end (cloud) / **< 1.5s** on-device after load
- Signup required? **Never** for core tool
- Lighthouse: perf **≥95**, a11y **≥100**, LCP **< 1.5s** (static pages)
- Free tier: full-resolution, batch up to 10 (vs zero elsewhere)
- SEO: 100+ indexable intent pages live in 60 days
- Supabase-free stack: static + 1 action endpoint; cost ≈ $0 up to thousands of images/day (hybrid mode)

---

## 8. Risks / jo aapko decide karna hai

1. **Engine** — hybrid (client model + cloud fallback) OK hai? Ya sirf cloud se start karein (faster launch, weaker privacy story)?
2. **Hosting** — Cloudflare / Vercel? (Astro static + server action endpoint chahiye)
3. **Paisa** — free tier limit kya: 10/day? 25/month? Koi paid plan abhi chahiye ya baad mein?
4. **Name/domain** — "unbg" hi rahega? Domain `unbg.com` available hai ya `.app` / `.in`?
5. **Canva/Leonardo se compare pages** — legally safe hai (facts + comparison only), par aap chahoge to skip.
6. **Scope** — P1+P2 pehle karein (recommended: 12 din ka window hai), ya poora P1–P5 ek saath?

---

## 9. Agar haan bolo to main next turn mein

1. `src/styles/global.css` mein poora `@theme` (DESIGN.md tokens) likh dunga
2. `Base/Nav/Footer` + home page ka pehla real screen banaunga (Vercel language, hero mesh gradient)
3. `npm run build` + dev preview + guideline audit karke push karunga

Bas bolo: **"P1 shuru karo"** ya **"poore plan par X/Y change karo"**.
