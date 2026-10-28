import { useEffect, useRef, useState } from "react";
import { Check, Shuffle } from "../ui/glyphs";
import {
  avatarCount,
  avatarMaxZoom,
  avatarPhotoLimit,
  avatarSource,
  boundAvatarCrop,
  initialAvatarCrop,
  zoomAvatarCrop,
  type AvatarCrop,
} from "../../shared/avatar";
import { formatText, t, useT } from "../i18n";
import { showToast } from "../ui/toast-store";
import { Button, SettingsModal } from "./controls";
import { avatarLabel, avatarVariants } from "./avatar-variants";
import "./avatar-dialogs.css";
import { isEditEndKey } from "../ui/ime";

export default function AvatarDialogs({
  file,
  current,
  hasPhoto = false,
  busy,
  onClose,
  onSave,
}: {
  file?: File;
  current: number;
  hasPhoto?: boolean;
  busy: boolean;
  onClose: () => void;
  onSave: (avatar: number, photo?: string) => Promise<void>;
}) {
  return file ? (
    <PhotoCrop
      file={file}
      busy={busy}
      onClose={onClose}
      onSave={(photo) => onSave(0, photo)}
    />
  ) : (
    <AvatarChooser
      current={current}
      hasPhoto={hasPhoto}
      busy={busy}
      onClose={onClose}
      onSave={(avatar) => onSave(avatar)}
    />
  );
}

function AvatarChooser({
  current,
  hasPhoto,
  busy,
  onClose,
  onSave,
}: {
  current: number;
  hasPhoto: boolean;
  busy: boolean;
  onClose: () => void;
  onSave: (avatar: number) => Promise<void>;
}) {
  useT();
  const [selected, setSelected] = useState(current);
  const [announcement, setAnnouncement] = useState<number>();
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const live = useRef(true);
  const grid = useRef<HTMLDivElement>(null);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const locked = busy || saving;
  const unchanged = selected === current && !hasPhoto;
  const invalid = !avatarVariants.includes(selected);
  const close = () => {
    if (!locked && !inFlight.current) onClose();
  };
  const submit = async () => {
    if (locked || inFlight.current || invalid || unchanged) return;
    inFlight.current = true;
    setSaving(true);
    try {
      await onSave(selected);
    } catch {
      if (live.current) showToast(t("Couldn’t save that change"));
    } finally {
      if (live.current) {
        inFlight.current = false;
        setSaving(false);
      }
    }
  };
  const select = (variant: number) => {
    if (locked || inFlight.current) return;
    setSelected(variant);
    setAnnouncement(undefined);
  };
  return (
    <SettingsModal
      title="Choose an avatar"
      showClose={false}
      onClose={close}
      className="settings-avatar-dialog"
    >
      <p className="settings-avatar-description">
        Use one of these instead of a photo.
      </p>
      <form
        className="settings-avatar-picker"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        onKeyDown={(event) => {
          if (
            !isEditEndKey(event, "Enter") ||
            !(event.metaKey || event.ctrlKey)
          )
            return;
          const dialog = event.currentTarget.closest('[role="dialog"]');
          const target = event.target as HTMLElement;
          if (
            target.closest('[role="dialog"]') !== dialog ||
            dialog?.closest(".overlay")?.hasAttribute("data-nested-open")
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          void submit();
        }}
      >
        <div
          ref={grid}
          className="settings-avatar-grid"
          role="radiogroup"
          aria-label={t("Avatar")}
        >
          {avatarVariants.map((variant) => (
            <button
              type="button"
              key={variant}
              role="radio"
              aria-checked={selected === variant}
              aria-label={avatarLabel(variant)}
              tabIndex={variant === (selected || 1) ? 0 : -1}
              disabled={locked}
              onClick={() => select(variant)}
              onKeyDown={(event) => {
                if (
                  locked ||
                  inFlight.current ||
                  event.nativeEvent.isComposing ||
                  event.keyCode === 229
                )
                  return;
                let next = variant;
                const index = avatarVariants.indexOf(variant);
                if (event.key === "ArrowRight" || event.key === "ArrowDown")
                  next = avatarVariants[(index + 1) % avatarCount];
                else if (event.key === "ArrowLeft" || event.key === "ArrowUp")
                  next =
                    avatarVariants[(index + avatarCount - 1) % avatarCount];
                else if (event.key === "Home") next = avatarVariants[0];
                else if (event.key === "End")
                  next = avatarVariants[avatarCount - 1];
                else return;
                event.preventDefault();
                select(next);
                event.currentTarget.parentElement
                  ?.querySelector<HTMLButtonElement>(`[data-variant="${next}"]`)
                  ?.focus();
              }}
              data-variant={variant}
            >
              <img
                src={avatarSource(
                  { avatar: variant },
                  import.meta.env?.BASE_URL ?? "/",
                )}
                width={32}
                height={32}
                alt=""
                draggable={false}
              />
              {selected === variant && (
                <span className="settings-avatar-check">
                  <Check size={12} aria-hidden="true" />
                </span>
              )}
            </button>
          ))}
        </div>
        <div role="status" className="sr-only">
          {announcement !== undefined
            ? formatText("Selected {avatar}", {
                avatar: avatarLabel(announcement),
              })
            : ""}
        </div>
        <div className="settings-avatar-footer">
          <Button
            disabled={locked}
            onClick={() => {
              if (locked || inFlight.current) return;
              const choices = avatarVariants.filter(
                (variant) => variant !== selected,
              );
              const next = choices[Math.floor(Math.random() * choices.length)];
              setSelected(next);
              setAnnouncement(next);
              grid.current
                ?.querySelector<HTMLElement>(`[data-variant="${next}"]`)
                ?.scrollIntoView?.({ block: "nearest" });
            }}
          >
            <Shuffle size={16} aria-hidden="true" />
            Shuffle
          </Button>
          <div className="settings-actions">
            <Button disabled={locked} onClick={close}>
              Cancel
            </Button>
            <Button
              primary
              disabled={locked || invalid || unchanged}
              onClick={() => void submit()}
            >
              Save
            </Button>
          </div>
        </div>
      </form>
    </SettingsModal>
  );
}

function PhotoCrop({
  file,
  busy,
  onClose,
  onSave,
}: {
  file: File;
  busy: boolean;
  onClose: () => void;
  onSave: (photo: string) => Promise<void>;
}) {
  useT();
  const [source, setSource] = useState("");
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [crop, setCrop] = useState<AvatarCrop>();
  const [encoding, setEncoding] = useState(false);
  const image = useRef<HTMLImageElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ spread: number; zoom: number } | undefined>(undefined);
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setSource(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const zoom = crop
    ? Math.min(dimensions.width, dimensions.height) / crop.size
    : 1;
  const maxZoom = avatarMaxZoom(dimensions.width, dimensions.height);
  const locked = busy || encoding;
  const changeZoom = (value: number, anchor?: { x: number; y: number }) =>
    setCrop(
      (before) =>
        before &&
        zoomAvatarCrop(
          before,
          dimensions.width,
          dimensions.height,
          value,
          anchor,
        ),
    );
  const move = (horizontal: number, vertical: number) =>
    setCrop(
      (before) =>
        before &&
        boundAvatarCrop(
          {
            ...before,
            x: before.x + horizontal * before.size,
            y: before.y + vertical * before.size,
          },
          dimensions.width,
          dimensions.height,
        ),
    );
  const viewport = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const element = viewport.current;
    if (!element || !crop || locked) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = element.getBoundingClientRect();
      const delta =
        event.deltaY *
        (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1);
      changeZoom(zoom * Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.002)), {
        x: (event.clientX - bounds.left) / bounds.width,
        y: (event.clientY - bounds.top) / bounds.height,
      });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [crop, locked, zoom, dimensions]);
  const save = async () => {
    if (!crop || !image.current || locked) return;
    setEncoding(true);
    try {
      const canvas = document.createElement("canvas");
      // A small square keeps the photo light enough to live in settings.
      const size = Math.max(1, Math.min(512, Math.round(crop.size)));
      canvas.width = canvas.height = size;
      const context = canvas.getContext("2d");
      if (!context) throw Error();
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(
        image.current,
        crop.x,
        crop.y,
        crop.size,
        crop.size,
        0,
        0,
        size,
        size,
      );
      const photo = canvas.toDataURL("image/jpeg", 0.9);
      if (((photo.length - photo.indexOf(",") - 1) * 3) / 4 > avatarPhotoLimit)
        throw Error();
      await onSave(photo);
    } catch {
      showToast(t("Couldn’t save that change"));
    } finally {
      setEncoding(false);
    }
  };
  return (
    <SettingsModal
      title="Crop photo"
      showClose={false}
      className="settings-avatar-crop-dialog"
      onClose={() => {
        if (!locked) onClose();
      }}
    >
      <div className="settings-avatar-crop-controls">
        <button
          ref={viewport}
          type="button"
          className="settings-avatar-crop"
          aria-label={t("Position")}
          disabled={locked}
          onKeyDown={(event) => {
            if (!crop || event.ctrlKey || event.metaKey || event.altKey) return;
            if (event.key === "ArrowLeft") move(0.02, 0);
            else if (event.key === "ArrowRight") move(-0.02, 0);
            else if (event.key === "ArrowUp") move(0, 0.02);
            else if (event.key === "ArrowDown") move(0, -0.02);
            else if (event.key === "+" || event.key === "=")
              changeZoom(zoom * 1.1);
            else if (event.key === "-" || event.key === "_")
              changeZoom(zoom / 1.1);
            else return;
            event.preventDefault();
          }}
          onPointerDown={(event) => {
            if (!crop || event.button !== 0 || pointers.current.size >= 2)
              return;
            event.currentTarget.setPointerCapture(event.pointerId);
            pointers.current.set(event.pointerId, {
              x: event.clientX,
              y: event.clientY,
            });
            const values = [...pointers.current.values()];
            if (values.length === 2)
              pinch.current = {
                spread: Math.max(
                  8,
                  Math.hypot(
                    values[0].x - values[1].x,
                    values[0].y - values[1].y,
                  ),
                ),
                zoom,
              };
          }}
          onPointerMove={(event) => {
            const before = pointers.current.get(event.pointerId);
            if (!before || !crop || locked) return;
            const bounds = event.currentTarget.getBoundingClientRect();
            const scale = pointers.current.size === 2 ? 2 : 1;
            move(
              (before.x - event.clientX) / bounds.width / scale,
              (before.y - event.clientY) / bounds.width / scale,
            );
            pointers.current.set(event.pointerId, {
              x: event.clientX,
              y: event.clientY,
            });
            const values = [...pointers.current.values()];
            if (pinch.current && values.length === 2)
              changeZoom(
                (pinch.current.zoom *
                  Math.hypot(
                    values[0].x - values[1].x,
                    values[0].y - values[1].y,
                  )) /
                  pinch.current.spread,
                {
                  x:
                    ((values[0].x + values[1].x) / 2 - bounds.left) /
                    bounds.width,
                  y:
                    ((values[0].y + values[1].y) / 2 - bounds.top) /
                    bounds.height,
                },
              );
          }}
          onLostPointerCapture={(event) => {
            pointers.current.delete(event.pointerId);
            pinch.current = undefined;
          }}
          onPointerUp={(event) => {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={(event) => {
            pointers.current.delete(event.pointerId);
            pinch.current = undefined;
          }}
        >
          {source && (
            <img
              ref={image}
              src={source}
              alt=""
              draggable={false}
              onLoad={(event) => {
                const { naturalWidth: width, naturalHeight: height } =
                  event.currentTarget;
                if (!width || !height) {
                  showToast(t("Couldn’t save that change"));
                  onClose();
                  return;
                }
                setDimensions({ width, height });
                setCrop(initialAvatarCrop(width, height));
              }}
              onError={() => {
                showToast(t("Couldn’t save that change"));
                onClose();
              }}
              style={
                crop
                  ? {
                      width: `${(dimensions.width / crop.size) * 100}%`,
                      height: `${(dimensions.height / crop.size) * 100}%`,
                      left: `${(-crop.x / crop.size) * 100}%`,
                      top: `${(-crop.y / crop.size) * 100}%`,
                    }
                  : { visibility: "hidden" }
              }
            />
          )}
          <span className="settings-avatar-crop-mask" aria-hidden="true" />
        </button>
        <div className="settings-avatar-zoom">
          <button
            type="button"
            aria-label={t("Zoom out")}
            disabled={locked || !crop || zoom <= 1}
            onClick={() => changeZoom(zoom / 1.25)}
          >
            −
          </button>
          <input
            type="range"
            aria-label={t("Zoom")}
            aria-valuetext={`${Math.round(zoom * 100)}%`}
            min={1}
            max={maxZoom}
            step={0.01}
            value={zoom}
            disabled={locked || !crop || maxZoom <= 1}
            onChange={(event) => changeZoom(Number(event.target.value))}
          />
          <button
            type="button"
            aria-label={t("Zoom in")}
            disabled={locked || !crop || zoom >= maxZoom}
            onClick={() => changeZoom(zoom * 1.25)}
          >
            +
          </button>
        </div>
      </div>
      <div className="settings-avatar-footer">
        <Button
          disabled={locked || !crop}
          onClick={() =>
            setCrop(initialAvatarCrop(dimensions.width, dimensions.height))
          }
        >
          Reset
        </Button>
        <div className="settings-actions">
          <Button disabled={locked} onClick={onClose}>
            Cancel
          </Button>
          <Button
            primary
            disabled={locked || !crop}
            onClick={() => void save()}
          >
            Save
          </Button>
        </div>
      </div>
    </SettingsModal>
  );
}
