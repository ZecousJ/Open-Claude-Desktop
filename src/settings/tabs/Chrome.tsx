import { Row, Section, SelectField, Toggle } from "../controls";
import type { TabProps } from "../context";
import { notAvailable } from "../unavailable";
import { useHostCapability } from "../../host/HostContext";
import "../desktop.css";
import "../original-rows.css";

/** Rows Settings search finds on this page. */
export { chromeLabels as searchLabels } from "./desktop-labels";

/**
 * Claude in Chrome: the original's page, drawn as it is. The Chrome extension
 * does not connect to Claudex, so its switch and the site policy are disabled
 * with the reason (owner rule: UI first). The navigation shows the page only
 * where the app runs local MCP servers (nav.tsx tabAvailable).
 */
export function ChromeTab(_props: TabProps) {
  const localMcp = useHostCapability("localMcp");
  // Where local MCP runs, the way Claudex can give Claude a browser.
  const reason = localMcp
    ? `${notAvailable}: the Chrome extension doesn’t connect to Claudex. A browser MCP server added under Developer can give Claudex a browser.`
    : `${notAvailable}: the Chrome extension doesn’t connect to Claudex.`;
  return (
    <div className="desktop-page chrome-settings">
      <div className="chrome-settings-hero">
        <ChromeIllustration />
        <h2>Claudex in Chrome settings</h2>
      </div>
      <Section>
        <Row
          label="Enable Claudex in Chrome"
          description="Use Claudex in your browser with the Claudex in Chrome extension. This setting only affects the extension."
        >
          <Toggle
            label="Enable Claudex in Chrome"
            checked={false}
            unavailable={reason}
          />
        </Row>
      </Section>
      <Section
        title="Site permissions"
        tightNote
        note="These permissions apply to Claudex in Chrome and the built-in browser in the Claudex desktop app."
      >
        <Row
          label="Default for all sites"
          description="Choose whether Claudex works on all sites by default"
        >
          <SelectField<string>
            label="Default for all sites"
            value=""
            placeholder="Select default policy"
            width={175}
            options={[]}
            disabled
            onChange={() => {}}
          />
        </Row>
      </Section>
    </div>
  );
}

/** Two browser windows and a pointer, 58×55. */
function ChromeIllustration() {
  return (
    <svg
      className="chrome-settings-art"
      width="58"
      height="55"
      viewBox="0 0 58 55"
      aria-hidden="true"
    >
      <rect className="back" x="0.5" y="0.5" width="47" height="35" />
      <path className="line" d="M0.5 6.5H47.5" />
      <rect className="front" x="11.5" y="19.5" width="46" height="35" />
      <path className="line" d="M11.5 25.5H57.5" />
      <path
        className="pointer"
        d="M31 32.5l9.5 3.8-4 1.6 3.4 3.4-1.8 1.8-3.4-3.4-1.6 4z"
      />
    </svg>
  );
}
