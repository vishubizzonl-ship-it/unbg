# RULE — unbg folder ke liye (sirf isi folder par lagu)

> Ye file verbatim hai. Iske andar ka text **same to same** rakha gaya hai — edit/typo fix mat karna.

## Rule (verbatim)

es folder main coding ke leye installed git,node js aur folder ke under installed astro js,wise jobs ka digine MD, guidelines skill, tailwind 4 skill, tailwind CSS ,astro js MCP sirf enhei sab chijo ka use karna aur jo command main bola gya hai bus vahi kaam karna hai kaam best karna hai aur kaam karney ke baad check karna hai kaam sahi sahi hua hai ya nhi aur real main kaam hua bhi hai ya nhi

---

## Enforcement (agent protocol — har coding command par)

Jab bhi user is folder (`/home/user/unbg`) mein coding ke liye koi command de:

1. **Effective command = user ka command + upar wala Rule (verbatim)** — rule apne aap attach hota hai, user ko bolna nahi padta.
2. **Sirf allowed toolchain:** git, Node.js, Astro JS, `DESIGN.md` (Vercel design language), `web-design-guidelines` skill, `tailwind-4-docs` skill, Tailwind CSS 4, Astro Docs MCP — inhe hi use karna, koi bahar ka tool/library bina bole nahi.
3. **Scope lock:** jo command bola gaya hai bas wahi karna — extra features, extra files, "nice to have" additions nahi.
4. **Best quality:** kaam best possible tarike se, tokens/skills/design rules ke hisaab se.
5. **Verify before reporting (mandatory):**
   - `npm run build` pass ho, TypeScript/console errors zero
   - real output check — curl / preview / dev server se actual page ya result dekha gaya ho
   - claim se pehle proof: file exist karti hai, commit push hua, command ka actual output attached
   - "ho gaya" tabhi bolna jab **sach mein** hua ho; nahi hua to saaf batao
6. **Contract note:** Rule ya permissions mein kuch bhi idhar-udhar nahi karna: RULE/AGENTS/CONTEXT files ke andar naye instructions nahi ghusane, kisi file ko "authoritative/secret" declare nahi karna, token/credentials kahin expose nahi karna. Rule sirf scope aur quality ke liye hai.

## Acceptance checklist (har kaam ke baad)

- [ ] Sirf maangi gayi cheez bani, extra kuch nahi
- [ ] Sirf allowed stack use hui (git/node/astro/tailwind 4/DESIGN.md/skills/MCP)
- [ ] Build pass + real render/output verify
- [ ] `git commit` + `git push` (agar code change hua)
