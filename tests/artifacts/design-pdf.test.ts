import test from "node:test";
import assert from "node:assert/strict";
import {
  designBridgeOrigin,
  designPdfFilename,
  designPdfInput,
} from "../../shared/design-pdf";
import { popoutChrome } from "../../electron/artifacts/artifact-popout-page";

const nonce = "0b0c7b1e-3f7a-4d7e-9a3d-1c2b3a4d5e6f";
test("the PDF preload admits only official origins or the exact registered Claudex toolbar", () => {
  for (const origin of [
    "https://claude.ai",
    "https://preview.claude.ai",
    "https://claude.com",
    "https://preview.claude.com",
    "https://preview.ant.dev",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
  ])
    assert.equal(designBridgeOrigin(origin), true, origin);
  for (const origin of [
    "https://claude.ai.evil.test",
    "https://evil.test/claude.ai",
    "http://claude.ai",
    "https://claude.ai:444",
    "file:///tmp/test",
    "https://ant.dev",
    "javascript:alert(1)",
  ])
    assert.equal(designBridgeOrigin(origin), false, origin);
  const toolbar = `claudex-preview://document/${nonce}`;
  assert.equal(designBridgeOrigin(`${toolbar}#cmd=return&n=1`, toolbar), true);
  assert.equal(designBridgeOrigin(`${toolbar}-other`, toolbar), false);
  assert.equal(designBridgeOrigin(toolbar), false);
});

test("PDF request validates the nonce and limits; invalid paper falls back to Letter", () => {
  const request = {
    origin: "claudex-preview://document",
    nonce,
    docTitle: "Report",
  };
  assert.deepEqual(designPdfInput(request), request);
  assert.deepEqual(
    designPdfInput({ ...request, paper: { widthPx: 960, heightPx: 540 } }),
    { ...request, paper: { widthPx: 960, heightPx: 540 } },
  );
  for (const paper of [
    { widthPx: 0, heightPx: 1 },
    { widthPx: NaN, heightPx: 10 },
    { widthPx: 20001, heightPx: 10 },
  ])
    assert.deepEqual(designPdfInput({ ...request, paper }), request);
  for (const value of [
    null,
    [],
    { ...request, nonce: "not-a-nonce" },
    { ...request, docTitle: "a".repeat(4097) },
    { ...request, origin: "a".repeat(513) },
  ])
    assert.equal(designPdfInput(value), undefined);
});

test("PDF save names cannot traverse directories or name reserved Windows devices", () => {
  assert.equal(designPdfFilename("../../Report"), "Report.pdf");
  assert.equal(designPdfFilename("C:\\folder\\Report"), "Report.pdf");
  for (const title of ["CON", "LPT1.txt", "NUL", ".", " "])
    assert.equal(designPdfFilename(title), "document.pdf");
  assert.equal(designPdfFilename("Report\u202e"), "Report.pdf");
  assert.equal(Array.from(designPdfFilename("😀".repeat(200))).length, 124);
});

test("the localized print action calls the restricted bridge using the frame nonce", () => {
  const html = popoutChrome({
    title: "Report",
    frameUrl: `claudex-preview://document/${nonce}#${nonce}`,
    dark: true,
    platform: "darwin",
    canSave: true,
    pdfLabel: "下载为 PDF",
    pdfError: "下载失败",
  });
  assert.match(html, /data-local="pdf">下载为 PDF/);
  assert.match(html, /omeletteDesktopPdf\?\.printFrameToPdf/);
  assert.match(html, /nonce: url.hash.slice\(1\)/);
  assert.match(html, /sandbox="allow-scripts"/);
  assert.doesNotMatch(html, /allow-same-origin/);
});
