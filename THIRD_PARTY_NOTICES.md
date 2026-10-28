# Third-party notices

Claudex is an independent project whose interface is inspired by Claude's apps. It is not an Anthropic product and is not endorsed by Anthropic or OpenAI. Credentials and personal conversation data are not bundled.

## Desktop and web app

The application bundles **OpenAI Codex 0.144.1**, licensed under Apache License 2.0. Source: https://github.com/openai/codex . The package preserves the upstream runtime layout, code-mode host, ripgrep, and shell resources. Upstream third-party licensing information is in https://github.com/openai/codex/blob/main/NOTICE .

Electron is MIT licensed; its Chromium and third-party notices ship with the Electron runtime. React, React DOM, Vite, TypeScript, Zod, react-markdown, remark-gfm, and lucide-react are distributed under their respective open-source licenses. The exact dependency versions are recorded in package-lock.json. @iarna/toml is ISC licensed. The interactive terminal uses @xterm/xterm 6.0.0 and @xterm/addon-fit 0.11.0, both MIT licensed (https://github.com/xtermjs/xterm.js). Math in replies is rendered with KaTeX (MIT, https://katex.org, including its bundled fonts under the SIL Open Font License 1.1) through remark-math and rehype-katex (MIT). Payment QR codes in Settings → Billing are drawn with **node-qrcode 1.5.4** (`qrcode` on npm, MIT, Copyright (c) 2012 Ryan Day, https://github.com/soldair/node-qrcode), whose browser build includes dijkstrajs 1.0.3 (MIT).

Artifact previews run the following libraries inside the sandboxed preview frame. Mermaid and Mammoth are inlined as the unmodified browser builds from their published packages; pdf.js and the React runtime are bundled and minified from their published packages when Claudex is built, without source changes.

- **Mermaid 12.0.0** (MIT, https://github.com/mermaid-js/mermaid) is used as its complete browser build, which contains **elkjs 0.9.3**, a build of the Eclipse Layout Kernel licensed under the **Eclipse Public License 2.0** (https://www.eclipse.org/legal/epl-2.0/). That EPL-2.0 code is distributed in object form only; its source is available from https://github.com/kieler/elkjs and https://github.com/eclipse/elk . The Mermaid build also contains DOMPurify (MPL-2.0 or Apache-2.0, used under Apache-2.0), Chevrotain (Apache-2.0), d3 and its modules (ISC, except d3-ease and d3-sankey with its d3 1.x modules, which are BSD-3-Clause), robust-predicates (Unlicense), and cytoscape, dagre-d3-es, roughjs, KaTeX, dayjs, khroma, marked, stylis, lodash-es and other MIT-licensed modules.
- PDF files are rendered with **pdf.js** from pdfjs-dist 6.3.289 (Apache-2.0, https://github.com/mozilla/pdf.js). Its predefined **Adobe CMaps** (the `cmaps/*.bcmap` files of pdfjs-dist, needed for PDFs whose CJK text uses them) are inlined into the preview. They are Copyright 1990-2009 Adobe Systems Incorporated, all rights reserved, and are redistributed under the BSD-3-Clause-style terms in `pdfjs-dist/cmaps/LICENSE`: redistributions keep that copyright notice, the list of conditions and the disclaimer; the name of Adobe Systems Incorporated and of its contributors may not be used to endorse or promote derived products without prior written permission; and the files are provided "as is", without express or implied warranties, and the copyright holders and contributors are not liable for any damages arising from their use.
- Word documents are converted with **Mammoth 1.12.3** (BSD-2-Clause, https://github.com/mwilliamson/mammoth.js), whose browser build contains JSZip (MIT or GPL-3.0-or-later, used under MIT), pako (MIT and Zlib), lop, option and dingbat-to-unicode (BSD-2-Clause), ieee754 (BSD-3-Clause), and bluebird, underscore, @xmldom/xmldom, base64-js, buffer, readable-stream, lie, immediate and other MIT-licensed modules.
- React artifacts run on React and React DOM with scheduler (MIT) and lucide-react (ISC), and are compiled in the application with **Sucrase 3.35.1** (MIT, https://github.com/alangpierce/sucrase), which includes ts-interface-checker (Apache-2.0) and lines-and-columns and the @jridgewell source-map modules (MIT).

The full license texts are included in each package as published on npm; exact versions are recorded in package-lock.json.

## ProseMirror Chat editor

The Chat editor dynamically loads **prosemirror-model**, **prosemirror-state**, **prosemirror-view**, **prosemirror-commands**, **prosemirror-history**, and **prosemirror-keymap**, together with **prosemirror-transform**, **orderedmap**, **rope-sequence**, and **w3c-keyname**. Source: https://github.com/ProseMirror . Exact versions are recorded in package-lock.json. The packages are MIT licensed: Copyright (C) 2015–2017 by Marijn Haverbeke and others; orderedmap and w3c-keyname Copyright (C) 2016 by Marijn Haverbeke and others; rope-sequence Copyright (C) 2016 by Marijn Haverbeke.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Computer use driver

Computer use runs through **Open Computer Use 0.3.5** (npm package `open-computer-use`, MIT License, Copyright (c) 2026 Leo, https://github.com/iFurySt/open-codex-computer-use, commit `386a260d1ab8b690adbbb27f7471595cf0c2b752`). `scripts/computer-use/fetch-driver.mjs` installs the native runtime for the target platform, checked against the SHA-256 hashes pinned in `scripts/computer-use/drivers.json`, into the package's `resources/computer-use` directory, together with the upstream `LICENSE` and a `NOTICES.md` that carries the notices below in full. Details are in `docs/computer-use.md`.

- The macOS runtime contains code derived from **Cua Driver** (https://github.com/trycua/cua, MIT, Copyright (c) 2025 Cua AI, Inc.) and **yabai** (https://github.com/asmvik/yabai, MIT, Copyright (c) 2019 Åsmund Vikane), as recorded in the upstream notices. Claudex does not include any other part of Cua; in particular it does not include the AGPL-3.0 `cua-perception` extension.
- The Windows runtime is a Go program and links the Go standard library and runtime (BSD 3-Clause License, Copyright 2009 The Go Authors).
- Claudex packages the runtime unchanged except that, on macOS, it leaves out the image `official-software-cursor-window-252.png`, which upstream extracted from another vendor's application and which the MIT license does not cover, and signs the helper bundle again. The driver then draws its own cursor.

## Claudex server: a modified Sub2API (LGPL-3.0)

The `backend/` directory is the Claudex server, a fork of **Sub2API** (https://github.com/Wei-Shaw/sub2api) at upstream commit `a3eb7ef302961cba716dc78b39b93b60c467db0e` (version 0.2.8). It keeps the upstream layout and every original Sub2API feature, and has been modified by the Claudex project since 2026-09-26. It is licensed under the **GNU Lesser General Public License v3.0**: `backend/LICENSE` is the upstream license file, unchanged, and `backend/COPYING` holds the GNU General Public License v3.0 on which the LGPL builds. The upstream `CLA.md`, README files and copyright notices are kept unchanged.

- **Changes:** `backend/CLAUDEX_CHANGES.md` lists every change to upstream files and every Claudex file added inside `backend/`; the repository history of `backend/` has the diffs and dates. Each change in an upstream file carries a `CLAUDEX:` marker.
- **Source offer:** `backend/SOURCE_OFFER.md` says what the corresponding source of a server image or binary is (the `backend/` directory and the build scripts at the commit recorded in `/app/SOURCE.txt`) and how to provide it when the server is distributed.
- Server images carry `/app/LICENSE`, `/app/COPYING`, `/app/CLAUDEX_CHANGES.md`, `/app/SOURCE.txt` and the OCI label `org.opencontainers.image.licenses=LGPL-3.0-only`.
- The server's own dependencies (Go modules in `backend/backend/go.mod`, npm packages in `backend/frontend/package.json`) keep their licenses, recorded in those manifests and their lock files.
- **Note for operators:** the upstream README (`backend/README.md`, “Important Notice”; `backend/README_CN.md`) states that the Sub2API developers have never authorized any individual or organization to run a commercial operation based on the project, and that anyone who does so bears the resulting disputes and liabilities alone. It is recorded here as written, not as a legal assessment.
- `backend/backend/internal/claudex/geoip/ip2region_v4.xdb` is the offline IP database of **ip2region** (Apache License 2.0, https://github.com/lionsoul2014/ip2region), embedded unchanged.

The Claudex desktop application contains no code from `backend/`. It talks to the server over HTTP (HTTPS in production) only.

## License boundary

- `backend/`: GNU Lesser General Public License v3.0 (`backend/LICENSE`, with `backend/COPYING`).
- Everything else in this repository, including the Claudex desktop application, except the third-party software and assets identified here: Apache License 2.0; see LICENSE.


## api-image

The image skill in `vendor/api-image` (bundled through `electron/skills/api-image-files.ts`) comes from https://github.com/yc-duan/api-image.

MIT License

Copyright (c) 2026 api-image contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

The OpenDyslexic chat font (`src/assets/fonts/OpenDyslexic-*.woff2`, version 2.001) is by Abelardo Gonzalez (https://opendyslexic.org), based on Bitstream Vera; the OpenDyslexic changes and additional glyphs are licensed under the Creative Commons Attribution 3.0 Unported License, and the original Bitstream Vera fonts are © Bitstream under the Bitstream Vera license.

The Source Serif 4 interface serif (`src/assets/fonts/SourceSerif4Variable-Roman.ttf.woff2` and `-Italic`, version 4.005, https://github.com/adobe-fonts/source-serif) is © 2014-2023 Adobe, with Reserved Font Name "Source", and is licensed under the SIL Open Font License, Version 1.1 (https://openfontlicense.org).


## highlight.js GitHub syntax palettes

The GitHub Light and GitHub Dark syntax colour tables are extracted from **highlight.js 11.11.2**, `styles/github.css` and `styles/github-dark.css`. Those styles identify github.com as author, @Hirse as maintainer, and the update date 2021-05-15. Upstream: https://github.com/highlightjs/highlight.js . The application retains its existing Claudex palettes as the defaults.

BSD 3-Clause License

Copyright (c) 2006, Ivan Sagalaev.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of the copyright holder nor the names of its
  contributors may be used to endorse or promote products derived from
  this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## CodeMirror and Lezer

The Code file editor uses the MIT-licensed CodeMirror and Lezer packages.
Source: https://github.com/codemirror and https://github.com/lezer-parser.

Packages: `@codemirror/autocomplete`, `@codemirror/commands`, `@codemirror/lang-css`, `@codemirror/lang-html`, `@codemirror/lang-javascript`, `@codemirror/lang-json`, `@codemirror/lang-markdown`, `@codemirror/language`, `@codemirror/lint`, `@codemirror/search`, `@codemirror/state`, `@codemirror/streamparser`, `@codemirror/view`.

```text
MIT License

Copyright (C) 2018-2021 by Marijn Haverbeke <marijn@haverbeke.berlin> and others

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

Packages: `@lezer/common`, `@lezer/css`, `@lezer/highlight`, `@lezer/html`, `@lezer/javascript`, `@lezer/lr`.

```text
MIT License

Copyright (C) 2018 by Marijn Haverbeke <marijn@haverbeke.berlin> and others

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

Packages: `@lezer/json`.

```text
MIT License

Copyright (C) 2020 by Marijn Haverbeke <marijn@haverbeke.berlin>, Arun Srinivasan <rulfzid@gmail.com>, and others

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

Packages: `@lezer/markdown`.

```text
MIT License

Copyright (C) 2020 by Marijn Haverbeke <marijn@haverbeke.berlin> and others

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## Phone apps

- The iOS app bundles **Noto Serif** and **Noto Serif SC** (Copyright 2022 The Noto Project Authors) and **JetBrains Mono** (Copyright 2020 The JetBrains Mono Project Authors), all under the SIL Open Font License 1.1; the license text is in `mobile/ios/Claudex/Resources/Fonts/OFL.txt`. Its icons are the system's SF Symbols, which are not bundled.
- The Android app bundles **JetBrains Mono** (SIL Open Font License 1.1, `mobile/android/app/src/main/assets/transcript-official/OFL.txt`). Its icons come from Material Icons (`material-icons-extended`, Apache License 2.0). Its other dependencies are fetched by Gradle and keep their own licenses.
- Both apps carry the shared conversation bundle built from this repository, which includes KaTeX's fonts and Source Serif 4 under the licenses above.
