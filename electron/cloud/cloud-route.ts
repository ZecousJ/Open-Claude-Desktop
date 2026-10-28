import type { Conversation, Project } from "../../shared/types";
import { createGitHubMethods } from "../../shared/web-client/github";
import { githubRoutes } from "../../shared/github-api";
import { cloudEnvironmentsMethods } from "../../shared/cloud-environments-api";
import { statusOf } from "../../shared/web-client/errors";
import { devicePaths } from "../../shared/remote-devices";
import { serviceData } from "./cloud-router-support";
import { githubConnectionCalls } from "./cloud-router-support";
import { conversationCalls } from "./cloud-router-support";
import { scopeCalls } from "./cloud-router-support";
import { projectCalls } from "./cloud-router-support";
import { eitherSideReads } from "./cloud-router-support";
import { cloudSideApproval } from "./cloud-router-support";
import type { CloudRouter } from "./cloud-router";
import type { Handler } from "./cloud-router";

/** The handler main.ts registers for `name`, in front of the local one. */
export function route(
  this: CloudRouter,
  name: string,
  local: Handler,
): Handler {
  if (name === "chatDevices" || name === "setChatDevice")
    return (...args) => this.cloud(name, args);
  if (name === "sendOnChatDevice")
    return async (input) => {
      const client = this.client();
      const attachments = await this.cloudAttachments(input.attachments ?? []);
      if (this.deps.client() !== client)
        throw new Error("The signed-in account changed. Try again.");
      return this.cloud(name, [{ ...input, attachments }]);
    };
  if (name === "deleteStoredCodeSessions")
    return async () => {
      const client = this.deps.client();
      if (!client) throw new Error("Sign in to Claudex again.");
      return client.call(name, []);
    };
  if (name === "listCoworkDevices")
    return async () => {
      const client = this.deps.client();
      if (!client?.json) return local();
      const body = (await client.json(
        `${devicePaths.list}?includeOffline=1`,
      )) as { value?: unknown };
      return body && "value" in body ? body.value : serviceData(body);
    };
  const routine = this.routines.route(name, local);
  if (routine) return routine;
  if (name === "linkCoworkTaskToComputer")
    return async (id: string) => {
      const client = this.deps.client();
      if (!client)
        throw new Error(
          "Sign in to Claudex again on this computer, then link this task.",
        );
      let payload;
      this.deps.claims?.add(id);
      try {
        payload = await client.call("exportCoworkTask", [
          id,
          this.deps.device?.(),
        ]);
      } catch (error) {
        this.deps.claims?.remove(id);
        if (statusOf(error) === 401)
          throw new Error(
            "Sign in to Claudex again on this computer, then link this task.",
          );
        if (error instanceof TypeError)
          throw new Error(
            "Couldn’t connect. Check your internet connection, then try again.",
          );
        throw error;
      }
      let conversation;
      try {
        conversation = await local(id, payload);
      } catch (error) {
        await client.call("releaseCoworkTask", [id]);
        this.deps.claims?.remove(id);
        throw error;
      }
      this.deps.claims?.remove(id);
      this.localTasks.add(id);
      this.deps.push({ type: "conversation", conversation });
      return conversation;
    };
  if (name === "snapshot")
    return async (...args) => this.merge(await local(...args));
  if (name === "send") return (input) => this.send(input, local);
  if (name === "createBlankArtifact")
    return async (input) => {
      const client = this.deps.client();
      if (!client) return local(input);
      const scope = this.snapshotGeneration;
      const result = (await client.call(name, [input])) as {
        conversation?: Conversation;
      };
      if (scope !== this.snapshotGeneration || client !== this.deps.client())
        throw new Error("This account changed. Open the artifact again.");
      if (result.conversation) {
        this.conversations.add(result.conversation.id);
        this.blankConversations.add(result.conversation.id);
      }
      return result;
    };
  if (name === "approve")
    return (id, ...rest) => {
      const raw = cloudSideApproval(id);
      return raw === undefined
        ? local(id, ...rest)
        : this.cloud("approve", [raw, ...rest]);
    };
  if (name === "steerTurn")
    return async (conversationId, text, attachmentIds, ...rest) =>
      this.isCloudConversation(conversationId)
        ? this.cloud("steerTurn", [
            conversationId,
            text,
            await this.cloudAttachmentIds(attachmentIds),
            ...rest,
          ])
        : local(conversationId, text, attachmentIds, ...rest);
  if (name === "reorderConversations")
    return (input: { sourceId?: string; targetId?: string }) => {
      const cloud = this.isCloudConversation(input?.sourceId);
      // A target on the other side is not in the list being reordered.
      const target =
        input?.targetId && this.isCloudConversation(input.targetId) === cloud
          ? input.targetId
          : undefined;
      const next = { ...input, targetId: target };
      return cloud ? this.cloud(name, [next]) : local(next);
    };
  if (name === "submitReplyFeedback")
    return (report: { conversationId?: string }, ...rest) =>
      this.isCloudConversation(report?.conversationId)
        ? this.cloud(name, [report, ...rest])
        : local(report, ...rest);
  if (name === "saveProject")
    return (project: Project, ...rest) =>
      this.inCloudProject(project)
        ? this.cloud(name, [project, ...rest])
        : local(project, ...rest);
  if (conversationCalls.has(name))
    return (id, ...rest) =>
      this.isCloudConversation(id)
        ? this.cloud(name, [id, ...rest])
        : local(id, ...rest);
  if (scopeCalls.has(name))
    return (scope: { conversationId?: string }, ...rest) =>
      this.isCloudConversation(scope?.conversationId)
        ? this.cloud(name, [scope, ...rest])
        : local(scope, ...rest);
  if (projectCalls.has(name))
    return (id, ...rest) =>
      this.isCloudProject(id)
        ? this.cloud(name, [id, ...rest])
        : local(id, ...rest);
  // Continue in cloud: only with the cloud on; the upload's credential is
  // the service's lease for the one repository (shared/git-lease.ts).
  if (name === "cloudContinuationPlan")
    return (...args) =>
      this.deps.client()?.json
        ? local(...args)
        : { kind: "unsupported", reason: "signedOut" };
  if (name === "uploadWorkForCloud")
    return (conversationId, options) => {
      const client = this.deps.client();
      if (!client?.json)
        throw new Error(
          "Sign in to Claudex and turn on sync with the web, then try again.",
        );
      const json = client.json.bind(client);
      return local(conversationId, options ?? {}, (repository: string) =>
        json(githubRoutes.pushGrant, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repository }),
        }).then(serviceData),
      );
    };
  if ((cloudEnvironmentsMethods as readonly string[]).includes(name))
    return (...args) => {
      const client = this.deps.client();
      return client ? client.call(name, args) : local(...args);
    };
  if (githubConnectionCalls.has(name))
    return (...args) => {
      const client = this.deps.client();
      if (!client?.json) return local(...args);
      const json = client.json.bind(client);
      const methods = createGitHubMethods({ json }) as Record<string, Handler>;
      return methods[name](...args);
    };
  if (eitherSideReads.has(name))
    return async (...args) => {
      let value: unknown;
      let failure: unknown;
      try {
        value = await local(...args);
      } catch (error) {
        failure = error;
      }
      if (value !== null && value !== undefined) return value;
      const client = this.deps.client();
      if (!client) {
        if (failure) throw failure;
        return value;
      }
      try {
        return await client.call(name, args);
      } catch (error) {
        throw failure ?? error;
      }
    };
  return local;
}
