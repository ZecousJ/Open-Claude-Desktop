import { z } from "zod";
import type { ComputerUseAPI } from "../../../shared/computer-use-api";
import type { ComputerUseAccessRequest } from "../../../shared/computer-use";

const prefix = "chat-computer-use:";

const consentText = (value: string) =>
  value.replace(/\s+/g, " ").replace(/[!-/:-@\[-`{-~]/g, "\\$&");

const response = z.object({
  askNonce: z.string(),
  response: z.object({
    verdict: z.union([z.literal(1), z.literal(2)]),
    approvalOption: z.union([z.literal(0), z.literal(1)]).optional(),
  }),
});

export function chatComputerUseHost(ports: {
  requests(
    conversationId: string,
  ): Promise<readonly ComputerUseAccessRequest[]>;
  answer(
    ...args: Parameters<ComputerUseAPI["answerComputerUseAccess"]>
  ): Promise<void>;
  translator(): Promise<(message: string) => string>;
}) {
  return {
    async list(conversationId: string) {
      const requests = await ports.requests(conversationId);
      if (!requests.length) return [];
      const translate = await ports.translator();
      return requests.map((request, index) => {
        const title =
          request.kind === "permissions"
            ? "Enable Computer Use in System Settings"
            : request.kind === "full-control"
              ? "Allow Claudex to take control of your screen?"
              : "Allow Claudex to use these apps?";
        const details =
          request.kind === "permissions"
            ? [
                translate(
                  "Grant Accessibility and Screen Recording in Settings → System → Computer use.",
                ),
              ]
            : [
                ...request.apps.map(
                  ({ app, tier }) =>
                    `${consentText(app.name)} (${translate(tier === "read" ? "Read-only" : tier === "click" ? "Click-only" : "Full access")})`,
                ),
                ...(request.clipboard?.read
                  ? [translate("Clipboard read access")]
                  : []),
                ...(request.clipboard?.write
                  ? [translate("Clipboard write access")]
                  : []),
                request.reason && consentText(request.reason),
              ];
        return {
          id: prefix + request.id,
          conversationId,
          index,
          request: {
            status: 1,
            kind: 1,
            askNonce: request.id,
            holdsConversation: true,
            requiresUserInteraction: true,
            title: translate(title),
            description: details.filter(Boolean).join("\n\n"),
            descriptionFormat: { style: 2 },
            requester: { kind: 2 },
            fields: [
              {
                name: "decision",
                type: 1,
                label: translate("Decision"),
                options: [
                  {
                    value: "once",
                    label: translate(
                      request.kind === "permissions"
                        ? "Check again"
                        : request.kind === "apps"
                          ? "Allow for this chat"
                          : "Allow once",
                    ),
                    approvalOption: 1,
                  },
                  { value: "deny", label: translate("Decline"), isDeny: true },
                ],
              },
            ],
          },
        };
      });
    },
    async respond(
      conversationId: string,
      input: { elicitationId?: string; askNonce?: unknown; response?: unknown },
    ) {
      if (!input.elicitationId?.startsWith(prefix)) return false;
      const id = input.elicitationId.slice(prefix.length);
      const parsed = response.safeParse(input);
      if (!parsed.success || parsed.data.askNonce !== id)
        throw Error(
          "The computer-use response does not match the displayed request.",
        );
      const request = (await ports.requests(conversationId)).find(
        (request) => request.id === id,
      );
      if (!request)
        throw Error("The computer-use request is no longer current.");
      await ports.answer(
        id,
        parsed.data.response.verdict === 2
          ? "deny"
          : { allow: request.apps.map(({ app }) => app.id), deny: [] },
      );
      return true;
    },
  };
}
