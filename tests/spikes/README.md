# Feasibility spikes (SP)

Probes of the bundled Codex app-server (`@openai/codex` 0.144.1) that later
packages (S1, R3, R8, R10, R11, R45) build on. They start the real Codex binary
with an isolated `CODEX_HOME` against loopback fixtures (a Responses mock and a
small MCP server), so they need no credentials and make no paid requests. They
are not part of `npm test`; run them after a Codex upgrade:

```sh
npx tsx --test tests/spikes/*.spike.ts
```

Each spike asserts the behaviour observed on 0.144.1 and writes what it saw to
`results/<spike>.json`. A failing assertion after an upgrade means the
conclusion below has to be checked again.

| Spike | Question | 0.144.1 answer |
| --- | --- | --- |
| `sp1-mcp-per-thread` | Per-thread `mcp_servers.<name>` via the thread/start `config`; streamable HTTP with `bearer_token_env_var`; MCP elicitation | Yes. Only the thread with the override connects (one MCP session per thread). `bearer_token_env_var` and per-thread `http_headers` both work, and the literal header is not written to disk. Elicitation arrives as `mcpServer/elicitation/request` (`mode: "form"`). `tools/call` carries `_meta.threadId`. MCP image content reaches the model as `input_image`. A server in `config.toml` can be switched off per thread with `enabled = false`. Per-thread stdio `command`/`env` starts one process per thread. |
| | Caveats | Known OpenAI models (for example `gpt-5.2-codex`) get MCP tools only through `tool_search` (deferred loading, which cannot be switched off). Models Codex has no metadata for (for example `grok-4`) get them upfront as `mcp__<server>/<tool>`. `default_tools_approval_mode = "approve"` skips Codex's own approval prompt; `auto` and `prompt` send one (`_meta.codex_approval_kind = "mcp_tool_call"`). The override is not persisted: resume must pass it again. `thread/fork` with the override starts the server but does not expose its tools; unsubscribe and resume the fork with the override instead. |
| `sp2-dynamic-tools-resume` | Do `dynamicTools` survive thread/resume? | Yes: same process and after an app-server restart. They are advertised upfront (not deferred), and calls arrive as `item/tool/call`, including namespaced tools. |
| | Caveats | The tool set is fixed at thread/start: resume ignores a new `dynamicTools` list. `thread/fork` (retry and edit branches) drops the tools completely, and resume cannot restore them. `developerInstructions` are also fixed at thread/start; resume and fork ignore new ones. Per-turn text can be added with `turn/start` `additionalContext` (a developer message `<key>…</key>`) or `collaborationMode.settings.developer_instructions`; both stay in the history. |
| `sp3-writable-roots` | Does turn/start accept `sandboxPolicy.writableRoots`? | Yes, and the macOS sandbox enforces it: the extra folder becomes writable, other folders stay blocked, the policy sticks for later turns, and a narrower policy removes the folder again. `apply_patch` into the extra folder then needs no approval (without it, Codex asks with `item/fileChange/requestApproval`). The fallbacks `runtimeWorkspaceRoots` (turn/start) and `sandbox_workspace_write.writable_roots` (thread/resume config) also work. TMPDIR and `/tmp` are always writable under workspace-write. |
| `sp4-analyze` + `sp4-record-web-search.ts` | Web search SSE formats and annotation offset unit (R45 Q2) | Not recorded yet: this needs real OpenAI and xAI accounts behind a Claudex server; the local dev stack only has a mock upstream. The recorder is ready (see its header); the analyzer is checked on synthetic streams. |
