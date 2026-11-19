/** Read-only integration check for Claudex Code sessions in the test profile. */
import { Client } from "./harness.mjs";
import os from "node:os";
import path from "node:path";
import { rm } from "node:fs/promises";

const client = await Client.launch();
try {
  const page = client.page(0);
  const result = await page.eval(`(async () => {
    const api = window['claude.web'].LocalSessions;
    const sessions = (await api.getSessionList()).sessions.filter((s) => s.cwd === ${JSON.stringify(path.join(os.homedir(), "Developer/Claudex"))});
    let supported = 0, unsupported = 0;
    for (const s of sessions) {
      try { await api.getTranscriptTail(s.sessionId, 20); supported++; }
      catch (error) { if (!String(error).includes('unsupported records')) throw error; unsupported++; }
    }
    return { sessions: sessions.length, supported, unsupported };
  })()`);
  console.log(JSON.stringify(result));
  if (!result.sessions) process.exitCode = 2;
} finally { await client.stop(); await rm(path.dirname(client.logFile), { recursive: true, force: true }); }
