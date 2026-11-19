# Inert native preview harness — source only, launch pending

This standalone fixture is not imported by the product, does not connect the official preview, and does not open any real account or artifact. Do not start it without the parent coordinating a separate cloud CUA terminal/window. Do not reuse the current native profile/session or reload a browser action that was rejected.

## Intended runtime

`main.ts` creates a dedicated nonpersistent Electron session and temporary user-data directory. The usual `sandbox`, `contextIsolation` and `webSecurity` remain enabled, and Node integration is off. No OS/default protocol or privileged scheme is registered. Only fixed self-authored `https://fixture.invalid` documents are served from an in-memory HTTPS handler; all other requests, permissions and popups are denied, with no network fallback or TLS override.

The parent document contains no proof and exposes no Electron API. A trusted preload creates a fixed-name iframe with `sandbox="allow-scripts"` (no same-origin permission), records its exact WindowProxy, and forwards only the fixed bootstrap envelope and one transferred port to that object. The outer shell holds a private proof and writes the one fixed text artifact into an independent nested `sandbox=""` iframe with scripts/network disabled. No user-selected HTML, real model call, file read, storage, download or tool command is accepted.

## Proof response gate

The shell URL contains a random resource identifier, **not the proof and not authorization**. Main captures the native child frame tree identity from the known trusted document. `onBeforeSendHeaders` requires the exact WebContents, captured tree identity, current actual `WebFrameMain`, `subFrame` resource type and GET path. Every renderer-provided case-insensitive tag header is removed. Only that trusted event mints a random one-use host request tag, bound to the frame and navigation/lease epoch. `protocol.handle` refuses to serve the proof-bearing shell without consuming this tag. Tags/proofs are never logged or reflected into a response header.

`protocol.handle` does not itself provide a frame ID. Therefore **the actual Electron callback ordering and metadata attribution must be tested**. If an intercepted request does not reach the trusted header callback, or its frame differs, the fixture fails closed (no tag/403), rather than falling back to URL/referrer/header assertions. Local SDK types and official Electron documentation establish the available interfaces, not their race-free runtime composition.

## Intended checks after authorized launch

- Open: private channel proves the shell before fixed inert HTML is sent.
- Navigate: revoke first, navigate the same iframe to a fixed blank replacement, record whether the WindowProxy stays equal, verify old channel stays closed.
- Revoke: remove the old loaded shell and close both ends; queued old clear notifications cannot remove a new frame.
- Probe: a main-process fetch with a forged tag and no native subframe identity must be denied (no shell body/proof read).
- Repeat open, expiry, close, wrong/repeated proof and document/navigation races still need real native verification. Pure tests cover only request-gate and primitive contracts.

## Build preparation (not a launch instruction)

Once the coordinator grants a runtime window, bundle `main.ts` as Node CJS with Electron external into a new `.runtime/inert-preview-harness/main.cjs`, copy the fixed `preload.cjs` alongside it, and launch that file through the supported cloud CUA terminal using the installed Electron executable. Do not add `--no-sandbox`, disable security settings or copy any existing account profile. If the environment cannot launch it under normal security controls, leave the actual-runtime check blocked.

Evidence so far: six pure/jsdom tests and strict TypeScript compilation pass. No native window has been launched for this harness, no actual WindowProxy/CSP proof has been claimed, and it does not mark production preview acceptance complete.

19:31 source review corrections: load listeners capture their actual created iframe/WindowProxy and ignore detached/older nodes. A renderer load signal is only a wake-up: main additionally requires its current native frame's committed URL to match the shell and its private request tag already to have been consumed. Bootstrap IPC to trusted preload carries a non-secret resource URL so an old queued port is closed rather than attached to a newer frame; the opaque child still receives only the original two-field envelope and port. The nested iframe reports load/size, not proof that its visual content rendered correctly.

Six pure/jsdom tests pass, including execution of this fixed preload against delayed old-frame load, old-bootstrap events and an old navigation reply arriving after a new frame was opened. Bind replies and navigation replies recheck the captured node before changing its URL. jsdom changes `contentWindow` on `src` assignment rather than modeling Chromium's retained WindowProxy, so the positive transfer path is deliberately **not claimed validated** by that test. Actual Electron ordering, committed-frame attribution, CSP rendering and navigation races remain pending.

20:16 UTC actual cloud Linux Electron run (normal security settings, separate temporary profile): the fixed host window opened. First Open failed closed with `No authenticated request tag. Shell not accepted.` and an Unavailable subframe. Thus the native intercepted-request/header metadata composition has **not** passed its positive path. The fixed main-process forged-tag Probe was blocked before a private response. Navigate displayed the fixed replacement document, and Revoke displayed revoked status; neither proves revocation of a previously established channel, because none was established in this run. No arbitrary artifact, account, external network fallback, proof logging or security override was used. Actual positive proof/port/content rendering remains blocked pending diagnosis, not accepted.

20:19 UTC second actual run with non-sensitive counters: the shell request reached `onBeforeRequest` once and `protocol.handle` once, but `onBeforeSendHeaders` zero times. Header-condition booleans were untouched defaults, not observed mismatches. This establishes why this runtime never mints the one-use tag. The current response gate must remain closed; correlating only the URL/referrer with an earlier request would not replace native request identity. Positive preview remains unavailable under this design. Diagnostics contain only callback counts/booleans, never resource IDs, headers, tags or proof values.
