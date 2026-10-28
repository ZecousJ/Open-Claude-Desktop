import test from "node:test";
import assert from "node:assert/strict";
import { codeEntryConversation, parseDeepLink } from "../../shared/deep-links";
import type { Conversation } from "../../shared/types";
import { parseSshLink, sshLinkIdentity } from "../../shared/ssh-links";

test("OS session links resolve the latest Code session or oldest waiting session", () => {
  const conversation = (
    id: string,
    mode: string,
    updatedAt: number,
    extra = {},
  ) => ({ id, mode, updatedAt, ...extra }) as Conversation;
  const sessions = [
    conversation("old", "code", 1),
    conversation("new", "code", 5),
    conversation("cowork", "cowork", 3),
    conversation("chat", "chat", 9),
    conversation("private", "code", 10, { incognito: true }),
    conversation("archived", "code", 11, { archived: true }),
  ];
  assert.equal(
    codeEntryConversation(
      { kind: "conversation", id: "last" },
      sessions,
      new Set(),
    )?.id,
    "new",
  );
  const waiting = new Set(["new", "cowork", "private", "archived"]);
  assert.equal(
    codeEntryConversation({ kind: "needs-input" }, sessions, waiting)?.id,
    "cowork",
  );
  assert.equal(
    codeEntryConversation({ kind: "needs-input", id: "new" }, sessions, waiting)
      ?.id,
    "new",
  );
  assert.equal(
    codeEntryConversation(
      { kind: "needs-input", id: "gone" },
      sessions,
      waiting,
    )?.id,
    "cowork",
  );
  assert.equal(
    codeEntryConversation({ kind: "needs-input" }, sessions, new Set()),
    undefined,
  );
  assert.equal(
    codeEntryConversation({ kind: "conversation", id: "last" }, [], waiting),
    undefined,
  );
});

test("a refused SSH link keeps its validated refusal rather than connecting", () => {
  assert.deepEqual(
    parseDeepLink("claudex://code/new?ssh_refused=truncated&ssh_host=host"),
    {
      kind: "ssh-error",
      error: "truncated",
    },
  );
});

test("SSH Code links preserve provenance without opening a connection", () => {
  assert.deepEqual(
    parseDeepLink(
      "claudex://code/new?ssh_host=user%40Box&ssh_port=2222&ssh_folder=%2Fwork",
    ),
    {
      kind: "ssh",
      target: { sshHost: "user@Box", sshPort: 2222, folder: "/work" },
    },
  );
  assert.equal(sshLinkIdentity("user@BOX."), sshLinkIdentity("user@box", 22));
  assert.deepEqual(parseDeepLink("claudex://code/new?ssh_host=box&q=Explain"), {
    kind: "ssh",
    target: { sshHost: "box", prompt: "Explain" },
  });
  assert.notEqual(sshLinkIdentity("User@box"), sshLinkIdentity("user@box"));
  for (const [query, error] of [
    ["ssh_host=-option", "invalid_host"],
    ["ssh_host=a&ssh_host=b", "invalid_host"],
    ["ssh_host=user@@box", "invalid_host"],
    ["ssh_host=box&ssh_port=0", "invalid_port"],
    ["ssh_host=box&ssh_port=65536", "invalid_port"],
    ["ssh_host=box&ssh_port=022", "invalid_port"],
    ["ssh_host=box&ssh_folder=relative", "invalid_folder"],
    ["ssh_host=box&ssh_folder=/a/../b", "invalid_folder"],
    ["ssh_host=box&ssh_folder=//share", "invalid_folder"],
    ["ssh_host=box&ssh_folder=/%E2%80%99", "invalid_folder"],
    ["ssh_host=box&folder=/local", "ambiguous"],
  ] as const)
    assert.deepEqual(parseSshLink(new URLSearchParams(query)), {
      kind: "ssh-error",
      error,
    });
  assert.equal(parseDeepLink("ssh://user@box"), undefined);
  assert.equal(parseDeepLink("claudex://code/%E0%A4"), undefined);
});

test("claudex:// links open a new chat, a conversation, a project or Code", () => {
  assert.deepEqual(parseDeepLink("claudex://new?q=Hello%20there"), {
    kind: "new",
    mode: "chat",
    prompt: "Hello there",
  });
  assert.deepEqual(parseDeepLink("claudex://claudex.example.com/new"), {
    kind: "new",
    mode: "chat",
  });
  assert.deepEqual(parseDeepLink("claudex://cowork/new?q=Plan"), {
    kind: "new",
    mode: "chat",
    prompt: "Plan",
  });
  assert.deepEqual(parseDeepLink("claudex://conversation/abc-123"), {
    kind: "conversation",
    id: "abc-123",
  });
  assert.deepEqual(parseDeepLink("claudex://claude.ai/chat/abc"), {
    kind: "conversation",
    id: "abc",
  });
  assert.deepEqual(parseDeepLink("claudex://project/p1"), {
    kind: "project",
    id: "p1",
  });
  assert.deepEqual(parseDeepLink("claudex://code/new?folder=%2Fwork%2Fapi"), {
    kind: "new",
    mode: "code",
    folder: "/work/api",
  });
  assert.deepEqual(parseDeepLink("claudex://code/continue?session=s1"), {
    kind: "conversation",
    id: "s1",
  });
  assert.deepEqual(parseDeepLink("claudex://code/needs-input"), {
    kind: "needs-input",
  });
  assert.equal(
    parseDeepLink("claudex://settings/connectors?connector=x"),
    undefined,
  );
  assert.equal(parseDeepLink("https://claudex.example.com/new"), undefined);
  assert.equal(parseDeepLink("claudex://conversation/a%20b"), undefined);
  assert.equal(parseDeepLink("claudex://user:pw@new"), undefined);
  assert.equal(parseDeepLink("not a url"), undefined);
});
