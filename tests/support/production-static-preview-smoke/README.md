# Actual production static-preview smoke

Runs the real `static-session.ts` opener and `static-preload.cjs`, not the older protocol fixture. The only content is self-authored HTML/CSS in `main.ts`; it never bootstraps Claudex accounts, providers, model calls or an existing profile.

Build into `.restore/static-preview-smoke` using esbuild with Electron external, copy `control-preload.cjs` and the production `static-preload.cjs` there. Launch on the authorized cloud desktop with ordinary Electron defaults:

```
./node_modules/electron/dist/electron .restore/static-preview-smoke/main.mjs /workspace/scratch/223a505c64e9/claudex-nov02/.restore/static-preview-smoke
```

No `--no-sandbox`, security-disable flags, existing app terminal/profile or original official bundle changes. Each launch creates its own `profile-*` directory beneath the exact dedicated workspace. Initial top-level await of `app.whenReady` caused startup to wait before a window existed; source now registers a `.then` continuation instead. The failed launch was stopped only in its own foreground terminal.

A local inert HTTP probe receives no private data and increments a counter if any of the fixed HTML image/frame/form/link/script URLs reaches it. Counter zero is **not** exhaustive network or CSP proof. The fixture labels script text unchanged as an observation; visual inspection is still required. The real content sandbox and host request/navigation gates remain unchanged except the reviewed navigation-failure UX fix.

Observed 2026-11-02 22:57–23:02 UTC: green CSS heading, border and background rendered; script marker unchanged; image/frame blocked; submitted form left preview intact and local probe remained zero. First link attempt left an empty inner frame (preserved negative screenshot). Production now retires direct-child failed navigation even when CSP blocks before webRequest, matching native frame process/routing IDs. A new ordinary launch showed the same CSS and clicking the same link closed its preview while the control window and zero counter remained. Explicit fixture activation retirement closed both mounted previews. Closing the smoke control exited only this app. Alt+F4 was attempted once but did not visibly close its target, and is not counted as a successful close.

Evidence: `docs/handoff/2026-11-02-cloud-evidence/ui/production-static-preview-{css,zero-probe,link-blank,retired,navigation-fixed}.png`.

This is actual production-opener rendering with self-authored content, **not** an authenticated account/artifact flow, original interactive artifact renderer, multi-platform acceptance, exhaustive navigation-race testing or a claim that every blocking layer was exercised.
