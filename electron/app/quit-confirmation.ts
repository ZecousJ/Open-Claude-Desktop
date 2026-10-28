/**
 * Whether the person already agreed to interrupt running tasks for this
 * quit (the window's "Update anyway"). The quit then skips its own
 * "A task is still running" question; any other quit still asks.
 */
export const quitConfirmation = { interrupt: false };
