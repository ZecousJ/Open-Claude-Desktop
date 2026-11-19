/**
 * Customize › Skills: the user's own skills on the Claudex agent. Create one
 * through the form, read it, turn it off and on, rename, duplicate, edit its
 * SKILL.md, upload another, remove it. Test skills are removed afterwards.
 */
import { expect } from "../harness.mjs";

const listSkills = (client) => client.eval("fetch('/api/organizations/x/skills/list-skills').then((r) => r.json()).then((j) => j.skills)");
const skillNamed = async (client, name) => (await listSkills(client)).find((s) => s.name === name);
const setField = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  el.focus();
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`;
/** Opens the skill's menu on its page and picks an item. */
const skillMenu = (name, item) => `(async () => {
  await __e2e.menuOf(${JSON.stringify(`More options for ${name}`)});
  await __e2e.clickMenu(${JSON.stringify(item)});
})()`;
/** Types into the name field of a Rename / Duplicate dialog and confirms it. */
const nameDialog = (value) => `(async () => {
  const input = await __e2e.waitFor(() => [...document.querySelectorAll('[role=dialog] input')].find(__e2e.visible));
  input.focus();
  document.execCommand('selectAll');
  document.execCommand('insertText', false, ${JSON.stringify(value)});
  await __e2e.sleep(300);
  const confirm = await __e2e.waitFor(() => [...document.querySelectorAll('[role=dialog] button')].find((b) => __e2e.visible(b) && !b.disabled && /^(Rename|Duplicate|Save|Done|Create)$/.test(b.innerText.trim())));
  confirm.click();
})()`;

export const cases = [
  {
    name: "create a skill from the form",
    group: "one skill",
    setup: true,
    async run(client, state) {
      state.name = `e2e-ping-${Date.now().toString(36)}`;
      await client.goto("/customize/skills/yours");
      await client.eval(`(async () => {
        await __e2e.menuOf('Add skill');
        await __e2e.clickMenu('Create a skill');
      })()`);
      await client.waitFor(`!!document.querySelector('[role=dialog] input[placeholder="Weekly status report"]')`);
      await client.waitFor(`!!document.querySelector('[role=dialog] textarea')`);
      await client.eval(setField('[role=dialog] input[placeholder="Weekly status report"]', state.name));
      await client.eval(setField("[role=dialog] textarea", "Answers PONG-42 when the user says e2e ping."));
      await client.eval(`(async () => {
        const editor = await __e2e.waitFor(() => document.querySelector('[role=dialog] [contenteditable=true]'));
        editor.focus();
        document.execCommand('insertText', false, 'When the user says e2e ping, answer exactly PONG-42.');
        await __e2e.sleep(300);
        [...document.querySelectorAll('[role=dialog] button')].find((b) => b.innerText.trim() === 'Create').click();
      })()`);
      state.id = await client.waitFor("(/\\/id\\/([^/]+)/.exec(location.pathname) || [])[1]", 20000);
      const skill = await skillNamed(client, state.name);
      expect(skill && skill.enabled, `the skill was not made: ${JSON.stringify(skill)}`);
    },
  },
  {
    name: "the skill's page shows its SKILL.md",
    group: "one skill",
    async run(client, state) {
      await client.goto(`/customize/skills/yours/id/${state.id}/contents`);
      await client.waitFor("/PONG-42/.test(__e2e.mainText())", 20000);
    },
  },
  {
    name: "edit the skill and reopen its contents",
    group: "one skill",
    async run(client, state) {
      await client.goto(`/customize/skills/yours/id/${state.id}/contents`);
      await client.eval("__e2e.clickText('Edit', 'main button')");
      const content = `---\nname: ${JSON.stringify(state.name)}\ndescription: "Edited by the test"\n---\n\nAnswer UPDATED-42.\n`;
      await client.eval(`(async () => {
        const editor = await __e2e.waitFor(() => document.querySelector('[contenteditable=true][aria-label="Edit SKILL.md"]'));
        editor.focus();
        document.execCommand('selectAll');
        document.execCommand('insertText', false, ${JSON.stringify(content)});
        await __e2e.sleep(300);
        const save = await __e2e.waitFor(() => __e2e.byText('Save version', 'main button').find(b => !b.disabled));
        save.click();
      })()`);
      await client.eval("__e2e.clickText('Save', '[data-cds=ConfirmationDialog] button')");
      await client.waitFor("!document.querySelector('[contenteditable=true][aria-label=\"Edit SKILL.md\"]')");
      await client.goto(`/customize/skills/yours/id/${state.id}/contents`);
      await client.waitFor("/UPDATED-42/.test(__e2e.mainText())", 20000);
    },
  },
  {
    name: "turn the skill off and on",
    group: "one skill",
    async run(client, state) {
      await client.goto(`/customize/skills/yours/id/${state.id}`);
      const toggle = `__e2e.all('[role=switch]').find((s) => __e2e.visible(s) && s.getAttribute('aria-label') === ${JSON.stringify(state.name)})`;
      await client.waitFor(`!!${toggle}`, 15000);
      await client.eval(`__e2e.press(${toggle})`);
      await client.waitFor(`fetch('/api/organizations/x/skills/list-skills').then((r) => r.json()).then((j) => j.skills.some((s) => s.name === ${JSON.stringify(state.name)} && !s.enabled))`, 15000);
      await client.eval(`__e2e.press(${toggle})`);
      await client.waitFor(`fetch('/api/organizations/x/skills/list-skills').then((r) => r.json()).then((j) => j.skills.some((s) => s.name === ${JSON.stringify(state.name)} && s.enabled))`, 15000);
    },
  },
  {
    name: "duplicate the skill",
    group: "one skill",
    async run(client, state) {
      await client.goto(`/customize/skills/yours/id/${state.id}`);
      await client.eval(skillMenu(state.name, "Duplicate"));
      state.copy = `${state.name}-copy`;
      await client.eval(nameDialog(state.copy));
      await client.waitFor(`fetch('/api/organizations/x/skills/list-skills').then((r) => r.json()).then((j) => j.skills.some((s) => s.name === ${JSON.stringify(state.copy)}))`, 15000);
    },
  },
  {
    name: "rename the skill",
    group: "one skill",
    async run(client, state) {
      await client.goto(`/customize/skills/yours/id/${state.id}`);
      await client.eval(skillMenu(state.name, "Rename"));
      const renamed = `${state.name}-renamed`;
      await client.eval(nameDialog(renamed));
      await client.waitFor(`fetch('/api/organizations/x/skills/list-skills').then((r) => r.json()).then((j) => j.skills.some((s) => s.name === ${JSON.stringify(renamed)}))`, 15000);
      state.name = renamed;
      state.id = (await skillNamed(client, renamed)).id;
    },
  },
  {
    name: "remove the skill",
    group: "one skill",
    async run(client, state) {
      await client.goto(`/customize/skills/yours/id/${state.id}`);
      await client.eval(skillMenu(state.name, "Remove"));
      await client.eval(`(async () => {
        const confirm = await __e2e.waitFor(() => [...document.querySelectorAll('[role=dialog] button, [role=alertdialog] button')].find((b) => __e2e.visible(b) && /^(Remove|Delete)$/.test(b.innerText.trim())));
        confirm.click();
      })()`);
      await client.waitFor(`fetch('/api/organizations/x/skills/list-skills').then((r) => r.json()).then((j) => !j.skills.some((s) => s.name === ${JSON.stringify(state.name)}))`, 15000);
    },
  },
  {
    name: "upload a skill file",
    async run(client, state) {
      state.name = `e2e-upload-${Date.now().toString(36)}`;
      await client.goto("/customize/skills/yours");
      await client.eval(`(async () => {
        await __e2e.menuOf('Add skill');
        await __e2e.clickMenu('Upload skill');
        await __e2e.waitFor(() => location.pathname.endsWith('/upload'));
        const input = await __e2e.waitFor(() => document.querySelector('input[type=file]'));
        const md = ${JSON.stringify(`---\nname: ${state.name}\ndescription: Uploaded by the e2e tests.\n---\n\nSay UPLOADED-7 when asked.\n`)};
        const dt = new DataTransfer();
        dt.items.add(new File([md], '${state.name}.md', { type: 'text/markdown' }));
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        const upload = await __e2e.waitFor(() => __e2e.all('main button').find((b) => __e2e.visible(b) && !b.disabled && b.innerText.trim() === 'Upload'));
        await __e2e.sleep(300);
        upload.click();
      })()`);
      await client.waitFor(`fetch('/api/organizations/x/skills/list-skills').then((r) => r.json()).then((j) => j.skills.some((s) => s.name === ${JSON.stringify(state.name)}))`, 20000);
    },
  },
];

/** Test skills leave whatever happened. */
export async function cleanup(client, state) {
  const skills = await listSkills(client).catch(() => []);
  const names = new Set([state.name, state.copy].filter(Boolean));
  for (const skill of skills.filter((s) => names.has(s.name)))
    await client.api("/api/organizations/x/skills/delete-skill", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ skill_id: skill.id }) });
}
