import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Routine } from "../../shared/routines";
import { approvalResponse } from "../../shared/approval-response";
import QRCode from "qrcode";
import type { DispatchStatus } from "../../shared/dispatch-api";
import type {
  DeviceConversation,
  DeviceConversationSummary,
  DeviceDirectory,
  DeviceMethod,
} from "../../shared/remote-devices";
import { preference } from "../../shared/settings-extras";
import { useApp } from "../app/AppContext";
import { formatText, t } from "../i18n";
import { Button, Toggle } from "../settings/controls";
import { RemoteFoldersRow } from "../settings/tabs/RemoteFolders";
import { dispatchGroups } from "./model";
import { requestScheduleConfirmation } from "../collections/routines/schedule-request";
import { AppIcon } from "../ui/app-icon";
import { showToast } from "../ui/toast-store";
import { helpUrl } from "../../shared/help-links";
import "./dispatch.css";

/** Pairing and task sections. */
export function DispatchPage() {
  const app = useApp();
  const settings = app.snapshot.settings;
  const [step, setStep] = useState<"home" | "pair" | "setup" | "tasks">(
    preference(settings, "dispatchOnboarded") ||
      new URLSearchParams(window.location.search).has("device")
      ? "tasks"
      : "home",
  );
  const [status, setStatus] = useState<DispatchStatus>();
  const [offline, setOffline] = useState(false);
  const [mobileNotifications, setMobileNotifications] = useState(
    preference(settings, "dispatchMobileNotifications"),
  );
  const [device, setDevice] = useState(
    () => new URLSearchParams(window.location.search).get("device") ?? "",
  );
  const [tasks, setTasks] = useState<DeviceConversationSummary[]>([]);
  const [directories, setDirectories] = useState<DeviceDirectory[]>([]);
  const [folder, setFolder] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<DeviceConversation>();
  const [qr, setQr] = useState<string>();
  const selectedId = useRef<string | undefined>(
    new URLSearchParams(window.location.search).get("task") ?? undefined,
  );
  const mounted = useRef(true);
  const [schedules, setSchedules] = useState<Routine[]>([]);
  const currentDevice = device || status?.local?.id || status?.devices[0]?.id;
  const local = Boolean(status?.local && currentDevice === status.local.id);
  const refresh = useRef<() => Promise<void>>(async () => {});
  refresh.current = async () => {
    try {
      const next = await window.desktop.dispatchStatus();
      if (!mounted.current) return;
      setStatus(next);
      const id = device || next.local?.id || next.devices[0]?.id;
      const online =
        id &&
        (id === next.local?.id
          ? next.local.online
          : next.onlineDeviceIds.includes(id));
      setOffline(!online);
      if (!id) return;
      if (!online && id !== next.local?.id) {
        setDirectories(
          (await window.desktop.dispatchCall(
            id,
            "listDirectories",
            [],
          )) as DeviceDirectory[],
        );
        return;
      }
      const [list, folders, notifications] = await Promise.all([
        window.desktop.dispatchTasks(id),
        window.desktop.dispatchCall(id, "listDirectories", []),
        window.desktop.dispatchCall(id, "dispatchPreferences", []),
      ]);
      if (!mounted.current) return;
      setTasks(list);
      setMobileNotifications(Boolean(notifications));
      setDirectories(folders as DeviceDirectory[]);
      if (id === next.local?.id)
        setSchedules(await window.desktop.listSchedules());
      if (selectedId.current)
        setSelected(
          (await window.desktop.dispatchCall(id, "openConversation", [
            selectedId.current,
          ])) as DeviceConversation,
        );
    } catch {
      setOffline(true);
    }
  };
  useEffect(() => {
    mounted.current = true;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh.current();
      if (live) timer = setTimeout(() => void poll(), 3000);
    };
    void poll();
    return () => {
      live = false;
      mounted.current = false;
      clearTimeout(timer);
    };
  }, [device]);
  useEffect(() => {
    let live = true;
    if (status?.appLink)
      void QRCode.toDataURL(status.appLink, { width: 176, margin: 0 })
        .then((url) => {
          if (live) setQr(url);
        })
        .catch(app.report);
    return () => {
      live = false;
    };
  }, [status?.appLink]);
  const save = async (patch: Parameters<typeof app.updatePreference>[0]) => {
    try {
      await app.updatePreference(patch);
    } catch (error) {
      app.report(error);
    }
  };
  const call = async (method: DeviceMethod, args: unknown[]) => {
    if (!currentDevice) return;
    const result = await window.desktop.dispatchCall(
      currentDevice,
      method,
      args,
    );
    await refresh.current();
    return result;
  };
  const finish = async () => {
    setBusy(true);
    try {
      await app.updatePreference({
        dispatchOnboarded: true,
        remoteControl: true,
      });
      setStep("tasks");
      await refresh.current();
    } catch (error) {
      app.report(error);
    } finally {
      setBusy(false);
    }
  };
  const openTask = async (task: DeviceConversationSummary) => {
    if (local) {
      const conversation = app.listed.find((item) => item.id === task.id);
      if (conversation) app.openConversation(conversation);
      return;
    }
    selectedId.current = task.id;
    setSelected(
      (await call("openConversation", [task.id])) as DeviceConversation,
    );
  };
  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      if (offline && !local && currentDevice) {
        await window.desktop.dispatchEnqueue(
          currentDevice,
          selected ? "send" : "newSession",
          selected
            ? { conversationId: selected.conversation.id, text }
            : { text, cwd: folder || directories[0]?.path, mode: "cowork" },
        );
        setText("");
        return;
      }
      if (selected)
        await call("send", [
          { conversationId: selected.conversation.id, text },
        ]);
      else {
        const result = (await call("newSession", [
          { text, cwd: folder || directories[0]?.path, mode: "cowork" },
        ])) as { conversationId: string };
        if (result) {
          selectedId.current = result.conversationId;
          setSelected(
            (await call("openConversation", [
              result.conversationId,
            ])) as DeviceConversation,
          );
        }
      }
      setText("");
    } catch (error) {
      app.report(error);
    } finally {
      setBusy(false);
    }
  };
  const ongoing = new Set(
    schedules
      .filter((task) => task.enabled)
      .map((task) => task.conversationId)
      .filter((id): id is string => Boolean(id)),
  );
  const groups = dispatchGroups(tasks, local ? ongoing : undefined);
  return (
    <div className="dispatch-page">
      <header className="dispatch-header">
        <h2>{t("Dispatch")}</h2>
        <Button onClick={() => setStep("pair")}>{t("Pair your phone")}</Button>
      </header>
      {step !== "tasks" ? (
        <div className="dispatch-onboarding">
          <div className="dispatch-onboarding-content">
            {step === "home" && (
              <>
                <h2>{t("Dispatch from anywhere")}</h2>
                <p>
                  {t(
                    "Dispatch to Claudex and check in from anywhere—a task, a code session, in one continuous thread.",
                  )}
                </p>
                <div className="dispatch-onboarding-actions">
                  <Button primary onClick={() => setStep("pair")}>
                    {t("Pair your phone")}
                  </Button>
                  <Button onClick={() => setStep("tasks")}>
                    {t("Set up later")}
                  </Button>
                </div>
              </>
            )}
            {step === "pair" && (
              <>
                <h2>{t("Pair with the Claudex Mobile app")}</h2>
                <p>
                  {t(
                    "Use the mobile app to talk to Claudex while it works from your desktop. Scan the code to download it on your phone.",
                  )}
                </p>
                {/* The access warning under the pairing text. */}
                <p className="dispatch-note">
                  {t(
                    "Claudex will access your desktop (files, apps, and browser) to complete tasks you send from your phone. This may have security risks. Only pair devices that you own and trust.",
                  )}{" "}
                  <a
                    href={helpUrl("cowork-safety")}
                    onClick={(event) => {
                      event.preventDefault();
                      void window.desktop.openExternal(
                        event.currentTarget.href,
                      );
                    }}
                  >
                    {t("Learn how to use this safely")}
                  </a>
                </p>
                {qr && (
                  <a href={status?.appLink} target="_blank" rel="noreferrer">
                    <img
                      className="dispatch-qr"
                      src={qr}
                      alt={t("Pair your phone")}
                    />
                  </a>
                )}
                <div className="dispatch-onboarding-actions">
                  <Button primary onClick={() => setStep("setup")}>
                    {t("I’m signed in on my phone")}
                  </Button>
                  <Button onClick={() => setStep("tasks")}>
                    {t("Set up later")}
                  </Button>
                </div>
              </>
            )}
            {step === "setup" && (
              <>
                <h2>{t("Get ready to dispatch")}</h2>
                <div className="dispatch-setting">
                  <div>
                    <strong>{t("Keep this computer awake")}</strong>
                    <p>{t("Prevents sleep while Dispatch is running.")}</p>
                  </div>
                  <Toggle
                    label={t("Keep this computer awake")}
                    checked={preference(settings, "keepAwake")}
                    onChange={(value) => void save({ keepAwake: value })}
                  />
                </div>
                <div className="dispatch-setting">
                  <div>
                    <strong>{t("All connectors are on")}</strong>
                    <p>
                      {t(
                        "Dispatch can use every connector you’ve authenticated.",
                      )}
                    </p>
                  </div>
                </div>
                <div className="dispatch-onboarding-actions">
                  <Button primary disabled={busy} onClick={() => void finish()}>
                    {t("Finish setup")}
                  </Button>
                  <Button onClick={() => setStep("pair")}>{t("Back")}</Button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="dispatch-content">
          <section className="dispatch-thread">
            {status && !status.local && (
              <select
                aria-label={t("Desktop")}
                value={currentDevice ?? ""}
                onChange={(event) => {
                  setDevice(event.target.value);
                  setSelected(undefined);
                  selectedId.current = undefined;
                  setTasks([]);
                  setDirectories([]);
                }}
              >
                <option value="">{t("Desktop")}</option>
                {status.devices.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            )}
            {/* A link the service refused for the sign-in. */}
            {status?.local?.cause === "sign_in" && (
              <div className="dispatch-offline" role="status">
                {t(
                  "Your sign-in session has expired, so Dispatch is disconnected on this device. Sign in again to reconnect.",
                )}
              </div>
            )}
            {offline && !local && (
              <div className="dispatch-offline" role="status">
                {t("Desktop appears offline.")}
                <br />
                {t("Will run when it reconnects.")}
              </div>
            )}
            {selected && (
              <>
                <Button
                  onClick={() => {
                    setSelected(undefined);
                    selectedId.current = undefined;
                  }}
                >
                  {t("Back")}
                </Button>
                <h2>{selected.conversation.title}</h2>
                <div className="dispatch-messages">
                  {selected.conversation.turns.map((turn) => (
                    <div key={turn.id}>
                      <p>{turn.prompt}</p>
                      {turn.items
                        .filter((item) => item.text)
                        .map((item) => (
                          <p key={item.id}>{item.text}</p>
                        ))}
                    </div>
                  ))}
                </div>
                {selected.approvals.map((approval) => (
                  <div className="dispatch-setting" key={approval.id}>
                    <span>{t("Claudex is waiting for your input")}</span>
                    <Button
                      onClick={() =>
                        void call("approve", [
                          approval.id,
                          approvalResponse(approval, "once"),
                        ]).catch(app.report)
                      }
                    >
                      {t("Allow once")}
                    </Button>
                    <Button
                      onClick={() =>
                        void call("approve", [
                          approval.id,
                          approvalResponse(approval, "deny"),
                        ]).catch(app.report)
                      }
                    >
                      {t("Deny")}
                    </Button>
                  </div>
                ))}
                {selected.conversation.turns.at(-1)?.status ===
                  "inProgress" && (
                  <Button
                    onClick={() =>
                      void call("interrupt", [selected.conversation.id]).catch(
                        app.report,
                      )
                    }
                  >
                    {t("Stop")}
                  </Button>
                )}
              </>
            )}
            <form
              className="dispatch-composer"
              onSubmit={(event) => void send(event)}
            >
              {!selected && (
                <select
                  aria-label={t("Folders for your phone")}
                  value={folder || directories[0]?.path || ""}
                  onChange={(event) => setFolder(event.target.value)}
                >
                  {directories.map((item) => (
                    <option key={item.path} value={item.path}>
                      {item.name}
                    </option>
                  ))}
                </select>
              )}
              <textarea
                aria-label={t("Message")}
                placeholder={t("Reply...")}
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
              <button
                className="settings-button primary"
                disabled={
                  busy ||
                  !currentDevice ||
                  !text.trim() ||
                  (!selected && !directories.length)
                }
                type="submit"
              >
                {t("Send")}
              </button>
            </form>
            {local && (
              <RemoteFoldersRow
                settings={settings}
                save={async (patch) => {
                  await app.updatePreference(patch);
                  await refresh.current();
                  return true;
                }}
                onError={app.report}
              />
            )}
          </section>
          <aside className="dispatch-tasks">
            <div className="dispatch-setting">
              <span>{t("Mobile notifications")}</span>
              <Toggle
                label={t("Mobile notifications")}
                checked={mobileNotifications}
                onChange={(value) => {
                  if (
                    value &&
                    typeof Notification !== "undefined" &&
                    Notification.permission === "default"
                  )
                    void Notification.requestPermission();
                  setMobileNotifications(value);
                  // Kept only once the desktop took it; a refusal puts the
                  // switch back and says so.
                  void call("dispatchPreferences", [value])
                    .then(() => save({ dispatchMobileNotifications: value }))
                    .catch((error) => {
                      setMobileNotifications(!value);
                      if (value)
                        showToast(
                          t("Failed to enable Dispatch notifications."),
                          {
                            variant: "danger",
                          },
                        );
                      else app.report(error);
                    });
                }}
              />
            </div>
            <p className="dispatch-note">
              {t("Get notified on your phone when Claudex messages you here.")}
            </p>
            {local && schedules.some((task) => task.enabled) && (
              <section>
                <h3>{t("Ongoing")}</h3>
                <div className="dispatch-ongoing">
                  {schedules
                    .filter((task) => task.enabled)
                    .map((task) => (
                      <button
                        key={task.id}
                        title={
                          task.repeat?.kind === "manual"
                            ? t("Manually run")
                            : formatText("Next run {when}", {
                                when: new Date(task.nextRunAt).toLocaleString(),
                              })
                        }
                        onClick={() => {
                          // openRoutineId selects the task's detail; routineId its editor.
                          requestScheduleConfirmation({
                            description: "",
                            openRoutineId: task.id,
                          });
                          app.setPage("scheduled");
                        }}
                      >
                        <AppIcon name="Clock" />
                        <span>{task.name}</span>
                      </button>
                    ))}
                </div>
              </section>
            )}
            {tasks.length === 0 && !status?.pending.length && (
              <p className="dispatch-empty">{t("No tasks yet")}</p>
            )}
            {status?.pending
              .filter((item) => item.deviceId === currentDevice)
              .map((item) => (
                <div className="dispatch-task" key={item.id}>
                  {item.title}
                  <br />
                  {t("Will run when it reconnects.")}
                </div>
              ))}
            {(
              [
                ["active", "Active"],
                ["attention", "Needs attention"],
                ["done", "Done"],
              ] as const
            ).map(
              ([key, label]) =>
                groups[key].length > 0 && (
                  <section key={key}>
                    <h3>{t(label)}</h3>
                    {groups[key].map((task) => (
                      <button
                        className="dispatch-task"
                        key={task.id}
                        onClick={() => void openTask(task).catch(app.report)}
                      >
                        {task.title || t("Starting task…")}
                      </button>
                    ))}
                  </section>
                ),
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
