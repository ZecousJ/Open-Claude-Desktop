/**
 * The runner's method guard (runner/src/method-guard.ts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  guardCall,
  localPathIn,
  runnerMethods,
  sanitizeResult,
  webArguments,
} from "../../runner/src/method-guard";
import {
  webAbsentMethods,
  webRemoteRunnerMethods,
} from "../../shared/web-bridge-methods";

test("only remote-runner methods pass", () => {
  assert.deepEqual([...runnerMethods].sort(), [...webRemoteRunnerMethods]);
  for (const name of ["chooseFolder", "terminalStart", "openMcpConfig"]) {
    assert.ok(webAbsentMethods.includes(name));
    assert.throws(() => guardCall(name, []), {
      code: "CLAUDEX_WEB_METHOD_UNAVAILABLE",
    });
  }
  assert.throws(() => guardCall("constructor", []));
  assert.throws(() => guardCall("loginAccount", []));
});

test("arguments that name a place on the host are refused", () => {
  assert.equal(localPathIn([{ text: "hi", attachments: [] }]), undefined);
  assert.equal(localPathIn([{ cwd: "" }]), undefined);
  assert.equal(localPathIn([{ cwd: "/etc" }]), "[0].cwd");
  assert.equal(
    localPathIn([{ project: { folders: ["/home/x"] } }]),
    "[0].project.folders",
  );
  assert.equal(
    localPathIn([{ environment: { kind: "ssh", hostId: "h" } }]),
    "[0].environment",
  );
  assert.equal(localPathIn([{ environment: { kind: "local" } }]), undefined);
  // A project's other folders name places on the host too.
  assert.equal(
    localPathIn([{ id: "p", additionalFolders: ["/srv/b"] }]),
    "[0].additionalFolders",
  );
  assert.equal(localPathIn([{ id: "p", additionalFolders: [] }]), undefined);
  assert.equal(localPathIn([new Uint8Array([1, 2])]), undefined);
  assert.throws(
    () =>
      guardCall("send", [
        { text: "x", mode: "chat", cwd: "/root", attachments: [] },
      ]),
    { code: "CLAUDEX_WEB_BAD_REQUEST" },
  );
  assert.throws(() =>
    guardCall("saveProject", [
      {
        id: "p",
        name: "P",
        description: "",
        instructions: "",
        cwd: "/",
        createdAt: 1,
      },
    ]),
  );
  assert.doesNotThrow(() =>
    guardCall("saveProject", [
      { id: "p", name: "P", description: "", instructions: "", createdAt: 1 },
    ]),
  );
});

test("send starts only the modes the web offers", () => {
  const send = (mode: string) => [
    { text: "x", mode, attachments: [], providerId: "sub2api", model: "m" },
  ];
  assert.doesNotThrow(() => guardCall("send", send("chat")));
  assert.throws(() => guardCall("send", send("code")), {
    message: "Code isn't available on the web yet.",
  });
  assert.throws(() => guardCall("send", send("cowork")), {
    message: "Cowork isn't available on the web yet.",
  });
  assert.doesNotThrow(() =>
    guardCall("send", send("cowork"), { modes: ["chat", "cowork"] }),
  );
});

test("answers that describe the host are cleared", () => {
  assert.deepEqual(
    sanitizeResult("mcpServers", {
      servers: [],
      configPath: "/var/lib/claudex-runner/users/1/profile/mcp.json",
      configError: "bad",
    }),
    { servers: [], configPath: "" },
  );
  assert.deepEqual(sanitizeResult("snapshot", { a: 1 }), { a: 1 });
  assert.deepEqual(
    sanitizeResult("linkChatGitHubRepository", {
      id: "repo",
      path: "/private/profile/attachments/repo",
      github: { repository: "octo/repo", branch: "main" },
    }),
    {
      id: "repo",
      path: "",
      github: { repository: "octo/repo", branch: "main" },
    },
  );
  assert.deepEqual(
    sanitizeResult("addAttachmentData", {
      id: "a1",
      name: "notes.txt",
      path: "/var/lib/claudex-runner/users/1/profile/attachments/a1/notes.txt",
      kind: "text",
      size: 5,
    }),
    { id: "a1", name: "notes.txt", path: "", kind: "text", size: 5 },
  );
});

test("what the app only echoes back does not trip the guard", () => {
  const folder = "/var/lib/claudex-runner/users/1/profile/workspace";
  const cwdOf = (id: string) => (id === "c1" ? folder : undefined);
  // A queued message sends whole Attachment rows (with their stored path).
  const queued = webArguments(
    "send",
    [
      {
        conversationId: "c1",
        text: "x",
        mode: "chat",
        attachments: [
          { id: "a1", name: "n.txt", path: folder + "/n.txt", kind: "text" },
        ],
        providerId: "sub2api",
        model: "m",
      },
    ],
    cwdOf,
  );
  assert.deepEqual((queued[0] as any).attachments, [{ id: "a1" }]);
  assert.doesNotThrow(() => guardCall("send", queued));
  // Sending from an artifact repeats the conversation's own folder.
  const fromArtifact = webArguments(
    "send",
    [
      {
        conversationId: "c1",
        text: "x",
        mode: "chat",
        cwd: folder,
        attachments: [],
      },
    ],
    cwdOf,
  );
  assert.equal((fromArtifact[0] as any).cwd, undefined);
  assert.doesNotThrow(() => guardCall("send", fromArtifact));
  // Any other folder is still refused.
  for (const [conversationId, cwd] of [
    ["c1", "/etc"],
    ["c2", folder],
    [undefined, folder],
  ])
    assert.throws(
      () =>
        guardCall(
          "send",
          webArguments(
            "send",
            [{ conversationId, text: "x", mode: "chat", cwd, attachments: [] }],
            cwdOf,
          ),
        ),
      { code: "CLAUDEX_WEB_BAD_REQUEST" },
    );
  const other = [{ cwd: folder }];
  assert.equal(webArguments("saveProject", other, cwdOf), other);
});
