import { t } from "../../i18n";
import { useCallback, useEffect, useState } from "react";
import type { MemoryReflection } from "../../../shared/memory-api";
import { Markdown } from "../../ui/Markdown";
import { RelativeTime } from "../../ui/RelativeTime";
import { Button, Section } from "../controls";
import type { TabProps } from "../context";
import "../../focus/focus.css";
import { Pictogram } from "../../ui/Pictogram";

/** Rows Settings search finds on this page. */
export { reflectLabels as searchLabels } from "./desktop-labels";

/**
 * Settings → Reflect: "Based on your conversations in Claude chat." With memory
 * off, a centred empty state: "For this reflection to work, you'll need to
 * enable memory in memory settings." (the link opens Memory). With memory on,
 * Claudex writes a short reflection from the memory with the account's model
 * and keeps it a day; the original's filled page had no capture (its account
 * keeps memory off).
 */
export function ReflectTab({ goTo, onError }: TabProps) {
  const [value, setValue] = useState<MemoryReflection>();
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    (refresh = false) => {
      setBusy(true);
      window.desktop
        .memoryReflection(refresh)
        .then(setValue)
        .catch(onError)
        .finally(() => setBusy(false));
    },
    [onError],
  );
  useEffect(() => load(), [load]);
  return (
    <Section
      title="Reflect"
      headingLevel={2}
      note="Based on your conversations in Claudex chat."
      tightNote
    >
      {!value ? (
        <div className="reflect-empty" aria-busy="true">
          {busy && <p>Writing your reflection…</p>}
        </div>
      ) : value.state === "off" ? (
        <div className="reflect-empty">
          <Pictogram name="HandWriting" />
          <MemoryOffNote onOpen={() => goTo("memory")} />
        </div>
      ) : value.state === "empty" ? (
        <div className="reflect-empty">
          <Pictogram name="HandWriting" />
          <p>
            Claudex hasn't written any memory from your chats yet. Your
            reflection shows here once it has.
          </p>
        </div>
      ) : (
        <div className="reflect-body">
          <Markdown text={value.text} />
          <div className="reflect-foot">
            <span>
              Written <RelativeTime createdAt={value.generatedAt} />
            </span>
            <Button disabled={busy} onClick={() => load(true)}>
              {busy ? "Writing…" : "Refresh"}
            </Button>
          </div>
        </div>
      )}
    </Section>
  );
}

/**
 * The sentence translated whole, its `<a>…</a>` part the link to Memory (a
 * language puts the link where its sentence needs it).
 */
function MemoryOffNote({ onOpen }: { onOpen: () => void }) {
  const [before, rest = ""] = t(
    "For this reflection to work, you’ll need to enable memory in <a>memory settings</a>.",
  ).split("<a>");
  const [linked, after = ""] = rest.split("</a>");
  return (
    <p>
      {before}
      <button type="button" className="reflect-link" onClick={onOpen}>
        {linked}
      </button>
      {after}
    </p>
  );
}
