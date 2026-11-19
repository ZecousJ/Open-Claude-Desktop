import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import manifest from "../../shared/codex-runtime-manifest.json" with { type: "json" };
import { Engine } from "../../electron/engine/engine";
import { resolveRuntime } from "../../electron/engine/runtime";
import { accountSkillsMount } from "../../electron/skills/space-skills";
import { Store } from "../../electron/store/store";
import { openPolicy } from "../../shared/client-policy";
import { BwrapDriver } from "../../runner/src/sandbox/bwrap";
import { chatSandboxSpec } from "../../runner/src/sandbox/sandbox-setup";
import type { LocalSkillReference } from "../../shared/skill-references";
import { FAKE_KEY, MODEL, MockResponses, tempRoot, until } from "./harness";

const runtime = resolveRuntime(process.env.CLAUDEX_RUNTIME_RESOURCES);
assert.equal(
  execFileSync(runtime, ["--version"], { encoding: "utf8" }).trim(),
  `codex-cli ${manifest.version}`,
);
const root = tempRoot("f039-sdk");
const providerService = path.join(root, "provider-service.cjs");
const mock = await new MockResponses().start();
const engines: Engine[] = [];
const sandboxed = process.env.CLAUDEX_F039_BWRAP === "1";
const modes = ["chat", "cowork", "code"] as const;
const markers = ["F039_NATIVE_FIRST_BODY", "F039_NATIVE_CHINESE_BODY"];
const names = ["f039-first", "演示"];
const profile = path.join(root, "profile");
const store = new Store(profile);
const home = path.join(profile, "codex-home");
const prompt = "🔎 Please use /f039-first and /演示, then reply.";
const references: LocalSkillReference[] = names.map((name) => {
  const start = prompt.indexOf(`/${name}`);
  return { kind: "local", name, start, end: start + name.length + 1 };
});
const provider = {
  ...store.settings.providers[0],
  id: "f039",
  name: "F039 loopback",
  baseUrl: mock.url,
  protocol: "responses" as const,
  model: MODEL,
  models: [MODEL],
};
store.settings.providers = [provider];
store.settings.activeProviderId = provider.id;
store.settings.chatExecution = true;

function skillFile(name: string) {
  return path.join(home, "skills", name, "SKILL.md");
}

function payload(index: number) {
  return mock.requests[index]?.input.flatMap(
    (item: { content?: { text?: string }[] }) =>
      item.content?.map((part) => part.text) ?? [],
  ) as (string | undefined)[] | undefined;
}

try {
  await build({
    entryPoints: ["server/provider-service.ts"],
    bundle: true,
    preserveSymlinks: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    outfile: providerService,
  });
  for (const [index, name] of names.entries()) {
    const file = skillFile(name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `---\nname: ${name}\ndescription: F039 synthetic fixture.\n---\n\n${markers[index]}\n`,
    );
  }
  const fixtureAsset = path.join(
    path.dirname(skillFile(names[0])),
    "fixture.txt",
  );
  fs.writeFileSync(fixtureAsset, "F039_ANCILLARY_FILE");

  for (const mode of modes) {
    const spaceId = `f039-${mode}`;
    const space = path.join(profile, "spaces", spaceId);
    const spaceHome = path.join(space, "codex-home");
    const accountSkills = accountSkillsMount(profile, spaceHome);
    fs.mkdirSync(path.dirname(accountSkills.sandbox), { recursive: true });
    let binary = runtime;
    if (sandboxed) {
      fs.mkdirSync(accountSkills.sandbox);
      const driver = new BwrapDriver({
        wrapper: path.resolve("runner/bin/sandbox-codex"),
        cgroup: "none",
      });
      binary = driver.prepare(
        chatSandboxSpec({
          userId: 1,
          id: spaceId,
          storeRoot: space,
          stateRoot: path.join(root, "sandbox-state"),
          codexBinary: runtime,
          accountSkills,
        }),
      ).binary;
    } else fs.symlinkSync(accountSkills.host, accountSkills.sandbox, "dir");
    const engine = new Engine(
      store,
      binary,
      () => FAKE_KEY,
      () => {},
      providerService,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        root: space,
        environment: { kind: "space", spaceId },
      },
    );
    engines.push(engine);
    engine.policy = () => openPolicy;
    const request = {
      text: prompt,
      mode,
      attachments: [],
      providerId: provider.id,
      model: MODEL,
      environment: engine.environment,
    };
    const send = async (skillReferences?: LocalSkillReference[]) => {
      const c = await engine.send({ ...request, skillReferences });
      await until(
        () => store.conversation(c.id).turns[0].status !== "inProgress",
        `${mode} completed`,
      );
      assert.equal(store.conversation(c.id).turns[0].status, "completed");
      assert.equal(store.conversation(c.id).turns[0].prompt, prompt);
      return store.conversation(c.id);
    };
    const selectedIndex = mock.requests.length;
    const selected = await send(references);
    const selectedTexts = mock.requests
      .slice(selectedIndex)
      .map((_, offset) => payload(selectedIndex + offset))
      .find((texts) => texts?.includes(prompt));
    assert(selectedTexts, `The selected ${mode} prompt reached the provider.`);
    for (const marker of markers)
      assert(selectedTexts.some((text) => text?.includes(marker)));
    const plainIndex = mock.requests.length;
    await send();
    const plain = mock.requests
      .slice(plainIndex)
      .map((_, offset) => payload(plainIndex + offset))
      .find((texts) => texts?.includes(prompt));
    assert(plain, `The literal ${mode} prompt reached the provider.`);
    for (const marker of markers)
      assert(!plain.some((text) => text?.includes(marker)));
    store.settings.disabledSkills = [
      fs.realpathSync.native(skillFile(names[0])),
    ];
    const selectedRequests = () =>
      mock.requests.filter((_, index) => payload(index)?.includes(prompt))
        .length;
    const requests = selectedRequests();
    await assert.rejects(
      engine.retryResponse(
        selected.id,
        selected.turns[0].id,
        provider.id,
        MODEL,
      ),
      /disabled/,
    );
    assert.equal(selectedRequests(), requests);
    store.settings.disabledSkills = [];
    const retried = await engine.retryResponse(
      selected.id,
      selected.turns[0].id,
      provider.id,
      MODEL,
    );
    await until(
      () => store.conversation(retried.id).turns[0].status === "completed",
      `${mode} re-enabled retry`,
    );
    assert(selectedRequests() > requests);
    if (sandboxed) {
      const file = path.join(accountSkills.sandbox, names[0], "fixture.txt");
      const result = await engine.rpc!.call("command/exec", {
        command: [
          "/bin/sh",
          "-c",
          'cat "$1" && ! touch "$(dirname "$1")/written"',
          "f039",
          file,
        ],
        cwd: selected.cwd,
        sandboxPolicy: { type: "dangerFullAccess" },
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, "F039_ANCILLARY_FILE");
      assert(!fs.existsSync(path.join(path.dirname(fixtureAsset), "written")));
    }
    console.log(
      `${mode}: selected bodies loaded, literal text preserved, disabled retry rejected`,
    );
  }
} finally {
  for (const engine of engines) await engine.stop();
  await mock.close();
  store.flush();
  fs.rmSync(root, { recursive: true, force: true });
}
