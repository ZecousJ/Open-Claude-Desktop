import { Suspense, useEffect } from "react";
import { flushSync } from "react-dom";
import { ChatHome } from "../home/ChatHome";
import { homeMode } from "../home/home-mode";
import { CodeHome } from "../code-home/CodeHome";
import { useHost } from "../host/HostContext";
import { useApp } from "./AppContext";
import { ComposerHost } from "./ComposerHost";
import { lazyPiece } from "../ui/lazy-piece";
import { openPullRequest } from "../pr/open-pull-request";
import { useOpenLink } from "../ui/ExternalLinks";
import { requestProject } from "../collections/open-requests";
import { requestComposerSubmit } from "../composer/submit-request";

// The Code landing's sections load with the Code home, with their styles.
const CodeLanding = lazyPiece(
  () => import("../code-home/CodeLanding"),
  "CodeLanding",
);

/** A new chat's home: the Code home, or the Chat and Cowork home. */
export function HomeHost() {
  const app = useApp();
  const host = useHost();
  const openLink = useOpenLink();
  const { snapshot, setMode } = app;
  const mode = homeMode(app.mode, host, app.incognitoShown);
  // The composer and the rest of the window follow the window's mode, so a
  // mode this host cannot offer is replaced there too.
  useEffect(() => {
    // Web navigation resolves the execution mode in newChat before paint.
    // A passive home effect must not overwrite an incognito/deep-link route.
    if (host.kind !== "web" && mode !== app.mode) setMode(mode);
  }, [host.kind, mode, app.mode, setMode]);
  return mode === "code" ? (
    <CodeHome
      name={snapshot.settings.name}
      conversations={snapshot.conversations}
      composer={<ComposerHost />}
      landing={
        <Suspense fallback={null}>
          <CodeLanding
            conversations={snapshot.conversations}
            projects={snapshot.projects}
            approvals={snapshot.approvals ?? []}
            onOpen={app.openConversation}
            onOpenProject={(project) => {
              requestProject(project.id);
              app.setPage("projects");
            }}
            onOpenPr={(pr) =>
              openPullRequest(pr.url, snapshot.settings, openLink)
            }
            onMarkAllRead={() =>
              snapshot.conversations
                .filter((c) => c.mode === "code" && c.unread && !c.archived)
                .forEach(
                  (c) => void app.patchConversation(c, { unread: false }),
                )
            }
          />
        </Suspense>
      }
    />
  ) : (
    <ChatHome
      incognito={app.incognitoShown}
      conversationCount={
        snapshot.conversations.filter(
          (conversation) => conversation.mode !== "code",
        ).length
      }
      accountEmail={app.accountEmail}
      name={snapshot.settings.name}
      mode="chat"
      model={app.model}
      connectionDismissed={app.connectionDismissed}
      onServiceStatus={() => app.setPage("status")}
      onDismiss={() => app.setConnectionDismissed(true)}
      onSuggestion={(prompt, submit) => {
        if (submit) flushSync(() => app.setText(prompt));
        else app.setText(prompt);
        app.composer.current?.focus();
        // Starter clicks send unless resources are attached or still loading.
        if (submit)
          requestComposerSubmit(
            `${app.activeId ?? app.draftSession}:${app.mode}`,
            {
              withoutResources: true,
            },
          );
      }}
      composer={<ComposerHost />}
    />
  );
}
