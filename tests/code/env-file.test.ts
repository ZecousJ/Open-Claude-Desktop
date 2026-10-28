import assert from "node:assert/strict";
import { test } from "node:test";
import { envFileProblem, parseEnvFile } from "../../shared/env-file";

test("parses the example the Local environment editor shows (R-0386)", () => {
  const text = [
    "NODE_ENV=production",
    "GIT_AUTHOR_NAME=Your Name",
    "",
    "# Multiline values - wrap in quotes",
    'CONFIG="key1=val1',
    'key2=val2"',
  ].join("\n");
  assert.deepEqual(parseEnvFile(text), {
    NODE_ENV: "production",
    GIT_AUTHOR_NAME: "Your Name",
    CONFIG: "key1=val1\nkey2=val2",
  });
});

test("handles export, single quotes, trailing comments and CRLF", () => {
  assert.deepEqual(
    parseEnvFile("export A=1 # one\r\nB='x y'\r\nnot a line\r\n=x\r\n"),
    { A: "1", B: "x y" },
  );
});

test("never lets a line replace the variables Claudex sets", () => {
  assert.deepEqual(
    parseEnvFile("CODEX_HOME=/x\nclaudex_gateway_token=t\nOK=1"),
    { OK: "1" },
  );
});

test("the editor says what is wrong with a line, as the original does", () => {
  const example = 'NODE_ENV=production\n# note\nCONFIG="a=1\nb=2"';
  assert.equal(envFileProblem(example), undefined);
  assert.deepEqual(envFileProblem("A=1\nfoo bar"), {
    message: "Couldn't parse “{line}”. Use KEY=value format.",
    values: { line: "foo bar" },
  });
  assert.equal(envFileProblem("A-B=1")?.values.name, "A-B");
  assert.match(envFileProblem("path=/x")!.message, /managed by Claudex/);
  // A name still being typed on the last line is let through while typing.
  assert.ok(envFileProblem("A=1\nB"));
  assert.equal(
    envFileProblem("A=1\nB", { allowTrailingBareKey: true }),
    undefined,
  );
});
