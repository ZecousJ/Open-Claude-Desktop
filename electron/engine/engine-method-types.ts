/**
 * The Engine methods that live in modules of their own (engine.ts installs
 * them on the prototype): their types, merged into the class.
 */
import type * as engineAgents from "./engine-agents";
import type * as engineApprovals from "./engine-approvals";
import type * as engineEvents from "./engine-events";
import type * as engineGuards from "./engine-guards";
import type * as engineHandoff from "./engine-handoff";
import type * as engineHistory from "./engine-history";
import type * as engineLifecycle from "./engine-lifecycle";
import type * as engineSend from "./engine-send";
import type * as engineTrust from "./engine-trust";
import type * as engineTurnSetup from "./engine-turn-setup";

import type * as engineStatus from "./engine-status";

declare module "./engine" {
  interface Engine {
    runningThread(
      ...args: Parameters<typeof engineStatus.runningThread>
    ): ReturnType<typeof engineStatus.runningThread>;
    xSearchAllowed(
      ...args: Parameters<typeof engineStatus.xSearchAllowed>
    ): ReturnType<typeof engineStatus.xSearchAllowed>;
    requestOptions(
      ...args: Parameters<typeof engineStatus.requestOptions>
    ): ReturnType<typeof engineStatus.requestOptions>;
    syncRequestOptions(
      ...args: Parameters<typeof engineStatus.syncRequestOptions>
    ): ReturnType<typeof engineStatus.syncRequestOptions>;
    changed(
      ...args: Parameters<typeof engineStatus.changed>
    ): ReturnType<typeof engineStatus.changed>;
    isBusy(
      ...args: Parameters<typeof engineStatus.isBusy>
    ): ReturnType<typeof engineStatus.isBusy>;
    ownBusy(
      ...args: Parameters<typeof engineStatus.ownBusy>
    ): ReturnType<typeof engineStatus.ownBusy>;
    gatewayEndpoint(
      ...args: Parameters<typeof engineStatus.gatewayEndpoint>
    ): ReturnType<typeof engineStatus.gatewayEndpoint>;
    assertMcpAvailable(
      ...args: Parameters<typeof engineStatus.assertMcpAvailable>
    ): ReturnType<typeof engineStatus.assertMcpAvailable>;
    quiesceMcp(
      ...args: Parameters<typeof engineStatus.quiesceMcp>
    ): ReturnType<typeof engineStatus.quiesceMcp>;
    clearApprovals(
      ...args: Parameters<typeof engineStatus.clearApprovals>
    ): ReturnType<typeof engineStatus.clearApprovals>;
    refusalText(
      ...args: Parameters<typeof engineStatus.refusalText>
    ): ReturnType<typeof engineStatus.refusalText>;
    updateProviderKey(
      ...args: Parameters<typeof engineGuards.updateProviderKey>
    ): ReturnType<typeof engineGuards.updateProviderKey>;
    assertSendable(
      ...args: Parameters<typeof engineGuards.assertSendable>
    ): ReturnType<typeof engineGuards.assertSendable>;
    assertExtensions(
      ...args: Parameters<typeof engineGuards.assertExtensions>
    ): ReturnType<typeof engineGuards.assertExtensions>;
    assertModel(
      ...args: Parameters<typeof engineGuards.assertModel>
    ): ReturnType<typeof engineGuards.assertModel>;
    assertPolicy(
      ...args: Parameters<typeof engineGuards.assertPolicy>
    ): ReturnType<typeof engineGuards.assertPolicy>;
    assertIdle(
      ...args: Parameters<typeof engineGuards.assertIdle>
    ): ReturnType<typeof engineGuards.assertIdle>;
    remoteCwdOf(
      ...args: Parameters<typeof engineGuards.remoteCwdOf>
    ): ReturnType<typeof engineGuards.remoteCwdOf>;
    remoteCwd(
      ...args: Parameters<typeof engineGuards.remoteCwd>
    ): ReturnType<typeof engineGuards.remoteCwd>;
    sendCwd(
      ...args: Parameters<typeof engineGuards.sendCwd>
    ): ReturnType<typeof engineGuards.sendCwd>;
    elsewhere(
      ...args: Parameters<typeof engineAgents.elsewhere>
    ): ReturnType<typeof engineAgents.elsewhere>;
    elsewhereFor(
      ...args: Parameters<typeof engineAgents.elsewhereFor>
    ): ReturnType<typeof engineAgents.elsewhereFor>;
    indexAgentRoutes(
      ...args: Parameters<typeof engineAgents.indexAgentRoutes>
    ): ReturnType<typeof engineAgents.indexAgentRoutes>;
    parentForAgent(
      ...args: Parameters<typeof engineAgents.parentForAgent>
    ): ReturnType<typeof engineAgents.parentForAgent>;
    captureAgentPrompt(
      ...args: Parameters<typeof engineAgents.captureAgentPrompt>
    ): ReturnType<typeof engineAgents.captureAgentPrompt>;
    attachPendingPrompt(
      ...args: Parameters<typeof engineAgents.attachPendingPrompt>
    ): ReturnType<typeof engineAgents.attachPendingPrompt>;
    signalTarget(
      ...args: Parameters<typeof engineAgents.signalTarget>
    ): ReturnType<typeof engineAgents.signalTarget>;
    patchItem(
      ...args: Parameters<typeof engineAgents.patchItem>
    ): ReturnType<typeof engineAgents.patchItem>;
    writeCodexProjects(
      ...args: Parameters<typeof engineTrust.writeCodexProjects>
    ): ReturnType<typeof engineTrust.writeCodexProjects>;
    trustCodexProject(
      ...args: Parameters<typeof engineTrust.trustCodexProject>
    ): ReturnType<typeof engineTrust.trustCodexProject>;
    remoteWorkspaceTrust(
      ...args: Parameters<typeof engineTrust.remoteWorkspaceTrust>
    ): ReturnType<typeof engineTrust.remoteWorkspaceTrust>;
    trustRemoteWorkspace(
      ...args: Parameters<typeof engineTrust.trustRemoteWorkspace>
    ): ReturnType<typeof engineTrust.trustRemoteWorkspace>;
    assertRemoteTrust(
      ...args: Parameters<typeof engineTrust.assertRemoteTrust>
    ): ReturnType<typeof engineTrust.assertRemoteTrust>;
    resolveCodeNewTask: OmitThisParameter<
      typeof engineHandoff.resolveCodeNewTask
    >;
    handOffConversation: OmitThisParameter<
      typeof engineHandoff.handOffConversation
    >;
    writeHandOffNote: OmitThisParameter<typeof engineHandoff.writeHandOffNote>;
    handOffNote: OmitThisParameter<typeof engineHandoff.handOffNote>;
    startWorkflowAgent: OmitThisParameter<
      typeof engineHandoff.startWorkflowAgent
    >;
    interruptWorkflowAgent: OmitThisParameter<
      typeof engineHandoff.interruptWorkflowAgent
    >;
    releaseWorkflowAgent: OmitThisParameter<
      typeof engineHandoff.releaseWorkflowAgent
    >;
    askSideChat: OmitThisParameter<typeof engineHandoff.askSideChat>;
    interruptSideChat: OmitThisParameter<
      typeof engineHandoff.interruptSideChat
    >;
    endSideChat: OmitThisParameter<typeof engineHandoff.endSideChat>;
    steerTurn: OmitThisParameter<typeof engineHandoff.steerTurn>;
    interrupt: OmitThisParameter<typeof engineHandoff.interrupt>;
    releaseRunner: OmitThisParameter<typeof engineHandoff.releaseRunner>;
    compactConversation: OmitThisParameter<
      typeof engineHistory.compactConversation
    >;
    runShellCommand: OmitThisParameter<typeof engineHistory.runShellCommand>;
    startReview: OmitThisParameter<typeof engineHistory.startReview>;
    rewindConversation: OmitThisParameter<
      typeof engineHistory.rewindConversation
    >;
    swapRewind: OmitThisParameter<typeof engineHistory.swapRewind>;
    forkConversation: OmitThisParameter<typeof engineHistory.forkConversation>;
    request: OmitThisParameter<typeof engineApprovals.request>;
    offeredParams: OmitThisParameter<typeof engineApprovals.offeredParams>;
    sshToolApproval: OmitThisParameter<typeof engineApprovals.sshToolApproval>;
    rememberToolApproval: OmitThisParameter<
      typeof engineApprovals.rememberToolApproval
    >;
    answerDynamicTool: OmitThisParameter<
      typeof engineApprovals.answerDynamicTool
    >;
    requestAppApproval: OmitThisParameter<
      typeof engineApprovals.requestAppApproval
    >;
    approve: OmitThisParameter<typeof engineApprovals.approve>;
    forward: OmitThisParameter<typeof engineApprovals.forward>;
    notification: OmitThisParameter<typeof engineEvents.notification>;
    retrySafeguard: OmitThisParameter<typeof engineEvents.retrySafeguard>;
    applyChildUsage: OmitThisParameter<typeof engineEvents.applyChildUsage>;
    applyTurnEvent: OmitThisParameter<typeof engineEvents.applyTurnEvent>;
    applyItemEvent: OmitThisParameter<typeof engineEvents.applyItemEvent>;
    recordOutputFiles: OmitThisParameter<typeof engineEvents.recordOutputFiles>;
    recordSteer: OmitThisParameter<typeof engineEvents.recordSteer>;
    send: OmitThisParameter<typeof engineSend.send>;
    fetchForSetup: OmitThisParameter<typeof engineSend.fetchForSetup>;
    retryResponse: OmitThisParameter<typeof engineSend.retryResponse>;
    discardTurn: OmitThisParameter<typeof engineSend.discardTurn>;
    editPrompt: OmitThisParameter<typeof engineSend.editPrompt>;
    selectPromptVersion: OmitThisParameter<
      typeof engineSend.selectPromptVersion
    >;
    selectReplyVersion: OmitThisParameter<typeof engineSend.selectReplyVersion>;
    queue: OmitThisParameter<typeof engineTurnSetup.queue>;
    canQueue: OmitThisParameter<typeof engineTurnSetup.canQueue>;
    deliverOutbox: OmitThisParameter<typeof engineTurnSetup.deliverOutbox>;
    deliver: OmitThisParameter<typeof engineTurnSetup.deliver>;
    branchFrom: OmitThisParameter<typeof engineTurnSetup.branchFrom>;
    assertIncognitoLive: OmitThisParameter<
      typeof engineTurnSetup.assertIncognitoLive
    >;
    dropWebSearch: OmitThisParameter<typeof engineTurnSetup.dropWebSearch>;
    ensureThread: OmitThisParameter<typeof engineTurnSetup.ensureThread>;
    threadOptions: OmitThisParameter<typeof engineTurnSetup.threadOptions>;
    turnContext: OmitThisParameter<typeof engineTurnSetup.turnContext>;
    turnExtras: OmitThisParameter<typeof engineTurnSetup.turnExtras>;
    contextConfig: OmitThisParameter<typeof engineTurnSetup.contextConfig>;
    ensure: OmitThisParameter<typeof engineLifecycle.ensure>;
    rememberMcpSecrets: OmitThisParameter<
      typeof engineLifecycle.rememberMcpSecrets
    >;
    safeMcpError: OmitThisParameter<typeof engineLifecycle.safeMcpError>;
    mcpConfig: OmitThisParameter<typeof engineLifecycle.mcpConfig>;
    runtimeKey: OmitThisParameter<typeof engineLifecycle.runtimeKey>;
    start: OmitThisParameter<typeof engineLifecycle.start>;
    stop: OmitThisParameter<typeof engineLifecycle.stop>;
    setupWindowsSandbox: OmitThisParameter<
      typeof engineLifecycle.setupWindowsSandbox
    >;
    sandboxSetupFolder: OmitThisParameter<
      typeof engineLifecycle.sandboxSetupFolder
    >;
  }
}
