# Embedded assets of the share viewer

- `mermaid.min.js.gz`: `dist/mermaid.min.js` of the npm package `mermaid@12.0.0`
  (MIT, https://github.com/mermaid-js/mermaid), unmodified, compressed with
  `gzip -9 -n`. SHA-256 of the uncompressed file:
  `28fca7ae6ebc7ed7bb63bde63136a74bfef14f296a57e403657eeb8b32836073`.
  It is the complete browser build and contains elkjs 0.9.3 (EPL-2.0, object
  form only; source at https://github.com/kieler/elkjs and
  https://github.com/eclipse/elk) and the other bundled modules listed in the
  repository's THIRD_PARTY_NOTICES.md. The same build is used by the desktop
  app's artifact previews.
- `LICENSE.mermaid.txt`: Mermaid's licence, also served at
  `/s/_assets/LICENSE.mermaid.txt`.

To update: take `dist/mermaid.min.js` from the version pinned in the root
package.json, `gzip -9 -n -c mermaid.min.js > mermaid.min.js.gz`, update the
hash above and the version in THIRD_PARTY_NOTICES.md.
