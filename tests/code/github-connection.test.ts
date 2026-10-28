import assert from "node:assert/strict";
import test from "node:test";
import {
  githubRoutes,
  parseGitHubBranches,
  parseGitHubConnect,
  parseGitHubRepositories,
  parseGitHubReturn,
  parseGitHubStatus,
  repositoryFullName,
} from "../../shared/github-api";
import {
  currentCodeRepository,
  repositoryRef,
  setCodeRepository,
} from "../../src/composer/code-repository";
import { webMethodKind } from "../../shared/web-bridge-methods";
import { json, signedInBridge } from "../app/web-bridge-fakes.test.ts";

const envelope = (data: unknown) => ({ code: 0, message: "success", data });

test("the connection calls run in the page and reach Go endpoints", () => {
  for (const name of [
    "githubStatus",
    "githubConnect",
    "githubDisconnect",
    "githubRepositories",
    "githubBranches",
    "githubIssues",
    "githubIssue",
    "githubPullRequest",
    "githubPullRequestAction",
  ])
    assert.equal(webMethodKind(name), "browser", name);
  assert.equal(webMethodKind("codeGitStatus"), "remote-runner");
  assert.equal(webMethodKind("startReview"), "remote-runner");
});

test("a status without a set-up service is never connected", () => {
  assert.deepEqual(parseGitHubStatus({ configured: false, connected: true }), {
    configured: false,
    connected: false,
  });
  assert.deepEqual(
    parseGitHubStatus({
      configured: true,
      connected: true,
      login: "octo",
      avatar_url: "https://avatars.example/1",
    }),
    {
      configured: true,
      connected: true,
      login: "octo",
      avatarUrl: "https://avatars.example/1",
    },
  );
  assert.deepEqual(parseGitHubStatus(null), {
    configured: false,
    connected: false,
  });
});

test("only an https address is followed to GitHub", () => {
  assert.equal(
    parseGitHubConnect({
      authorize_url: "https://github.com/login/oauth/authorize?client_id=x",
    }).authorizeUrl,
    "https://github.com/login/oauth/authorize?client_id=x",
  );
  for (const bad of [
    "",
    "javascript:alert(1)",
    "http://github.com/x",
    "not a url",
  ])
    assert.throws(() => parseGitHubConnect({ authorize_url: bad }), bad);
  assert.throws(() => parseGitHubConnect(undefined));
});

test("repository and branch pages are read defensively", () => {
  const page = parseGitHubRepositories({
    items: [
      {
        full_name: "octo/hello",
        name: "hello",
        owner: "octo",
        private: true,
        description: "Hi",
        default_branch: "main",
        clone_url: "https://github.com/octo/hello.git",
      },
      { full_name: "broken" },
      null,
    ],
    next_page: 2,
    truncated: true,
  });
  assert.deepEqual(page, {
    items: [
      {
        fullName: "octo/hello",
        name: "hello",
        owner: "octo",
        private: true,
        description: "Hi",
        defaultBranch: "main",
        cloneUrl: "https://github.com/octo/hello.git",
      },
    ],
    nextPage: 2,
    truncated: true,
  });
  assert.equal(
    parseGitHubRepositories({ items: [], next_page: 1 }).nextPage,
    null,
  );
  assert.deepEqual(
    parseGitHubBranches({
      default_branch: "main",
      items: [{ name: "main", protected: true }, { name: "" }, { name: "x" }],
      next_page: null,
    }),
    {
      defaultBranch: "main",
      items: [
        { name: "main", protected: true },
        { name: "x", protected: false },
      ],
      nextPage: null,
      truncated: false,
    },
  );
});

test("the return from GitHub and repository addresses", () => {
  assert.equal(parseGitHubReturn("connected"), "connected");
  assert.equal(parseGitHubReturn("denied"), "denied");
  assert.equal(parseGitHubReturn("failed"), "failed");
  assert.equal(parseGitHubReturn("<script>"), undefined);
  assert.equal(
    repositoryFullName("https://github.com/octo/hello.git"),
    "octo/hello",
  );
  assert.equal(repositoryFullName("https://github.com/octo"), undefined);
});

test("the web bridge asks the service, with the session's token", async () => {
  const { bridge, tab } = await signedInBridge();
  const seen: Array<{
    method: string;
    url: string;
    auth: string | null;
    body?: unknown;
  }> = [];
  tab.routes.push((request) => {
    const url = new URL(request.url, "https://claudex.example");
    if (!url.pathname.startsWith("/api/v1/claudex/web/github"))
      return undefined;
    seen.push({
      method: request.method,
      url: url.pathname + url.search,
      auth: request.headers.get("authorization"),
      body: request.body,
    });
    if (url.pathname === githubRoutes.status && request.method === "GET")
      return json(
        envelope({ configured: true, connected: true, login: "octo" }),
      );
    if (url.pathname === githubRoutes.status && request.method === "DELETE")
      return json(envelope({ configured: true, connected: false }));
    if (url.pathname === githubRoutes.connect)
      return json(
        envelope({
          authorize_url: "https://github.com/login/oauth/authorize?state=s",
        }),
      );
    if (url.pathname === githubRoutes.repositories)
      return json(
        envelope({
          items: [
            {
              full_name: "octo/hello",
              name: "hello",
              owner: "octo",
              default_branch: "main",
              clone_url: "https://github.com/octo/hello.git",
            },
          ],
          next_page: null,
        }),
      );
    if (url.pathname === githubRoutes.branches)
      return json(
        envelope({
          default_branch: "main",
          items: [{ name: "main" }],
          next_page: null,
        }),
      );
    return json({ code: 404 }, 404);
  });

  assert.deepEqual(await bridge.api.githubStatus(), {
    configured: true,
    connected: true,
    login: "octo",
  });
  assert.equal(
    (await bridge.api.githubConnect()).authorizeUrl,
    "https://github.com/login/oauth/authorize?state=s",
  );
  const repos = await bridge.api.githubRepositories({
    query: " hel ",
    page: 2,
  });
  assert.equal(repos.items[0]!.fullName, "octo/hello");
  const branches = await bridge.api.githubBranches({
    repository: "octo/hello",
    query: "ma",
  });
  assert.equal(branches.defaultBranch, "main");
  assert.equal((await bridge.api.githubDisconnect()).connected, false);

  assert.deepEqual(
    seen.map((r) => `${r.method} ${r.url}`),
    [
      "GET /api/v1/claudex/web/github",
      "POST /api/v1/claudex/web/github/connect",
      "GET /api/v1/claudex/web/github/repos?query=hel&page=2",
      "GET /api/v1/claudex/web/github/branches?repo=octo%2Fhello&query=ma",
      "DELETE /api/v1/claudex/web/github",
    ],
  );
  for (const r of seen) assert.match(r.auth ?? "", /^Bearer at-/);
});

test("the service's refusal reaches the window in words", async () => {
  const { bridge, tab } = await signedInBridge();
  tab.routes.push((request) =>
    request.url.includes("/web/github")
      ? json(
          {
            code: 409,
            reason: "CLAUDEX_GITHUB_NOT_CONNECTED",
            message: "Connect your GitHub account first",
          },
          409,
        )
      : undefined,
  );
  await assert.rejects(
    bridge.api.githubRepositories(),
    /Connect your GitHub account first/,
  );
});

test("issues and pull requests come from the service, and a missing connection is a reason, not a crash", async () => {
  const { bridge, tab } = await signedInBridge();
  const seen: string[] = [];
  tab.routes.push((request) => {
    const url = new URL(request.url, "https://claudex.example");
    if (!url.pathname.startsWith("/api/v1/claudex/web/github"))
      return undefined;
    seen.push(url.pathname + url.search);
    if (url.pathname === githubRoutes.issues)
      return url.searchParams.get("repo") === "octo/off"
        ? json(
            {
              code: 409,
              reason: "CLAUDEX_GITHUB_NOT_CONNECTED",
              message: "Connect your GitHub account first",
            },
            409,
          )
        : json(
            envelope({
              items: [
                {
                  number: 12,
                  title: "Crash",
                  state: "open",
                  repository: "octo/hello",
                  url: "https://github.com/octo/hello/issues/12",
                  labels: ["bug"],
                },
              ],
            }),
          );
    if (url.pathname === githubRoutes.issue)
      return json(
        envelope({
          number: 12,
          title: "Crash",
          state: "open",
          url: "https://github.com/octo/hello/issues/12",
          labels: [],
          body: "Steps",
          author: "octo",
          author_association: "OWNER",
        }),
      );
    if (url.pathname === githubRoutes.pull)
      return url.searchParams.get("number") === "8"
        ? json(
            { code: 404, reason: "CLAUDEX_GITHUB_NO_ACCESS", message: "gone" },
            404,
          )
        : json(
            envelope({
              number: 7,
              url: "https://github.com/octo/hello/pull/7",
              title: "T",
              state: "open",
              checks: "passed",
              base_ref: "main",
              head_ref: "feature",
            }),
          );
    return json({ code: 404 }, 404);
  });

  const issues = await bridge.api.githubIssues({
    repository: "octo/hello",
    query: " crash ",
  });
  assert.equal(issues.items[0]!.number, 12);
  assert.equal(issues.problem, undefined);
  assert.deepEqual(await bridge.api.githubIssues({ repository: "octo/off" }), {
    items: [],
    problem: "not-connected",
  });
  // A repository that isn't owner/name never reaches the service.
  assert.deepEqual(await bridge.api.githubIssues({ repository: "nope" }), {
    items: [],
  });
  assert.equal(
    (await bridge.api.githubIssue({ repository: "octo/hello", number: 12 }))
      ?.body,
    "Steps",
  );
  const pull = await bridge.api.githubPullRequest({
    repository: "octo/hello",
    number: 7,
  });
  assert.equal(pull.pullRequest?.checks, "passed");
  assert.deepEqual(
    await bridge.api.githubPullRequest({ repository: "octo/hello", number: 8 }),
    { pullRequest: null },
  );
  assert.deepEqual(seen, [
    "/api/v1/claudex/web/github/issues?repo=octo%2Fhello&query=crash",
    "/api/v1/claudex/web/github/issues?repo=octo%2Foff",
    "/api/v1/claudex/web/github/issue?repo=octo%2Fhello&number=12",
    "/api/v1/claudex/web/github/pull?repo=octo%2Fhello&number=7",
    "/api/v1/claudex/web/github/pull?repo=octo%2Fhello&number=8",
  ]);
});

test("the chosen repository is what the next Code session sends", () => {
  assert.equal(currentCodeRepository(), undefined);
  setCodeRepository(
    repositoryRef("https://github.com/o/r.git", "main", "main"),
  );
  assert.deepEqual(currentCodeRepository(), {
    url: "https://github.com/o/r.git",
  });
  setCodeRepository(
    repositoryRef("https://github.com/o/r.git", "main", "feature/x"),
  );
  assert.deepEqual(currentCodeRepository(), {
    url: "https://github.com/o/r.git",
    ref: "feature/x",
  });
  setCodeRepository(undefined);
  assert.equal(currentCodeRepository(), undefined);
});

test("sending without a repository asks the workspace bar to open its picker", async () => {
  const {
    requestRepositoryPicker,
    onRepositoryPickerRequest,
    setCodeRepository,
  } = await import("../../src/composer/code-repository");
  setCodeRepository(undefined);
  // A request made before the bar mounts waits for it.
  requestRepositoryPicker();
  let opened = 0;
  const stop = onRepositoryPickerRequest(() => opened++);
  assert.equal(opened, 1);
  requestRepositoryPicker();
  assert.equal(opened, 2);
  stop();
  // Choosing a repository drops a waiting request.
  requestRepositoryPicker();
  setCodeRepository({ url: "https://github.com/acme/app.git" });
  const again = onRepositoryPickerRequest(() => opened++);
  assert.equal(opened, 2);
  again();
  setCodeRepository(undefined);
});

test("the branch row's changes post to the service and come back as reasons", async () => {
  const { bridge, tab } = await signedInBridge();
  const bodies: unknown[] = [];
  tab.routes.push((request) => {
    const url = new URL(request.url, "https://claudex.example");
    if (url.pathname !== githubRoutes.pullAction) return undefined;
    // The fake hands the JSON body over parsed.
    const body = request.body as { number: number; action: string };
    bodies.push(body);
    if (body.number === 9)
      return json(
        {
          code: 409,
          reason: "CLAUDEX_GITHUB_NOT_CONNECTED",
          message: "Connect your GitHub account first",
        },
        409,
      );
    return json(
      envelope(
        body.action === "merge"
          ? { ok: true }
          : { ok: false, reason: "repo_disallows_auto_merge" },
      ),
    );
  });
  assert.deepEqual(
    await bridge.api.githubPullRequestAction({
      repository: "octo/hello",
      number: 7,
      action: "merge",
      headSha: "0123456789abcdef",
      mergeMethod: "squash",
    }),
    { ok: true },
  );
  assert.deepEqual(
    await bridge.api.githubPullRequestAction({
      repository: "octo/hello",
      number: 7,
      action: "autoMergeOn",
    }),
    { ok: false, reason: "repo_disallows_auto_merge" },
  );
  assert.deepEqual(
    await bridge.api.githubPullRequestAction({
      repository: "octo/hello",
      number: 9,
      action: "ready",
    }),
    { ok: false, reason: "not_connected" },
  );
  // A repository that isn't owner/name never reaches the service.
  assert.equal(
    (
      await bridge.api.githubPullRequestAction({
        repository: "nope",
        number: 7,
        action: "ready",
      })
    ).ok,
    false,
  );
  assert.deepEqual(bodies[0], {
    repo: "octo/hello",
    number: 7,
    action: "merge",
    head_sha: "0123456789abcdef",
    merge_method: "squash",
  });
  assert.equal(bodies.length, 3);
});
