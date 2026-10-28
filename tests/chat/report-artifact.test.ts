import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppContext } from "../../electron/app/app-context";
import {
  artifactReportError,
  registerSharingHandlers,
} from "../../electron/ipc/sharing";
import { requestJson, Sub2ApiError } from "../../electron/sub2api/http";
import {
  artifactReportOf,
  ReportArtifactDialog,
  ReportDialog,
  reportsTurnedOff,
  reportUnavailable,
  type ReportAnswer,
} from "../../src/artifacts/ReportArtifactDialog";
import {
  artifactReportContentChars,
  parseArtifactReportsState,
} from "../../shared/sharing";
import { sharingMethods } from "../../shared/sharing-api";
import { fail, MockSub2Api, ok } from "../support/sub2api-mock";

type Json = Record<string, unknown>;
const user = { id: 3, email: "bob@example.test", password: "bob-password" };

const answer = (overrides: Partial<ReportAnswer> = {}): ReportAnswer => ({
  category: "violation_of_terms",
  notes: "",
  reporterName: "",
  reporterEmail: "",
  optOutOfTraining: false,
  ...overrides,
});
const page = {
  identity: "c-1:page.html",
  title: "Page",
  language: "html",
  content: "<p>hi</p>",
};

test("Report artifact waits for the service's answer, then sends or says why not", () => {
  // Rendered without an answer yet: Report waits, disabled, with no reason.
  const checking = renderToStaticMarkup(
    createElement(ReportArtifactDialog, { artifact: page, onClose() {} }),
  );
  assert.match(checking, /Report Artifact/);
  assert.match(checking, /<button class="publish-dialog-publish" disabled="">/);
  assert.ok(!checking.includes(reportUnavailable));
  assert.doesNotMatch(
    checking,
    /role="switch"/,
    "the viewer's report has no opt-out",
  );

  // Without an artifact, or on a local account: the reason.
  const none = renderToStaticMarkup(
    createElement(ReportArtifactDialog, { onClose() {} }),
  );
  assert.ok(none.includes(reportUnavailable));
  assert.match(none, /aria-describedby="report-dialog-unavailable"/);

  // Reports turned off by the administrator.
  const off = renderToStaticMarkup(
    createElement(ReportDialog, {
      title: "Report artifact",
      unavailable: reportsTurnedOff,
      onClose() {},
    }),
  );
  assert.ok(off.includes(reportsTurnedOff));
  assert.ok(!off.includes(reportUnavailable));
});

test("an artifact report carries the form and a copy, cut with the whole size", () => {
  assert.deepEqual(
    artifactReportOf(answer({ notes: "spam", reporterName: "Ann" }), page),
    {
      category: "violation_of_terms",
      notes: "spam",
      reporterName: "Ann",
      ...page,
    },
  );
  assert.equal(
    artifactReportOf(answer({ category: "copyright_infringement" }), page),
    null,
    "the form does not take copyright reports",
  );

  const long = "é".repeat(artifactReportContentChars + 10);
  const cut = artifactReportOf(answer(), { ...page, content: long })!;
  assert.equal(cut.content.length, artifactReportContentChars);
  assert.equal(cut.contentBytes, long.length * 2);

  // A character outside the Basic Multilingual Plane is never split.
  const emoji = "a" + "😀".repeat(artifactReportContentChars);
  const whole = artifactReportOf(answer(), { ...page, content: emoji })!;
  assert.equal(whole.content.length, artifactReportContentChars - 1);
  assert.doesNotMatch(whole.content, /[\uD800-\uDBFF]$/);

  // A binary file sends only its size.
  const image = artifactReportOf(answer(), {
    ...page,
    language: "image",
    content: "ignored",
    blob: true,
    bytes: 4096,
  })!;
  assert.equal(image.content, "");
  assert.equal(image.contentBytes, 4096);

  assert.equal(
    artifactReportOf(answer(), { ...page, language: "x".repeat(40) })!.language
      .length,
    32,
  );
});

test("the service's status says whether it takes artifact reports", () => {
  assert.equal(parseArtifactReportsState({ artifact_reports: true }), "open");
  assert.equal(parseArtifactReportsState({ artifact_reports: false }), "off");
  assert.equal(parseArtifactReportsState({ enabled: true }), "none");
  assert.equal(parseArtifactReportsState(null), "none");
  assert.equal(sharingMethods.includes("reportArtifact"), true);
  assert.equal(sharingMethods.includes("artifactReportsState"), true);
});

test("a failed report says what the live viewer says", () => {
  assert.equal(
    artifactReportError(new Sub2ApiError(429, "CLAUDEX_RATE_LIMITED", "x"))
      .message,
    "Too many reports submitted. Try again in a moment.",
  );
  assert.equal(
    artifactReportError(new Sub2ApiError(404, "CLAUDEX_REPORTS_OFF", "x"))
      .message,
    "Your administrator has turned off reports.",
  );
  assert.equal(
    artifactReportError(new Error("socket")).message,
    "Couldn’t send the report. Try again.",
  );
});

/** The sharing handlers over a Claudex account (or a local one). */
async function desktop(
  t: TestContext,
  remote: boolean,
  status: Json = { enabled: false, artifact_reports: true },
) {
  const mock = new MockSub2Api({ users: [user] });
  await mock.start();
  t.after(() => mock.close());
  const reports: Json[] = [];
  mock.route("GET", "/api/v1/claudex/sharing/status", () => ok(status));
  mock.route("POST", "/api/v1/claudex/sharing/artifact-reports", (request) => {
    if (status.artifact_reports !== true)
      return fail(404, "Reports are off", "CLAUDEX_REPORTS_OFF");
    reports.push(request.body);
    return ok({ reported: true });
  });
  const login = (await requestJson(fetch, `${mock.url}/api/v1/auth/login`, {
    method: "POST",
    body: { email: user.email, password: user.password },
  })) as Json;
  const token = String(login.access_token);
  const ctx = {
    store: { root: "/nonexistent", conversations: [] },
    remote: remote
      ? {
          accounts: { baseUrl: mock.url },
          session: {
            authorized: <T>(call: (token: string) => Promise<T>) => call(token),
          },
        }
      : undefined,
    artifactShares: {},
    services: {},
    push() {},
  } as unknown as AppContext;
  const handlers = new Map<string, (...args: any[]) => any>();
  registerSharingHandlers((name, fn) => handlers.set(name, fn), ctx);
  const call = (name: string, ...args: unknown[]) =>
    handlers.get(name)!(...args);
  return { call, reports, status };
}

test("Report artifact reaches the service's report route, sharing on or not", async (t) => {
  const { call, reports, status } = await desktop(t, true);
  assert.equal(await call("artifactReportsState"), "open");
  await call("reportArtifact", {
    ...artifactReportOf(answer({ reporterEmail: "ann@example.com" }), page),
  });
  assert.deepEqual(reports, [
    {
      category: "violation_of_terms",
      notes: "",
      reporter_name: "",
      reporter_email: "ann@example.com",
      identity: "c-1:page.html",
      title: "Page",
      language: "html",
      content: "<p>hi</p>",
    },
  ]);
  // A category the form does not take never leaves the app.
  await assert.rejects(
    call("reportArtifact", { ...page, category: "copyright_infringement" }),
  );
  assert.equal(reports.length, 1);

  status.artifact_reports = false;
  assert.equal(await call("artifactReportsState"), "off");
  await assert.rejects(
    call("reportArtifact", { ...page, category: "fraud" }),
    /turned off reports/,
  );
  delete status.artifact_reports;
  assert.equal(await call("artifactReportsState"), "none", "an older service");
});

test("a local account cannot send Report artifact", async (t) => {
  const { call, reports } = await desktop(t, false);
  assert.equal(await call("artifactReportsState"), "none");
  await assert.rejects(
    call("reportArtifact", { ...page, category: "fraud" }),
    /sign in to one first/,
  );
  assert.equal(reports.length, 0);
});
