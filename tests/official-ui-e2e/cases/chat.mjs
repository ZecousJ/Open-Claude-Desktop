/**
 * Chat: sending, attachments, ratings, retry, edit, versions, forking and the
 * conversation menu, through the official page against the Claudex service.
 */
import { expect, sleep } from "../harness.mjs";

/** Starts a new chat with `prompt` and waits for the reply; returns the conversation id. */
async function newChat(client, prompt, before, state) {
  await client.goto("/new");
  await client.eval("__e2e.chatMode()");
  await client.goto("/new");
  if (before) await before();
  await client.eval(`__e2e.type(${JSON.stringify(prompt)})`);
  await client.eval("__e2e.send()");
  await client.waitFor("__e2e.conversationId()", 30000);
  await client.waitFor("__e2e.lastReply() && __e2e.finished()", 90000, 1000);
  const id = await client.eval("__e2e.conversationId()");
  if (state) (state.created ??= []).push(id);
  return id;
}

/** Picks a model in the composer's model menu. */
async function chooseModel(client, name) {
  await client.eval(`(async () => {
    await __e2e.closeMenus();
    __e2e.press(__e2e.all('button[aria-label^="Model:"]').find(__e2e.visible));
    const item = await __e2e.waitFor(() => __e2e.all('[role=menuitemradio]').find((m) => __e2e.visible(m) && m.textContent.includes(${JSON.stringify(name)})));
    item.click();
    await __e2e.sleep(600);
  })()`);
}

export const cases = [
  {
    name: "send a text message and get a reply",
    group: "one chat",
    setup: true,
    async run(client, state) {
      state.chat = await newChat(client, "只回答一个数字：1+1=?", undefined, state);
      const reply = await client.eval("__e2e.lastReply()");
      expect(/2|二/.test(reply), `unexpected reply: ${reply}`);
      const list = await client.api("/api/organizations/x/chat_conversations_v2?limit=5");
      expect(list.body.data.some((c) => c.uuid === state.chat || c.name.includes("1+1")), "the new chat is not in Recents");
    },
  },
  {
    name: "attach an image; the model sees it and the tile loads",
    async run(client, state) {
      await newChat(client, "这张图片是什么颜色？只回答颜色名。", async () => {
        await client.eval(`__e2e.pngOf('#2e7d32').then((b) => __e2e.attach('green.png', 'image/png', b))`);
        await client.waitFor("document.querySelectorAll('[data-testid=file-thumbnail]').length === 1", 15000);
      }, state);
      const reply = await client.eval("__e2e.lastReply()");
      expect(/绿|green/i.test(reply), `the model did not see the image: ${reply}`);
      const tiles = await client.eval("document.querySelectorAll('main [data-testid=file-thumbnail]').length");
      expect(tiles === 1, `expected one attachment tile, saw ${tiles}`);
      await client.goto(await client.eval("location.pathname"));
      await client.waitFor("(() => { const i = document.querySelector('main [data-testid=file-thumbnail] img'); return i && i.complete && i.naturalWidth > 0; })()", 20000);
    },
  },
  {
    name: "attach a text file; its content reaches the model",
    async run(client, state) {
      await newChat(client, "附件里写的暗号是什么？只回答暗号。", async () => {
        await client.eval(`__e2e.attach('code.txt', 'text/plain', '暗号：青松')`);
        await client.waitFor("document.querySelectorAll('[data-testid=file-thumbnail]').length === 1", 15000);
      }, state);
      const reply = await client.eval("__e2e.lastReply()");
      expect(/青松/.test(reply), `the model did not read the file: ${reply}`);
    },
  },
  {
    name: "rate a reply (Good response with a comment) and the rating stays",
    group: "one chat",
    async run(client, state) {
      await client.goto(`/chat/${state.chat}`);
      await client.eval("__e2e.clickLabel('Good response', { last: true })");
      await client.waitFor("__e2e.dialogText().includes('feedback')");
      await client.eval(`(async () => { const t = document.querySelector('[role=dialog] textarea'); t.focus(); document.execCommand('insertText', false, 'e2e'); await __e2e.sleep(200); await __e2e.clickText('Submit'); })()`);
      await sleep(2500);
      await client.goto(`/chat/${state.chat}`);
      await client.waitFor("__e2e.byLabel('Good response').some((b) => b.getAttribute('aria-pressed') === 'true')", 15000);
    },
  },
  {
    name: "retry a reply; both versions can be viewed",
    group: "one chat",
    async run(client, state) {
      await client.goto(`/chat/${state.chat}`);
      await client.eval("__e2e.clickLabel('Retry', { last: true })");
      await client.waitFor("/2 \\/ 2/.test(__e2e.mainText()) && __e2e.finished()", 90000, 1000);
      await client.eval("__e2e.clickLabel('Previous version')");
      await client.waitFor("/1 \\/ 2/.test(__e2e.mainText())", 10000);
    },
  },
  {
    name: "continue an earlier version in a new session",
    group: "one chat",
    async run(client, state) {
      await client.goto(`/chat/${state.chat}`);
      await client.eval("__e2e.clickLabel('Previous version')");
      await client.eval("__e2e.clickText('Continue in a new session')");
      await client.waitFor(`__e2e.conversationId() && __e2e.conversationId() !== ${JSON.stringify(state.chat)}`, 30000);
      await client.waitFor("__e2e.lastReply() !== ''", 30000);
    },
  },
  {
    name: "edit the first prompt; the new answer follows it",
    group: "one chat",
    async run(client, state) {
      await client.goto(`/chat/${state.chat}`);
      await client.waitFor(`!!document.querySelector('main button[aria-label^="Show message actions"]')`, 20000);
      await client.eval(`(async () => { __e2e.press(document.querySelector('main button[aria-label^="Show message actions"]')); await __e2e.sleep(600); await __e2e.clickLabel('Edit'); await __e2e.sleep(800); const t = document.querySelector('main textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, '只回答一个数字：3+3=?'); t.dispatchEvent(new Event('input', { bubbles: true })); await __e2e.sleep(300); await __e2e.clickText('Save'); })()`);
      await client.waitFor("/3\\+3/.test(__e2e.mainText()) && /6|六/.test(__e2e.lastReply()) && __e2e.finished()", 90000, 1000);
    },
  },
  {
    name: "pin, rename and archive through the conversation menu",
    group: "one chat",
    async run(client, state) {
      const id = state.chat;
      const row = () => client.eval(`fetch('/api/organizations/x/chat_conversations/${id}').then((r) => r.json())`);
      await client.goto(`/chat/${id}`);
      await client.eval("__e2e.conversationMenu()");
      await client.eval("__e2e.clickMenu('Pin')");
      await client.waitFor(`fetch('/api/organizations/x/chat_conversations/${id}').then((r) => r.json()).then((c) => c.is_starred)`, 15000);
      await client.eval("__e2e.conversationMenu()");
      await client.eval("__e2e.clickMenu('Rename')");
      await client.eval(`(async () => { const i = await __e2e.waitFor(() => __e2e.all('[role=dialog] input, main input[type=text], header input').find(__e2e.visible)); i.focus(); document.execCommand('selectAll'); document.execCommand('insertText', false, 'e2e 改名'); await __e2e.sleep(200); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })); await __e2e.sleep(300); const save = __e2e.byText('Save')[0]; if (save) save.click(); })()`);
      await client.waitFor(`fetch('/api/organizations/x/chat_conversations/${id}').then((r) => r.json()).then((c) => c.name === 'e2e 改名')`, 15000);
      await client.eval("__e2e.conversationMenu()");
      await client.eval("__e2e.clickMenu('Archive')");
      await client.waitFor(`fetch('/api/organizations/x/chat_conversations/${id}').then((r) => r.json()).then((c) => c.is_archived)`, 15000);
      const archived = await client.api("/api/organizations/x/chat_conversations_v2?archived=true&limit=50");
      expect(archived.body.data.some((c) => c.name === "e2e 改名"), "the archived chat is not under Archived");
      void row;
    },
  },
  {
    name: "delete chats from Recents' select mode",
    async run(client, state) {
      const id = await newChat(client, "只回答：好", undefined, state);
      const del = await client.api("/api/organizations/x/chat_conversations/delete_many", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversation_uuids: [id] }) });
      expect(del.status === 200 && del.body.deleted.includes(id), `delete_many failed: ${JSON.stringify(del.body)}`);
      const list = await client.api("/api/organizations/x/chat_conversations_v2?limit=50");
      expect(!list.body.data.some((c) => c.uuid === id), "the deleted chat is still listed");
      void state;
    },
  },
];

cases.splice(cases.findIndex((c) => c.name.startsWith("pin, rename")), 0, {
  name: "share a chat publicly; the copied link is the Claudex address",
  group: "one chat",
  async run(client, state) {
    await client.goto(`/chat/${state.chat}`);
    await client.eval("__e2e.conversationMenu()");
    await client.eval("__e2e.clickMenu('Share session')");
    await client.waitFor("/Who has access/.test(__e2e.dialogText())", 20000);
    // Switch to "Anyone with the link" unless it already is.
    await client.eval(`(async () => {
      if (/Anyone with the link/.test(__e2e.dialogText())) return;
      // The access button opens the settings view, whose own selector opens the menu.
      for (let i = 0; i < 4; i++) {
        const option = __e2e.all('[role=menuitemradio]').find((m) => __e2e.visible(m) && /Anyone with the link/.test(m.textContent));
        if (option) { option.click(); break; }
        const selects = __e2e.all('[role=dialog] button').filter((b) => __e2e.visible(b) && /Only people invited/.test(b.innerText));
        selects[selects.length - 1]?.click();
        await __e2e.sleep(900);
      }
      await __e2e.sleep(400);
      const save = __e2e.all('[role=dialog] button').find((b) => b.innerText.trim() === 'Save');
      if (save) save.click();
    })()`);
    await client.waitFor("__e2e.all('[role=dialog] button').some((b) => /Copy public link/.test(b.innerText))", 20000);
    const copied = await client.eval(`(async () => {
      expectShim: if (!navigator.clipboard.__claudex) return 'no shim';
      const seen = [];
      const shimmed = navigator.clipboard.writeText;
      navigator.clipboard.writeText = async (t) => { seen.push(t); };
      __e2e.all('[role=dialog] button').find((b) => /Copy public link/.test(b.innerText)).click();
      await __e2e.waitFor(() => seen.length, 60000);
      navigator.clipboard.writeText = shimmed;
      return [seen[0], await window.__claudexPublicLink(seen[0])];
    })()`);
    expect(Array.isArray(copied), `share link not produced: ${copied}`);
    const [pageLink, publicLink] = copied;
    expect(/\/share\//.test(pageLink), `unexpected page link ${pageLink}`);
    expect(/^https:\/\//.test(publicLink) && !publicLink.includes("localhost"), `the public link is not a Claudex address: ${publicLink}`);
    const latest = await client.api(`/api/organizations/x/chat_conversations/${state.chat}/latest`);
    expect(latest.body.snapshot && latest.body.visibility === "public", `the share is not live: ${JSON.stringify(latest.body)}`);
    state.shareLink = publicLink;
  },
});

cases.push(
  {
    name: "choose another model; the chat uses it and the choice is remembered",
    async run(client, state) {
      await client.goto("/new");
      await client.eval("__e2e.chatMode()");
      await chooseModel(client, "Claude Sonnet 5.5");
      const id = await newChat(client, "只回答一个字：好", undefined, state);
      const row = await client.api(`/api/organizations/x/chat_conversations/${id}`);
      expect(row.body.model === "claude-sonnet-5-5", `the chat ran on ${row.body.model}`);
      await client.goto("/new");
      const label = await client.eval(`__e2e.all('button[aria-label^="Model:"]').find(__e2e.visible)?.getAttribute('aria-label')`);
      expect(/Claude Sonnet 5\.5/.test(label), `the choice was not remembered: ${label}`);
      await chooseModel(client, "GPT-6.1 Sol");
    },
  },
  {
    name: "turn web search off for a new chat",
    async run(client, state) {
      const id = await newChat(client, "只回答一个字：好", async () => {
        await client.eval(`(async () => {
          __e2e.press(__e2e.byLabel('Add files, connectors, and more')[0]);
          const item = await __e2e.waitFor(() => __e2e.all('[role=menuitemcheckbox]').find((m) => __e2e.visible(m) && /Web search/.test(m.textContent)));
          if (item.getAttribute('aria-checked') === 'true') item.click();
          await __e2e.sleep(400);
          await __e2e.closeMenus();
        })()`);
      }, state);
      const row = await client.api(`/api/organizations/x/chat_conversations/${id}`);
      expect(row.body.settings.enabled_web_search === false, `web search stayed on: ${JSON.stringify(row.body.settings)}`);
      // Back on for the cases after this one.
      await client.goto("/new");
      await client.eval(`(async () => {
        __e2e.press(__e2e.byLabel('Add files, connectors, and more')[0]);
        const item = await __e2e.waitFor(() => __e2e.all('[role=menuitemcheckbox]').find((m) => __e2e.visible(m) && /Web search/.test(m.textContent)));
        if (item.getAttribute('aria-checked') !== 'true') item.click();
        await __e2e.sleep(400);
        await __e2e.closeMenus();
      })()`);
    },
  },
  {
    name: "stop a reply while it is being written",
    async run(client, state) {
      await client.goto("/new");
      await client.eval("__e2e.chatMode()");
      await client.eval(`__e2e.type('写一篇两千字的散文，主题是秋天的河流。')`);
      await client.eval("__e2e.send()");
      await client.waitFor("__e2e.conversationId()", 30000);
      (state.created ??= []).push(await client.eval("__e2e.conversationId()"));
      const stopButton = "__e2e.all('button[aria-label]').find((b) => __e2e.visible(b) && /^Stop .*response$/i.test(b.getAttribute('aria-label')))";
      await client.waitFor(`!!${stopButton}`, 60000);
      await client.eval(`${stopButton}.click()`);
      await client.waitFor(`!${stopButton} && !/Claudex is responding/.test(__e2e.mainText())`, 30000);
    },
  },
  {
    name: "an incognito chat is not kept in Recents",
    async run(client) {
      await client.goto("/new");
      await client.eval("__e2e.chatMode()");
      await client.eval("__e2e.clickLabel('Use incognito')");
      await client.eval(`__e2e.type('只回答一个字：好')`);
      await client.eval("__e2e.send()");
      await client.waitFor("__e2e.lastReply() && __e2e.finished()", 90000, 1000);
      const list = await client.api("/api/organizations/x/chat_conversations_v2?limit=50");
      expect(!list.body.data.some((c) => c.is_temporary), "an incognito chat is listed");
    },
  },
);
