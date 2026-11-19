const sessionKey = "(?:session|cse)_([a-f0-9]{32})";
const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const sessionFile = new RegExp(`^/v1/code/sessions/${sessionKey}/file$`);
const coworkDownload = new RegExp(
  `^/api/organizations/(${uuid})/cowork/sessions/${sessionKey}/download-file$`,
);

export function isOfficialSessionFilePath(pathname: string) {
  return sessionFile.test(pathname);
}

export function isOfficialWorkspaceDownloadPath(pathname: string) {
  return isOfficialSessionFilePath(pathname) || coworkDownload.test(pathname);
}

export function officialWorkspaceDownload(
  method: string,
  pathname: string,
  search: string,
) {
  if (method !== "GET") return undefined;
  const cowork = coworkDownload.exec(pathname);
  const key = cowork?.[2] ?? sessionFile.exec(pathname)?.[1];
  if (!key) return undefined;
  const params = new URLSearchParams(search);
  const file = params.get("path");
  if (params.size !== 1 || !file || file.length > 4096 || file.includes("\0"))
    return undefined;
  return { key, file, organization: cowork?.[1] };
}
