import test from "node:test";
import assert from "node:assert/strict";
import {
  claudexIdentity,
  codexModelCatalog,
} from "../../electron/engine/codex-model-catalog";

test("Codex's identity sentences say Claudex", () => {
  assert.equal(
    claudexIdentity(
      "You are Codex, an agent based on GPT-5. As Codex, you are curious.",
    ),
    "You are Claudex, an agent. As Claudex, you are curious.",
  );
  assert.equal(
    claudexIdentity(
      "You are a coding agent running in the Codex CLI, a terminal-based coding assistant. Codex CLI is an open source project led by OpenAI.",
    ),
    "You are Claudex, a coding agent running in the Claudex app. Claudex is an open-source project.",
  );
  // Codex as a tool or setting name stays.
  assert.equal(claudexIdentity("Run `codex exec`."), "Run `codex exec`.");
});

test("no model in the catalog introduces itself as Codex or GPT", () => {
  const text = JSON.stringify(codexModelCatalog());
  assert.doesNotMatch(
    text,
    /You are Codex|You are GPT-|Codex CLI is an open source|As Codex, you are|inner life as Codex/,
  );
  assert.match(text, /You are Claudex/);
});
