import {
  onThisMachine,
  type Conversation,
  type Item,
} from "../../shared/types";
import {
  simulatorKindLabel,
  type SimulatorKind,
} from "../../shared/simulators";
import {
  instructionOrder,
  type DynamicToolResult,
  type EngineExtension,
  type EngineTurnContext,
} from "../engine/engine-extensions";
import type { ControlResult, SimulatorService } from "./service";
import { AppLogs } from "./app-logs";
import { type SimulatorBuilds } from "./builds";
import { buildCall, logsCall } from "./tool-calls";
import {
  simulatorToolSpecs,
  simulatorInstructions,
  controlArguments,
} from "./tool-schemas";
import {
  simulatorNamespaces,
  controlTool,
  buildTool,
  logsTool,
} from "./tool-schemas";
import { refusal } from "./tool-calls";

export const simulatorExtensionId = "simulators";

/** A control result as the engine's tool result. */
export function toolResult(result: ControlResult): DynamicToolResult {
  return {
    success: result.success,
    contentItems: result.parts.map((part) =>
      part.type === "text"
        ? { type: "inputText" as const, text: part.text }
        : {
            type: "inputImage" as const,
            imageUrl: `data:${part.image.mimeType};base64,${part.image.data.toString("base64")}`,
          },
    ),
  };
}

// -- The engine extension ----------------------------------------------------

export interface SimulatorExtensionDeps {
  service(): SimulatorService | undefined;
  /** Claude's headless iOS builds. */
  builds?(): SimulatorBuilds | undefined;
  /** The iOS apps' logs and crash reports. */
  appLogs?(): AppLogs | undefined;
  /** Asks the person in the conversation (an approval card); the answer. */
  ask?(
    conversationId: string,
    params: Record<string, unknown>,
  ): Promise<{ action?: string } | undefined>;
  /** A routine's run works in this conversation: nobody is there to answer. */
  unattended(conversationId: string): boolean;
}

/** Screenshots a conversation's transcript keeps; later ones are answered to the model but not stored. */
export const keptScreenshots = 12;

const isSimulatorItem = (item: Item) =>
  item.type === "dynamicToolCall" &&
  (item.namespace === simulatorNamespaces.ios ||
    item.namespace === simulatorNamespaces.android);

const isPicture = (part: unknown) =>
  !!part &&
  typeof part === "object" &&
  (part as { type?: unknown }).type === "inputImage";

/** The pictures already stored in the conversation by the device tools. */
function storedPictures(conversation: Readonly<Conversation>, except: string) {
  let count = 0;
  for (const turn of conversation.turns)
    for (const item of turn.items)
      if (
        item.id !== except &&
        isSimulatorItem(item) &&
        Array.isArray(item.contentItems)
      )
        count += item.contentItems.filter(isPicture).length;
  return count;
}

const kindOfNamespace = (
  namespace: string | null,
): SimulatorKind | undefined =>
  namespace === simulatorNamespaces.ios
    ? "ios"
    : namespace === simulatorNamespaces.android
      ? "android"
      : undefined;

/** Code on this computer, with somebody there to be asked. */
function applies(
  ctx: Pick<EngineTurnContext, "conversation" | "mode">,
  deps: SimulatorExtensionDeps,
) {
  return (
    ctx.mode === "code" &&
    ctx.conversation.mode === "code" &&
    onThisMachine(ctx.conversation.environment) &&
    !deps.unattended(ctx.conversation.id)
  );
}

export function simulatorExtension(
  deps: SimulatorExtensionDeps,
): EngineExtension & { forget(conversationId: string): void } {
  const kindsFor = (ctx: EngineTurnContext) => {
    const service = deps.service();
    if (!service || !applies(ctx, deps)) return [];
    return (["ios", "android"] as const).filter(
      (kind) => service.unavailable(kind) === undefined && service.ready(kind),
    );
  };
  return {
    id: simulatorExtensionId,
    order: instructionOrder.feature,
    turnContext: (ctx) => {
      if (applies(ctx, deps))
        deps
          .service()
          ?.permissionMode(
            ctx.conversation.id,
            ctx.sandbox === "workspace-write" &&
              !ctx.settings.autoAcceptEdits &&
              !ctx.settings.codePlanMode &&
              ctx.approvalPolicy !== "untrusted",
          );
      return undefined;
    },
    developerInstructions: (ctx) =>
      kindsFor(ctx).length ? simulatorInstructions : undefined,
    dynamicTools: (ctx) => {
      const kinds = kindsFor(ctx);
      return kinds.length ? simulatorToolSpecs(kinds) : undefined;
    },
    async handleDynamicTool(call) {
      const kind = kindOfNamespace(call.namespace);
      if (
        kind &&
        call.conversation.mode === "code" &&
        onThisMachine(call.conversation.environment) &&
        !deps.unattended(call.conversation.id)
      ) {
        const answer = await deps.service()?.approveTools?.();
        if (answer && answer !== "granted")
          return refusal(
            "Re-approve emulator access in Settings > Claudex Code > Mobile simulators",
          );
      }
      if (kind === "ios" && call.tool === buildTool)
        return buildCall(call, deps);
      if (kind === "ios" && call.tool === logsTool) return logsCall(call, deps);
      if (!kind || call.tool !== controlTool) return undefined;
      const service = deps.service();
      const refuse = (message: string): DynamicToolResult => ({
        success: false,
        contentItems: [{ type: "inputText", text: message }],
      });
      if (!service) return refuse("The simulators are not available.");
      if (
        call.conversation.mode !== "code" ||
        !onThisMachine(call.conversation.environment) ||
        deps.unattended(call.conversation.id)
      )
        return refuse(
          `${simulatorKindLabel[kind]} can only be used in a Code session on this computer.`,
        );
      const checked = controlArguments(call.arguments);
      if ("error" in checked) return refuse(checked.error);
      return toolResult(
        await service.control(kind, call.conversation.id, checked.args),
      );
    },
    // A screenshot is a few hundred kilobytes of text in the conversation's
    // file, so only the first ones of a conversation are kept.
    recordItem(item, conversation) {
      if (!isSimulatorItem(item) || !Array.isArray(item.contentItems))
        return undefined;
      if (!item.contentItems.some(isPicture)) return undefined;
      if (storedPictures(conversation, item.id) < keptScreenshots)
        return undefined;
      return {
        ...item,
        contentItems: item.contentItems.map((part: unknown) =>
          isPicture(part)
            ? {
                type: "inputText",
                text: "Screenshot not kept in this transcript.",
              }
            : part,
        ),
      };
    },
    forget(conversationId) {
      deps.service()?.forget(conversationId);
    },
  };
}
