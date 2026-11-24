import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { CodexRPC } from "../../electron/engine/rpc";

const child = () =>
  spawn(
    process.execPath,
    [
      "-e",
      String.raw`
  const readline=require('node:readline'),fs=require('node:fs');
  const lines=readline.createInterface({input:process.stdin});
  const keep=setInterval(()=>{},1000);
  lines.on('close',()=>{clearInterval(keep);process.exit(0)});
  lines.on('line',line=>{
    const msg=JSON.parse(line);
    if(msg.id===undefined)return;
    if(msg.method==='close-output'){fs.closeSync(1);return;}
    if(msg.method==='crash'){process.exit(7);return;}
    if(msg.method==='final-output'){const text=JSON.stringify({id:msg.id,result:{ok:true}}); if(process.platform==='win32')process.stdout.write(text,()=>process.exit(0));else process.stdout.end(text);return;}
    if(msg.method==='unicode-tool'){
      const frame=Buffer.from(JSON.stringify({method:'item/completed',params:{text:'甲\u2028乙\u2029丙'}})+'\r\n');
      const split=frame.indexOf(Buffer.from('\u2028'))+1;
      process.stdout.write(frame.subarray(0,split));
      setImmediate(()=>process.stdout.write(Buffer.concat([frame.subarray(split),Buffer.from(JSON.stringify({id:msg.id,result:true})+'\n')])));
      return;
    }
    if(msg.method==='hang')return;
    const result=msg.method==='large'?{content:'x'.repeat(3*1024*1024)}:{ok:true};
    process.stdout.write(JSON.stringify({id:msg.id,result})+'\n');
  });
`,
    ],
    { stdio: "pipe", windowsHide: true },
  );

test(
  "a closed RPC output rejects pending calls promptly and reconnects with a fresh process",
  {
    skip:
      process.platform === "win32" &&
      "The Node fixture does not produce EOF while alive on Windows; process-exit recovery is tested separately",
  },
  async () => {
    const rpc = new CodexRPC();
    const failures: Error[] = [];
    rpc.on("failure", (e) => failures.push(e));
    try {
      await rpc.startWith(child);
      const at = Date.now();
      await assert.rejects(
        rpc.call("close-output", {}, 5000),
        /connection closed/,
      );
      assert.ok(
        Date.now() - at < 2000,
        "EOF must not consume the full request timeout",
      );
      assert.equal(rpc.connected, false);
      await assert.rejects(
        rpc.call("thread/resume", {}, 5000),
        /connection closed/,
      );
      assert.equal(
        failures.length,
        1,
        "one broken connection produces one failure",
      );
      await rpc.startWith(child);
      assert.equal(rpc.connected, true);
      assert.deepEqual(await rpc.call("thread/resume"), { ok: true });
      assert.equal(
        failures.length,
        1,
        "stopping the old child cannot fail the replacement",
      );
    } finally {
      await rpc.stop();
    }
  },
);

test("EOF delivers a complete final JSON response even without a newline", async () => {
  const rpc = new CodexRPC();
  try {
    await rpc.startWith(child);
    assert.deepEqual(await rpc.call("final-output", {}, 5000), { ok: true });
    const until = Date.now() + 2000;
    while (rpc.connected && Date.now() < until)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(rpc.connected, false);
    await assert.rejects(
      rpc.call("thread/resume"),
      /connection closed|process exited/,
    );
  } finally {
    await rpc.stop();
  }
});

test("large JSON RPC replies stay intact and deliberate stop settles pending calls", async () => {
  const rpc = new CodexRPC();
  const failures: Error[] = [];
  rpc.on("failure", (e) => failures.push(e));
  try {
    await rpc.startWith(child);
    const result = await rpc.call("large", {}, 5000);
    assert.equal(result.content.length, 3 * 1024 * 1024);
    const pending = assert.rejects(
      rpc.call("hang", {}, 5000),
      /connection closed/,
    );
    await rpc.stop();
    await pending;
    assert.equal(
      failures.length,
      0,
      "an intentional stop is not an engine crash",
    );
  } finally {
    await rpc.stop();
  }
});

test("an unexpected process exit fails promptly and a replacement accepts requests", async () => {
  const rpc = new CodexRPC();
  try {
    await rpc.startWith(child);
    const started = Date.now();
    await assert.rejects(
      rpc.call("crash", {}, 5000),
      /connection closed|process exited/,
    );
    assert.ok(Date.now() - started < 2000);
    assert.equal(rpc.connected, false);
    await rpc.startWith(child);
    assert.deepEqual(await rpc.call("thread/resume"), { ok: true });
  } finally {
    await rpc.stop();
  }
});

test("Unicode separators in a browser result preserve the completion notification", async () => {
  const rpc = new CodexRPC();
  const messages: unknown[] = [];
  rpc.on("notification", message => messages.push(message));
  try {
    await rpc.startWith(child);
    assert.equal(await rpc.call("unicode-tool", {}, 5000), true);
    assert.deepEqual(messages, [{ method: "item/completed", params: { text: "甲\u2028乙\u2029丙" } }]);
  } finally {
    await rpc.stop();
  }
});
