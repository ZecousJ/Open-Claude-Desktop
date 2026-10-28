import test from "node:test";
import assert from "node:assert/strict";
import { mayUseMicrophone } from "../../electron/voice/microphone-permission";

test("microphone permission is limited to the app main frame requesting audio only", () => {
  const app =
    "file:///Applications/Claudex.app/Contents/Resources/app.asar/dist/index.html";
  const request = {
    requesterIsMainWindow: true,
    isMainFrame: true,
    requestingUrl: app,
    mainUrl: app,
    mediaTypes: ["audio"],
  };
  assert.equal(mayUseMicrophone(request), true);
  assert.equal(mayUseMicrophone({ ...request, isMainFrame: false }), false);
  assert.equal(
    mayUseMicrophone({ ...request, requesterIsMainWindow: false }),
    false,
  );
  assert.equal(mayUseMicrophone({ ...request, mediaTypes: ["video"] }), false);
  assert.equal(
    mayUseMicrophone({ ...request, mediaTypes: ["audio", "video"] }),
    false,
  );
  assert.equal(
    mayUseMicrophone({
      ...request,
      requestingUrl: "claudex-preview://document/fixture",
    }),
    false,
  );
  assert.equal(
    mayUseMicrophone({ ...request, mainUrl: "https://example.invalid/" }),
    false,
  );
  assert.equal(
    mayUseMicrophone({
      ...request,
      mainUrl: "http://127.0.0.1:5173/",
      requestingUrl: "http://127.0.0.1:5173/",
    }),
    true,
  );
});

test("Quick Entry may capture audio only from its owned top frame and exact page", () => {
  for (const app of [
    "file:///Applications/Claudex.app/Contents/Resources/app.asar/dist/quick.html",
    "claudex-app://ui/packs/current/quick.html",
  ]) {
    const request = {
      requesterIsMainWindow: false,
      requesterIsQuickEntry: true,
      isMainFrame: true,
      requestingUrl: app,
      mainUrl: app,
      mediaTypes: ["audio"],
    };
    assert.equal(mayUseMicrophone(request), true);
    assert.equal(
      mayUseMicrophone({ ...request, requesterIsQuickEntry: false }),
      false,
    );
    assert.equal(mayUseMicrophone({ ...request, isMainFrame: false }), false);
    assert.equal(
      mayUseMicrophone({ ...request, mediaTypes: ["video"] }),
      false,
    );
    assert.equal(
      mayUseMicrophone({
        ...request,
        requestingUrl: "https://example.invalid/",
      }),
      false,
    );
    const other = app.replace("quick.html", "index.html");
    assert.equal(
      mayUseMicrophone({ ...request, mainUrl: other, requestingUrl: other }),
      false,
    );
  }
});
