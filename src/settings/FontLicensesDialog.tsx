import { useEffect, useState } from "react";
import { Section, SettingsModal } from "./controls";
import "./font-licenses.css";

/** nameID13 from the bundled OpenDyslexic-Regular.woff2 (v2.001), also
 * recorded in THIRD_PARTY_NOTICES.md:59. Preserve the author's notice. */
export const openDyslexicLicenseNotice = [
  "Fonts are © Bitstream. OpenDyslexic changes and additional glyphs by Abelardo Gonzalez are licensed under a Creative Commons Attribution 3.0 Unported License.",
  "Based on a work at http://dyslexicfonts.com. 2012 by Abelardo Gonzalez. Copying is an act of love. Please copy.",
  "Bitstream license available here: http://opendyslexic.org/legal/",
].join("\n");

/** Source Serif 4's notice (src/assets/fonts/SourceSerif4Variable-*.woff2,
 * version 4.005), also in THIRD_PARTY_NOTICES.md. */
export const sourceSerifLicenseNotice = [
  "Source Serif 4 © 2014-2023 Adobe (https://adobe.com/), with Reserved Font Name 'Source'.",
  "This Font Software is licensed under the SIL Open Font License, Version 1.1.",
  "This license is available with a FAQ at: https://openfontlicense.org",
].join("\n");

/** Actual license information for the interface choices; local reference
 * fonts and operating-system fonts are not presented as shipped fonts. */
export function FontLicensesContent({
  onError,
}: {
  onError: (error: unknown) => void;
}) {
  return (
    <div className="font-licenses-content">
      <Section title="OpenDyslexic 2.001">
        <pre className="font-license-notice" data-no-translate>
          {openDyslexicLicenseNotice}
        </pre>
        <p>
          <a
            href="https://opendyslexic.org/legal/"
            target="_blank"
            rel="noreferrer"
            onClick={(event) => {
              if (
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              void window.desktop
                .openExternal("https://opendyslexic.org/legal/")
                .catch(onError);
            }}
          >
            OpenDyslexic website
          </a>
        </p>
      </Section>
      <Section title="Source Serif 4 (4.005)">
        <pre className="font-license-notice" data-no-translate>
          {sourceSerifLicenseNotice}
        </pre>
      </Section>
      <p>System fonts are supplied by your operating system.</p>
    </div>
  );
}

export function FontLicensesDialog({
  onClose,
  onError,
}: {
  onClose: () => void;
  onError: (error: unknown) => void;
}) {
  return (
    <SettingsModal title="Font licenses" onClose={onClose}>
      <FontLicensesContent onError={onError} />
    </SettingsModal>
  );
}
