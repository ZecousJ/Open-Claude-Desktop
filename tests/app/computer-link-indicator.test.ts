import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import type { Conversation } from "../../shared/types";
import { ComputerLinkIndicator } from "../../src/conversation/ComputerLinkIndicator";

const chat = (extra: Partial<Conversation> = {}): Conversation => ({
  id: "c",
  title: "c",
  mode: "chat",
  pinned: false,
  archived: false,
  providerId: "p",
  model: "m",
  createdAt: 1,
  updatedAt: 1,
  turns: [],
  ...extra,
});
const render = (c: Conversation) =>
  parseHTML(
    `<div>${renderToStaticMarkup(createElement(ComputerLinkIndicator, { conversation: c }))}</div>`,
  ).document;

test("a chat linked to a computer shows the live Laptop indicator beside its title", () => {
  assert.equal(render(chat()).querySelector(".computer-link"), null);
  const unknown = render(
    chat({ linkedToComputer: true, linkedComputerName: "Studio Mac" }),
  );
  const plain = unknown.querySelector(".computer-link-trigger")!;
  assert.equal(plain.getAttribute("aria-label"), "Studio Mac");
  assert.equal(plain.getAttribute("data-status"), null);
  assert.ok(plain.querySelector('[data-icon="Laptop"]'));
  const online = render(
    chat({
      linkedToComputer: true,
      linkedComputerName: "Studio Mac",
      linkedComputerOnline: true,
      linkedComputerAccess: true,
    }),
  ).querySelector(".computer-link-trigger")!;
  assert.equal(online.getAttribute("data-status"), "connected");
  assert.equal(online.getAttribute("aria-label"), "Studio Mac, Connected");
  assert.ok(online.querySelector(".computer-link-dot.connected"));
  const away = render(
    chat({
      linkedToComputer: true,
      linkedComputerName: "Studio Mac",
      linkedComputerOnline: false,
    }),
  ).querySelector(".computer-link-trigger")!;
  assert.equal(away.getAttribute("data-status"), "away");
  assert.equal(
    away.getAttribute("aria-label"),
    "Studio Mac, Asleep or app closed",
  );
});
