import type {
  OfficialUiReadRequest,
  OfficialUiReadResponse,
} from "../../shared/official-ui-web";
import {
  officialShareAddressPath,
  officialShareId,
  parseOfficialShareAddress,
} from "../../shared/official-share-link";

export async function readOfficialShareAddress(
  read: (request: OfficialUiReadRequest) => Promise<OfficialUiReadResponse>,
  id: string,
  origin: string,
) {
  const answer = await read({
    method: "GET",
    path: officialShareAddressPath(id),
  });
  if (
    answer.status !== 200 ||
    answer.body.byteLength > 8192 ||
    !/^text\/plain(?:;|$)/i.test(answer.contentType)
  )
    throw Error("The shared link could not be resolved.");
  return parseOfficialShareAddress(
    new TextDecoder("utf-8", { fatal: true }).decode(answer.body),
    origin,
  );
}

export function installOfficialShareClipboard({
  clipboard,
  clipboardItem,
  origin,
  resolve,
}: {
  clipboard?: Clipboard;
  clipboardItem?: typeof ClipboardItem;
  origin: string;
  resolve(id: string): Promise<string>;
}) {
  if (!clipboard) return;
  const writeText = clipboard.writeText.bind(clipboard);
  const write = clipboard.write?.bind(clipboard);
  const shareId = (text: string) => {
    if (URL.canParse(text)) return officialShareId(new URL(text), origin);
  };
  const writePlain =
    write &&
    clipboardItem &&
    ((text: Promise<Blob>, style?: PresentationStyle) => {
      void text.catch(() => {});
      return write([
        new clipboardItem({ "text/plain": text }, { presentationStyle: style }),
      ]);
    });
  const mappedBlob = (value: string) =>
    new Blob([value], { type: "text/plain" });
  clipboard.writeText = (text) => {
    const id = shareId(text);
    if (!id) return writeText(text);
    const target = resolve(id);
    return writePlain
      ? writePlain(target.then(mappedBlob))
      : target.then(writeText);
  };
  if (write && writePlain)
    clipboard.write = (items) => {
      const item = items[0];
      if (
        items.length !== 1 ||
        item?.types.length !== 1 ||
        item.types[0] !== "text/plain"
      )
        return write(items);
      // The original invitation flow supplies promised text. Write before waiting
      // for its mutation or the address lookup so the browser keeps user activation.
      return writePlain(
        item.getType("text/plain").then(async (blob) => {
          if (blob.size > 8192) return blob;
          const id = shareId(await blob.text());
          return id ? mappedBlob(await resolve(id)) : blob;
        }),
        item.presentationStyle,
      );
    };
}
