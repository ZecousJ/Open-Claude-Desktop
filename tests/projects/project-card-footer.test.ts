import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { desktopHost, webHost, type HostInfo } from "../../shared/host";
import type { Project } from "../../shared/types";
import { HostContext } from "../../src/host/HostContext";
import { ProjectCardFooter } from "../../src/collections/projects/ProjectCardFooter";
import {
  projectDate,
  projectDateTooltip,
} from "../../src/collections/projects/project-list";

const project: Project = {
  id: "local",
  name: "Garden",
  description: "",
  instructions: "",
  cwd: "/Users/ada/Garden",
  createdAt: new Date(2025, 2, 8).getTime(),
};

const footer = (host: HostInfo, value = project, timestamp = value.createdAt) =>
  renderToStaticMarkup(
    createElement(
      HostContext.Provider,
      { value: host },
      createElement(ProjectCardFooter, { project: value, timestamp }),
    ),
  );

test("project footer orders date, folder and Local with the full accessible labels and official glyphs", () => {
  const html = footer(desktopHost);
  assert.match(html, /dateTime="2025-03-0[78]T/);
  assert.ok(html.indexOf("<time") < html.indexOf('class="prj-card-folder"'));
  assert.ok(
    html.indexOf('class="prj-card-folder"') <
      html.indexOf('class="prj-card-local"'),
  );
  assert.match(html, /dir="ltr"/);
  assert.match(html, /aria-hidden="true">Garden<\/span>/);
  assert.match(html, /class="sr-only">\/Users\/ada\/Garden<\/span>/);
  assert.match(html, /aria-hidden="true">Local<\/span>/);
  assert.match(html, /class="sr-only">Runs on this computer<\/span>/);
  assert.equal((html.match(/<svg[^>]*width="16"/g) ?? []).length, 2);
  assert.match(html, /lucide-laptop/);
  assert.match(html, /lucide-folder/);
  assert.doesNotMatch(html, /title=/);
});

test("only desktop projects with a working folder show folder and local badges", () => {
  for (const html of [
    footer(webHost),
    footer(desktopHost, { ...project, cwd: undefined }),
    footer(desktopHost, { ...project, cwd: "" }),
  ]) {
    assert.doesNotMatch(
      html,
      /prj-card-badges|prj-card-folder|prj-card-local|Runs on this computer/,
    );
    assert.match(html, /<time/);
  }
  assert.doesNotMatch(footer(desktopHost, project, 0), /<time/);
});

test("Ee dates use rounded relative times for seven days, then short dates with the year only when needed", () => {
  const now = new Date(2026, 9, 15, 12).getTime();
  const minute = 60_000;
  const day = 24 * 60 * minute;
  assert.equal(projectDate(now, now), "just now");
  assert.equal(projectDate(now - 59_000, now), "just now");
  assert.equal(projectDate(now - minute, now), "1 minute ago");
  assert.equal(projectDate(now - 91_000, now), "2 minutes ago");
  assert.equal(projectDate(now - 60 * minute, now), "1 hour ago");
  assert.equal(projectDate(now - day, now), "yesterday");
  assert.equal(projectDate(now - 6 * day, now), "6 days ago");
  assert.equal(projectDate(now - 7 * day, now), "Oct 8");
  assert.equal(projectDate(new Date(2025, 2, 8).getTime(), now), "Mar 8, 2025");
  assert.equal(
    projectDateTooltip(now),
    new Date(now).toLocaleString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }),
  );
});
