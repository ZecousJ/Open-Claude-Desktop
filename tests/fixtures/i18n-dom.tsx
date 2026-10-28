import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { setLocale, formatText, useLocale } from "../../src/i18n";
import { startDomTranslation } from "../../src/i18n/dom";
import { ConversationShareView } from "../../src/conversation/ConversationShareDialog";
import { shareDate } from "../../src/conversation/share-date";

const check = (ok: boolean, label: string) => {
  if (!ok) throw new Error(label);
};
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 25));
const noop = () => {};
const at = Date.UTC(2026, 8, 30);
const status = {
  conversations: true,
  artifacts: true,
  maxSnapshotBytes: 1,
  maxArtifactBytes: 1,
};
let publicShare = false;
function View() {
  useLocale();
  return (
    <>
      <ConversationShareView
        conversation={{ id: "sample", title: "Settings", mode: "code" }}
        status={status}
        state={{
          share: publicShare
            ? {
                id: "s",
                kind: "conversation",
                sourceKey: "sample",
                title: "Settings",
                url: "https://example.test/shared",
                createdAt: at,
                snapshotAt: at,
                status: "active",
                stale: true,
              }
            : null,
          busy: false,
          confirmStop: false,
          copied: false,
          repository: false,
        }}
        onPublic={noop}
        onPrivate={noop}
        onStop={noop}
        onCancelStop={noop}
        onCopy={noop}
        onUpdate={noop}
        onUsagePolicy={noop}
      />
      <div id="dynamic" data-no-translate>
        {formatText("Showing only {kind} that match “{query}”.", {
          kind: "Settings",
          query: "Private",
        })}
      </div>
      <div className="user-message" title="Private">
        Private
      </div>
      <pre title="Private">
        <code>Only you have access</code>
      </pre>
      <div id="excluded" data-no-translate title="Private">
        Settings
      </div>
      <span className="thread-folder-chip">
        <span id="folder">Developer</span>
      </span>
      <input
        id="input"
        placeholder="Only you have access"
        defaultValue="Settings"
      />
      <div className="assistant-content">
        <p id="reply">Settings</p>
        <p id="outcome" role="status">
          This response didn’t finish
        </p>
        <small id="kind">
          {"Image"}
          {" · "}
          {"PNG"}
        </small>
      </div>
      <section className="file-viewer">
        <button
          id="viewer-control"
          aria-label="More comment options"
          title="Filter comments"
        />
        <div className="file-preview artifact-markdown-preview">
          <span id="viewer-content" title="Private" />
          <img id="viewer-image" alt="Private" />
        </div>
      </section>
      <div id="meter" role="meter" aria-valuetext="75% used">
        Finished
      </div>
    </>
  );
}
export async function run() {
  await setLocale("en-US");
  const host = document.createElement("main");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(<View />));
  startDomTranslation();
  for (const locale of ["zh-CN", "fr-FR", "en-US", "zh-CN", "en-US"]) {
    await setLocale(locale);
    await settle();
    const expectedPrivate =
      locale === "zh-CN" ? "私密" : locale === "fr-FR" ? "Privé" : "Private";
    check(
      document.querySelector(".share-option-title")?.textContent ===
        expectedPrivate,
      `private label ${locale}`,
    );
    const permission = document.querySelector(
      ".share-option-description",
    )?.textContent;
    check(
      locale === "en-US"
        ? permission === "Only you have access"
        : permission !== "Only you have access",
      `private description ${locale}`,
    );
    check(document.documentElement.lang === locale, `document lang ${locale}`);
    // A folder named Developer keeps its name (it was shown as 开发者).
    check(
      document.querySelector("#folder")?.textContent === "Developer",
      `folder name ${locale}`,
    );
    check(
      document.querySelector(".user-message")?.textContent === "Private",
      "user text preserved",
    );
    check(
      document.querySelector(".user-message")?.getAttribute("title") ===
        "Private",
      "user attribute preserved",
    );
    check(
      document.querySelector("pre")?.getAttribute("title") === "Private",
      "code attribute preserved",
    );
    check(
      document.querySelector("code")?.textContent === "Only you have access",
      "code preserved",
    );
    check(
      document.querySelector("#excluded")?.getAttribute("title") === "Private",
      "excluded attribute preserved",
    );
    // The viewer's controls follow the language; what the file holds does not.
    const control = document.querySelector("#viewer-control");
    check(
      locale === "zh-CN"
        ? control?.getAttribute("aria-label") === "更多评论选项"
        : control?.getAttribute("aria-label") === "More comment options" ||
            locale === "fr-FR",
      `viewer control label ${locale}`,
    );
    check(
      document.querySelector("#viewer-content")?.getAttribute("title") ===
        "Private" &&
        document.querySelector("#viewer-image")?.getAttribute("alt") ===
          "Private",
      `viewer content attributes preserved ${locale}`,
    );
    check(
      document.querySelector<HTMLInputElement>("#input")?.value === "Settings",
      "input value preserved",
    );
    check(
      document.querySelector("#dynamic")?.textContent?.includes("Settings") ===
        true &&
        document.querySelector("#dynamic")?.textContent?.includes("Private") ===
          true,
      "interpolated user values preserved",
    );
    check(
      locale === "en-US"
        ? document.querySelector("#meter")?.getAttribute("aria-valuetext") ===
            "75% used"
        : document.querySelector("#meter")?.getAttribute("aria-valuetext") !==
            "75% used",
      `accessible value ${locale}`,
    );
    check(
      document.querySelector("#reply")?.textContent === "Settings",
      "reply text preserved",
    );
    check(
      locale === "zh-CN"
        ? document.querySelector("#outcome")?.textContent?.trim() ===
            "这条回复没有完成"
        : locale === "en-US"
          ? document.querySelector("#outcome")?.textContent?.trim() ===
            "This response didn’t finish"
          : true,
      `reply status line ${locale}`,
    );
    check(
      locale === "zh-CN"
        ? document.querySelector("#kind")?.textContent === "图片 · PNG"
        : locale === "en-US"
          ? document.querySelector("#kind")?.textContent === "Image · PNG"
          : true,
      `file kind ${locale}`,
    );
    publicShare = true;
    flushSync(() => root.render(<View />));
    await settle();
    const stale = document.querySelector(".share-stale")?.textContent ?? "";
    check(stale.includes(shareDate(at)), `date follows locale ${locale}`);
    check(
      locale === "en-US"
        ? stale.includes("New messages aren't included.")
        : !stale.includes("New messages aren't included."),
      `whole stale sentence ${locale}`,
    );
    publicShare = false;
    flushSync(() => root.render(<View />));
    await settle();
  }
  root.unmount();
  await settle();
}
