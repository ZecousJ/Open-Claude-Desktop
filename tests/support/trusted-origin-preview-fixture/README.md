# Separate trusted-origin inert preview fixture

Standalone self-authored validation harness, not imported by the product. No real account, provider, arbitrary HTML/artifact, profile reuse or application bridge. The earlier request-tag/opaque-shell attempt remains separately preserved in `../opaque-preview-fixture` with its real failed native callback evidence.

This candidate serves only fixed public shell/host documents on two 127.0.0.1-bound ephemeral listeners, using different cookie hostnames (127.0.0.1 parent; localhost shell). It rejects unexpected Host, cookies, authorization, methods and paths. There are no redirects, proxies or remote fallback. Listeners live until their dedicated window and ports are retired. A separate Electron session denies permissions, popups and all requests except the exact first parent document and exact first shell subframe request per mount. Only top-frame trusted preload is used; no session-wide page shim/subframe preload.

The trusted shell generates a fresh nonce per Document. Parent checks exact source/origin, binds a mount identifier, then transfers one port with that document nonce and a separate host nonce to the exact origin. A private ACK is validated against native captured frame/activation before requesting the one fixed inert rendering. Old ready/ACK/timer cannot operate a replacement mount. The actual inert document is compiled fixed text inside `sandbox=""`, with script/connect/frame/form/base denied by its own CSP; the outer shell has a hash-only script CSP and no network capability. Main also rejects subsequent outer/nested navigation. Neither the nonce nor a retained WindowProxy alone is claimed to authenticate a Document.

## Source evidence

`tests/official-ui-trusted-origin-preview-fixture.test.ts`: seven pure/actual-fixed-script VM checks passed, including wrong/coercible nonce, duplicate ready/ACK, old mount, stale native lease, strict shell CSP and no dynamic artifact payload. Scoped strict TypeScript and preload syntax checks passed. These are not native event-order tests.

## Actual cloud Linux observations (20:29–20:32 UTC)

Normal Electron launch with a new temporary profile and no security override showed the self-authored host. Open completed the nonce/channel handshake. A first immediate screenshot showed an empty nested frame; a later screenshot showed the fixed heading `Fixed inert preview` and its full fixed paragraph. No CSP exception or blocked-request diagnostic was produced during that positive path. Therefore the initial empty screenshot was not treated as a pass or patched by loosening CSP.

With content visibly present, Navigate same frame produced `Frame navigation denied and channel retired.` and removed the iframe. A subsequent new Open successfully displayed the fixed content again. Explicit Revoke then produced `Explicitly retired. No live channel.` and removed the iframe. These are concrete fixed-fixture UI observations, not acceptance of production artifacts or arbitrary content.

Still open: adversarial nested links/meta refresh/custom schemes/network matrix; deliberately scheduled ACK/content-vs-navigation races; BFCache/history restoration; cookie/Host/redirect integration tests; real product session/shim isolation; any actual account artifact. Queued content already delivered cannot be retrospectively recalled. Do not generalize the fixed-content observations to those untested cases.

## Reproduction boundaries

Bundle `main.ts` as Node CJS with Electron external into a dedicated runtime directory and copy `preload.cjs` beside it. Run only through the supported cloud UI in a separately coordinated window. Do not use `--no-sandbox`, reuse existing profiles, change security settings, touch live-login tabs or recreate a denied browser reload through another navigation. Diagnostic output is counts/categories and bounded redacted fixed-fixture CSP errors only, never nonce values or account data.

20:33 UTC: a further Open was left without interaction past its 30-second lifetime. The actual window displayed `Fixture lease expired.` and removed the iframe. This verifies the visible expiry cleanup in this fixed fixture run, not arbitrary interprocess race schedules.

## Fixed eight-case cloud run, 2026-11-02 20:40–20:45 UTC

This is an independent Electron fixture, not production preview acceptance. All inputs are fixed self-authored strings, no account data, external destination, model or tool invocation. No policy was relaxed to make a request reach a second blocking layer.

| Fixed case | Actual observation | Native deny layer | Local `/probe` listener arrivals |
| --- | --- | --- | --- |
| plain | Fixed heading and paragraph visibly painted, including fresh retry at 20:45 | Not applicable | 0 |
| link | Clicked fixed local link; `frame-src about:` CSP blocked; nested region became blank | Not reached / not verified by this case | 0 |
| refresh | Browser explicitly refused meta redirect because sandbox lacks `allow-scripts` | Not reached / not verified by this case | 0 |
| custom-scheme | Clicked unregistered fixed scheme; `frame-src about:` blocked, nested blank; no external handler opened | Not reached / not verified by this case | 0 |
| image | Broken-image fallback visible; `default-src 'none'` blocked image | Not reached / not verified by this case | 0 |
| form | Clicked no-data fixed local form; sandbox lacks `allow-forms`, submission blocked | Not reached / not verified by this case | 0 |
| iframe | Empty nested probe; both inherited `frame-src about:` and inner `frame-src 'none'` violations logged | Not reached / not verified by this case | 0 |
| script-marker | Heading rendered; sandbox lacks `allow-scripts`, script blocked; exact execution marker never logged | Not reached / not verified by this case | 0 |

Evidence lives in `docs/handoff/2026-11-02-cloud-evidence/trusted-preview-*-204*.png` and `trusted-preview-matrix-diagnostics-2045.jsonl`. Earlier positive Navigate/Revoke/expiry screenshots remain separate evidence, not counted as every probe exercising native cancellation.

Open findings: two first attempts to replace an existing mount (script-marker then plain) reported `Fixed shell setup unavailable`; ordinary subsequent Open recovered. This is a reproducible availability/registration timing issue, not accepted as seamless repeat-open. For CSP-blocked link/scheme the outer text retains the historical `Nested load reported` message after the inner goes blank; it is not current visual-success confirmation. Do not drive retirement from unattributed queued console strings. Exact native queued ACK/navigation/port races are still not fully exercised in this run; pure handshake tests are not substitutes. No production integration or arbitrary artifact support is claimed.
