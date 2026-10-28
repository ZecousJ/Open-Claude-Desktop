import { Check } from "../ui/glyphs";
import { useContext, useEffect, useState } from "react";
import { useConversationServices } from "../conversation/ConversationServices";
import { AppContext } from "../app/AppContext";
import { t } from "../i18n";
import { AppIcon } from "../ui/app-icon";

/**
 * The thinking text as a Markdown quote, as the original copies it:
 * "**Thinking** (~N tok)" with N a quarter of its length, then every line
 * quoted.
 */
export function thinkingQuote(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
  return `> **Thinking** (~${Math.round(text.length / 4)} tok)\n>\n${lines}`;
}

/**
 * The Thinking and Verbose views' thinking: muted italic text after a rule,
 * with a ghost Copy as quote button at its top right that shows while the block
 * is hovered or focused.
 */
export function ThinkingInline({ text }: { text: string }) {
  const services = useConversationServices();
  const app = useContext(AppContext);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const label = copied ? "Copied" : "Copy as quote";
  return (
    <div className="code-thinking-inline">
      <div className="code-thinking-text">{text}</div>
      <div className="code-thinking-actions">
        <button
          type="button"
          aria-label={t(label)}
          title={t(label)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() =>
            void services.copyText(thinkingQuote(text)).then(
              () => {
                setCopied(true);
                app?.notify("Copied");
              },
              (error) => app?.report(error),
            )
          }
        >
          {copied ? (
            <Check size={16} aria-hidden="true" />
          ) : (
            <AppIcon name="Copy" />
          )}
        </button>
      </div>
    </div>
  );
}
