import {
  Suspense,
  useContext,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";
import { AppContext } from "../app/AppContext";
import { MicrophoneChevron } from "./voice/CoworkVoiceControls";
import { canSpeak } from "../voice/speech";
import { useVoiceInputPreference } from "./voice-input-preference";
/** O16 shared-8:10545–10587/10909–10977. Only the single primary
 * layout offers the preference, and choosing it never starts recording. */
export function PreferredVoiceInput({
  dictation,
  voice,
  reason,
  busy = false,
}: {
  dictation: ReactNode;
  voice: ReactNode;
  reason?: string;
  busy?: boolean;
}) {
  const app = useContext(AppContext);
  const preference = useVoiceInputPreference(app?.accountId ?? "");
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const owner = useRef(app);
  owner.current = app;
  const bridge = window.desktop;
  const origin = window.location.origin;
  const supported = Boolean(app) && !reason && canSpeak();
  return (
    <div
      className="cowork-voice-controls chin-voice-controls with-options preferred-voice-input"
      role="group"
      aria-label="Voice controls"
    >
      {supported && preference.value === "voice" ? (
        <Suspense
          fallback={
            <span className="voice-mode-button standalone" aria-hidden="true">
              <span className="voice-mode-main" />
            </span>
          }
        >
          {voice}
        </Suspense>
      ) : (
        dictation
      )}
      <MicrophoneChevron
        className="cowork-voice-options"
        label={supported ? "Voice input" : undefined}
        reason={reason}
        menuVariant="idle"
        voiceInput={
          supported
            ? {
                value: preference.value,
                choose(value) {
                  const live = owner.current;
                  if (
                    busy ||
                    !mounted.current ||
                    !app ||
                    !live ||
                    live.accountId !== app.accountId ||
                    live.controllerScope !== app.controllerScope ||
                    live.activeId !== app.activeId ||
                    live.draftSession !== app.draftSession ||
                    live.page !== app.page ||
                    app.currentController?.current?.controllerScope !==
                      app.controllerScope ||
                    window.desktop !== bridge ||
                    window.location.origin !== origin
                  )
                    return;
                  const current = app.currentController?.current;
                  if (
                    current?.accountId !== app.accountId ||
                    current?.activeId !== app.activeId ||
                    current?.draftSession !== app.draftSession ||
                    current?.page !== app.page
                  )
                    return;
                  preference.choose(value);
                },
              }
            : undefined
        }
      />
    </div>
  );
}
