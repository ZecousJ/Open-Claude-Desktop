import { Suspense, useContext, useRef, useState, type ReactNode } from "react";
import type { Conversation, Mode } from "../../../shared/types";
import { AppContext } from "../../app/AppContext";
import { useHost } from "../../host/HostContext";
import { formatText, t } from "../../i18n";
import { EllipsisVertical } from "../../ui/glyphs";
import { lazyPiece } from "../../ui/lazy-piece";
import { formatWebRoute } from "../../web/routes";

const ProjectChatActions = lazyPiece(
  () => import("./ProjectChatActions"),
  "ProjectChatActions",
);

/**
 * Both recents and search use a primary link with a separate action trigger.
 */
export function ProjectChatRow({
  id,
  title,
  mode,
  conversation,
  className,
  onOpen,
  children,
}: {
  id: string;
  title: string;
  mode: Mode;
  conversation?: Conversation;
  className: string;
  /** false leaves native web navigation available for a search-only record. */
  onOpen(): void | false;
  children: ReactNode;
}) {
  const web = useHost().kind === "web";
  const app = useContext(AppContext);
  const [menu, setMenu] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const Row = web ? "a" : "button";
  const label = formatText("More options for {chatName}", {
    chatName: title || t("Untitled"),
  });
  return (
    <li className="prj-chat-cell" data-menu-open={menu || undefined}>
      <Row
        type={web ? undefined : "button"}
        className={className}
        href={
          web
            ? formatWebRoute({
                kind: mode === "code" ? "code-chat" : "chat",
                id,
              })
            : undefined
        }
        onClick={(event) => {
          if (
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          if (onOpen() !== false) event.preventDefault();
        }}
      >
        {children}
      </Row>
      {app && conversation && !conversation.incognito && (
        <>
          <button
            ref={anchor}
            type="button"
            className="prj-chat-more"
            aria-label={label}
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={(event) => {
              event.stopPropagation();
              setMenu(!menu);
            }}
          >
            <EllipsisVertical size={16} aria-hidden="true" />
          </button>
          {menu && (
            <Suspense fallback={null}>
              <ProjectChatActions
                conversation={conversation}
                anchor={anchor}
                label={label}
                onClose={() => setMenu(false)}
              />
            </Suspense>
          )}
        </>
      )}
    </li>
  );
}
