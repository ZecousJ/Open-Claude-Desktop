import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  formReasons,
  optOutNote,
  ReportDialog,
  reportCategoryIds,
  reportReasons,
  reportUnavailable,
} from "../../src/artifacts/ReportArtifactDialog";
import {
  ReportChatDialog,
  sharedChatReport,
} from "../../src/collections/shared/ReportChatDialog";
import { parseSharedChat, reportFormCategories } from "../../shared/sharing";
import { sharingMethods } from "../../shared/sharing-api";
import { ClaudexSharing } from "../../electron/sub2api/claudex-sharing";

const submit = async () => {};

test("Report chat opens on the reason list, with no buttons until a reason the form takes", () => {
  const html = renderToStaticMarkup(
    createElement(ReportChatDialog, {
      token: "A".repeat(43),
      onSent() {},
      onClose() {},
    }),
  );
  assert.match(html, /Report chat/);
  assert.match(html, /Why are you reporting this\?/);
  assert.doesNotMatch(html, /role="switch"/);
  assert.doesNotMatch(html, />Report<\/button>/);
  // It sends, so it never says reporting is unavailable.
  assert.ok(!html.includes(reportUnavailable));
});

test("the opt-out switch follows the notes, off until switched on (live wording)", () => {
  const html = renderToStaticMarkup(
    createElement(ReportDialog, {
      title: "Report chat",
      optOut: true,
      submit,
      defaultReason: "Fraud",
      onClose() {},
    }),
  );
  assert.match(html, /Opt out of training on this report/);
  assert.match(
    html,
    /<button type="button" role="switch" class="settings-toggle" aria-labelledby="report-dialog-opt-out" aria-describedby="report-dialog-opt-out-note" aria-checked="false">/,
  );
  assert.ok(html.indexOf("<textarea") < html.indexOf('role="switch"'));
  assert.ok(html.includes(optOutNote));
  assert.match(optOutNote, /Claudex administrator/);
  assert.match(
    optOutNote,
    /Opt out of this use by changing the toggle above\.$/,
  );
  assert.match(
    html,
    />Close<\/button><button class="publish-dialog-publish">Report<\/button>/,
  );
});

test("the artifact viewer's report has no opt-out, and a form reason sends nothing", () => {
  const artifact = renderToStaticMarkup(
    createElement(ReportDialog, {
      title: "Report artifact",
      defaultReason: "Fraud",
      onClose() {},
    }),
  );
  assert.doesNotMatch(artifact, /role="switch"/);
  assert.match(artifact, /<button class="publish-dialog-publish" disabled=""/);
  const copyright = renderToStaticMarkup(
    createElement(ReportDialog, {
      title: "Report chat",
      optOut: true,
      submit,
      defaultReason: "Copyright infringement",
      onClose() {},
    }),
  );
  assert.match(
    copyright,
    /Please use this form to report copyright infringement\./,
  );
  assert.doesNotMatch(copyright, /role="switch"/);
  assert.doesNotMatch(copyright, />Report<\/button>/);
});

test("every reason has the live category, and the form takes all but the form reasons", () => {
  assert.deepEqual(Object.keys(reportCategoryIds), [...reportReasons]);
  const taken = reportReasons
    .filter((reason) => !formReasons.includes(reason))
    .map((reason) => reportCategoryIds[reason]);
  assert.deepEqual([...taken].sort(), [...reportFormCategories].sort());
});

test("a chat report carries the choice and drops empty fields", () => {
  assert.deepEqual(
    sharedChatReport({
      category: "fraud",
      notes: "",
      reporterName: "Ann",
      reporterEmail: "",
      optOutOfTraining: true,
    }),
    { category: "fraud", reporterName: "Ann", optOutOfTraining: true },
  );
  assert.deepEqual(
    sharedChatReport({
      category: "violation_of_terms",
      notes: "x".repeat(1200),
      reporterName: "",
      reporterEmail: "ann@example.com",
      optOutOfTraining: false,
    }),
    {
      category: "violation_of_terms",
      notes: "x".repeat(1000),
      reporterEmail: "ann@example.com",
      optOutOfTraining: false,
    },
  );
  assert.equal(
    sharedChatReport({
      category: "copyright_infringement",
      notes: "",
      reporterName: "",
      reporterEmail: "",
      optOutOfTraining: false,
    }),
    null,
  );
});

test("a shared chat says whether the administrator takes reports", () => {
  const token = "A".repeat(43);
  const wire = {
    token,
    kind: "conversation",
    title: "Plan",
    owner: "ann@example.com",
    snapshot_at: "2026-09-26T01:00:00Z",
    snapshot: { messages: [{ role: "user", text: "Hi" }] },
  };
  assert.equal(
    parseSharedChat({ ...wire, reportable: true })!.reportable,
    true,
  );
  assert.equal(parseSharedChat(wire)!.reportable, undefined);
  assert.equal(
    parseSharedChat({ ...wire, reportable: "yes" })!.reportable,
    undefined,
  );
  assert.equal(sharingMethods.includes("reportSharedChat"), true);
});

test("the report goes to the shared chat's report route with the opt-out", async () => {
  const calls: { url: string; method?: string; body: unknown }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method,
      body: JSON.parse(String(init?.body)),
    });
    return new Response(
      JSON.stringify({ code: 0, message: "success", data: { reported: true } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  const api = new ClaudexSharing("https://claudex.example.test", fetchImpl);
  const token = "B".repeat(43);
  await api.reportShared("access", token, {
    category: "fraud",
    reporterEmail: "ann@example.com",
    optOutOfTraining: true,
  });
  assert.deepEqual(calls, [
    {
      url: `https://claudex.example.test/api/v1/claudex/sharing/shared-with-me/${token}/report`,
      method: "POST",
      body: {
        category: "fraud",
        notes: "",
        reporter_name: "",
        reporter_email: "ann@example.com",
        opt_out_of_training: true,
      },
    },
  ]);
});
