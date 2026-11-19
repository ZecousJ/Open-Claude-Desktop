/**
 * Runs the real renderer in a browser against the offline fixture bridge.
 * The shared options are read here; each package's fixtures/<domain>.ts
 * reads its own parameters (fixtures/index.ts lists them):
 * policy=links|locked|pending, update=available|required, announcements=1
 * (policy); weekly=<percent>|none, moreUsage=none, reason=… (usage).
 * fonts=system keeps the system fonts instead of the local Claude
 * installation's reference fonts.
 * environments=some|empty|error selects the explicit cloud-profile fixture.
 * sidebarWidth=208..480 aligns the comparison viewport's sidebar width.
 * locale=<supported locale id> fixes the comparison language explicitly.
 * appearance=large-system uses Large/wide/sans/System settings at cold boot.
 * catalog=some|null|error-once|error, catalogDelay=<ms>, catalogExtra=<count>
 * select offline model-catalog states; skillsDelay/designsDelay=<ms> and
 * skillsFailure/designsFailure=once|always select offline Add-menu states.
 * skillMenu=empty selects a truly empty skills inventory (including built-ins).
 */
import { createFixtureDesktop, type FixtureOptions } from "./app-fixture";

const params = new URLSearchParams(location.search);
window.desktop = createFixtureDesktop(
  {
    history: params.get("history") === "empty" ? "empty" : "full",
    // plan=Max signs in a Sub2API account on that plan (label, Usage page).
    plan: params.get("plan") ?? undefined,
    // auth=local|remote|remote-open|remote-2fa starts on the sign-in screen.
    auth: (params.get("auth") as FixtureOptions["auth"]) ?? undefined,
    // states=1 adds the transcript-state conversations (errors, limits, math…).
    states: params.get("states") === "1",
    longTurns: Number(params.get("long")) || undefined,
    // artifacts=1 adds chats with generated files for the file viewer's previews.
    artifacts: params.get("artifacts") === "1",
    rowStates: params.has("rowStates"),
    // approval=edit|write|command|permissions|form|url|questions
    approval: (params.get("approval") ??
      undefined) as FixtureOptions["approval"],
    // planMode=1 starts in Code Plan mode.
    planMode: params.get("planMode") === "1",
    // connectors=1: the web's runner keeps the user's remote connectors.
    customConnectors: params.get("connectors") === "1",
    // sandboxNetwork=trusted|full|none: the web's sandbox network ceiling.
    sandboxNetwork: (params.get("sandboxNetwork") ??
      undefined) as FixtureOptions["sandboxNetwork"],
  },
  params,
);
await import("../../src/main");

// Explicit test-only control for the source-conditioned task rail. The
// production entry has no such control; this exercises the real App overlay,
// not a detached copy or a direct React-state mutation.
if (params.get("taskRailPreview") === "1") {
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.textContent = "Open task rail (preview)";
  trigger.style.cssText =
    "position:fixed;bottom:8px;left:8px;z-index:9999;padding:4px 8px";
  trigger.addEventListener("click", () =>
    window.dispatchEvent(new Event("claudex:tasks-panel")),
  );
  document.body.append(trigger);
}

/**
 * steps=[{"click":".selector","wait":400},{"type":".selector","text":"…"},
 * {"eval":"js"}] runs after the page has loaded, so renders that cannot take
 * clicks (the remote WSL/Windows jobs) still reach menus and typed states.
 * Encode the JSON (encodeURIComponent); "&" and "#" must not appear raw.
 */
type PreviewStep = {
  click?: string;
  type?: string;
  text?: string;
  eval?: string;
  wait?: number;
};
const stepsParam = params.get("steps");
if (stepsParam) {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  void (async () => {
    const find = async <T extends Element>(selector: string) => {
      for (let i = 0; i < 60; i++) {
        const el = document.querySelector<T>(selector);
        if (el) return el;
        await pause(50);
      }
      return null;
    };
    await find(".sidebar");
    for (const step of JSON.parse(stepsParam) as PreviewStep[]) {
      if (step.click) {
        const el = await find<HTMLElement>(step.click);
        for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"])
          el?.dispatchEvent(new MouseEvent(type, { bubbles: true }));
        el?.click();
      }
      if (step.type) {
        const el = await find<HTMLTextAreaElement | HTMLInputElement>(
          step.type,
        );
        if (el) {
          el.focus();
          const proto =
            el instanceof HTMLTextAreaElement
              ? HTMLTextAreaElement.prototype
              : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(
            el,
            step.text ?? "",
          );
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
      if (step.eval) (0, eval)(step.eval);
      await pause(step.wait ?? 400);
    }
  })();
}
/*
 * settingsPage=<page label> opens Settings on that page for renders that
 * cannot click (the remote screenshot hosts): settingsScroll=<px> scrolls
 * the page, settingsClick=<button text> presses a button of the dialog.
 */
const settingsPage = params.get("settingsPage");
if (settingsPage) {
  const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
  const find = (selector: string, text: string) =>
    [...document.querySelectorAll<HTMLElement>(selector)].find((element) =>
      element.textContent?.trim().startsWith(text),
    );
  /** Runs `act` on the first match, polling for up to 10s. */
  const until = async (
    selector: string,
    text: string,
    act: (e: HTMLElement) => void,
  ) => {
    for (let tries = 0; tries < 100; tries++) {
      const found = find(selector, text);
      if (found) return act(found);
      await wait(100);
    }
  };
  for (
    let tries = 0;
    tries < 100 && !document.querySelector(".profile");
    tries++
  )
    await wait(100);
  document.querySelector<HTMLElement>(".profile")?.click();
  await until("[role=menuitem], button", "Settings", (e) => e.click());
  await until(
    ".settings-dialog button, .settings-dialog [role=tab]",
    settingsPage,
    (e) => e.click(),
  );
  await wait(400);
  const scroll = Number(params.get("settingsScroll") ?? 0);
  if (scroll) {
    const pages = [
      ...document.querySelectorAll<HTMLElement>(".settings-dialog *"),
    ]
      .filter(
        (e) =>
          e.scrollHeight > e.clientHeight + 20 &&
          getComputedStyle(e).overflowY !== "visible",
      )
      .sort((a, b) => b.clientHeight - a.clientHeight);
    if (pages[0]) pages[0].scrollTop = scroll;
  }
  const press = params.get("settingsClick");
  if (press) {
    await wait(300);
    find(".settings-dialog button", press)?.click();
  }
}
