import "@vitejs/plugin-react/preamble";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { DesignWindowBridge } from "../../shared/design-window";
import { BlankDesignCanvas } from "../artifacts/BlankDesignCanvas";
import { setLocale } from "../i18n";
import "../styles/00-foundation.css";

declare global {
  interface Window {
    designWindow?: DesignWindowBridge;
  }
}

function DesignWindow({ bridge }: { bridge: DesignWindowBridge }) {
  const { accountId, title } = bridge.context;
  const [conversation, setConversation] = useState(bridge.context.conversation);
  const ports = useMemo(
    () => ({
      readBlankArtifact: () => bridge.read(),
      saveBlankArtifact: ({
        content,
        expectedRevision,
      }: Parameters<DesignWindowBridge["save"]>[0]) =>
        bridge.save({ content, expectedRevision }),
    }),
    [bridge],
  );
  useEffect(() => {
    let active = true;
    let pushed = false;
    const off = bridge.onConversation((value) => {
      pushed = true;
      setConversation(value);
    });
    void bridge
      .currentConversation()
      .then((value) => {
        if (active && !pushed) setConversation(value);
      })
      .catch((error) => {
        if (active)
          console.error("Could not read the Design conversation:", error);
      });
    return () => {
      active = false;
      off();
    };
  }, [bridge]);
  return (
    <BlankDesignCanvas
      accountId={accountId}
      conversation={conversation}
      title={title}
      bridge={ports}
    />
  );
}

async function start() {
  const bridge = window.designWindow;
  const container = document.getElementById("root");
  if (!bridge || !container) return;
  const { locale, theme } = bridge.context;
  document.documentElement.dataset.theme = theme;
  await setLocale(locale, { persist: false });
  createRoot(container).render(<DesignWindow bridge={bridge} />);
}

void start();
