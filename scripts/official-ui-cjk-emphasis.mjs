import fs from 'node:fs';
import path from 'node:path';

// Recover emphasis when a CJK closing punctuation mark meets a word directly.
// Operate on parsed text nodes so code, escapes and links keep their meaning.
export function cjkEmphasis() {
  const pattern = /\*\*([^*\r\n]*[\u3001-\u303f\uff01-\uff65])([ \t]*)\*\*(?=[\p{L}\p{N}])/gu;
  function visit(node, file) {
    if (!Array.isArray(node.children) || ['code', 'inlineCode', 'html', 'math', 'inlineMath', 'strong'].includes(node.type)) return;
    const next = [];
    for (const child of node.children) {
      if (child.type !== 'text' || typeof child.value !== 'string') {
        visit(child, file); next.push(child); continue;
      }
      const start = child.position?.start;
      const end = child.position?.end;
      const source = String(file.value ?? '');
      if (!start || !end || start.line !== end.line || source.slice(start.offset, end.offset) !== child.value) {
        next.push(child); continue;
      }
      const value = child.value;
      let cursor = 0, match;
      pattern.lastIndex = 0;
      const position = (from, to) => ({
        start: { line: start.line, column: start.column + from, offset: start.offset + from },
        end: { line: start.line, column: start.column + to, offset: start.offset + to },
      });
      const text = (from, to) => ({ type: 'text', value: value.slice(from, to), position: position(from, to) });
      while ((match = pattern.exec(value))) {
        const begin = match.index, close = begin + match[0].length;
        if (begin > cursor) next.push(text(cursor, begin));
        const bodyEnd = begin + 2 + match[1].length;
        next.push({ type: 'strong', position: position(begin, close), children: [text(begin + 2, bodyEnd)] });
        if (match[2]) next.push({ type: 'text', value: match[2], position: position(bodyEnd, bodyEnd + match[2].length) });
        cursor = close;
      }
      if (cursor === 0) next.push(child);
      else if (cursor < value.length) next.push(text(cursor, value.length));
    }
    node.children = next;
  }
  return (tree, file) => visit(tree, file);
}

export const cjkEmphasisRevision = 'cjk-emphasis-v1';
export const cjkEmphasisTarget = 'shared-38-ChyOhHlY.js';
const anchor = 'function wI(e, t, n) {\n  return Fj()\n    .use(eI)\n    .use(e ?? k0)\n    .use(ny)';
export function deriveCjkEmphasisModule(name, source) {
  if (name !== cjkEmphasisTarget) return source;
  const first = source.indexOf(anchor);
  if (first < 0 || source.indexOf(anchor, first + anchor.length) >= 0) throw Error('CJK emphasis anchor mismatch');
  const ownSource = fs.readFileSync(path.resolve('scripts/official-ui-cjk-emphasis.mjs'), 'utf8');
  const begin = ownSource.indexOf('export function cjkEmphasis() {');
  const end = ownSource.indexOf('\nexport const cjkEmphasisRevision', begin);
  if (begin < 0 || end < 0) throw Error('CJK emphasis source missing');
  const implementation = ownSource.slice(begin, end).replace('export function', 'function');
  return source.replace(anchor, `${implementation}\nfunction wI(e, t, n) {\n  return Fj()\n    .use(eI)\n    .use(e ?? k0)\n    .use(cjkEmphasis)\n    .use(ny)`);
}
export function applyCjkEmphasis(directory) {
  const file = path.join(directory, cjkEmphasisTarget);
  fs.writeFileSync(file, deriveCjkEmphasisModule(cjkEmphasisTarget, fs.readFileSync(file, 'utf8')));
  return { revision: cjkEmphasisRevision };
}
