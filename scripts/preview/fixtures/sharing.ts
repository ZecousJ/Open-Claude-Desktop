/**
 * Hosted sharing (R1) for the preview. Nothing leaves the page: the
 * service is synthetic, links point at share.example.test and Open in web
 * opens nothing.
 *
 * `sharing=off` (the default) is a service without sharing: no Share entry
 * shows. `on`: sharing is on and nothing is shared yet. `public`: the first
 * conversation and one artifact have public links. `stale`: the first
 * conversation's link is older than its last message. `disabled`: an
 * administrator took the first conversation's link down. `blocked`: the
 * administrator turned sharing off for this account. `policy=none` leaves
 * the Usage Policy link out.
 */
import type {
  HostedShare,
  ShareKind,
  SharingStatus,
} from "../../../shared/sharing-api";
import type { ArtifactShareInput } from "../../../shared/types";
import type { FixtureDomain } from "./index";

const day = 24 * 60 * 60 * 1000;
const unavailable = async (): Promise<never> => {
  throw new Error("Sharing isn't available on this service.");
};
let next = 1;
const token = () => `${String(next++).padStart(4, "0")}${"x".repeat(39)}`;

export const sharingFixture: FixtureDomain = {
  params: {
    sharing:
      "off (default: no hosted sharing) | on | public | stale | disabled | blocked",
    policy: "none: the administrator set no Usage Policy link",
    mail: "off: the service cannot send invitation mail",
    sharedWithMe: "1: two chats shared with this account",
  },
  bridge: ({ params, origin, state, emit }) => {
    const mode = params.get("sharing") ?? "off";
    if (!["on", "public", "stale", "disabled", "blocked"].includes(mode))
      return {
        sharingStatus: async () => null,
        conversationShare: async () => null,
        hostedShares: async () => [],
        shareConversation: unavailable,
        unshareConversation: unavailable,
        publishArtifact: unavailable,
        revokeShare: unavailable,
        sharedWithMe: async () => [],
        readSharedChat: unavailable,
        openShare: unavailable,
      };
    const blocked = mode === "blocked";
    const status: SharingStatus = {
      conversations: !blocked,
      artifacts: !blocked,
      ...(params.get("policy") === "none"
        ? {}
        : { usagePolicyUrl: "https://share.example.test/usage-policy" }),
      maxSnapshotBytes: 8 * 1024 * 1024,
      maxArtifactBytes: 2 * 1024 * 1024,
      ...(blocked ? { blocked: true } : {}),
    };
    const make = (
      kind: ShareKind,
      sourceKey: string,
      title: string,
      at: number,
    ): HostedShare => ({
      id: String(next),
      kind,
      sourceKey,
      title,
      url: `https://share.example.test/s/${token()}`,
      createdAt: at,
      snapshotAt: at,
      status: "active",
      views: 0,
    });
    const shares: HostedShare[] = [];
    const first = state.conversations.find((c) => !c.incognito);
    if (first && mode !== "on" && mode !== "blocked") {
      const share = make("conversation", first.id, first.title, origin - day);
      share.views = 12;
      if (mode === "stale") share.stale = true;
      if (mode === "disabled") {
        share.status = "disabled";
        share.disabledReason = "Reported content";
      }
      shares.push(share);
    }
    if (mode === "public")
      shares.push(
        make(
          "artifact",
          JSON.stringify(["fixture", "/workspace/report.html"]),
          "Quarterly report",
          origin - 2 * day,
        ),
      );
    const changed = (kind: ShareKind, sourceKey?: string) => {
      emit({ type: "sharing", kind, ...(sourceKey ? { sourceKey } : {}) });
      if (kind === "artifact") {
        const links = new Map(
          shares
            .filter((s) => s.kind === "artifact" && s.status === "active")
            .map((s) => [s.sourceKey, s.url]),
        );
        const local = state.artifactShares.filter((s) => s.scope !== "public");
        state.artifactShares = [
          ...local.filter((s) => !links.has(s.identity)),
          ...[...links].map(([identity, url]) => ({
            identity,
            visibility: "link" as const,
            showInList:
              local.find((s) => s.identity === identity)?.showInList ?? true,
            url,
            scope: "public" as const,
            publicUrl: url,
          })),
        ];
        emit({ type: "artifact-shares", shares: state.artifactShares });
      }
    };
    const allowed = (kind: ShareKind) => {
      if (blocked)
        throw new Error(
          "Your administrator has turned off sharing for your account.",
        );
      return kind;
    };
    const find = (kind: ShareKind, sourceKey: string) =>
      shares.find((s) => s.kind === kind && s.sourceKey === sourceKey);
    const remove = (id: string) => {
      const index = shares.findIndex((s) => s.id === id);
      return index < 0 ? undefined : shares.splice(index, 1)[0];
    };
    const publicArtifacts = () =>
      shares
        .filter((s) => s.kind === "artifact")
        .map((s) => ({
          identity: `hosted:${s.id}`,
          title: s.title,
          ...(s.status === "active" ? { url: s.url } : {}),
          scope: "public" as const,
        }));
    return {
      sharingStatus: async () => structuredClone(status),
      artifactShareState: async (input: ArtifactShareInput) => ({
        share: structuredClone(find("artifact", input.identity) ?? null),
        versions: [],
        currentVersion: "fixture-current",
        autoUpdate: false,
      }),
      artifactPublication: async (input: ArtifactShareInput) => {
        const share = find("artifact", input.identity) ?? null;
        return { share: structuredClone(share), liveLinks: share?.status === "active" ? 1 : 0, unpublished: false };
      },
      conversationShare: async (id: string) =>
        structuredClone(find("conversation", id) ?? null),
      hostedShares: async (kind?: ShareKind) =>
        structuredClone(shares.filter((s) => !kind || s.kind === kind)),
      shareConversation: async (id: string, access?: "link" | "invited") => {
        allowed("conversation");
        const conversation = state.conversations.find((c) => c.id === id);
        if (!conversation) throw new Error("Conversation not found.");
        if (conversation.incognito)
          throw new Error("Incognito chats can't be shared.");
        const now = origin + 60_000;
        let share = find("conversation", id);
        if (share) Object.assign(share, { snapshotAt: now, stale: undefined });
        else {
          shares.unshift(
            (share = make("conversation", id, conversation.title, now)),
          );
          if (access === "invited") {
            share.access = "invited";
            share.invites = [];
          }
        }
        changed("conversation", id);
        return structuredClone(share);
      },
      setShareAccess: async (id: string, access: "link" | "invited") => {
        allowed("conversation");
        const share = find("conversation", id);
        if (!share) return null;
        if (access === "invited") {
          if (!share.invites?.length) {
            remove(share.id);
            changed("conversation", id);
            return null;
          }
          share.access = "invited";
        } else delete share.access;
        changed("conversation", id);
        return structuredClone(share);
      },
      inviteToShare: async (id: string, email: string) => {
        allowed("conversation");
        const conversation = state.conversations.find((c) => c.id === id);
        if (!conversation) throw new Error("Conversation not found.");
        let share = find("conversation", id);
        if (!share) {
          shares.unshift(
            (share = make(
              "conversation",
              id,
              conversation.title,
              origin + 60_000,
            )),
          );
          share.access = "invited";
          share.invites = [];
        }
        const address = email.trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address))
          throw new Error("Enter a valid e-mail address.");
        share.invites ??= [];
        const added = !share.invites.includes(address);
        if (added) share.invites.push(address);
        changed("conversation", id);
        return {
          share: structuredClone(share),
          added,
          mailed: params.get("mail") !== "off",
        };
      },
      removeShareInvite: async (id: string, email: string) => {
        const share = find("conversation", id);
        if (!share) return null;
        share.invites = (share.invites ?? []).filter((e) => e !== email);
        if (share.access === "invited" && !share.invites.length) {
          remove(share.id);
          changed("conversation", id);
          return null;
        }
        changed("conversation", id);
        return structuredClone(share);
      },
      sharedWithMe: async () =>
        params.get("sharedWithMe")
          ? [
              {
                token: "S".repeat(43),
                title: "Quarterly plan",
                owner: "ann@example.com",
                snapshotAt: origin - 3 * day,
              },
              {
                token: "T".repeat(43),
                title: "Trip to Kyoto",
                owner: "bo@example.com",
                snapshotAt: origin - 9 * day,
              },
            ]
          : [],
      readSharedChat: async (token: string) => ({
        token,
        title: token.startsWith("S") ? "Quarterly plan" : "Trip to Kyoto",
        owner: token.startsWith("S") ? "ann@example.com" : "bo@example.com",
        snapshotAt: origin - 3 * day,
        messages: [
          { role: "user" as const, text: "Draft a plan for next quarter." },
          {
            role: "assistant" as const,
            text: "Here is a plan.\n\n1. Ship the API page\n2. Tighten sharing\n3. Review costs",
            activity: ["Read a file"],
          },
        ],
      }),
      unshareConversation: async (id: string) => {
        const share = find("conversation", id);
        if (share) remove(share.id);
        changed("conversation", id);
      },
      publishArtifact: async (input: ArtifactShareInput) => {
        allowed("artifact");
        let share = find("artifact", input.identity);
        if (share) Object.assign(share, { title: input.title });
        else
          shares.unshift(
            (share = make("artifact", input.identity, input.title, origin)),
          );
        changed("artifact", input.identity);
        return structuredClone(share);
      },
      revokeShare: async (id: string) => {
        const share = remove(id);
        if (share) changed(share.kind, share.sourceKey);
      },
      // Privacy → Shared artifacts lists the public links (R1-C merges them).
      sharedArtifacts: async () => publicArtifacts(),
      stopSharingArtifact: async (identity: string) => {
        const share = remove(identity.replace(/^hosted:/, ""));
        if (share) changed(share.kind, share.sourceKey);
        return publicArtifacts();
      },
      openShare: async (id: string) => {
        if (!shares.some((s) => s.id === id && s.status === "active"))
          throw new Error("This link no longer exists.");
      },
    };
  },
};
