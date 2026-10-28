import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSignInOptions } from "../../shared/sign-in-api";

test("the sign-in options name only real Google client ids", () => {
  const web = "983491988149-abc.apps.googleusercontent.com";
  assert.deepEqual(
    parseSignInOptions({
      email_code_login: false,
      google_client_id: web,
      google_desktop_client_id: "not a client id",
    }),
    { emailCodeLogin: false, googleClientId: web },
  );
});

test("the desktop's Google sign-in waits for the browser's code on a loopback address", async () => {
  const { authorizeWithGoogle } =
    await import("../../electron/account/google-sign-in");
  let opened = "";
  const done = authorizeWithGoogle(
    "client.apps.googleusercontent.com",
    async (url) => {
      opened = url;
      const sent = new URL(url);
      const redirect = sent.searchParams.get("redirect_uri")!;
      assert.match(redirect, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
      assert.equal(sent.searchParams.get("code_challenge_method"), "S256");
      assert.equal(sent.searchParams.get("scope"), "openid email profile");
      // A request with another state is refused; the right one finishes.
      await fetch(`${redirect}?code=x&state=wrong`);
      await fetch(
        `${redirect}?code=the-code&state=${sent.searchParams.get("state")}`,
      );
    },
  );
  const result = await done;
  assert.equal(result.code, "the-code");
  assert.ok(result.codeVerifier.length >= 43);
  assert.equal(
    result.redirectUri,
    new URL(opened).searchParams.get("redirect_uri"),
  );
});
