import { redactUrl, clip } from "./cdp-support";
import type { CdpDriver } from "./cdp";
import type { ConsoleEntry } from "./cdp";

export function message(this: CdpDriver, method: string, params: any) {
  switch (method) {
    case "Runtime.consoleAPICalled": {
      const type = String(params?.type ?? "log");
      const level: ConsoleEntry["level"] =
        type === "error" || type === "assert"
          ? "error"
          : type === "warning"
            ? "warn"
            : type === "info" || type === "debug"
              ? type
              : "log";
      const text = (params?.args ?? [])
        .map((arg: any) =>
          arg?.value !== undefined
            ? typeof arg.value === "string"
              ? arg.value
              : JSON.stringify(arg.value)
            : String(arg?.description ?? arg?.type ?? ""),
        )
        .join(" ");
      // Electron's own advice to app developers, not the page's.
      if (text.startsWith("%cElectron Security Warning")) break;
      this.console.push({
        level,
        text: clip(text, 2000),
        source: "console-api",
        url: params?.stackTrace?.callFrames?.[0]?.url
          ? redactUrl(params.stackTrace.callFrames[0].url)
          : undefined,
        time: Date.now(),
      });
      break;
    }
    case "Runtime.exceptionThrown": {
      const details = params?.exceptionDetails;
      const text =
        details?.exception?.description ?? details?.text ?? "Uncaught error";
      this.console.push({
        level: "error",
        source: "javascript",
        text: clip(String(text), 2000),
        url: details?.url ? redactUrl(details.url) : undefined,
        time: Date.now(),
      });
      break;
    }
    case "Log.entryAdded": {
      const entry = params?.entry;
      const level: ConsoleEntry["level"] =
        entry?.level === "error"
          ? "error"
          : entry?.level === "warning"
            ? "warn"
            : entry?.level === "verbose"
              ? "debug"
              : "info";
      this.console.push({
        level,
        source: entry?.source,
        text: clip(String(entry?.text ?? ""), 2000),
        url: entry?.url ? redactUrl(entry.url) : undefined,
        time: Date.now(),
      });
      break;
    }
    case "Network.requestWillBeSent": {
      const request = params?.request;
      if (!request?.url || String(request.url).startsWith("data:")) break;
      this.network.push({
        id: String(params.requestId),
        method: String(request.method ?? "GET"),
        url: clip(redactUrl(String(request.url)), 2000),
        type: params.type ? String(params.type) : undefined,
        time: Date.now(),
      });
      break;
    }
    case "Network.responseReceived": {
      const entry = this.network.find(
        (e) => e.id === String(params?.requestId),
      );
      if (entry) {
        entry.status = Number(params?.response?.status) || undefined;
        entry.mimeType = params?.response?.mimeType
          ? String(params.response.mimeType)
          : undefined;
      }
      break;
    }
    case "Network.loadingFailed": {
      const entry = this.network.find(
        (e) => e.id === String(params?.requestId),
      );
      if (entry)
        entry.error = params?.canceled
          ? "canceled"
          : String(params?.errorText ?? "failed");
      break;
    }
    case "Page.javascriptDialogOpening": {
      const type = String(params?.type ?? "alert");
      if (type === "alert") {
        void this.send("Page.handleJavaScriptDialog", { accept: true }).catch(
          () => {},
        );
        break;
      }
      if (type !== "confirm" && type !== "prompt" && type !== "beforeunload")
        break;
      this.dialogOpen = true;
      this.hooks.dialogOpened?.({
        type,
        message: clip(String(params?.message ?? ""), 2000),
        url: String(params?.url ?? ""),
        ...(type === "prompt"
          ? { defaultPrompt: clip(String(params?.defaultPrompt ?? ""), 2000) }
          : {}),
      });
      break;
    }
    case "Page.javascriptDialogClosed":
      if (this.dialogOpen) {
        this.dialogOpen = false;
        this.hooks.dialogClosed?.();
      }
      break;
    case "Page.frameNavigated":
      this.revision++;
      if (!params?.frame?.parentId) {
        this.refs.clear();
        this.nodes.clear();
        this.nextRef = 1;
        this.hooks.navigated?.();
      }
      break;
    case "Overlay.inspectNodeRequested":
      if (this.pick) {
        const pick = this.pick;
        this.pick = undefined;
        pick.resolve(Number(params?.backendNodeId));
      }
      break;
  }
}

/** Answers the page's confirm, prompt or beforeunload dialog. */
export async function answerDialog(
  this: CdpDriver,
  accept: boolean,
  promptText?: string,
) {
  await this.ready();
  await this.send("Page.handleJavaScriptDialog", {
    accept,
    ...(promptText !== undefined ? { promptText } : {}),
  });
}

/** Waits (up to 5 seconds) until the document has been parsed, so a page still loading can be read. */
export async function waitForDocument(this: CdpDriver, timeoutMs = 5000) {
  await this.ready();
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const state = await this.send("Runtime.evaluate", {
      expression: "document.readyState",
      returnByValue: true,
    }).catch(() => undefined);
    if (state?.result?.value && state.result.value !== "loading") return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
