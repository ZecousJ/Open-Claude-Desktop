// .
export class EarlyUpdateInstall {
  private downloaded = false;
  private windowOpened = false;
  private installing = false;

  constructor(private readonly install: () => void) {}

  onDownloaded() {
    this.downloaded = true;
  }

  update(state: {
    mainWindow: boolean;
    busy: boolean;
    ready: boolean;
    enabled: boolean;
  }) {
    this.windowOpened ||= state.mainWindow;
    if (
      !this.installing &&
      this.downloaded &&
      !this.windowOpened &&
      !state.busy &&
      state.ready &&
      state.enabled
    ) {
      this.installing = true;
      this.install();
    }
  }
}
