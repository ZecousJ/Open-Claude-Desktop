import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  DynamicToolCall,
  DynamicToolResult,
  EngineExtension,
  EngineTurnContext,
  GatewaySignalContext,
  GatewaySignalEvent,
} from "../engine/engine-extensions";
import { instructionOrder } from "../engine/engine-extensions";
import {
  ResearchArgumentError,
  parseResearchPlan,
  parseResearchReport,
  parseResearchStartReport,
  researchInstructions,
  researchOffInstructions,
  researchPlanTool,
  researchReportTool,
  researchStartReportTool,
  researchTools,
} from "../engine/research-instructions";
import {
  defaultMaxSearchesPerTurn,
  researchPolicyOf,
  type ClientPolicy,
} from "../../shared/client-policy";
import type { ModelCatalogItem } from "../../shared/model-catalog-api";
import {
  hadResearch,
  maxResearchReportBytes,
  reportHeading,
  researchFinished,
  researchTurnIdPattern,
  researchUnavailable,
  researchUnavailableMessages,
  researchConnectorEnabled,
  sourceKey,
  turnSourceUrls,
  type ResearchState,
} from "../../shared/research";
import type { ResearchEvent } from "../../shared/research-api";
import type { AppEvent, Conversation, Turn } from "../../shared/types";

/**
 * Research mode (R4, design R45 §3.3): the conversation switch, the Research
 * engine extension (instructions, the research_plan / research_report
 * tools, source counting, the report as a file) and reading or saving a
 * finished report.
 */

/**
 * Finished reports as Markdown files in the account's folder:
 * `research/<conversation id>/<turn id>.md`, readable only by the account's
 * user. The window never names a path; it asks by conversation and turn.
 */
export class ResearchReports {
  readonly folder: string;
  constructor(readonly accountRoot: string) {
    this.folder = path.join(accountRoot, "research");
  }
  private safeName(value: string) {
    return researchTurnIdPattern.test(value) ? value : undefined;
  }
  /** Writes a report; returns its path relative to the account folder. */
  write(conversationId: string, turnId: string, markdown: string) {
    const folderName = this.safeName(conversationId);
    if (!folderName) throw new Error("This conversation can't keep reports.");
    const fileName = `${this.safeName(turnId) ?? randomUUID()}.md`;
    const folder = path.join(this.folder, folderName);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const file = path.join(folder, fileName);
    const temporary = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, markdown, { mode: 0o600 });
    fs.renameSync(temporary, file);
    return {
      path: path.relative(this.accountRoot, file).split(path.sep).join("/"),
      bytes: Buffer.byteLength(markdown, "utf8"),
    };
  }
  /** A stored report's text; refuses any path outside the reports folder. */
  read(relativePath: string) {
    const file = path.resolve(this.accountRoot, relativePath);
    const inside = path.relative(this.folder, file);
    if (
      !inside ||
      inside.startsWith("..") ||
      path.isAbsolute(inside) ||
      !file.endsWith(".md")
    )
      throw new Error("This research report isn't available.");
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(file);
    } catch {
      throw new Error("This research report is no longer available.");
    }
    if (!stat.isFile() || stat.size > maxResearchReportBytes * 2)
      throw new Error("This research report isn't available.");
    return fs.readFileSync(file, "utf8");
  }
  /** Removes the reports of conversations that no longer exist. */
  removeOrphans(conversationIds: Set<string>) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries)
      if (entry.isDirectory() && !conversationIds.has(entry.name))
        fs.rmSync(path.join(this.folder, entry.name), {
          recursive: true,
          force: true,
        });
  }
}

export interface ResearchExtensionDeps {
  policy(): ClientPolicy;
  /** The service catalog's entry for a model, when the service has one. */
  catalogItem(providerId: string, model: string): ModelCatalogItem | undefined;
  reports: ResearchReports;
  /** Sends a progress event to the windows. */
  push(event: AppEvent): void;
  now?: () => number;
}

function textResult(text: string, success: boolean): DynamicToolResult {
  return { contentItems: [{ type: "inputText", text }], success };
}

/** The running turn a tool call or signal belongs to. */
function runningTurn(conversation: Conversation, turnId?: string) {
  return (
    (turnId
      ? conversation.turns.find((turn) => turn.id === turnId)
      : undefined) ??
    conversation.turns.filter((turn) => turn.status === "inProgress").at(-1)
  );
}

/**
 * The Research engine extension. Research runs in a Chat whose switch is
 * on, while the administrator allows Research and a search integration is
 * available; with Research turned off by the administrator the
 * Chat simply continues without it.
 */
export function createResearchExtension(
  deps: ResearchExtensionDeps,
): EngineExtension {
  const now = deps.now ?? Date.now;
  /** Distinct pages and search calls seen per turn (signals arrive before items). */
  const seenUrls = new WeakMap<Turn, Set<string>>();
  const seenSearches = new WeakMap<Turn, Set<string>>();

  const policyAllows = () => researchPolicyOf(deps.policy()).enabled;
  const unavailable = (ctx: EngineTurnContext) =>
    researchUnavailable({
      policy: ctx.policy,
      mode: ctx.mode,
      incognito: ctx.conversation.incognito,
      provider: ctx.provider,
      model: ctx.model,
      catalogItem: deps.catalogItem(ctx.provider.id, ctx.model),
      searchIntegrationEnabled: researchConnectorEnabled(
        ctx.settings,
        ctx.policy,
        ctx.conversation.connectorOverrides,
      ),
    });
  const active = (ctx: EngineTurnContext) =>
    !!ctx.conversation.research && !unavailable(ctx);

  const publish = (conversation: Conversation, turn: Turn) => {
    if (!turn.research) return;
    const event: ResearchEvent = {
      type: "research",
      conversationId: conversation.id,
      turnId: turn.id,
      research: structuredClone(turn.research),
    };
    deps.push(event);
  };
  const stateOf = (turn: Turn): ResearchState =>
    (turn.research ??= {
      state: "starting",
      startedAt: turn.createdAt || now(),
      sourceCount: 0,
      searchCount: 0,
    });
  const countSources = (turn: Turn, extra: string[] = []) => {
    let urls = seenUrls.get(turn);
    if (!urls) {
      urls = turnSourceUrls(turn);
      seenUrls.set(turn, urls);
    } else for (const url of turnSourceUrls(turn)) urls.add(url);
    for (const url of extra) {
      const key = sourceKey(url);
      if (key) urls.add(key);
    }
    const research = stateOf(turn);
    research.sourceCount = Math.max(research.sourceCount, urls.size);
  };

  const plan = (call: DynamicToolCall, turn: Turn) => {
    const { title, questions, plan } = parseResearchPlan(call.arguments);
    const research = stateOf(turn);
    research.title = title;
    research.questions = questions;
    research.plan = plan;
    if (research.state === "starting" || research.state === "planning")
      research.state = "gathering";
    call.changed();
    publish(call.conversation, turn);
    return textResult(
      "Plan recorded. Research the questions now; submit the report with research_report when you are done.",
      true,
    );
  };
  const report = (call: DynamicToolCall, turn: Turn) => {
    const { title, markdown } = parseResearchReport(call.arguments);
    const stored = deps.reports.write(
      call.conversation.id,
      turn.id.startsWith("pending-") ? call.turnId : turn.id,
      markdown,
    );
    const research = stateOf(turn);
    research.title = title;
    research.report = { title, ...stored };
    research.reportSource = "tool";
    research.state = "done";
    research.completedAt = now();
    countSources(turn);
    call.changed();
    publish(call.conversation, turn);
    return textResult(
      "Report saved; the person can open it in the Research panel. Now reply with a brief summary of the main findings (a few sentences), not the whole report.",
      true,
    );
  };

  return {
    id: "research",
    order: instructionOrder.research,
    beforeSend(ctx) {
      if (!ctx.conversation.research) return;
      const reason = unavailable(ctx);
      // An administrator who turns Research off leaves the Chat usable.
      if (!reason || reason === "policy") return;
      throw new Error(
        `${researchUnavailableMessages[reason]} Turn off Research to send this message.`,
      );
    },
    turnContext(ctx) {
      const conversation = ctx.conversation as Conversation;
      if (active(ctx)) {
        const turn = conversation.turns.at(-1);
        if (turn?.status === "inProgress" && !turn.research)
          turn.research = {
            state: "starting",
            startedAt: now(),
            sourceCount: 0,
            searchCount: 0,
          };
        const research = researchPolicyOf(ctx.policy);
        return {
          instructions: researchInstructions({
            searchIntegration:
              !conversation.webSearch &&
              researchConnectorEnabled(
                ctx.settings,
                ctx.policy,
                conversation.connectorOverrides,
              ),
            maxSearches:
              research.maxSearchesPerTurn || defaultMaxSearchesPerTurn,
          }),
        };
      }
      return hadResearch(conversation)
        ? { instructions: researchOffInstructions }
        : undefined;
    },
    dynamicTools(ctx) {
      return active(ctx) ? researchTools() : undefined;
    },
    threadConfigOverrides(ctx) {
      if (!active(ctx)) return;
      if (
        !ctx.conversation.webSearch &&
        researchConnectorEnabled(
          ctx.settings,
          ctx.policy,
          ctx.conversation.connectorOverrides,
        )
      )
        return;
      return { web_search: "live" };
    },
    handleDynamicTool(call) {
      if (
        call.namespace ||
        (call.tool !== researchPlanTool &&
          call.tool !== researchReportTool &&
          call.tool !== researchStartReportTool)
      )
        return undefined;
      // A thread keeps its tools after Research is turned off.
      if (!call.conversation.research || !policyAllows())
        return textResult(researchOffInstructions, false);
      const turn = call.turn ?? runningTurn(call.conversation, call.turnId);
      if (!turn || turn.status !== "inProgress")
        return textResult("This research turn has ended.", false);
      try {
        if (call.tool === researchStartReportTool) {
          parseResearchStartReport(call.arguments);
          const research = stateOf(turn);
          if (!researchFinished(research)) {
            research.state = "writing";
            research.writingStartedAt ??= now();
            call.changed();
            publish(call.conversation, turn);
          }
          return textResult(
            "Write and cite the report now, then submit it with research_report.",
            true,
          );
        }
        return call.tool === researchPlanTool
          ? plan(call, turn)
          : report(call, turn);
      } catch (error) {
        if (error instanceof ResearchArgumentError)
          return textResult(error.message, false);
        throw error;
      }
    },
    onGatewaySignal(signal: GatewaySignalEvent, target: GatewaySignalContext) {
      if (signal.type !== "webSources") return;
      const conversation = target.conversation ?? target.parent;
      if (!conversation) return;
      const turn =
        (target.conversation ? target.turn : undefined) ??
        runningTurn(conversation);
      const research = turn?.research;
      if (!turn || !research || researchFinished(research)) return;
      const event = signal.event;
      const urls =
        event.kind === "search"
          ? event.sources.map((source) => source.url)
          : event.kind === "message"
            ? event.citations.map((citation) => citation.url)
            : event.urls;
      if (event.kind === "search") {
        const calls = seenSearches.get(turn) ?? new Set<string>();
        seenSearches.set(turn, calls);
        if (!calls.has(event.callId)) {
          calls.add(event.callId);
          research.searchCount = (research.searchCount ?? 0) + 1;
        }
        if (research.state === "starting" || research.state === "planning")
          research.state = "gathering";
      }
      countSources(turn, urls);
      publish(conversation, turn);
    },
    recordItem(item, conversation) {
      const turn = runningTurn(conversation);
      const research = turn?.research;
      if (!turn || !research || researchFinished(research)) return;
      if (
        item.tool === researchReportTool ||
        (item.type === "agentMessage" && item.phase === "final_answer")
      ) {
        research.state = "writing";
        research.writingStartedAt ??= now();
      } else if (research.state === "starting") research.state = "planning";
      publish(conversation, turn);
      return item;
    },
    onTurnCompleted(conversation, turn) {
      const research = turn.research;
      if (!research) return;
      countSources(turn);
      if (researchFinished(research)) {
        research.completedAt ??= now();
        return;
      }
      research.completedAt = now();
      if (turn.status !== "completed") {
        research.state = turn.status === "failed" ? "failed" : "interrupted";
        if (turn.status === "failed" && turn.error)
          research.error ??= "research_failed";
        return;
      }
      // No research_report (a thread without the tool, or the model skipped
      // it): the final reply is the report.
      const reply = turn.items
        .filter(
          (item) =>
            item.type === "agentMessage" &&
            typeof item.text === "string" &&
            item.text.trim(),
        )
        .at(-1)?.text;
      if (!reply || !policyAllows()) {
        research.state = reply ? "done" : "failed";
        return;
      }
      const title =
        reportHeading(reply) ?? research.title ?? conversation.title;
      try {
        const stored = deps.reports.write(conversation.id, turn.id, reply);
        research.report = { title, ...stored };
        research.reportSource = "reply";
        research.title ??= title;
      } catch (error) {
        console.error(
          "Research report could not be saved:",
          error instanceof Error ? error.message : String(error),
        );
      }
      research.state = "done";
    },
  };
}

export const id = z.string().min(1).max(500);
