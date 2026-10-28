/**
 * Offline fixture for the Browser pane's page-area states: the start page,
 * Browser tools off, a dev server that failed, wasn't started or stopped,
 * and Setting up preview. ?theme=light draws the light theme.
 */
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserEmptyState } from "../../src/browser/BrowserEmptyState";
import {
  BrowserToolsOff,
  DevServerFailedCard,
  DevServerNotStarted,
  DevServerStoppedCard,
  SettingUpPreview,
} from "../../src/browser/PreviewStatus";
import { Menu } from "../../src/ui/Menu";
import { devServerEntries } from "../../src/browser/DevServersMenu";
import {
  browserSettingsEntries,
  keepCookiesEntries,
} from "../../src/browser/BrowserSettingsMenu";
import {
  CloseRunningTabDialog,
  DevServerLogsDrawer,
} from "../../src/browser/DevServerDialogs";
import type { DevServerState } from "../../shared/browser";
import { useRef } from "react";
import { FilesPanel } from "../../src/files/FilesPanel";
import { CodeLanding } from "../../src/code-home/CodeLanding";
import {
  InspectorLayer,
  InspectorPanel,
  useInspectorState,
} from "../../src/simulators/SimulatorInspector";
import "../../src/simulators/simulator-panel.css";
import "../../src/styles.css";
import "../../src/artifacts/file-viewer.css";
import "../../src/ui/menu.css";
import "../../src/browser/browser-panel.css";

const theme = new URLSearchParams(location.search).get("theme");
if (theme) document.documentElement.dataset.theme = theme;

function Frame({ label, children }: { label: string; children: ReactNode }) {
  return (
    <figure style={{ margin: 0 }}>
      <figcaption
        style={{ font: "11px sans-serif", opacity: 0.6, marginBottom: 4 }}
      >
        {label}
      </figcaption>
      <div
        className="work-panel browser-panel"
        style={{ position: "relative", width: 420, height: 300 }}
      >
        <div
          className="browser-viewport"
          style={{ position: "relative", height: "100%" }}
        >
          {children}
        </div>
      </div>
    </figure>
  );
}

const servers: DevServerState[] = [
  {
    name: "web",
    command: "npm run dev",
    port: 5173,
    url: "http://localhost:5173",
    status: "running",
    source: "launch.json",
  },
  {
    name: "docs",
    command: "npm run docs",
    status: "stopped",
    source: "launch.json",
  },
  {
    name: "api",
    command: "npm run api",
    port: 8080,
    status: "starting",
    source: "launch.json",
  },
];
const noop = () => {};
const view = new URLSearchParams(location.search).get("view");

const elements = [
  {
    path: "0",
    type: "Application",
    label: "MyApp",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    bounds: { x: 0, y: 0, width: 393, height: 852 },
    depth: 0,
  },
  {
    path: "1",
    type: "StaticText",
    label: "Welcome",
    frame: { x: 0.05, y: 0.1, width: 0.4, height: 0.05 },
    bounds: { x: 20, y: 85, width: 157, height: 43 },
    depth: 1,
  },
  {
    path: "2",
    type: "Button",
    label: "Sign in",
    identifier: "signIn",
    enabled: true,
    frame: { x: 20 / 393, y: 700 / 852, width: 353 / 393, height: 50 / 852 },
    bounds: { x: 20, y: 700, width: 353, height: 50 },
    depth: 1,
  },
];

function InspectorPreview() {
  const state = useInspectorState();
  const surface = useRef<HTMLImageElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const svg = encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="393" height="852"><rect width="393" height="852" fill="#f2f2f7"/><rect x="20" y="700" width="353" height="50" rx="12" fill="#0a84ff"/><text x="196" y="732" font-size="17" text-anchor="middle" fill="#fff">Sign in</text><text x="20" y="120" font-size="34" font-weight="bold">Welcome</text></svg>',
  );
  return (
    <div style={{ padding: 16 }}>
      <div className="sim-stage-row" style={{ width: 760, height: 560 }}>
        <div ref={frame} className="sim-stage-frame">
          <div className="sim-stage">
            <img
              ref={surface}
              className="sim-screen ios"
              src={`data:image/svg+xml,${svg}`}
              width={393}
              height={852}
              alt=""
            />
          </div>
          <InspectorLayer
            elements={elements}
            surface={surface}
            frame={frame}
            state={state}
            onAddToChat={async () => {}}
            onClose={() => {}}
          />
        </div>
        <InspectorPanel
          elements={elements}
          loading={false}
          state={state}
          onClose={() => {}}
          onCopy={() => {}}
        />
      </div>
    </div>
  );
}

const fakeFiles: Record<
  string,
  { name: string; path: string; kind: "file" | "folder" }[]
> = {
  "": [
    { name: "src", path: "src", kind: "folder" },
    { name: "package.json", path: "package.json", kind: "file" },
    { name: "README.md", path: "README.md", kind: "file" },
  ],
  src: [
    { name: "components", path: "src/ui/components", kind: "folder" },
    { name: "App.tsx", path: "src/app/App.tsx", kind: "file" },
    { name: "main.ts", path: "src/main.ts", kind: "file" },
  ],
  "src/ui/components": [],
};

const landingSession = (
  id: string,
  title: string,
  extra: Record<string, unknown>,
) =>
  ({
    id,
    title,
    mode: "code",
    turns: [
      {
        id: "t",
        prompt: "x",
        attachments: [],
        items: [],
        status: "completed",
        createdAt: 0,
      },
    ],
    pinned: false,
    archived: false,
    createdAt: 0,
    updatedAt: Date.now() - 60_000,
    ...extra,
  }) as never;

function Preview() {
  if (view === "inspector") return <InspectorPreview />;
  if (view === "landing")
    return (
      <CodeLanding
        conversations={[
          landingSession("1", "Fix the login redirect", {
            updatedAt: Date.now() - 120_000,
          }),
          landingSession("2", "Add dark mode to settings", {
            unread: true,
            updatedAt: Date.now() - 3_600_000,
          }),
          landingSession("3", "Refactor the billing worker", {
            turns: [
              {
                id: "t",
                prompt: "x",
                attachments: [],
                items: [],
                status: "inProgress",
                createdAt: 0,
              },
            ],
            updatedAt: Date.now() - 30_000,
            projectId: "p1",
          }),
        ]}
        projects={[{ id: "p1", name: "Payments" } as never]}
        approvals={[{ conversationId: "1" }]}
        onOpen={() => {}}
        onOpenProject={() => {}}
        onOpenPr={() => {}}
        onMarkAllRead={() => {}}
      />
    );
  if (view === "files")
    return (
      <div
        className="files-fixture"
        style={{ width: 760, height: 520, display: "flex", padding: 16 }}
      >
        <style>
          {
            ".files-fixture > .work-panel { width: 100% !important; max-width: none !important; }"
          }
        </style>
        <FilesPanel
          conversation={{ id: "c", mode: "code", cwd: "/work/app" } as never}
          bridge={{
            listProjectFolder: async (_id, folder) => ({
              entries: fakeFiles[folder] ?? [],
              truncated: false,
            }),
            readProjectFile: async (_id, file) => ({
              path: file,
              bytes: 120,
              content: file.endsWith(".tsx")
                ? 'import { useState } from "react";\n\nexport function App() {\n  const [count, setCount] = useState(0);\n  return <button onClick={() => setCount(count + 1)}>{count}</button>;\n}\n'
                : '{\n  "name": "app"\n}\n',
            }),
          }}
          onClose={() => {}}
        />
      </div>
    );
  if (view === "menu")
    return (
      <Menu
        label="Dev servers"
        entries={devServerEntries(
          servers,
          {
            start: noop,
            stop: noop,
            open: noop,
            stopAll: noop,
            add: noop,
            toggleLogs: noop,
          },
          { showingUrl: "http://localhost:5173/" },
        )}
        position={{ left: 16, top: 16 }}
        width={220}
        onClose={noop}
      />
    );
  if (view === "settings" || view === "cookies")
    return (
      <Menu
        label="Browser settings"
        entries={
          view === "cookies"
            ? keepCookiesEntries({ browserKeepCookies: "always" }, noop)
            : browserSettingsEntries({
                browserName: "Google Chrome",
                hasPage: true,
                canOpenElsewhere: true,
                toolsAvailable: true,
                viewport: "mobile",
                colorScheme: "system",
                autoVerify: false,
                settings: {
                  browserOpenLinksInApp: true,
                  browserAllowedSites: [],
                  browserKeepCookies: "until-quit",
                },
                actions: {
                  openElsewhere: noop,
                  copyUrl: noop,
                  setViewport: noop,
                  setColorScheme: noop,
                  toggleAutoVerify: noop,
                  saveScreenshot: noop,
                  openHtmlFile: noop,
                  setPreference: noop,
                  manageAllowedSites: noop,
                  chooseKeepCookies: noop,
                  clearBrowsingData: noop,
                },
              })
        }
        position={{ left: 16, top: 16 }}
        width={231}
        onClose={noop}
      />
    );
  if (view === "drawer")
    return (
      <div
        className="work-panel browser-panel"
        style={{
          position: "relative",
          width: 420,
          height: 420,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          className="browser-viewport"
          style={{ position: "relative", flex: 1 }}
        />
        <DevServerLogsDrawer
          server={servers[0]}
          onRead={async () => [
            "> vite",
            "",
            "  VITE v6.0.0  ready in 312 ms",
            "  ➜  Local:   http://localhost:5173/",
            "warning: deprecated option",
            "Error: failed to load config",
          ]}
          onClose={noop}
        />
      </div>
    );
  if (view === "close")
    return (
      <CloseRunningTabDialog
        servers={[servers[0]]}
        others={false}
        onStop={async () => {}}
        onKeep={noop}
        onClose={noop}
      />
    );
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 16, padding: 16 }}>
      <Frame label="start page">
        <BrowserEmptyState toolsAvailable onDetect={() => {}} />
      </Frame>
      <Frame label="tools off">
        <BrowserToolsOff onTurnOn={() => {}} />
      </Frame>
      <Frame label="failed">
        <DevServerFailedCard
          message={
            "> vite\n\nError: listen EADDRINUSE: address already in use :::5173"
          }
          busy={false}
          onRetry={() => {}}
        />
      </Frame>
      <Frame label="not started">
        <DevServerNotStarted busy={false} onRetry={() => {}} />
      </Frame>
      <Frame label="stopped">
        <DevServerStoppedCard name="web" busy={false} onRestart={() => {}} />
      </Frame>
      <Frame label="setting up">
        <SettingUpPreview />
      </Frame>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
