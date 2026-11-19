import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { JSDOM } from "jsdom";
import { completionQuoteVisibleParagraphs as visible } from "../electron/official-ui/api/completion-quote-visible-text";
import {
  resolveCompletionQuoteSources as resolve,
  type QuoteSourceContext,
} from "../electron/official-ui/api/completion-quote-source";
import { normalizeCompletionQuotes } from "../electron/official-ui/api/completion-quotes";

const target = "33333333-3333-4333-8333-333333333333";
const source = "Hello **bold** world and [link](https://example.invalid)";
test("projects visible CJK emphasis next to words without changing source", () => {
  assert.deepEqual(visible("**型号：**PWM"), ["型号：PWM"]);
  assert.deepEqual(visible("**型号： **PWM"), ["型号： PWM"]);
});
const context = (text = source): QuoteSourceContext => ({
  conversation: {
    id: "owned",
    turns: [
      {
        id: "turn",
        prompt: "User prompt",
        items: [
          { type: "agentMessage", text },
          { type: "thinking", text: "PRIVATE_THOUGHT" },
          { type: "tool", text: "PRIVATE_TOOL" },
        ],
      },
    ],
    savedBranches: [],
  } as any,
  current: () => true,
  userMessageId: () => "msg_user",
  assistantMessageId: () => target,
});
const quote = (text: string, id: string | undefined = target): any => ({
  passage: {
    case: "excerpt",
    value: { text, ...(id === undefined ? {} : { targetMessageId: id }) },
  },
  comment: "Explain formatting",
  author: 2,
});

test("projects only known inline paragraph text, including nested formatting, labels and code", () => {
  assert.deepEqual(visible(source), ["Hello bold world and link"]);
  assert.deepEqual(
    visible(
      "😀 **strong and *emphasis***, ~~removed~~, ` code `, 中文 &amp; text",
    ),
    ["😀 strong and emphasis, removed, code, 中文 & text"],
  );
  assert.deepEqual(
    visible("A [**bold** link](https://example.invalid/private) label"),
    ["A bold link label"],
  );
  assert.deepEqual(visible("Keep ~single tildes~ literal"), [
    "Keep ~single tildes~ literal",
  ]);
});

test("accepts selection of rendered CJK emphasis against the original message", () => {
  assert.equal(resolve(context("**型号：**PWM"), [quote("型号：PWM")]).quotes.length, 1);
  assert.equal(resolve(context("**型号： **PWM"), [quote("型号： PWM")]).quotes.length, 1);
  assert.throws(() => resolve(context("`**型号：**PWM`"), [quote("型号：PWM")]), /does not match/);
});

test("refuses unsupported blocks, images, HTML, math and ambiguous line breaks", () => {
  for (const value of [
    "a **bold**\nb",
    "a **bold**\r\nb",
    "a **bold**\u2028b",
    "a **bold**\tb",
    "# A **heading**",
    "- A **list**",
    "> A **quote**",
    "    indented code",
    "A ![image](https://example.invalid) caption",
    "A <b>bold</b> value",
    "<div hidden>\n\nA **hidden** paragraph.\n\n</div>",
    "A &#10; **bold** value",
    "A &#9; **bold** value",
    "A $x^2$ formula",
    "A $$x^2$$ formula",
    "A \\(x^2\\) formula",
    "A \\[x^2\\] formula",
    "| A | B |\n| - | - |",
    "",
    "---",
  ])
    assert.equal(visible(value), undefined, JSON.stringify(value));
});

test("matches one eligible paragraph inside a larger message without joining block boundaries", () => {
  const raw =
    "Alpha paragraph.\n\n" +
    source +
    "\n\n中文段落。\n\n# Unsupported heading\n\nA $x^2$ paragraph.";
  assert.deepEqual(visible(raw), [
    "Alpha paragraph.",
    "Hello bold world and link",
    "中文段落。",
  ]);
  assert.equal(
    resolve(context(raw), [quote("Hello bold world and link")]).quotes.length,
    1,
  );
  for (const passage of [
    "paragraph. Hello bold",
    "link\n\n中文",
    "heading A x2",
  ])
    assert.throws(
      () => resolve(context(raw), [quote(passage)]),
      /does not match/,
    );
});

test("bounds parser input and projected node count, without widening the raw source path", () => {
  assert.equal(visible("x".repeat(64 * 1024 + 1)), undefined);
  assert.equal(visible("**x** ".repeat(2050)), undefined);
  assert.equal(visible("*".repeat(68) + "word" + "*".repeat(68)), undefined);
  const raw = "start\n**raw**\n" + "x".repeat(70_000);
  assert.equal(resolve(context(raw), [quote("**raw**")]).quotes.length, 1);
});

test("formatted matching keeps exact target/comment and still rejects invented or hidden text", () => {
  const ctx = context();
  const input = quote("bold world and link"),
    before = structuredClone(input);
  assert.deepEqual(resolve(ctx, [input]).quotes, [input]);
  assert.deepEqual(input, before);
  for (const text of [
    "bold world and other",
    "PRIVATE_THOUGHT",
    "PRIVATE_TOOL",
  ])
    assert.throws(() => resolve(ctx, [quote(text)]), /does not match/);
  assert.equal(
    resolve(ctx, [quote("https://example.invalid")]).quotes.length,
    1,
    "existing raw-source match is unchanged",
  );
  assert.throws(
    () => resolve(ctx, [quote("bold world and link", "msg_foreign")]),
    /not in this conversation/,
  );
  ctx.messageRef = () => ({
    turnId: "different",
    kind: "assistant",
    branchId: "original",
    active: true,
  });
  assert.throws(() => resolve(ctx, [input]), /stale/);
  ctx.current = () => false;
  assert.throws(() => resolve(ctx, [input]), /account changed/);
});

test("does not assume user prompts have the assistant Markdown renderer", () => {
  const ctx = context();
  ctx.conversation!.turns[0].prompt = "A **bold** user prompt";
  assert.throws(
    () => resolve(ctx, [quote("A bold user prompt", "msg_user")]),
    /does not match/,
  );
  assert.equal(
    resolve(ctx, [quote("A **bold** user prompt", "msg_user")]).quotes.length,
    1,
  );
});

test("unsupported projection does not flatten richer syntax, and targetless excerpts retain their contract", () => {
  for (const [raw, selected] of [
    ["A <b>bold</b> text", "A bold text"],
    ["A $x^2$ value", "A x2 value"],
    ["A **bold**\nnext line", "A bold next line"],
    ["A ![image](https://example.invalid) label", "A image label"],
  ])
    assert.throws(
      () => resolve(context(raw), [quote(selected)]),
      /does not match/,
    );
  const ctx = context();
  delete ctx.conversation;
  const input = quote("User supplied excerpt");
  delete input.passage.value.targetMessageId;
  assert.deepEqual(resolve(ctx, [input]).quotes, [input]);
});

const assets =
  ".restore/archive-extracted/claude-frontend-4.4212.0/src/cloud/assets/v1/";
function original(file: string, name: string): string {
  const ast = ts.createSourceFile(
    file,
    fs.readFileSync(assets + file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const found = ast.statements.filter(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  assert.equal(found.length, 1, `original ${file}:${name}`);
  return found[0].getText(ast);
}

test("actual original DOM selection and HO producer survive resolver and quote normalization", () => {
  const dom = new JSDOM(
    '<p id="source">Hello <strong>bold</strong> world and <a href="https://example.invalid">link</a></p>',
  );
  try {
    const p = dom.window.document.getElementById("source")!;
    const range = dom.window.document.createRange();
    range.selectNodeContents(p);
    dom.window.getSelection()!.addRange(range);
    const selection = vm.createContext({
      eN: (element: Element) => element.ownerDocument.defaultView,
      Node: dom.window.Node,
      nl: 2,
    });
    for (const name of ["I0", "Kh"])
      vm.runInContext(original("shared-39-BVbIfnmZ.js", name), selection);
    const passage = selection.I0(selection.Kh(p));
    assert.equal(passage, "Hello bold world and link");
    const producer = vm.createContext({
      At: (s: string) => /^[a-f0-9-]{36}$/i.test(s),
      Yr: (s: string) => !s.trim(),
      mr: (a: any) => a.kind === "excerpt",
    });
    const file = "30d42b21c0beac5d9cf92fe74ad903f7b6e31755849b8edc-BRBPiM5u.js";
    for (const name of [
      "GO",
      "KO",
      "qO",
      "JO",
      "YO",
      "HO",
      "ek",
      "nk",
      "tk",
      "$O",
      "QO",
    ])
      vm.runInContext(original(file, name), producer);
    const wire = JSON.parse(
      JSON.stringify(
        producer.HO(
          [
            {
              kind: "excerpt",
              extracted_content: passage,
              quote_reply: "Explain formatting",
              quote_message_uuid: target,
            },
          ],
          "My question",
          true,
        ),
      ),
    );
    const resolved = resolve(
      context("Alpha paragraph.\n\n" + source + "\n\n中文段落。"),
      wire.quotes,
    );
    const prepared = normalizeCompletionQuotes({
      text: wire.text,
      quotes: resolved.quotes,
    });
    assert.equal(prepared.quotes[0].passage.value.text, passage);
    assert.equal(prepared.quotes[0].passage.value.targetMessageId, target);
    const recovered = JSON.parse(
      JSON.stringify(producer.QO(prepared.quotes, prepared.text)),
    );
    assert.equal(recovered.typedText, "My question");
    assert.equal(recovered.quotes[0].passage, passage);
    assert.equal(recovered.quotes[0].reply, "Explain formatting");
  } finally {
    dom.window.close();
  }
});
