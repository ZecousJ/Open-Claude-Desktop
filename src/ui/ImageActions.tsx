import {
  cloneElement,
  Suspense,
  useState,
  type ReactElement,
  type HTMLAttributes,
} from "react";
import { lazyPiece } from "./lazy-piece";

const ImageMenu = lazyPiece(() => import("./ImageMenu"));

/** Image context actions. */
export function ImageActions({
  src,
  fileName,
  children,
}: {
  src?: string | null;
  fileName?: string;
  children: ReactElement<HTMLAttributes<HTMLElement>>;
}) {
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    container?: Element;
  }>();
  return (
    <>
      {cloneElement(children, {
        onContextMenu: (event) => {
          children.props.onContextMenu?.(event);
          if (event.defaultPrevented || !src) return;
          event.preventDefault();
          event.stopPropagation();
          setPosition({
            left: event.clientX,
            top: event.clientY,
            container: event.currentTarget.closest(".lightbox") ?? undefined,
          });
        },
        onKeyDown: (event) => {
          children.props.onKeyDown?.(event);
          if (
            event.defaultPrevented ||
            !src ||
            !(
              event.key === "ContextMenu" ||
              (event.shiftKey && event.key === "F10")
            )
          )
            return;
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          setPosition({
            left: rect.left,
            top: rect.bottom,
            container: event.currentTarget.closest(".lightbox") ?? undefined,
          });
        },
      })}
      {position && src && (
        <Suspense fallback={null}>
          <ImageMenu
            src={src}
            fileName={fileName}
            position={{ left: position.left, top: position.top }}
            container={position.container}
            onClose={() => setPosition(undefined)}
          />
        </Suspense>
      )}
    </>
  );
}
