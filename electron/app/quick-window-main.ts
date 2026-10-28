/**
 * Quick Entry as the app runs it (quick-window.ts): the composer's window,
 * its IPC channels and the hand-over to the main window. A call is
 * answered only for the composer's own page, from its top frame, with
 * checked arguments.
 */
// The default import is read when the composer is first asked for, so
// tests can load this file under plain Node.
import electron from "electron";
import type { BrowserWindow, IpcMainEvent } from "electron";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  quickEntryChannels,
  quickEntryMaxLength,
} from "../../shared/quick-entry";
import type { AppEvent, Attachment } from "../../shared/types";
import type { QuickEntryImage } from "../../shared/quick-entry";
import { extraPagePreferences, loadExtraPage } from "../extra-pages";
import { QuickWindow, type QuickBrowserWindow } from "./quick-window";
import type { QuickEntryBridge } from "../../shared/quick-entry";

export const quickVoiceMethods = [
  "requestMicrophone",
  "startDictation",
  "dictationAudio",
  "finishDictation",
  "cancelDictation",
] as const;

const positionFile = z.object({
  x: z.number().int().min(-100000).max(100000),
  y: z.number().int().min(-100000).max(100000),
});
const textArgument = z.string().max(quickEntryMaxLength);
const heightArgument = z.number().finite().min(0).max(10000);

/**
 * The composer, created on first use. `main` is the main window while it
 * is open; `showMain` brings it forward and returns it; `send` delivers an
 * event to it.
 */
export function quickWindowFor(options: {
  dirname: string;
  main: () => BrowserWindow | undefined;
  showMain: () => BrowserWindow | undefined;
  send: (win: BrowserWindow, event: AppEvent) => void;
  attach?: (images: QuickEntryImage[]) => Attachment[];
  voice?: (
    method: keyof NonNullable<QuickEntryBridge["voice"]>,
    ...args: unknown[]
  ) => Promise<unknown>;
}) {
  const { app, BrowserWindow, ipcMain, screen } = electron;
  /** Where the position is kept between runs (the composer is not per account). */
  const positionPath = () =>
    path.join(app.getPath("userData"), "quick-entry-position.json");
  const quick = new QuickWindow({
    createWindow: (bounds) => {
      const mac = process.platform === "darwin";
      const win = new BrowserWindow({
        ...bounds,
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: "#00000000",
        hasShadow: true,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        // A panel floats over full-screen apps without taking the Dock.
        ...(mac
          ? { type: "panel" as const, hiddenInMissionControl: true }
          : {}),
        webPreferences: extraPagePreferences(
          options.dirname,
          "quick-preload.cjs",
        ),
      });
      win.setAlwaysOnTop(true, "pop-up-menu");
      void loadExtraPage(win.webContents, "quick.html", options.dirname).catch(
        (error: unknown) =>
          console.error(
            "Quick Entry could not load:",
            error instanceof Error ? error.message : String(error),
          ),
      );
      // The main window closing quits the app; the hidden composer must not
      // keep it running.
      options.main()?.once("closed", () => quick.destroy());
      return win as unknown as QuickBrowserWindow;
    },
    workArea: (point) =>
      (point
        ? screen.getDisplayNearestPoint(point)
        : screen.getPrimaryDisplay()
      ).workArea,
    loadPosition: () => {
      try {
        const parsed = positionFile.safeParse(
          JSON.parse(fs.readFileSync(positionPath(), "utf8")),
        );
        return parsed.success ? parsed.data : undefined;
      } catch {
        return undefined;
      }
    },
    savePosition: (position) => {
      try {
        fs.writeFileSync(positionPath(), JSON.stringify(position), {
          mode: 0o600,
        });
      } catch (error) {
        console.error(
          "Quick Entry position could not be saved:",
          error instanceof Error ? error.message : error,
        );
      }
    },
    deliver: (text, attachments) => {
      const main = options.showMain();
      if (main)
        options.send(main, {
          type: "quick-entry",
          text,
          ...(attachments?.length ? { attachments } : {}),
        });
    },
  });
  /** The composer's own page, from its top frame. */
  const trusted = (event: Pick<IpcMainEvent, "sender" | "senderFrame">) =>
    event.senderFrame === event.sender.mainFrame && quick.owns(event.sender);
  ipcMain.on(quickEntryChannels.ready, (event) => {
    if (trusted(event)) quick.rendererLoaded(event.sender);
  });
  ipcMain.handle(
    quickEntryChannels.voice,
    (event, method: unknown, ...args: unknown[]) => {
      if (
        !trusted(event) ||
        !options.voice ||
        !quickVoiceMethods.includes(
          method as (typeof quickVoiceMethods)[number],
        )
      )
        throw Error("This computer can't do that.");
      return options.voice(
        method as (typeof quickVoiceMethods)[number],
        ...args,
      );
    },
  );
  if (options.attach)
    ipcMain.handle(
      quickEntryChannels.submitImages,
      (event, text: unknown, images: unknown) => {
        if (!trusted(event)) throw Error("This file can't be attached.");
        const prompt = textArgument.parse(text);
        const files = z
          .array(
            z
              .object({
                name: z
                  .string()
                  .min(1)
                  .max(500)
                  .regex(/\.(png|jpe?g|gif|webp)$/i),
                data: z
                  .instanceof(Uint8Array)
                  .refine(
                    (data) =>
                      data.byteLength > 0 &&
                      data.byteLength <= 30 * 1024 * 1024,
                  ),
              })
              .strict(),
          )
          .min(1)
          .max(10)
          .parse(images);
        if (
          files.reduce((bytes, file) => bytes + file.data.byteLength, 0) >
          30 * 1024 * 1024
        )
          throw Error("This file can't be attached.");
        quick.submit(event.sender, prompt, options.attach!(files));
      },
    );
  ipcMain.on(quickEntryChannels.submit, (event, text: unknown) => {
    const parsed = textArgument.safeParse(text);
    if (trusted(event) && parsed.success)
      quick.submit(event.sender, parsed.data);
  });
  ipcMain.on(quickEntryChannels.dismiss, (event) => {
    if (trusted(event)) quick.dismiss(event.sender);
  });
  ipcMain.on(quickEntryChannels.resize, (event, height: unknown) => {
    const parsed = heightArgument.safeParse(height);
    if (trusted(event) && parsed.success)
      quick.resize(event.sender, parsed.data);
  });
  return quick;
}
