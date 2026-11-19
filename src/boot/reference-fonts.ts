import type { DesktopAPI } from "../../shared/types";

type ReferenceFonts = DesktopAPI["referenceFonts"];

/**
 * Consume the bridge that actually supplies fonts. The browser bridge returns
 * an empty list; the local preview can supply the installed fonts even while
 * rendering the web surface. A surface capability is therefore not a font
 * delivery check.
 */
export async function loadReferenceFonts(
  readFonts: ReferenceFonts | undefined,
  target: Pick<Document, "documentElement" | "fonts"> = document,
  Face: typeof FontFace = FontFace,
) {
  delete target.documentElement.dataset.referenceFonts;
  if (!readFonts) return;
  try {
    const fonts = await readFonts();
    const loaded = await Promise.allSettled(
      fonts.map(async (font) => {
        const face = new Face(font.family, Uint8Array.from(font.data).buffer, {
          style: font.style,
          weight: "300 800",
          display: "swap",
        });
        await face.load();
        target.fonts.add(face);
        return font;
      }),
    );
    // A missing italic must not discard successfully loaded roman faces, and
    // an italic alone must not claim that the normal body font is available.
    const normal = new Set(
      loaded.flatMap((result) =>
        result.status === "fulfilled" && result.value.style === "normal"
          ? [result.value.family]
          : [],
      ),
    );
    if (
      normal.has("Claudex Reference Serif") &&
      normal.has("Claudex Reference Sans")
    )
      target.documentElement.dataset.referenceFonts = "true";
  } catch {
    // The existing system fallback remains usable when the bridge fails.
  }
}
