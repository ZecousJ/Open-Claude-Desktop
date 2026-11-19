import test from "node:test";
import assert from "node:assert/strict";
import { codeEntryConversation, parseDeepLink } from "../../shared/deep-links";
import type { Conversation } from "../../shared/types";
import { parseSshLink, sshLinkIdentity } from "../../shared/ssh-links";
import { officialDeepLinkRoute } from "../../electron/official-ui/deep-link-route";

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
  assert.deepEqual(parseDeepLink("claudex://claudex.zecous.cn/new"), {
    kind: "new",
    mode: "chat",
  });
  assert.deepEqual(parseDeepLink("claudex://cowork/new?q=Plan"), {
    kind: "new",
    mode: "cowork",
    prompt: "Plan",
  });
  assert.deepEqual(
    parseDeepLink("claudex://claude.ai/new?surface=cowork&q=Plan"),
    {
      kind: "new",
      mode: "cowork",
      prompt: "Plan",
    },
  );
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
    kind: "code-continue",
    id: "s1",
  });
  assert.deepEqual(parseDeepLink("claudex://code/needs-input"), {
    kind: "needs-input",
  });
  assert.equal(
    parseDeepLink("claudex://settings/connectors?connector=x"),
    undefined,
  );
  assert.equal(parseDeepLink("https://claudex.zecous.cn/new"), undefined);
  assert.equal(parseDeepLink("claudex://conversation/a%20b"), undefined);
  assert.equal(parseDeepLink("claudex://user:pw@new"), undefined);
  assert.equal(parseDeepLink("not a url"), undefined);
});

test("the official desktop opens drafts in the requested composer and keeps SSH confirmation in Code", () => {
  const draft = "Read this & do not send";
  const q = encodeURIComponent(draft);
  const route = (href: string) => {
    const link = parseDeepLink(href);
    assert.ok(link);
    return new URL(officialDeepLinkRoute(link, "owner"), "http://localhost");
  };
  for (const [link, pathname] of [
    [`claudex://new?q=${q}`, "/new"],
    [`claudex://cowork/new?q=${q}`, "/task/new"],
    [`claudex://claude.ai/new?surface=cowork&q=${q}`, "/task/new"],
    [`claudex://code/new?prompt=${q}`, "/epitaxy"],
  ]) {
    const url = route(link);
    assert.equal(url.pathname, pathname);
    assert.equal(url.searchParams.get("q"), draft);
  }
  const folder = route("claudex://code/new?folder=%2Fwork%2Fapi");
  assert.equal(folder.searchParams.get("folder"), "/work/api");
  assert.equal(folder.searchParams.get("src"), "external");
  const ssh = route(
    `claudex://code/new?ssh_host=user%40Box&ssh_port=2222&ssh_folder=%2Fwork&q=${q}`,
  );
  assert.equal(ssh.pathname, "/epitaxy");
  assert.deepEqual(Object.fromEntries(ssh.searchParams), {
    ssh_host: "user@Box",
    ssh_port: "2222",
    ssh_folder: "/work",
    q: draft,
    src: "external",
  });
  const refused = route("claudex://code/new?ssh_host=-option&q=ignore");
  assert.equal(
    refused.pathname + refused.search,
    "/epitaxy?ssh_refused=invalid_host",
  );
  assert.equal(
    route("claudex://claude.ai/project/project-1").pathname,
    "/project/project-1",
  );
});

test("the official desktop opens owned sessions and resolves Code entry points against desktop sessions", () => {
  const conversation = (
    id: string,
    mode: Conversation["mode"],
    updatedAt: number,
    extra: Partial<Conversation> = {},
  ) =>
    ({
      id,
      mode,
      updatedAt,
      cwd: "/work",
      ...extra,
    }) as Conversation;
  const snapshot = {
    conversations: [
      conversation("old", "code", 1),
      conversation("new", "code", 5),
      conversation("cowork", "cowork", 3),
      conversation("chat", "chat", 9),
      conversation("private", "code", 10, { incognito: true }),
      conversation("archived", "code", 11, { archived: true }),
      conversation("cloud", "code", 12, { cloudHosted: true }),
      conversation("another-account", "code", 13, {
        sessionAuthors: {
          ownerAccountUuid: "different-owner",
          viewerAccountUuid: "different-owner",
        },
      }),
    ],
    approvals: ["new", "cowork", "private", "another-account"].map(
      (conversationId) => ({ conversationId }),
    ),
  };
  const route = (href: string) => {
    const link = parseDeepLink(href);
    assert.ok(link);
    return officialDeepLinkRoute(link, "owner", snapshot);
  };
  assert.equal(route("claudex://conversation/chat"), "/chat/chat");
  assert.equal(route("claudex://conversation/cowork"), "/cowork/local_cowork");
  assert.equal(
    route("claudex://code/continue?session=local_old"),
    "/epitaxy/local_old",
  );
  assert.equal(
    route("claudex://code/continue?session=last"),
    "/epitaxy/local_new",
  );
  assert.equal(route("claudex://code/continue?session=chat"), "/epitaxy");
  assert.equal(
    route("claudex://code/needs-input?session=local_new"),
    "/epitaxy/local_new",
  );
  assert.equal(
    route("claudex://code/needs-input?session=gone"),
    "/cowork/local_cowork",
  );
  assert.equal(route("claudex://conversation/another-account"), "/recents");
  assert.equal(route("claudex://conversation/private"), "/recents");
});
