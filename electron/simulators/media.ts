/**
 * What the pane's control bar and menus do besides touch input:
 *
 * - Save screenshot: a PNG of the screen on the Desktop, named as the
 *   original names it, with a small picture for the corner thumbnail.
 * - Record video (iOS): `simctl io recordVideo` into a private folder, moved
 *   to the Desktop when it stops ("Simulator Recording - … .mp4").
 * - A saved capture's menu: Show in Finder and Delete, only for files this
 *   app saved and that are unchanged since.
 * - Device → Appearance (iOS) and Edit → Get / Send clipboard (iOS).
 * - Show logs: one log stream per device while the drawer reads it.
 */
import { constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  canRecord,
  captureBaseName,
  captureThumbnailEdge,
  clipboardTextLimit,
  type ClipboardDirection,
  type SimulatorAnnotateCapture,
  type SimulatorAppearance,
  type SimulatorCapture,
  type SimulatorKind,
  type SimulatorLogBatch,
} from "../../shared/simulators";
import { SimulatorError, type DeviceDriver, type InputSpace } from "./driver";
import { LogCapture } from "./logs";
import { pngSize, type ImageScaler, type ScaledImage } from "./png";
import { within, type Runner, type RunningProcess } from "./runner";
import { fitWithin } from "./service-support";

/** The files a capture touches. */
export interface CaptureFiles {
  /** Where captures are saved (the Desktop). */
  folder(): string;
  /** A new private folder for a recording in progress. */
  stagingFolder(): Promise<string>;
}

export interface MediaDeps {
  /** The driver for a device the pane names (checks the id). */
  driver(kind: SimulatorKind, id: string): DeviceDriver;
  deviceName(kind: SimulatorKind, id: string): Promise<string>;
  runner: Runner;
  scaler: ImageScaler;
  files: CaptureFiles;
  clipboard: {
    read(): string | Promise<string>;
    write(text: string): void | Promise<void>;
  };
  /** A picture of a file (a recording's first frame); undefined when there is none. */
  thumbnail?(file: string, size: InputSpace): Promise<ScaledImage | undefined>;
  /** Shows a file in Finder (Explorer on Windows). */
  reveal(file: string): void;
  now(): number;
}

interface Recording {
  process: RunningProcess;
  file: string;
  folder: string;
  base: string;
  /** Set when the recorder stopped by itself. */
  failed?: string;
}

/** How long a recording may take to finish its file. */
export const recordingFinishMs = 15_000;
/** A log stream nobody read for this long is stopped. */
export const logIdleMs = 30_000;
/** Names tried before giving up ("… 2.png" to "… 100.png"). */
const nameAttempts = 100;

const dataUrl = (image: ScaledImage) =>
  `data:${image.mimeType};base64,${image.data.toString("base64")}`;

/** `base.ext`, else `base 2.ext`, `base 3.ext`…: the first name that isn't taken. */
async function claimName(
  folder: string,
  base: string,
  extension: string,
  write: (file: string) => Promise<void>,
) {
  for (let attempt = 0; attempt < nameAttempts; attempt++) {
    const file = path.join(
      folder,
      attempt === 0
        ? `${base}${extension}`
        : `${base} ${attempt + 1}${extension}`,
    );
    try {
      await write(file);
      return file;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new SimulatorError("Couldn’t find a free file name on the Desktop.");
}

/** Moves a file to a name that must not exist yet (copies across disks). */
async function moveExclusive(from: string, to: string) {
  try {
    await fs.link(from, to);
    await fs.unlink(from).catch(() => undefined);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw error;
  }
  await fs.copyFile(from, to, constants.COPYFILE_EXCL);
  await fs.unlink(from).catch(() => undefined);
}

export class SimulatorMedia {
  private recordings = new Map<string, Recording>();
  private logs = new Map<string, LogCapture>();
  private nextCapture = 1;
  /** What this app saved: path → kind and size, for the capture menu. */
  private saved = new Map<
    string,
    { kind: SimulatorCapture["kind"]; size: number }
  >();
  private sweeper?: ReturnType<typeof setInterval>;
  constructor(private deps: MediaDeps) {}

  // -- Save screenshot -------------------------------------------------------

  async saveScreenshot(
    kind: SimulatorKind,
    id: string,
  ): Promise<SimulatorCapture> {
    const driver = this.deps.driver(kind, id);
    const png = await driver.screenshot(id);
    const size = pngSize(png);
    if (!size) throw new SimulatorError("The screenshot couldn’t be read.");
    const base = captureBaseName(
      "Simulator Screenshot",
      await this.deps.deviceName(kind, id),
      new Date(this.deps.now()),
    );
    const file = await claimName(
      this.deps.files.folder(),
      base,
      ".png",
      (target) => fs.writeFile(target, png, { flag: "wx" }),
    );
    this.saved.set(file, { kind: "screenshot", size: png.length });
    let thumbnail: SimulatorCapture["thumbnail"];
    try {
      const picture = this.deps.scaler(
        png,
        fitWithin(size, captureThumbnailEdge),
      );
      thumbnail = {
        dataUrl: dataUrl(picture),
        width: picture.width,
        height: picture.height,
      };
    } catch {
      thumbnail = undefined;
    }
    return { kind: "screenshot", path: file, thumbnail };
  }

  /**
   * Annotate: the screen as a full-size PNG for the editor. Nothing goes to
   * the Desktop; the annotated picture is attached under the name a saved
   * screenshot would get.
   */
  async captureScreenshot(
    kind: SimulatorKind,
    id: string,
  ): Promise<SimulatorAnnotateCapture> {
    const png = await this.deps.driver(kind, id).screenshot(id);
    const size = pngSize(png);
    if (!size) throw new SimulatorError("The screenshot couldn’t be read.");
    return {
      dataUrl: `data:image/png;base64,${png.toString("base64")}`,
      width: size.width,
      height: size.height,
      name: captureBaseName(
        "Simulator Screenshot",
        await this.deps.deviceName(kind, id),
        new Date(this.deps.now()),
      ),
    };
  }

  // -- Record video ----------------------------------------------------------

  async startRecording(kind: SimulatorKind, id: string) {
    const driver = this.deps.driver(kind, id);
    if (!canRecord(kind) || !driver.record)
      throw new SimulatorError("This device can’t be recorded.");
    const key = `${kind}:${id}`;
    if (this.recordings.has(key))
      throw new SimulatorError("This device is already being recorded.");
    const base = captureBaseName(
      "Simulator Recording",
      await this.deps.deviceName(kind, id),
      new Date(this.deps.now()),
    );
    const folder = await this.deps.files.stagingFolder();
    const file = path.join(folder, "recording.mp4");
    let process: RunningProcess;
    try {
      process = await driver.record(id, file);
    } catch (error) {
      await fs
        .rm(folder, { recursive: true, force: true })
        .catch(() => undefined);
      throw error;
    }
    const recording: Recording = { process, file, folder, base };
    this.recordings.set(key, recording);
    void process.exited.then(({ code }) => {
      if (this.recordings.get(key) === recording && !recording.failed)
        recording.failed = `The recorder stopped by itself${code === null ? "" : ` (exit ${code})`}.`;
    });
  }

  isRecording(kind: SimulatorKind, id: string) {
    return this.recordings.has(`${kind}:${id}`);
  }

  async stopRecording(
    kind: SimulatorKind,
    id: string,
  ): Promise<SimulatorCapture> {
    const key = `${kind}:${id}`;
    const recording = this.recordings.get(key);
    if (!recording) throw new SimulatorError("No recording in progress.");
    this.recordings.delete(key);
    const { process, file, folder, base } = recording;
    process.kill("SIGINT");
    const finished = await within(
      process.exited.then(() => true),
      recordingFinishMs,
      false,
    );
    if (!finished) {
      process.kill("SIGKILL");
      await fs
        .rm(folder, { recursive: true, force: true })
        .catch(() => undefined);
      throw new SimulatorError("Couldn’t save the recording. Try again.");
    }
    const size = await fs
      .stat(file)
      .then((stat) => stat.size)
      .catch(() => 0);
    if (!size) {
      await fs
        .rm(folder, { recursive: true, force: true })
        .catch(() => undefined);
      throw new SimulatorError(
        recording.failed
          ? `Couldn’t save the recording. ${recording.failed}`
          : "Couldn’t save the recording. Try again.",
      );
    }
    let saved: string;
    let kept = false;
    try {
      saved = await claimName(
        this.deps.files.folder(),
        base,
        ".mp4",
        (target) => moveExclusive(file, target),
      );
      await fs
        .rm(folder, { recursive: true, force: true })
        .catch(() => undefined);
    } catch {
      saved = file;
      kept = true;
    }
    this.saved.set(saved, { kind: "recording", size });
    let thumbnail: SimulatorCapture["thumbnail"];
    try {
      const picture = await this.deps.thumbnail?.(saved, {
        width: captureThumbnailEdge,
        height: captureThumbnailEdge,
      });
      if (picture)
        thumbnail = {
          dataUrl: dataUrl(picture),
          width: picture.width,
          height: picture.height,
        };
    } catch {
      thumbnail = undefined;
    }
    return {
      kind: "recording",
      path: saved,
      thumbnail,
      ...(kept ? { kept } : {}),
    };
  }

  // -- A saved capture's menu ------------------------------------------------

  /** The saved capture at `file`, unchanged since it was saved; else an error. */
  async savedCapture(file: string) {
    const known = this.saved.get(file);
    if (!known) throw new SimulatorError("That file wasn’t saved here.");
    const stat = await fs.lstat(file).catch(() => undefined);
    if (!stat?.isFile() || stat.size !== known.size)
      throw new SimulatorError("The file has changed or is gone.");
    return known;
  }

  async captureAction(file: string, action: "reveal" | "delete") {
    try {
      await this.savedCapture(file);
    } catch {
      return false;
    }
    if (action === "reveal") {
      this.deps.reveal(file);
      return true;
    }
    try {
      await fs.unlink(file);
      this.saved.delete(file);
      return true;
    } catch {
      return false;
    }
  }

  // -- Device and Edit menus -------------------------------------------------

  async appearance(
    kind: SimulatorKind,
    id: string,
    set?: SimulatorAppearance,
  ): Promise<SimulatorAppearance | null> {
    const driver = this.deps.driver(kind, id);
    if (!driver.appearance) return null;
    return driver.appearance(id, set);
  }

  /** Device → Show on-screen keyboard (Android); null where it can't be read. */
  async softwareKeyboard(kind: SimulatorKind, id: string, show?: boolean) {
    const driver = this.deps.driver(kind, id);
    if (!driver.softwareKeyboard) return null;
    return driver.softwareKeyboard(id, show);
  }

  /** A foldable's hinge angle in degrees; null where there is none. */
  async hinge(kind: SimulatorKind, id: string, degrees?: number) {
    const driver = this.deps.driver(kind, id);
    if (!driver.hinge) return null;
    return driver.hinge(id, degrees);
  }

  /** Device → Slow animations (Android); null where it can't be read. */
  async slowAnimations(kind: SimulatorKind, id: string, on?: boolean) {
    const driver = this.deps.driver(kind, id);
    if (!driver.slowAnimations) return null;
    return driver.slowAnimations(id, on);
  }

  async clipboard(
    kind: SimulatorKind,
    id: string,
    direction: ClipboardDirection,
  ) {
    const driver = this.deps.driver(kind, id);
    if (!driver.readPasteboard || !driver.writePasteboard)
      throw new SimulatorError("This device has no clipboard to share.");
    if (direction === "get") {
      const text = await driver.readPasteboard(id);
      if (text.length > clipboardTextLimit)
        throw new SimulatorError("The device’s clipboard holds too much text.");
      if (text) await this.deps.clipboard.write(text);
      return text.length;
    }
    const text = await this.deps.clipboard.read();
    if (!text) return 0;
    if (text.length > clipboardTextLimit)
      throw new SimulatorError("The clipboard holds too much text.");
    await driver.writePasteboard(id, text);
    return text.length;
  }

  // -- Show logs -------------------------------------------------------------

  async readLogs(
    kind: SimulatorKind,
    id: string,
    since: number,
  ): Promise<SimulatorLogBatch> {
    const driver = this.deps.driver(kind, id);
    const key = `${kind}:${id}`;
    let capture = this.logs.get(key);
    // Opening the drawer again restarts a stream that ended.
    if (capture?.ended !== undefined && since === 0) {
      capture.stop();
      this.logs.delete(key);
      capture = undefined;
    }
    if (!capture) {
      if (!driver.logStream)
        throw new SimulatorError("This device’s log can’t be read.");
      const stream = await driver.logStream(id);
      capture = new LogCapture(
        this.nextCapture++,
        this.deps.runner.start(stream.file, stream.args),
        stream.parse,
        this.deps.now,
      );
      this.logs.set(key, capture);
      this.sweep();
    }
    const entries = capture.read(since);
    return {
      entries,
      captureId: capture.id,
      ...(capture.ended !== undefined ? { ended: capture.ended } : {}),
    };
  }

  stopLogs(kind: SimulatorKind, id: string) {
    const key = `${kind}:${id}`;
    this.logs.get(key)?.stop();
    this.logs.delete(key);
  }

  /** Stops log streams nobody reads any more. */
  private sweep() {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      const now = this.deps.now();
      for (const [key, capture] of this.logs)
        if (now - capture.lastRead > logIdleMs) {
          capture.stop();
          this.logs.delete(key);
        }
      if (!this.logs.size) {
        clearInterval(this.sweeper);
        this.sweeper = undefined;
      }
    }, logIdleMs / 3);
    this.sweeper.unref?.();
  }

  /** Signing out or quitting: recordings are finished and log streams stopped. */
  dispose() {
    for (const recording of this.recordings.values())
      recording.process.kill("SIGINT");
    this.recordings.clear();
    for (const capture of this.logs.values()) capture.stop();
    this.logs.clear();
    clearInterval(this.sweeper);
    this.sweeper = undefined;
  }
}

/** Captures on this computer: saved to `folder`, recorded under the temporary folder. */
export function nodeCaptureFiles(folder: () => string): CaptureFiles {
  return {
    folder,
    stagingFolder: () =>
      fs.mkdtemp(path.join(os.tmpdir(), "claudex-simulator-rec-")),
  };
}
