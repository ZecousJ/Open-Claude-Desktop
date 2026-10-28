import { Suspense, useRef, useState } from "react";
import { Image, Pencil, Shapes, Shuffle, Trash2, X } from "../ui/glyphs";
import {
  avatarSource,
  avatarUploadLimit,
  avatarUploadTypes,
  randomAvatar,
} from "../../shared/avatar";
import { t, useT } from "../i18n";
import { lazyPiece } from "../ui/lazy-piece";
import { useDismiss } from "../ui/useDismiss";
import { showToast } from "../ui/toast-store";
import { profileInitials } from "../sidebar/profile";
import type { TabProps } from "./context";

const AvatarDialogs = lazyPiece(() => import("./AvatarDialogs"));

export function AccountAvatar({
  settings,
  name,
  save,
  uploadLimit = avatarUploadLimit,
}: Pick<TabProps, "settings" | "save"> & {
  name: string;
  uploadLimit?: number;
}) {
  useT();
  const [menu, setMenu] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [failedSource, setFailedSource] = useState<string>();
  const anchor = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useDismiss([anchor], menu, () => setMenu(false));
  const source = avatarSource(settings, import.meta.env?.BASE_URL ?? "/");
  const photoEnabled = settings.profilePhotoEnabled ?? false;
  const commit = async (avatar: number, avatarPhoto = "") => {
    if (busy) return;
    setBusy(true);
    try {
      const kept = await save(
        { avatar, avatarPhoto },
        "Couldn’t save that change",
      );
      if (kept !== false) {
        setChoosing(false);
        setFile(undefined);
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className={`settings-avatar-group${photoEnabled ? " photo-enabled" : ""}`}
      ref={anchor}
    >
      <button
        type="button"
        className="settings-avatar-button"
        aria-label={t(photoEnabled ? "Profile photo" : "Randomize avatar")}
        aria-haspopup={photoEnabled ? "menu" : undefined}
        aria-expanded={photoEnabled ? menu : undefined}
        disabled={busy}
        onClick={() =>
          photoEnabled ? setMenu(!menu) : void commit(randomAvatar())
        }
      >
        <span className="settings-avatar">
          {source && source !== failedSource ? (
            <img
              src={source}
              width={40}
              height={40}
              alt=""
              draggable={false}
              onError={() => setFailedSource(source)}
            />
          ) : (
            profileInitials(name)
          )}
        </span>
        {photoEnabled ? (
          <Pencil size={20} strokeWidth={1.5} aria-hidden="true" />
        ) : (
          <Shuffle size={20} strokeWidth={1.5} aria-hidden="true" />
        )}
      </button>
      {!photoEnabled && !!settings.avatar && (
        <button
          type="button"
          className="settings-avatar-clear"
          aria-label={t("Clear avatar")}
          title={t("Clear avatar")}
          disabled={busy}
          onClick={() => void commit(0)}
        >
          <X size={12} aria-hidden="true" />
        </button>
      )}
      {photoEnabled && (
        <input
          ref={input}
          type="file"
          accept={avatarUploadTypes.join(",")}
          hidden
          onChange={(event) => {
            const selected = event.target.files?.[0];
            event.target.value = "";
            if (!selected) return;
            if (
              !avatarUploadTypes.includes(selected.type) ||
              selected.size > uploadLimit
            ) {
              showToast(t("Couldn’t save that change"));
              return;
            }
            setFile(selected);
          }}
        />
      )}
      {menu && (
        <div
          className="popover settings-avatar-menu"
          role="menu"
          onKeyDown={(event) => {
            const items = [
              ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                "button",
              ),
            ];
            const index = items.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              items[
                (index + (event.key === "ArrowDown" ? 1 : items.length - 1)) %
                  items.length
              ]?.focus();
            }
          }}
        >
          <button
            type="button"
            role="menuitem"
            autoFocus
            onClick={() => {
              setMenu(false);
              input.current?.click();
            }}
          >
            <Image size={16} />
            {t(settings.avatarPhoto ? "Change photo" : "Upload photo")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(false);
              setChoosing(true);
            }}
          >
            <Shapes size={16} />
            {t("Choose avatar")}
          </button>
          {(settings.avatarPhoto || !!settings.avatar) && (
            <button
              type="button"
              role="menuitem"
              className="danger"
              onClick={() => {
                setMenu(false);
                void commit(0);
              }}
            >
              <Trash2 size={16} />
              {t("Clear avatar")}
            </button>
          )}
        </div>
      )}
      {(file || choosing) && (
        <Suspense fallback={null}>
          <AvatarDialogs
            file={file}
            current={settings.avatar ?? 0}
            hasPhoto={!!settings.avatarPhoto}
            busy={busy}
            onClose={() => {
              setFile(undefined);
              setChoosing(false);
            }}
            onSave={commit}
          />
        </Suspense>
      )}
    </div>
  );
}
