import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeModelPreference } from "../electron/official-ui/api/model-selection-preferences";
function persistence(t: any): any {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "selector-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    account: () => ({ id: "test" }),
    stateDirectory: () => root,
    sessionIdentity: () => 1,
  };
}
import assert from "node:assert/strict";
import { test } from "node:test";
import { modelSelectorOf } from "../electron/official-ui/api/bootstrap";
import {
  inAdapterScope,
  newAdapterScope,
} from "../electron/official-ui/api/scope";

test("absent effort metadata cannot advertise legacy choices; explicit limits and supported saved choices remain", async (t) => {
  const stored = persistence(t);
  const common = {
    displayName: "Model",
    description: "",
    badges: [],
    sort: 0,
    hidden: false,
    isDefault: false,
    usageHint: "",
  };
  await inAdapterScope(newAdapterScope("models"), async () => {
    writeModelPreference(stored, "code", {
      model: "legacy",
      thinking: { type: "disabled" },
    });
    const result = await modelSelectorOf(
      {
        ...stored,
        settings: () => ({
          effort: "medium",
          codeEffort: "high",
          providers: [],
        }),
        modelCatalog: async () => ({
          defaultModel: "legacy",
          items: [
            { ...common, id: "legacy" },
            {
              ...common,
              id: "limited",
              efforts: ["low", "high"],
              defaultEffort: "low",
            },
            { ...common, id: "disabled", efforts: [] },
          ],
        }),
      } as never,
      {},
    );
    const code = result.config.find((s: any) => s.id === "code")!;
    assert.equal(code.models[0].thinking.type, "disabled");
    assert.deepEqual(
      code.models[1].thinking.effort_options?.map((option) => option.id),
      ["low", "high"],
    );
    assert.equal(code.models[2].thinking.type, "disabled");
    assert.equal(
      result.state.find((s: any) => s.id === "code")!.thinking.type,
      "disabled",
    );
    assert.equal(
      result.state.find((s: any) => s.id === "chat")!.thinking.type,
      "disabled",
    );
    const chatState = result.state.find((s: any) => s.id === "chat");
    assert.ok(chatState, "Chat selector state must be present");
    const limited = chatState.thinking_by_model.find(
      (m: any) => m.id === "limited",
    );
    assert.ok(
      limited,
      "The explicitly supported model must have thinking state",
    );
    assert.equal(limited.thinking.effort, "low");
    writeModelPreference(stored, "code", {
      model: "limited",
      thinking: { type: "effort", effort: "low" },
    });
    const saved = await modelSelectorOf(
      {
        ...stored,
        settings: () => ({
          effort: "medium",
          codeEffort: "high",
          providers: [],
        }),
        modelCatalog: async () => ({
          defaultModel: "legacy",
          items: [
            {
              ...common,
              id: "limited",
              efforts: ["low", "high"],
              defaultEffort: "high",
            },
          ],
        }),
      } as never,
      {},
    );
    const selected = saved.state.find((s: any) => s.id === "code")!;
    assert.equal(selected.thinking.effort, "low");
    assert.equal(selected.thinking_by_model[0].thinking.effort, "low");
    writeModelPreference(stored, "code", {
      model: "limited",
      thinking: { type: "effort", effort: "ultra" },
    });
    const rejected = await modelSelectorOf(
      {
        ...stored,
        settings: () => ({ codeEffort: "high", providers: [] }),
        modelCatalog: async () => ({
          defaultModel: "limited",
          items: [
            {
              ...common,
              id: "limited",
              efforts: ["low", "high"],
              defaultEffort: "high",
            },
          ],
        }),
      } as never,
      {},
    );
    assert.equal(
      rejected.state.find((s: any) => s.id === "code")!.thinking.effort,
      "high",
    );
  });
});

test("catalog More models remain selectable and saved/default hidden selection is preserved", async (t) => {
  const stored = persistence(t);
  const common = {
    displayName: "Model",
    description: "",
    badges: [],
    sort: 0,
    isDefault: false,
    usageHint: "",
    efforts: [],
  };
  const items = [
    { ...common, id: "more", hidden: true, sort: 2 },
    { ...common, id: "main", hidden: false, sort: 1 },
  ];
  await inAdapterScope(newAdapterScope("more-models"), async () => {
    const ctx: any = {
      ...stored,
      settings: () => ({ providers: [] }),
      modelCatalog: async () => ({ defaultModel: "more", items }),
    };
    const result = await modelSelectorOf(ctx, {});
    const models = result.config.find((s: any) => s.id === "chat")!.models;
    assert.deepEqual(
      models.map((m: any) => [m.id, m.section]),
      [
        ["main", "main"],
        ["more", "overflow"],
      ],
    );
    assert.equal(result.state.find((s: any) => s.id === "chat")!.model, "more");
    assert.ok(result.available.models.some((m: any) => m.model_id === "more"));
    writeModelPreference(stored, "chat", {
      model: "more",
      thinking: { type: "disabled" },
    });
    ctx.modelCatalog = async () => ({ defaultModel: "main", items });
    const saved = await modelSelectorOf(ctx, {});
    assert.equal(saved.state.find((s: any) => s.id === "chat")!.model, "more");
    assert.equal(
      saved.state.find((s: any) => s.id === "chat")!.selection_source,
      "user_setting",
    );
    assert.deepEqual(
      items.map((m) => m.id),
      ["more", "main"],
      "source catalog order is not mutated",
    );
  });
});
