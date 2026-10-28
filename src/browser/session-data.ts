/** Launch server session data. */
export function sessionDataConfirmation(clear: boolean) {
  return {
    title: clear ? "Clear session data?" : "Keep cookies?",
    body: clear
      ? "This will delete all saved cookies, local storage, and other session data for Launch servers in all workspaces."
      : "Session data such as cookies and local storage will be saved across server restarts. This can be useful for staying logged in during development.",
    confirm: clear ? "Clear data" : "Enable",
    danger: clear,
  };
}

// .
export function browsingDataConfirmation(shared: boolean) {
  return {
    title: "Clear browsing data?",
    body: shared
      ? "This deletes the cookies, sign-ins, and site data the browser saves for every Code session and Cowork. You’ll need to sign in to sites again."
      : "This deletes the cookies, sign-ins, and site data saved for this session’s browser. You’ll need to sign in to sites again.",
    confirm: "Clear data",
    danger: true,
  };
}
