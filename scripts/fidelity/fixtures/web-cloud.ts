/**
 * The web app's cloud sandboxes (web surface only, CLAUDEX_SURFACE=web).
 * `cloud=cowork` reports a service that runs Cowork in the cloud, so the
 * Cowork home shows its Project / Manual / Output row and the Active list
 * (ref-web-chat-home); `cloud=cowork,code` adds cloud Code. Without the
 * parameter the web host keeps its defaults (no cloud Cowork or Code).
 * `active=empty` leaves the Active list with nothing to show.
 */
import { desktopHost, webHost } from "../../../shared/host";
import type { FixtureDomain } from "./index";

export const webCloudFixture: FixtureDomain = {
  params: {
    cloud: "cowork | code | cowork,code: cloud sandboxes the service offers",
    active: "empty: no Cowork task is active",
    codePermissions: "legacy: simulate older backend; current: advertise native session scope",
  },
  bridge: ({ params, state, origin }) => {
    const cloud = (params.get("cloud") ?? "").split(",");
    if (cloud.some(Boolean))
      state.host = {
        kind: "web",
        capabilities: {
          ...webHost.capabilities,
          cloudCowork: cloud.includes("cowork"),
          cloudCode: cloud.includes("code"),
          codeSessionPermissions: cloud.includes("code") && params.get("codePermissions")!=="legacy",
          scheduledTasks: true,
        },
        // Match the real runner's advertised policy capabilities (main.ts).
        cloud: {
          environments: [{ id: "default", name: "Default", network: "full", isDefault: true }],
          permissionModes: ["auto", "manual", "acceptEdits", "plan", "bypass"],
        },
      };
    if (!cloud.some(Boolean) && params.get("codePermissions")==="current")
      state.host={...desktopHost,capabilities:{...desktopHost.capabilities,codeSessionPermissions:true}};
    if (params.get("active") !== "empty" && cloud.includes("cowork")) {
      // Five Cowork tasks as in the reference's Active list: two unread.
      const titles = [
        "Quarterly report outline",
        "codex",
        "Release notes cleanup",
        "Supplier invoice summary",
        "hello",
      ];
      const day = 86_400_000;
      const ages = [15, 15, 16, 16, 21];
      const tasks = state.conversations
        .filter((c) => c.mode !== "code" && !c.archived)
        .slice(-titles.length);
      tasks.forEach((c, i) => {
        c.mode = "cowork";
        c.title = titles[i];
        c.updatedAt = origin - ages[i] * day - i * 1000;
        c.unread = true;
      });
    }
    return {};
  },
};
