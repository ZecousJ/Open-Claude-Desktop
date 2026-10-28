/** Keep the themed background while authentication and workspace data load.
 * A partial greeting/composer differs from the real controls and creates a
 * visible layout jump when the workspace replaces it.
 */
export function BootShell({ native = false }: { native?: boolean }) {
  return (
    <div className="boot-shell" aria-busy="true">
      {native && <div className="boot-drag-strip" aria-hidden="true" />}
    </div>
  );
}

export function WebBoot() {
  return <BootShell />;
}
