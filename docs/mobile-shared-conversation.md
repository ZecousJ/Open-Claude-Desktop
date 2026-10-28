# Shared mobile conversation surface

## One canonical source

The mobile apps package a local, versioned renderer compiled from the same React components and CSS files that web and Electron use. It is not a remote website, a screen capture, a Markdown reimplementation, or a copied native design system. SwiftUI / Compose still own navigation, account/session state, transport, the composer, approvals, permissions, file pickers and the native file/share viewers.

Reviewed upstream base for this change: `e7033fc9865ff60c584c993f3b6c987f82751021` (2026-10-02). No dependencies or package-lock versions change.

### Actual reuse graph

- `ConversationTranscript` → `UserMessage`, `ChatTurnContent`, `AgentItems`, `ReplyToolbar`, `ReplyVersions`, `TurnOutcome`, selection and scrolling controls
- `ChatTurnContent` → `ChatSteps`, `ItemView`, existing reasoning/tool/search/file-change/workflow components and citation processing
- `Markdown` → existing react-markdown / GFM / highlighting / KaTeX, `MarkdownImage`, `ArtifactCard`, citations and local-file resolution
- Attachments → original `MessageAttachments` / file tiles / image thumbnails
- Output files → original `GeneratedFileCard`, `GeneratedImageCard`, `SheetTile` and artifact metadata
- `useTranscriptScroll` remains the existing scrolling implementation
- Read-only native Markdown/source previews → the same `Markdown`, including code copying and math

`src/mobile-conversation/styles.css` imports the actual original stylesheet files, including the foundation/theme tokens, transcript/Markdown/tools/citations/file-card styles and web responsive rules. The same CSS-only late slot modules loaded by main (sheet cards, browser/computer tool rows, light-main and live-web) are imported after the base cascade. The same `webLightPalettePlugin` used by the production web build transforms the web palette. Mobile additions contain only host layout/touch rules; no duplicate color or font palette.

The build's `reuse-manifest.json` records source-file hashes, every actual bundled source module, required shared components, exact lockfile hash, bundled package versions, and all shipped asset hashes. The checker fails if a required original component is missing or a bundled dependency differs from the lock.

### Narrow platform seam

`ConversationServicesContext` supplies only copy, attachment preview/opening, explicitly requested remote image loading, scoped generated-file bytes/image snapshots, and artifact downloading. Web/desktop defaults call their previous services. Native supplies safe data and typed actions. There is no native `window.desktop` object, generic RPC, backend credential, fetch proxy, token or filesystem capability in JavaScript.

The whole model-generated document is data. Raw Markdown HTML is not enabled. HTML/code artifacts are handed to native using an identity, and read-only documents display source. The renderer CSP prohibits network, frames, objects and forms. Generated HTML cannot run inside the privileged renderer.

## Protocol v1

Types are canonical in `shared/mobile/conversation-contract.ts`.

- Local entry: `dist-mobile-conversation/index.html`; all code/font/style chunks use relative asset paths
- JavaScript first posts `{version:1,type:'ready'}`
- Native calls `ClaudexConversation.render(state)` with canonical shared conversation JSON, a fresh opaque session lease, monotonic revision and theme
- Native can call `update` with matching `baseRevision` and append-text/upsert-turn/remove-turn operations. Out-of-date revisions emit `stateRejected`; a complete render recovers
- Successful React layout emits `stateApplied`. Native holds at most one render in flight, coalesces newer canonical state, and should update at most every 80 ms. Unchanged media is omitted from deltas
- A provided `media` map replaces the previous bounded snapshot. Omit to retain; `{}` clears. Account/conversation/session changes clear everything
- Native calls `renderDocument` for a validated read-only document; no shared source code is copied into the native preview screen
- Actions contain version, lease, request ID, a fixed type and a bounded typed payload. Native validates local origin, main frame, lease/account generation, current conversation/turn/version/file membership and in-flight action state
- Native always completes actions through `result`; error and cancellation reject the JavaScript promise. Explicit Retry/Open link confirmation declines may add `cancellationReason:"userDeclined"` with `ok:false,cancelled:true` only before mutation/intent dispatch. The renderer recognizes this typed no-op for those two actions and suppresses its error banner; it does not resolve the request as a successful action. Unclassified cancellation and native lifecycle warnings remain visible, preserving native error text. A later successful request with the same action and payload clears only the matching error already displayed when that retry began; unrelated or newer concurrent errors are retained. Each session/surface owns its error state. Ordinary actions time out after 30 seconds and emit `cancelRequest`; dispose/session changes cancel all outstanding work. The two export actions are lifecycle-scoped human choosers, limited to one outstanding export, and do not expire while a picker is open
- `downloadArtifacts` carries `{conversationId, files}` with 1–32 distinct canonical file identities, captured by one trusted Download all click. Native validates the whole batch before starting, resolves each file again before its chooser/save, and owns the sequence. No later JavaScript gesture or arbitrary continuation is authorized. A user cancellation stops the remaining files and returns `ok:true,result:{saved:number,cancelled:true}`; normal completion has `cancelled:false`. Count only completed saves. Top-level `cancelled:true` on exports remains lifecycle/request cancellation and rejects the promise; it never means a successful partial save. Native keeps the chooser reservation until its original dismissal/callback, including after cancellation, so an old callback cannot write a newer file
- The 1.5-second trusted top-document gesture gate applies to every newly admitted action and is cleared on session change/disposal. Host results never renew it. A slow export result may settle its existing request, but cannot authorize a new request
- `quoteReply.text` is raw selected/rendered text. Native adds Markdown quote prefixes exactly once, validating rendered text separately from stricter source/code copying
- Files are identities: `generated:<fileId>:<digest>`, `fence:<itemId>:<index>` or `fence-summary:<itemId>:<index>`. Native independently resolves current canonical source. An ID never grants permission to open a supplied arbitrary path/digest
- No model-content `message` listener feeds native commands. Only trusted top-document controls dispatch actions; native independently enforces the boundary

## Packaging and propagation

The shared change belongs in one main-targeted source PR. Native branches retain their backend/navigation work and consume exactly the same built renderer. Do not fork the TS/CSS source into separate mobile source trees.

For a release, check out one exact published shared-source commit, install its locked dependencies, run the build below, then use each native branch's sync script to copy the same output directory and verify its manifest. Record that shared source commit and the manifest hash in both native consumers. A later fix to web/desktop `Markdown`, transcript actions, tool rows, attachment cards or imported CSS flows into both native apps when this canonical build is rebuilt and the locked asset version is advanced. Native branches do not independently restyle those components.

The development candidate was built locally and has not been published by this change. Do not configure CI to fetch an unpublished local commit.

## Remaining reuse and capability work

This change does not claim that every mobile screen is shared. The native composer and surrounding navigation/settings/system UI remain native. Composer reuse requires extracting the current `Composer` service dependencies without importing its desktop controller or losing native keyboard/file/dictation behavior.

Image-tool snapshot discovery and interactive workflow/agent/plan panels need explicit native adapters. Missing image-tool previews are visibly unavailable; the existing generated-file/image cards still work with canonical scoped snapshots. Inline artifact sharing is capability-gated off here because sharing lives in the native file viewer. Native handlers must return a visible unsupported result for panel actions they do not implement. iOS remote image loading may be unavailable until its own safe image-fetch adapter is implemented. No blank/mock success should stand in for those features.
