// The reference design.
export function previewLinkLabel(value: string, softWrap = true) {
  let label: string;
  try {
    const url = new URL(value);
    const hostname =
      url.hostname.length > 80 ? `…${url.hostname.slice(-80)}` : url.hostname;
    const origin = `${url.protocol}//${hostname}${url.port ? `:${url.port}` : ""}`;
    const suffix = value.slice(url.origin.length);
    label =
      origin +
      (suffix.length > 160
        ? `${suffix.slice(0, 80)}…${suffix.slice(-80)}`
        : suffix);
  } catch {
    label = value.slice(0, 160);
  }
  return softWrap && label.length > 40
    ? label.replace(/.{16}/g, "$&\u200B")
    : label;
}
