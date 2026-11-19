/**
 * Projects: create one through the form, give it instructions and knowledge
 * (text and an uploaded file), talk to it, pin and rename it, move a chat into
 * it, and remove it. Each case of the group builds on the project the first one
 * made; the project is deleted at the end either way.
 */
import { expect, sleep } from "../harness.mjs";

const projectApi = (state, rest = "") => `/api/organizations/x/projects/${state.project}${rest}`;
const setField = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  el.focus();
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`;
/** Clicks the Add button of a section of the project page ("Files", "Instructions"…). */
const sectionButton = (section, label) => `(() => {
  const title = [...document.querySelectorAll('main *')].find((e) => e.children.length === 0 && e.textContent.trim() === ${JSON.stringify(section)});
  const box = title?.closest('div')?.parentElement;
  const button = [...(box?.querySelectorAll('button') ?? [])].find((b) => b.innerText.trim() === ${JSON.stringify(label)});
  button?.click();
  return !!button;
})()`;

export const cases = [
  {
    name: "create a project from the form",
    group: "one project",
    setup: true,
    async run(client, state) {
      await client.goto("/projects/create");
      await client.waitFor(`!!document.querySelector('input[placeholder="Name your project"]')`);
      state.name = `e2e 项目 ${Date.now().toString(36)}`;
      await client.eval(setField('input[placeholder="Name your project"]', state.name));
      await client.eval(setField("main textarea", "端到端测试用项目"));
      await client.eval("__e2e.clickText('Create project')");
      state.project = await client.waitFor("(/\\/project\\/([0-9a-f-]{36})/.exec(location.pathname) || [])[1]", 30000);
      const row = await client.api(projectApi(state));
      expect(row.status === 200 && row.body.name === state.name && row.body.description === "端到端测试用项目", `project not saved: ${JSON.stringify(row.body)}`);
      const list = await client.api("/api/organizations/x/projects_v2?limit=50");
      expect(list.body.data.some((p) => p.uuid === state.project), "the project is not on the Projects page");
    },
  },
  {
    name: "set the project instructions",
    group: "one project",
    async run(client, state) {
      await client.goto(`/project/${state.project}`);
      await client.waitFor(sectionButton("Instructions", "Add"));
      await client.waitFor("!!document.querySelector('[role=dialog] textarea')");
      await client.eval(setField("[role=dialog] textarea", "回答时只用一个词，并在末尾加上暗号：松果"));
      await client.eval("__e2e.clickText('Save instructions')");
      await client.waitFor(`fetch(${JSON.stringify(projectApi(state))}).then((r) => r.json()).then((p) => p.prompt_template.includes('松果'))`, 15000);
    },
  },
  {
    name: "add text content to the project knowledge",
    group: "one project",
    async run(client, state) {
      await client.goto(`/project/${state.project}`);
      await client.waitFor(sectionButton("Files", "Add"));
      await client.eval("__e2e.clickMenu('Add text content')");
      await client.waitFor(`!!document.querySelector('[role=dialog] input[placeholder="Name your content"]')`);
      await client.eval(setField('[role=dialog] input[placeholder="Name your content"]', "暗号说明"));
      await client.eval(setField("[role=dialog] textarea", "项目暗号是：银杏"));
      await client.eval("__e2e.clickText('Add Content')");
      await client.waitFor(`fetch(${JSON.stringify(projectApi(state, "/docs"))}).then((r) => r.json()).then((d) => d.some((x) => x.content.includes('银杏')))`, 20000);
      await client.waitFor("/1 file/.test(__e2e.mainText())", 20000);
    },
  },
  {
    name: "upload a file to the project knowledge",
    group: "one project",
    async run(client, state) {
      await client.goto(`/project/${state.project}`);
      await client.waitFor(sectionButton("Files", "Add"));
      await client.eval(`(async () => {
        const input = await __e2e.waitFor(() => [...document.querySelectorAll('input[type=file]')].find((i) => !i.closest('form[data-chat]')));
        await __e2e.clickMenu('Upload from device').catch(() => {});
        const dt = new DataTransfer();
        dt.items.add(new File(['第二份资料：项目代号是青柠'], '代号.txt', { type: 'text/plain' }));
        const target = [...document.querySelectorAll('input[type=file]')].pop() ?? input;
        target.files = dt.files;
        target.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await client.waitFor(`fetch(${JSON.stringify(projectApi(state, "/docs"))}).then((r) => r.json()).then((d) => d.some((x) => x.content.includes('青柠')))`, 30000);
    },
  },
  {
    name: "a chat in the project follows its instructions and knowledge",
    group: "one project",
    async run(client, state) {
      await client.goto(`/project/${state.project}`);
      await client.eval(`__e2e.type('项目资料里的暗号是什么？')`);
      await client.eval("__e2e.send()");
      await client.waitFor("__e2e.conversationId()", 30000);
      const chat = await client.eval("__e2e.conversationId()");
      (state.created ??= []).push(chat);
      // The model reads the project's files with its tools first: allow for that.
      await client.waitFor("__e2e.lastReply() && __e2e.finished()", 180000, 1000);
      const reply = await client.eval("__e2e.lastReply()");
      expect(/银杏/.test(reply) && /松果/.test(reply), `the reply ignored the project: ${reply}`);
      const listed = await client.api(`/api/organizations/x/chat_conversations_v2?project_uuid=${state.project}`);
      expect(listed.body.data.length >= 1, "the chat is not listed in the project");
    },
  },
  {
    name: "pin and rename the project",
    group: "one project",
    async run(client, state) {
      await client.goto(`/project/${state.project}`);
      await client.eval("__e2e.clickLabel('Pin project')");
      await client.waitFor(`fetch(${JSON.stringify(projectApi(state))}).then((r) => r.json()).then((p) => p.is_starred)`, 15000);
      await client.eval(`__e2e.clickLabel(${JSON.stringify(`Rename ${state.name}`)})`);
      state.name = `${state.name} 改名`;
      await client.eval(`(async () => {
        const input = await __e2e.waitFor(() => __e2e.all('main input, [role=dialog] input').find((i) => __e2e.visible(i) && i.value && ${JSON.stringify(state.name)}.startsWith(i.value)));
        input.focus();
        document.execCommand('selectAll');
        document.execCommand('insertText', false, ${JSON.stringify(state.name)});
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        await __e2e.sleep(300);
        input.blur();
      })()`);
      await client.waitFor(`fetch(${JSON.stringify(projectApi(state))}).then((r) => r.json()).then((p) => p.name === ${JSON.stringify(state.name)})`, 15000);
    },
  },
  {
    name: "move a chat into the project from its menu",
    group: "one project",
    async run(client, state) {
      await client.goto("/new");
      await client.eval("__e2e.chatMode()");
      await client.eval(`__e2e.type('只回答：好')`);
      await client.eval("__e2e.send()");
      await client.waitFor("__e2e.conversationId()", 30000);
      const chat = await client.eval("__e2e.conversationId()");
      (state.created ??= []).push(chat);
      await client.waitFor("__e2e.lastReply() && __e2e.finished()", 90000, 1000);
      await client.eval("__e2e.conversationMenu()");
      await client.eval("__e2e.clickMenu('Add to project')");
      await client.eval(`(async () => {
        const option = await __e2e.waitFor(() => __e2e.all('[role=menuitemradio], [role=option], [role=menuitem]').find((o) => __e2e.visible(o) && o.textContent.replace(/[\uE000-\uF8FF]/g, '').trim() === ${JSON.stringify(state.name ?? "")}));
        option.click();
        await __e2e.sleep(500);
        const confirm = __e2e.all('[role=dialog] button').find((b) => __e2e.visible(b) && /^(Move|Add|Save|Done)$/.test(b.innerText.trim()));
        if (confirm) confirm.click();
      })()`);
      await client.waitFor(`fetch('/api/organizations/x/chat_conversations/${chat}').then((r) => r.json()).then((c) => c.project_uuid === ${JSON.stringify(state.project)})`, 20000);
    },
  },
  {
    name: "delete the project",
    group: "one project",
    async run(client, state) {
      const removed = await client.api(projectApi(state), { method: "DELETE" });
      expect(removed.status === 204, `delete answered ${removed.status}`);
      const list = await client.api("/api/organizations/x/projects_v2?limit=100");
      expect(!list.body.data.some((p) => p.uuid === state.project), "the project is still listed");
      await sleep(0);
    },
  },
];

/** After the group: the project goes even when a case before the last failed. */
export async function cleanup(client, state) {
  if (state.project) await client.api(projectApi(state), { method: "DELETE" });
}
