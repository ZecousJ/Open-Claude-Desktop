import { Suspense } from "react";
import { useT } from "../i18n";
import { lazyPiece } from "../ui/lazy-piece";
import { PlacePickerTrigger, usePlacePickerShell } from "./PlacePickerTrigger";
import type { NativeProjectPickerProps } from "./NativeProjectPicker";
import { folderName } from "./recentFolders";

/** The eager native trigger never changes identity when its popup loads. */
export function createNativeProjectPickerShell(
  load: () => Promise<{
    NativeProjectPicker: typeof import("./NativeProjectPicker").NativeProjectPicker;
  }>,
) {
  const Popup = lazyPiece(load, "NativeProjectPicker");
  return function NativeProjectPickerShell(props: NativeProjectPickerProps) {
    const t = useT();
    const { open, anchor, popup, close, toggle } = usePlacePickerShell();
    const extra = Boolean(
      props.project && props.cwd && props.cwd !== props.project.cwd,
    );
    const label = props.project
      ? `${props.project.name}${extra ? " +1" : ""}`
      : props.cwd
        ? folderName(props.cwd)
        : t("Project or folder");
    return (
      <>
        <PlacePickerTrigger
          label={label}
          chosen={Boolean(props.project || props.cwd)}
          native
          collapsed={props.collapsed}
          badgeCount={extra ? 2 : 1}
          anchor={anchor}
          open={open}
          onToggle={toggle}
        />
        {open && (
          <Suspense fallback={null}>
            <Popup
              {...props}
              externalTrigger={{ anchor, popup, onClose: close }}
            />
          </Suspense>
        )}
      </>
    );
  };
}
export const NativeProjectPickerShell = createNativeProjectPickerShell(
  () => import("./NativeProjectPicker"),
);
