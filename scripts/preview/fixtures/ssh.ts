/**
 * SSH environments (R9-S5) for the preview. Without `ssh` there are no SSH
 * hosts and no ssh program, so no SSH entry shows (as in the app until
 * remote sessions work, src/ssh/availability.ts).
 *
 * `ssh=1` offers two saved hosts, "devbox" and "gpu-box" (unreachable),
 * two ~/.ssh/config suggestions, a folder tree on each host, and runs the
 * Code conversation "Exit code test" on devbox (Recents shows the
 * Environment filter). `sshState=` sets devbox's connection:
 * ready (default) | idle | connecting | installing | reconnecting |
 * needs-auth | error. `sshPrompt=password|passphrase|hostkey` asks that
 * question once the window has read the hosts. `sshSelect=1` starts the Code home on
 * devbox in ~/projects/claudex.
 */
import type { SshHost, SshPrompt, SshStatus } from "../../../shared/ssh-api";
import { previewRemoteSessions } from "../../../src/ssh/availability";
import { setCodeEnvironment } from "../../../src/ssh/codeEnvironment";
import type { FixtureDomain } from "./index";

const statuses: Record<string, SshStatus> = {
  ready: { state: "ready" },
  idle: { state: "idle" },
  connecting: { state: "connecting" },
  installing: { state: "installing", phase: "upload", progress: 0.42 },
  reconnecting: { state: "reconnecting", attempt: 2 },
  "needs-auth": { state: "needs-auth" },
  error: {
    state: "error",
    code: "host-unreachable",
    message: "The host can't be reached from this network.",
  },
};

const tree: Record<string, string[]> = {
  "/home/ada": ["projects", "notes", ".config", "datasets"],
  "/home/ada/projects": ["claudex", "wonder-sim", "wonder-vla"],
  "/home/ada/projects/claudex": ["backend", "electron", "src", "shared"],
};

export const sshFixture: FixtureDomain = {
  params: {
    ssh: "1: two saved hosts and an SSH Code session",
    sshState:
      "ready|idle|connecting|installing|reconnecting|needs-auth|error: devbox's connection",
    sshPrompt: "password|passphrase|hostkey: the question ssh asks",
    sshSelect: "1: the Code home starts on devbox",
  },
  bridge: ({ params, origin, state, emit }) => {
    const on = params.has("ssh");
    const unavailable = async (): Promise<never> => {
      throw new Error("SSH connections aren't available yet.");
    };
    if (!on)
      return {
        sshListHosts: async () => ({
          hosts: [],
          suggestions: [],
          sshAvailable: false,
        }),
        sshStatus: async () => ({ state: "idle" as const }),
        sshSaveHost: unavailable,
        sshDeleteHost: unavailable,
        sshConnect: unavailable,
        sshDisconnect: async () => {},
        sshTestHost: unavailable,
        sshForgetHostKey: unavailable,
        sshAnswerPrompt: async () => {},
        sshListDirectory: unavailable,
        sshChooseFolder: unavailable,
      };

    previewRemoteSessions();
    const hosts: SshHost[] = [
      {
        id: "host-devbox",
        label: "devbox",
        destination: "ada@devbox.internal",
        createdAt: origin - 86_400_000 * 3,
        lastUsedAt: origin - 3_600_000,
      },
      {
        id: "host-gpu",
        label: "gpu-box",
        destination: "ubuntu@10.0.4.21",
        port: 2222,
        createdAt: origin - 86_400_000 * 10,
      },
    ];
    const status: Record<string, SshStatus> = {
      "host-devbox": statuses[params.get("sshState") ?? "ready"] ?? {
        state: "ready",
      },
      "host-gpu": statuses.error,
    };
    const session = state.conversations.find((c) => c.id === "c-exit");
    if (session) {
      session.environment = { kind: "ssh", hostId: "host-devbox" };
      session.cwd = "/home/ada/projects/claudex";
    }
    if (params.get("sshSelect") === "1")
      setCodeEnvironment({
        environment: { kind: "ssh", hostId: "host-devbox" },
        folder: undefined,
      });
    // Asked once the window listens (its first host list), as ssh would
    // while a connection it started is being made.
    let ask: (() => void) | undefined;
    const kind = params.get("sshPrompt");
    if (kind === "password" || kind === "passphrase" || kind === "hostkey") {
      const prompt: SshPrompt =
        kind === "hostkey"
          ? {
              id: "prompt-1",
              hostId: "host-gpu",
              kind,
              text: "The authenticity of host '[10.0.4.21]:2222' can't be established.\nED25519 key fingerprint is SHA256:k3R9q0ZyV1m2xH7cQ4sT8uWnB5dLfE6gJ0pA1oY2iXc.\nAre you sure you want to continue connecting (yes/no/[fingerprint])?",
              fingerprint: "SHA256:k3R9q0ZyV1m2xH7cQ4sT8uWnB5dLfE6gJ0pA1oY2iXc",
            }
          : kind === "passphrase"
            ? {
                id: "prompt-1",
                hostId: "host-devbox",
                kind,
                text: "Enter passphrase for key '/Users/ada/.ssh/id_ed25519':",
              }
            : {
                id: "prompt-1",
                hostId: "host-devbox",
                kind,
                text: "ada@devbox.internal's password:",
              };
      ask = () => setTimeout(() => emit({ type: "ssh-prompt", prompt }), 500);
    }
    const setStatus = (hostId: string, next: SshStatus) => {
      status[hostId] = next;
      emit({ type: "ssh-status", hostId, status: next });
      return next;
    };
    return {
      sshListHosts: async () => {
        ask?.();
        ask = undefined;
        return {
          hosts: structuredClone(hosts),
          suggestions: ["staging", "build-01"],
          sshAvailable: true,
          sshVersion: "OpenSSH_9.9p2",
        };
      },
      sshStatus: async (id) => status[id] ?? { state: "idle" },
      sshSaveHost: async (input) => {
        const saved: SshHost = {
          ...input,
          id: input.id ?? `host-${hosts.length + 1}`,
          createdAt: origin,
        };
        const index = hosts.findIndex((h) => h.id === saved.id);
        if (index >= 0) hosts[index] = saved;
        else hosts.push(saved);
        return structuredClone(saved);
      },
      sshDeleteHost: async (id) => {
        const index = hosts.findIndex((h) => h.id === id);
        if (index >= 0) hosts.splice(index, 1);
      },
      sshConnect: async (id) =>
        id === "host-gpu"
          ? setStatus(id, statuses.error)
          : setStatus(id, { state: "ready" }),
      sshDisconnect: async (id) => void setStatus(id, { state: "idle" }),
      sshTestHost: async (input) =>
        input.destination.includes("10.0.4.21")
          ? { ok: false, error: "The host can't be reached from this network." }
          : input.destination.includes("rebuilt")
            ? {
                ok: false,
                code: "host-key-changed" as const,
                error: "The host key changed.",
              }
            : { ok: true, platform: "Linux x86_64" },
      sshForgetHostKey: async () => ({ removed: true }),
      sshAnswerPrompt: async (id) => emit({ type: "ssh-prompt-closed", id }),
      sshListDirectory: async (_hostId, path) => {
        const folder =
          (path ?? "/home/ada")
            .replace(/^~(?=\/|$)/, "/home/ada")
            .replace(/\/+$/, "") || "/";
        const names = tree[folder];
        if (!names) throw new Error(`${folder} isn't a folder on this host.`);
        return {
          path: folder,
          entries: [
            ...names.map((name) => ({ name, kind: "folder" as const })),
            { name: "README.md", kind: "file" as const },
          ],
        };
      },
      sshChooseFolder: async () => {},
    };
  },
};
