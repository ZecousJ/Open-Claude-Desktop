import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  taskConnectionRequest,
  taskConnectionHoldMessage,
} from "../../shared/task-connection-hold";
import { ConnectionHold } from "../../src/collections/routines/ConnectionHold";
import { FolderInstructions } from "../../src/cowork/FolderInstructions";

test("connection requests require URL elicitation and a configured matching HTTPS service origin", () => {
  const servers = { notion: { url: "https://mcp.notion.com/mcp" } };
  const request = (url: string, serverName = "notion", mode = "url") =>
    taskConnectionRequest(
      {
        method: "mcpServer/elicitation/request",
        params: { mode, url, serverName },
      },
      servers,
    );
  assert.deepEqual(request("https://mcp.notion.com/sign-in"), {
    service: "notion",
    url: "https://mcp.notion.com/sign-in",
  });
  for (const url of [
    "http://mcp.notion.com",
    "javascript:alert(1)",
    "https://other.test",
    "https://user:pass@mcp.notion.com",
    "not a url",
  ])
    assert.deepEqual(request(url), { service: "notion" });
  assert.deepEqual(request("https://unknown.test", "unknown"), {
    service: "unknown",
  });
  assert.equal(request("https://mcp.notion.com", "notion", "form"), undefined);
});

test("connection recovery exposes the official host and action-group copy", () => {
  const html = renderToStaticMarkup(
    createElement(ConnectionHold, {
      hold: { service: "Notion", url: "https://mcp.notion.com/sign-in" },
      onRun() {},
      disabled: false,
    }),
  );
  assert(html.includes(taskConnectionHoldMessage));
  assert.match(html, /Its sign-in page is at mcp.notion.com\./);
  assert.match(html, /aria-label="Connect and run"/);
  assert.match(html, />Connect Notion<\/button>/);
  assert.doesNotMatch(html, />Run now<\/button>/);
});

test("folder editor loads before saving and has no close X", () => {
  const html = renderToStaticMarkup(
    createElement(FolderInstructions, { conversationId: "task", onClose() {} }),
  );
  assert.match(html, /Folder instructions/);
  assert.match(
    html,
    /Use this to give Claudex instructions for working in this folder\./,
  );
  assert.match(html, /Loading\.\.\./);
  assert.match(html, /disabled=""[^>]*>Save/);
  assert.doesNotMatch(html, /aria-label="Close"/);
});

test("home Active rows and the Tasks sidepanel retain their distinct official geometry", () => {
  const css = fs
    .readFileSync(
      new URL("../../src/cowork/cowork-active.css", import.meta.url),
      "utf8",
    )
    .replace(/\s+/g, " ");
  assert.match(
    css,
    /\.cowork-active a \{[^}]*gap: 12px; padding: 12px 8px;[^}]*border-radius: 8px/,
  );
  assert.match(
    css,
    /\.cowork-panel-row \{[^}]*height: 56px; gap: 10px;[^}]*border-radius: 16px; padding: 0 14px 0 12px/,
  );
  assert.match(css, /\.cowork-active-text strong \{[^}]*font-size: 14px/);
  assert.match(css, /\.cowork-active-text small \{[^}]*font-size: 12px/);
});
