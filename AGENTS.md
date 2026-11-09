# Project rules

Read `docs/2026-11-06-newsletter-reader-design.md` (spec) and `docs/2026-11-07-newsletter-reader.md` (plan) first; they are the source of truth.

- **Strict TypeScript.** `strict` is on, plus `noUncheckedIndexedAccess`. No `any` without a comment saying why.
- **Tests beside pure logic.** Every pure function in `packages/*` has a `<name>.test.ts` next to it. Write the test first. Unit tests (`*.test.ts`) use no network and no browser; flows go in `*.integration.test.ts`; shell end-to-end tests are Playwright, in `apps/shell/e2e`.
- **English only**, including comments and test names. The core ships no user-facing strings; a host brings its own.
- **Nothing deployment-specific in code.** No publication is named in code, docs, tests or fixtures; use `example.substack.com` and placeholder text. The feed URL, name and other settings are configuration (`SUBSTACKER_CONFIG` or the gitignored `substacker.config.local.json`; template `substacker.config.example.json`). Never read, copy or commit the local file.
- **Never rewrite `content`.** It is the only copy of old posts. No force push, no history edits, and the scraper never deletes.
- **The raw feed item is the backup**; every served file is derived from it and is never committed.
- **Before finishing a task:** `npm run typecheck`, `npm run lint`, `npm run test:unit`, `npm run test:integration`. One commit per plan task.
- No dependencies beyond the plan's tech stack without a stated reason.
