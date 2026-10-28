import type { ReactNode } from "react";

/** Native panels remain buttons; web cards keep the browser's link actions. */
export function ArtifactOpenLink({
  href,
  className,
  children,
  onOpen,
}: {
  href?: string;
  className: string;
  children: ReactNode;
  onOpen: () => void;
}) {
  return href ? (
    <a
      href={href}
      className={className}
      onClick={(event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        onOpen();
      }}
    >
      {children}
    </a>
  ) : (
    <button type="button" className={className} onClick={onOpen}>
      {children}
    </button>
  );
}
