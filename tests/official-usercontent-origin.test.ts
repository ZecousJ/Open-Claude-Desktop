import test from "node:test";
import assert from "node:assert/strict";
import { officialUserContentOrigin } from "../shared/official-usercontent-origin";
test("only configured isolated HTTPS or distinct loopback origins can receive document content", () => {
  assert.equal(
    officialUserContentOrigin("http://localhost:5200", "http://127.0.0.1:5100"),
    "http://localhost:5200",
  );
  assert.equal(
    officialUserContentOrigin(
      "https://content.example.test",
      "https://app.example.test",
    ),
    "https://content.example.test",
  );
  for (const value of [
    undefined,
    "",
    "http://remote.example",
    "https://app.example.test",
    "https://app.example.test:9999",
    "https://user:secret@content.example.test",
    "https://content.example.test/path",
    "https://content.example.test/?secret=1",
    "javascript:alert(1)",
    "https://content.example.test#x",
  ])
    assert.equal(
      officialUserContentOrigin(value, "https://app.example.test"),
      undefined,
    );
  assert.equal(
    officialUserContentOrigin(
      "http://localhost:5200",
      "https://app.example.test",
    ),
    undefined,
  );
});
