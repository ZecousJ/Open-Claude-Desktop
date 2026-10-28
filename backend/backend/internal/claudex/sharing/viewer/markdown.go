package viewer

import (
	"html/template"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Markdown renders the Markdown subset of shared replies as HTML that is safe
// to put into a page (design R1 5.3): paragraphs, ATX and setext headings,
// bullet, ordered and task lists, block quotes, fenced code, thematic
// breaks, GFM tables, code spans, strong, emphasis, strikethrough, inline
// links, autolinks and bare http(s) URLs.
//
// Every piece of source text is HTML-escaped; raw HTML is shown as text.
// Only http, https and mailto links become anchors, all with
// rel="nofollow noopener noreferrer ugc" and target="_blank". Images are
// never loaded: ![alt](url) becomes a link labelled with the alt text.
// Mermaid and math stay code blocks. Nesting is capped (maxBlockDepth,
// maxInlineDepth) and every scan is linear per nesting level, so hostile
// input cannot exhaust the stack or the CPU.
func Markdown(src string) template.HTML {
	src = strings.ReplaceAll(src, "\r\n", "\n")
	src = strings.ReplaceAll(src, "\r", "\n")
	src = strings.ReplaceAll(src, "\x00", "�")
	var b buf
	renderBlocks(&b, strings.Split(src, "\n"), 0, false)
	return template.HTML(b.String()) // #nosec G203 -- built only from escaped text and fixed tags
}

// buf collects rendered HTML; strings.Builder writes never fail.
type buf struct{ sb strings.Builder }

func (b *buf) s(str string)   { _, _ = b.sb.WriteString(str) }
func (b *buf) c(ch byte)      { _ = b.sb.WriteByte(ch) }
func (b *buf) r(r rune)       { _, _ = b.sb.WriteRune(r) }
func (b *buf) Len() int       { return b.sb.Len() }
func (b *buf) Reset()         { b.sb.Reset() }
func (b *buf) String() string { return b.sb.String() }

const (
	maxBlockDepth  = 12
	maxInlineDepth = 8
)

const linkRel = `rel="nofollow noopener noreferrer ugc" target="_blank"`

var (
	reATX        = regexp.MustCompile(`^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$`)
	reATXClose   = regexp.MustCompile(`(?:^|[ \t]+)#+[ \t]*$`)
	reHR         = regexp.MustCompile(`^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$`)
	reSetext1    = regexp.MustCompile(`^ {0,3}=+[ \t]*$`)
	reSetext2    = regexp.MustCompile(`^ {0,3}-+[ \t]*$`)
	reFence      = regexp.MustCompile("^( {0,3})(`{3,}|~{3,})(.*)$")
	reBullet     = regexp.MustCompile(`^( {0,3})([-*+])(?:([ \t]+)(.*))?$`)
	reOrdered    = regexp.MustCompile(`^( {0,3})([0-9]{1,9})([.)])(?:([ \t]+)(.*))?$`)
	reQuote      = regexp.MustCompile(`^ {0,3}>`)
	reTableDelim = regexp.MustCompile(`^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$`)
	reTaskMarker = regexp.MustCompile(`^\[([ xX])\](?:[ \t]+|$)`)
)

func isBlank(line string) bool { return strings.TrimSpace(line) == "" }

// indentOf counts leading columns (a tab advances to the next multiple of 4).
func indentOf(line string) int {
	n := 0
	for _, r := range line {
		switch r {
		case ' ':
			n++
		case '\t':
			n += 4 - n%4
		default:
			return n
		}
	}
	return n
}

// dedent removes up to n columns of leading whitespace.
func dedent(line string, n int) string {
	col := 0
	for i, r := range line {
		if col >= n {
			return line[i:]
		}
		switch r {
		case ' ':
			col++
		case '\t':
			next := col + 4 - col%4
			if next > n {
				return strings.Repeat(" ", next-n) + line[i+1:]
			}
			col = next
		default:
			return line[i:]
		}
	}
	return ""
}

// startsBlock reports whether line opens a block that interrupts a
// paragraph.
func startsBlock(line string) bool {
	if reFence.MatchString(line) || reATX.MatchString(line) || reHR.MatchString(line) || reQuote.MatchString(line) {
		return true
	}
	if m := reBullet.FindStringSubmatch(line); m != nil && strings.TrimSpace(m[4]) != "" {
		return true
	}
	if m := reOrdered.FindStringSubmatch(line); m != nil && m[2] == "1" && strings.TrimSpace(m[5]) != "" {
		return true
	}
	return false
}

// renderBlocks renders lines as block content. tight renders paragraphs
// without <p> (tight list items).
func renderBlocks(b *buf, lines []string, depth int, tight bool) {
	if depth > maxBlockDepth {
		text := strings.TrimSpace(strings.Join(lines, "\n"))
		if text != "" {
			b.s("<p>")
			b.s(template.HTMLEscapeString(text))
			b.s("</p>\n")
		}
		return
	}
	for i := 0; i < len(lines); {
		line := lines[i]
		switch {
		case isBlank(line):
			i++
		case reFence.MatchString(line):
			i = renderFence(b, lines, i)
		case reHR.MatchString(line):
			b.s("<hr>\n")
			i++
		case reATX.MatchString(line):
			m := reATX.FindStringSubmatch(line)
			text := strings.TrimSpace(reATXClose.ReplaceAllString(m[2], ""))
			level := strconv.Itoa(len(m[1]))
			b.s("<h" + level + ">")
			renderInline(b, text, 0, false)
			b.s("</h" + level + ">\n")
			i++
		case reQuote.MatchString(line):
			var inner []string
			for i < len(lines) && reQuote.MatchString(lines[i]) {
				l := strings.TrimPrefix(strings.TrimLeft(lines[i], " ")[1:], " ")
				inner = append(inner, l)
				i++
			}
			b.s("<blockquote>\n")
			renderBlocks(b, inner, depth+1, false)
			b.s("</blockquote>\n")
		case reBullet.MatchString(line) || reOrdered.MatchString(line):
			i = renderList(b, lines, i, depth)
		case i+1 < len(lines) && strings.Contains(line, "|") && reTableDelim.MatchString(lines[i+1]) &&
			len(splitRow(line)) == len(splitRow(lines[i+1])):
			i = renderTable(b, lines, i)
		default:
			i = renderParagraph(b, lines, i, tight)
		}
	}
}

func renderFence(b *buf, lines []string, i int) int {
	m := reFence.FindStringSubmatch(lines[i])
	indent, fence, info := len(m[1]), m[2], strings.TrimSpace(m[3])
	if fence[0] == '`' && strings.Contains(info, "`") {
		// Not a fence (CommonMark): a backtick info string cannot hold backticks.
		return renderParagraph(b, lines, i, false)
	}
	lang := ""
	if f := strings.Fields(info); len(f) > 0 {
		lang = langClass(f[0])
	}
	var body []string
	j := i + 1
	for ; j < len(lines); j++ {
		l := lines[j]
		t := strings.TrimLeft(l, " ")
		if len(l)-len(t) <= 3 && strings.HasPrefix(t, fence[:1]) {
			run := len(t) - len(strings.TrimLeft(t, fence[:1]))
			if run >= len(fence) && strings.TrimSpace(t[run:]) == "" {
				break
			}
		}
		body = append(body, dedent(l, indent))
	}
	writeCodeBlock(b, lang, strings.Join(body, "\n"))
	if j < len(lines) {
		j++ // closing fence
	}
	return j
}

func writeCodeBlock(b *buf, lang, code string) {
	b.s(`<div class="code-block"><div class="code-bar">`)
	if lang != "" {
		b.s(template.HTMLEscapeString(lang))
	} else {
		b.s("code")
	}
	b.s(`</div><pre><code`)
	if lang != "" {
		b.s(` class="language-` + template.HTMLEscapeString(lang) + `"`)
	}
	b.s(">")
	b.s(template.HTMLEscapeString(code))
	b.s("</code></pre></div>\n")
}

func renderParagraph(b *buf, lines []string, i int, tight bool) int {
	var para []string
	para = append(para, strings.TrimLeft(lines[i], " \t"))
	j := i + 1
	heading := ""
	for ; j < len(lines); j++ {
		l := lines[j]
		if isBlank(l) {
			break
		}
		if reSetext1.MatchString(l) {
			heading = "1"
			j++
			break
		}
		if reSetext2.MatchString(l) {
			heading = "2"
			j++
			break
		}
		if startsBlock(l) {
			break
		}
		para = append(para, strings.TrimLeft(l, " \t"))
	}
	text := strings.TrimRight(strings.Join(para, "\n"), " \t")
	switch {
	case heading != "":
		b.s("<h" + heading + ">")
		renderInline(b, text, 0, false)
		b.s("</h" + heading + ">\n")
	case tight:
		renderInline(b, text, 0, false)
		b.s("\n")
	default:
		b.s("<p>")
		renderInline(b, text, 0, false)
		b.s("</p>\n")
	}
	return j
}

// listMarker describes the marker of a list item line; ok is false for any
// other line.
type listMarker struct {
	ok      bool
	ordered bool
	delim   byte // bullet char or ordered delimiter
	start   int
	width   int // content column
	content string
}

func parseMarker(line string) listMarker {
	if reHR.MatchString(line) {
		return listMarker{}
	}
	if m := reBullet.FindStringSubmatch(line); m != nil {
		return markerFrom(false, m[2][0], 0, len(m[1])+1, m[3], m[4])
	}
	if m := reOrdered.FindStringSubmatch(line); m != nil {
		n, _ := strconv.Atoi(m[2])
		return markerFrom(true, m[3][0], n, len(m[1])+len(m[2])+1, m[4], m[5])
	}
	return listMarker{}
}

func markerFrom(ordered bool, delim byte, start, markerEnd int, spaces, content string) listMarker {
	gap := indentOf(spaces)
	if gap == 0 || gap > 4 || strings.TrimSpace(content) == "" {
		gap = 1
	}
	if gap > 4 {
		content = strings.Repeat(" ", gap-1) + content
		gap = 1
	}
	return listMarker{ok: true, ordered: ordered, delim: delim, start: start, width: markerEnd + gap, content: content}
}

func renderList(b *buf, lines []string, i, depth int) int {
	first := parseMarker(lines[i])
	type item struct{ lines []string }
	var items []item
	loose := false
	j := i
	for j < len(lines) {
		mk := parseMarker(lines[j])
		if !mk.ok || mk.ordered != first.ordered || mk.delim != first.delim {
			break
		}
		it := item{lines: []string{mk.content}}
		j++
		blankRun := 0
		for j < len(lines) {
			l := lines[j]
			if isBlank(l) {
				blankRun++
				it.lines = append(it.lines, "")
				j++
				continue
			}
			if indentOf(l) >= mk.width {
				if blankRun > 0 {
					loose = true
				}
				blankRun = 0
				it.lines = append(it.lines, dedent(l, mk.width))
				j++
				continue
			}
			if blankRun == 0 && !startsBlock(l) && !parseMarker(l).ok {
				// Lazy paragraph continuation.
				it.lines = append(it.lines, strings.TrimLeft(l, " \t"))
				j++
				continue
			}
			break
		}
		// Trailing blank lines belong between items (or after the list).
		for len(it.lines) > 0 && it.lines[len(it.lines)-1] == "" {
			it.lines = it.lines[:len(it.lines)-1]
		}
		items = append(items, it)
		if blankRun > 0 {
			if n := parseMarker(safeLine(lines, j)); n.ok && n.ordered == first.ordered && n.delim == first.delim {
				loose = true
			}
		}
	}
	tag := "ul"
	if first.ordered {
		tag = "ol"
	}
	b.s("<" + tag)
	if first.ordered && first.start != 1 {
		b.s(` start="` + strconv.Itoa(first.start) + `"`)
	}
	b.s(">\n")
	for _, it := range items {
		b.s("<li>")
		content := it.lines
		if len(content) > 0 {
			if m := reTaskMarker.FindStringSubmatch(content[0]); m != nil {
				if m[1] == " " {
					b.s(`<input type="checkbox" disabled> `)
				} else {
					b.s(`<input type="checkbox" checked disabled> `)
				}
				content = append([]string{content[0][len(m[0]):]}, content[1:]...)
			}
		}
		renderBlocks(b, content, depth+1, !loose)
		b.s("</li>\n")
	}
	b.s("</" + tag + ">\n")
	return j
}

func safeLine(lines []string, i int) string {
	if i < len(lines) {
		return lines[i]
	}
	return ""
}

// splitRow splits a table row on unescaped pipes (GFM splits inside code
// spans too; \| keeps a literal pipe).
func splitRow(line string) []string {
	s := strings.TrimSpace(line)
	s = strings.TrimPrefix(s, "|")
	if strings.HasSuffix(s, "|") && !strings.HasSuffix(s, `\|`) {
		s = s[:len(s)-1]
	}
	var cells []string
	var cur buf
	for k := 0; k < len(s); k++ {
		switch {
		case s[k] == '\\' && k+1 < len(s) && s[k+1] == '|':
			cur.c('|')
			k++
		case s[k] == '|':
			cells = append(cells, strings.TrimSpace(cur.String()))
			cur.Reset()
		default:
			cur.c(s[k])
		}
	}
	return append(cells, strings.TrimSpace(cur.String()))
}

func renderTable(b *buf, lines []string, i int) int {
	head := splitRow(lines[i])
	delims := splitRow(lines[i+1])
	align := make([]string, len(delims))
	for k, d := range delims {
		left, right := strings.HasPrefix(d, ":"), strings.HasSuffix(d, ":")
		switch {
		case left && right:
			align[k] = ` class="al-c"`
		case right:
			align[k] = ` class="al-r"`
		case left:
			align[k] = ` class="al-l"`
		}
	}
	b.s(`<div class="table-wrap"><table><thead><tr>`)
	for k := range delims {
		b.s("<th" + align[k] + ">")
		if k < len(head) {
			renderInline(b, head[k], 0, false)
		}
		b.s("</th>")
	}
	b.s("</tr></thead>")
	j := i + 2
	if j < len(lines) && !isBlank(lines[j]) && !startsBlock(lines[j]) {
		b.s("<tbody>")
		for ; j < len(lines) && !isBlank(lines[j]) && !startsBlock(lines[j]); j++ {
			row := splitRow(lines[j])
			b.s("<tr>")
			for k := range delims {
				b.s("<td" + align[k] + ">")
				if k < len(row) {
					renderInline(b, row[k], 0, false)
				}
				b.s("</td>")
			}
			b.s("</tr>")
		}
		b.s("</tbody>")
	}
	b.s("</table></div>\n")
	return j
}

// inlineScan holds per-string lookups that keep inline parsing linear: code
// span ends by start offset, matching brackets, and the offsets from which a
// closing delimiter run is known not to exist.
type inlineScan struct {
	s        string
	codeEnd  map[int]int // start of an opening backtick run -> end of the span
	codeLen  map[int]int // start -> length of the backtick run
	bracket  map[int]int // '[' offset -> matching ']' offset
	failFrom map[closerKey]int
}

// closerKey identifies one closer search: delimiter, run length and the end
// of the range searched. For a fixed key, a search that fails from offset p
// fails from every later offset too, since whether a run can close does not
// depend on the opener.
type closerKey struct {
	c     byte
	n     int
	limit int
}

func newInlineScan(s string) *inlineScan {
	sc := &inlineScan{s: s, codeEnd: map[int]int{}, codeLen: map[int]int{}, bracket: map[int]int{}, failFrom: map[closerKey]int{}}
	// Code spans first: they bind tighter than everything else.
	noCloser := map[int]int{} // run length -> offset from which no closer exists
	for i := 0; i < len(s); {
		if s[i] == '\\' && i+1 < len(s) {
			i += 2
			continue
		}
		if s[i] != '`' {
			i++
			continue
		}
		k := runLen(s, i, '`')
		if from, ok := noCloser[k]; ok && i+k >= from {
			i += k
			continue
		}
		end := -1
		for j := i + k; j < len(s); {
			if s[j] != '`' {
				j++
				continue
			}
			r := runLen(s, j, '`')
			if r == k {
				end = j
				break
			}
			j += r
		}
		if end < 0 {
			noCloser[k] = i + k
			i += k
			continue
		}
		sc.codeEnd[i] = end + k
		sc.codeLen[i] = k
		i = end + k
	}
	// Brackets, skipping escapes and code spans.
	var stack []int
	for i := 0; i < len(s); {
		if e, ok := sc.codeEnd[i]; ok {
			i = e
			continue
		}
		switch s[i] {
		case '\\':
			i += 2
			continue
		case '[':
			stack = append(stack, i)
		case ']':
			if len(stack) > 0 {
				sc.bracket[stack[len(stack)-1]] = i
				stack = stack[:len(stack)-1]
			}
		}
		i++
	}
	return sc
}

func runLen(s string, i int, c byte) int {
	n := 0
	for i+n < len(s) && s[i+n] == c {
		n++
	}
	return n
}

func isPunctASCII(c byte) bool {
	return c < 0x80 && unicode.IsPunct(rune(c)) || strings.IndexByte("$+<=>^`|~", c) >= 0
}

func runeBefore(s string, i int) rune {
	if i <= 0 {
		return ' '
	}
	r, _ := utf8.DecodeLastRuneInString(s[:i])
	return r
}

func runeAt(s string, i int) rune {
	if i >= len(s) {
		return ' '
	}
	r, _ := utf8.DecodeRuneInString(s[i:])
	return r
}

func isWordRune(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) }

// findCloser finds a run of exactly n delimiter chars c in s[from:limit]
// that can close emphasis (right-flanking; for '_' not followed by a word
// character), skipping code spans and escapes. The failure cache makes
// repeated failed searches in one string cost nothing.
func (sc *inlineScan) findCloser(c byte, n, from, limit int) int {
	key := closerKey{c: c, n: n, limit: limit}
	if f, ok := sc.failFrom[key]; ok && from >= f {
		return -1
	}
	s := sc.s
	for j := from; j < limit; {
		if e, ok := sc.codeEnd[j]; ok {
			j = e
			continue
		}
		if s[j] == '\\' {
			j += 2
			continue
		}
		if s[j] != c {
			j++
			continue
		}
		r := runLen(s, j, c)
		if j+r > limit {
			r = limit - j
		}
		if r == n && j > from && !unicode.IsSpace(runeBefore(s, j)) && (c != '_' || !isWordRune(runeAt(s, j+r))) {
			return j
		}
		j += r
	}
	if f, ok := sc.failFrom[key]; !ok || from < f {
		sc.failFrom[key] = from
	}
	return -1
}

// renderInline renders one run of inline text. noLinks is set inside link
// text, where links do not nest.
func renderInline(b *buf, s string, depth int, noLinks bool) {
	if depth > maxInlineDepth {
		b.s(template.HTMLEscapeString(s))
		return
	}
	sc := newInlineScan(s)
	sc.render(b, 0, len(s), depth, noLinks)
}

func (sc *inlineScan) render(b *buf, from, to, depth int, noLinks bool) {
	s := sc.s
	text := from // start of pending plain text
	flush := func(i int) {
		if i > text {
			b.s(template.HTMLEscapeString(s[text:i]))
		}
	}
	for i := from; i < to; {
		c := s[i]
		switch {
		case c == '\\' && i+1 < to && isPunctASCII(s[i+1]):
			flush(i)
			b.s(template.HTMLEscapeString(s[i+1 : i+2]))
			i += 2
			text = i
			continue
		case c == '\\' && i+1 < to && s[i+1] == '\n':
			flush(i)
			b.s("<br>\n")
			i += 2
			text = i
			continue
		case c == '\n':
			flush(i)
			if i-from >= 2 && s[i-1] == ' ' && s[i-2] == ' ' {
				b.s("<br>")
			}
			b.s("\n")
			i++
			text = i
			continue
		case c == '`':
			if end, ok := sc.codeEnd[i]; ok && end <= to {
				flush(i)
				k := sc.codeLen[i]
				code := strings.ReplaceAll(s[i+k:end-k], "\n", " ")
				if len(code) >= 2 && code[0] == ' ' && code[len(code)-1] == ' ' && strings.TrimSpace(code) != "" {
					code = code[1 : len(code)-1]
				}
				b.s("<code>" + template.HTMLEscapeString(code) + "</code>")
				i = end
				text = i
				continue
			}
			i += runLen(s, i, '`')
			continue
		case c == '!' && i+1 < to && s[i+1] == '[' && !noLinks:
			if end, label, dest, ok := sc.link(i+1, to); ok {
				flush(i)
				alt := strings.TrimSpace(label)
				if alt == "" {
					alt = "Image"
				}
				if href, ok := safeURL(dest); ok {
					b.s(`<a class="image-link" href="` + template.HTMLEscapeString(href) + `" ` + linkRel + `>`)
					b.s(template.HTMLEscapeString(alt))
					b.s("</a>")
				} else {
					b.s(template.HTMLEscapeString(alt))
				}
				i = end
				text = i
				continue
			}
		case c == '[' && !noLinks:
			if end, label, dest, ok := sc.link(i, to); ok {
				flush(i)
				if href, ok := safeURL(dest); ok {
					b.s(`<a href="` + template.HTMLEscapeString(href) + `" ` + linkRel + `>`)
					renderInline(b, label, depth+1, true)
					b.s("</a>")
				} else {
					renderInline(b, label, depth+1, true)
				}
				i = end
				text = i
				continue
			}
		case c == '<' && !noLinks:
			if end := strings.IndexByte(s[i+1:window(i+1, to)], '>'); end > 0 {
				inner := s[i+1 : i+1+end]
				if !strings.ContainsAny(inner, " \t\n<") {
					href := inner
					if !strings.Contains(inner, ":") && strings.Contains(inner, "@") {
						href = "mailto:" + inner
					}
					if safe, ok := safeURL(href); ok {
						flush(i)
						b.s(`<a href="` + template.HTMLEscapeString(safe) + `" ` + linkRel + `>`)
						b.s(template.HTMLEscapeString(inner))
						b.s("</a>")
						i += end + 2
						text = i
						continue
					}
				}
			}
		case (c == 'h' || c == 'H') && !noLinks && !isWordRune(runeBefore(s, i)) && hasURLPrefix(s[i:to]):
			end := bareURLEnd(s, i, to)
			if href, ok := safeURL(s[i:end]); ok {
				flush(i)
				b.s(`<a href="` + template.HTMLEscapeString(href) + `" ` + linkRel + `>`)
				b.s(template.HTMLEscapeString(s[i:end]))
				b.s("</a>")
				i = end
				text = i
				continue
			}
		case c == '~':
			if r := runLen(s, i, '~'); r == 2 && i+2 < to && !unicode.IsSpace(runeAt(s, i+2)) {
				if j := sc.findCloser('~', 2, i+2, to); j > i+2 {
					flush(i)
					b.s("<del>")
					sc.renderSub(b, i+2, j, depth, noLinks)
					b.s("</del>")
					i = j + 2
					text = i
					continue
				}
				i += r
				continue
			}
		case c == '*' || c == '_':
			r := runLen(s, i, c)
			if i+r > to {
				r = to - i
			}
			opens := i+r < to && !unicode.IsSpace(runeAt(s, i+r)) && (c != '_' || !isWordRune(runeBefore(s, i)))
			if opens && r <= 3 {
				if j := sc.findCloser(c, r, i+r, to); j > i+r {
					flush(i)
					open, close := "<em>", "</em>"
					switch r {
					case 2:
						open, close = "<strong>", "</strong>"
					case 3:
						open, close = "<strong><em>", "</em></strong>"
					}
					b.s(open)
					sc.renderSub(b, i+r, j, depth, noLinks)
					b.s(close)
					i = j + r
					text = i
					continue
				}
			}
			i += r
			continue
		}
		_, size := utf8.DecodeRuneInString(s[i:])
		i += size
	}
	flush(to)
}

// renderSub renders s[from:to] one nesting level deeper, sharing the scan.
func (sc *inlineScan) renderSub(b *buf, from, to, depth int, noLinks bool) {
	if depth+1 > maxInlineDepth {
		b.s(template.HTMLEscapeString(sc.s[from:to]))
		return
	}
	sc.render(b, from, to, depth+1, noLinks)
}

// link parses an inline link starting at the '[' at offset i: [label](dest
// "title"). It returns the offset after the closing parenthesis.
func (sc *inlineScan) link(i, to int) (end int, label, dest string, ok bool) {
	s := sc.s
	close, found := sc.bracket[i]
	if !found || close >= to || close+1 >= to || s[close+1] != '(' {
		return 0, "", "", false
	}
	label = s[i+1 : close]
	j := close + 2
	for j < to && (s[j] == ' ' || s[j] == '\t' || s[j] == '\n') {
		j++
	}
	start := j
	if j < to && s[j] == '<' {
		k := strings.IndexByte(s[j+1:window(j+1, to)], '>')
		if k < 0 || strings.ContainsAny(s[j+1:j+1+k], "\n<") {
			return 0, "", "", false
		}
		dest = s[j+1 : j+1+k]
		j += k + 2
	} else {
		parens := 0
		for lim := window(j, to); j < lim; {
			ch := s[j]
			if ch == '\\' && j+1 < to {
				j += 2
				continue
			}
			if ch == ' ' || ch == '\t' || ch == '\n' || ch < 0x20 {
				break
			}
			if ch == '(' {
				parens++
			} else if ch == ')' {
				if parens == 0 {
					break
				}
				parens--
			}
			j++
		}
		dest = s[start:j]
	}
	for j < to && (s[j] == ' ' || s[j] == '\t' || s[j] == '\n') {
		j++
	}
	if j < to && (s[j] == '"' || s[j] == '\'' || s[j] == '(') {
		q := s[j]
		if q == '(' {
			q = ')'
		}
		k := strings.IndexByte(s[j+1:window(j+1, to)], q)
		if k < 0 {
			return 0, "", "", false
		}
		j += k + 2
		for j < to && (s[j] == ' ' || s[j] == '\t' || s[j] == '\n') {
			j++
		}
	}
	if j >= to || s[j] != ')' {
		return 0, "", "", false
	}
	return j + 1, label, unescapeDest(dest), true
}

func unescapeDest(d string) string {
	if !strings.Contains(d, `\`) {
		return d
	}
	var b buf
	for k := 0; k < len(d); k++ {
		if d[k] == '\\' && k+1 < len(d) && isPunctASCII(d[k+1]) {
			k++
		}
		b.c(d[k])
	}
	return b.String()
}

// maxScan bounds the look-ahead of URL, autolink and link-title scans, so a
// long run of unmatched openers stays linear. safeURL rejects longer URLs.
const maxScan = 4096

func window(from, to int) int { return min(to, from+maxScan) }

func hasURLPrefix(s string) bool {
	l := strings.ToLower(s[:min(len(s), 8)])
	return strings.HasPrefix(l, "http://") || strings.HasPrefix(l, "https://")
}

// bareURLEnd finds the end of a bare URL starting at i: up to whitespace or
// '<', minus trailing punctuation and unbalanced closing parentheses (GFM
// autolink literal rules).
func bareURLEnd(s string, i, to int) int {
	j := i
	for lim := window(i, to); j < lim; {
		r, size := utf8.DecodeRuneInString(s[j:])
		if unicode.IsSpace(r) || r == '<' || r == '`' {
			break
		}
		j += size
	}
	for j > i {
		last := s[j-1]
		if strings.IndexByte(`?!.,:*_~'"`, last) >= 0 {
			j--
			continue
		}
		if last == ')' && strings.Count(s[i:j], "(") < strings.Count(s[i:j], ")") {
			j--
			continue
		}
		break
	}
	return j
}

// safeURL accepts absolute http, https and mailto URLs only and returns them
// normalised for an href.
func safeURL(raw string) (string, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > 4096 {
		return "", false
	}
	for _, r := range raw {
		if r < 0x20 || r == 0x7f || unicode.IsSpace(r) {
			return "", false
		}
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", false
	}
	switch strings.ToLower(u.Scheme) {
	case "http", "https":
		if u.Host == "" {
			return "", false
		}
	case "mailto":
		if u.Opaque == "" {
			return "", false
		}
	default:
		return "", false
	}
	return u.String(), true
}

// plainText collapses s to one escaped-safe line (titles, activity).
func plainText(s string, limit int) string {
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) > limit {
		r := []rune(s)
		s = strings.TrimSpace(string(r[:limit-1])) + "…"
	}
	return s
}
