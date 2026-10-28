import test from "node:test";
import assert from "node:assert/strict";
import {
  routineMailer,
  routineRunMails,
} from "../../electron/routines/routine-mail";

test("a run mails when the person's switch is on, or when its task asks", () => {
  assert.equal(
    routineRunMails({ notifyOnCompletion: { email: true } }, false),
    true,
  );
  // A new task saves email off: that never silences the person's switch.
  assert.equal(
    routineRunMails({ notifyOnCompletion: { email: false } }, true),
    true,
  );
  assert.equal(routineRunMails({}, true), true);
  assert.equal(routineRunMails({}, false), false);
  assert.equal(
    routineRunMails({ notifyOnCompletion: { email: false } }, false),
    false,
  );
});

test("the mailer asks the service once in a while and posts the run with the session's token", async () => {
  const requests: {
    url: string;
    method: string;
    auth: string;
    body?: string;
  }[] = [];
  let clock = 0;
  const fake = (async (url: string, init: RequestInit = {}) => {
    requests.push({
      url,
      method: init.method ?? "GET",
      auth: String(
        (init.headers as Record<string, string>)?.Authorization ?? "",
      ),
      body: init.body as string | undefined,
    });
    const data =
      (init.method ?? "GET") === "GET" ? { available: true } : { sent: true };
    return new Response(JSON.stringify({ code: 0, data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  const mailer = routineMailer(
    () => ({
      baseUrl: () => "https://svc.example",
      authorized: (call) => call("tok"),
    }),
    fake,
    () => clock,
  );
  assert.equal(await mailer.available(), true);
  assert.equal(await mailer.available(), true);
  assert.equal(requests.length, 1, "cached");
  clock += 6 * 60_000;
  await mailer.available();
  assert.equal(requests.length, 2);
  assert.equal(
    await mailer.send({ task: "Digest", outcome: "completed", summary: "ok" }),
    true,
  );
  const post = requests.at(-1)!;
  assert.equal(post.url, "https://svc.example/api/v1/claudex/routines/email");
  assert.equal(post.method, "POST");
  assert.match(post.auth, /tok/);
  assert.deepEqual(JSON.parse(post.body!), {
    task: "Digest",
    outcome: "completed",
    summary: "ok",
  });
  const signedOut = routineMailer(() => undefined, fake);
  assert.equal(await signedOut.available(), false);
  assert.equal(await signedOut.send({ task: "x", outcome: "failed" }), false);
});
