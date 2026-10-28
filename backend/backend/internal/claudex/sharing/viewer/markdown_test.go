package viewer

import (
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func md(s string) string { return string(Markdown(s)) }

func TestMarkdownBlocks(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"paragraph", "Hello\nworld", "<p>Hello\nworld</p>\n"},
		{"atx heading", "## Title ##", "<h2>Title</h2>\n"},
		{"hashtag is text", "#tag", "<p>#tag</p>\n"},
		{"setext", "Title\n===", "<h1>Title</h1>\n"},
		{"hr", "a\n\n---\n\nb", "<p>a</p>\n<hr>\n<p>b</p>\n"},
		{"quote", "> quoted\n> more", "<blockquote>\n<p>quoted\nmore</p>\n</blockquote>\n"},
		{"bullets", "- one\n- two", "<ul>\n<li>one\n</li>\n<li>two\n</li>\n</ul>\n"},
		{"ordered start", "3. c\n4. d", "<ol start=\"3\">\n<li>c\n</li>\n<li>d\n</li>\n</ol>\n"},
		{"nested", "- a\n  - b", "<ul>\n<li>a\n<ul>\n<li>b\n</li>\n</ul>\n</li>\n</ul>\n"},
		{"loose", "- a\n\n- b", "<ul>\n<li><p>a</p>\n</li>\n<li><p>b</p>\n</li>\n</ul>\n"},
		{"task", "- [x] done\n- [ ] todo", "<ul>\n<li><input type=\"checkbox\" checked disabled> done\n</li>\n<li><input type=\"checkbox\" disabled> todo\n</li>\n</ul>\n"},
		{"fence", "```go\nfmt.Println(\"<b>\")\n```", "<div class=\"code-block\"><div class=\"code-bar\">go</div><pre><code class=\"language-go\">fmt.Println(&#34;&lt;b&gt;&#34;)</code></pre></div>\n"},
		{"unclosed fence", "~~~\ncode", "<div class=\"code-block\"><div class=\"code-bar\">code</div><pre><code>code</code></pre></div>\n"},
		{"table", "| a | b |\n|:-|-:|\n| 1 | 2 |", "<div class=\"table-wrap\"><table><thead><tr><th class=\"al-l\">a</th><th class=\"al-r\">b</th></tr></thead><tbody><tr><td class=\"al-l\">1</td><td class=\"al-r\">2</td></tr></tbody></table></div>\n"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) { assert.Equal(t, c.want, md(c.in)) })
	}
}

func TestMarkdownInline(t *testing.T) {
	cases := []struct{ in, want string }{
		{"**bold** and *em* and ***both***", "<p><strong>bold</strong> and <em>em</em> and <strong><em>both</em></strong></p>\n"},
		{"snake_case_name stays", "<p>snake_case_name stays</p>\n"},
		{"~~gone~~", "<p><del>gone</del></p>\n"},
		{"use `a < b` here", "<p>use <code>a &lt; b</code> here</p>\n"},
		{"`` a ` b ``", "<p><code>a ` b</code></p>\n"},
		{`\*not em\*`, "<p>*not em*</p>\n"},
		{"[site](https://example.com/a?b=1&c=2)", `<p><a href="https://example.com/a?b=1&amp;c=2" rel="nofollow noopener noreferrer ugc" target="_blank">site</a></p>` + "\n"},
		{"see https://example.com/x).", `<p>see <a href="https://example.com/x" rel="nofollow noopener noreferrer ugc" target="_blank">https://example.com/x</a>).</p>` + "\n"},
		{"<https://example.com>", `<p><a href="https://example.com" rel="nofollow noopener noreferrer ugc" target="_blank">https://example.com</a></p>` + "\n"},
		{"![chart](https://img.example/c.png)", `<p><a class="image-link" href="https://img.example/c.png" rel="nofollow noopener noreferrer ugc" target="_blank">chart</a></p>` + "\n"},
		{"line  \nbreak", "<p>line  <br>\nbreak</p>\n"},
		{"*a **b** c*", "<p><em>a <strong>b</strong> c</em></p>\n"},
	}
	for _, c := range cases {
		assert.Equal(t, c.want, md(c.in), c.in)
	}
}

// TestMarkdownXSS runs the classic vectors: nothing may come out as markup
// other than the renderer's own tags, and no URL other than http, https or
// mailto may become an href.
func TestMarkdownXSS(t *testing.T) {
	vectors := []string{
		"<script>alert(1)</script>",
		"<img src=x onerror=alert(1)>",
		"<a href=\"javascript:alert(1)\">x</a>",
		"[x](javascript:alert(1))",
		"[x](JaVaScRiPt:alert(1))",
		"[x](java\tscript:alert(1))",
		"[x](&#106;avascript:alert(1))",
		"[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
		"[x](vbscript:msgbox)",
		"[x](//evil.example/path)",
		"[x](/relative)",
		"![x](javascript:alert(1))",
		"<javascript:alert(1)>",
		"[x](https://ok.example \"a\\\" onmouseover=\\\"alert(1)\")",
		"[x](https://ok.example/\"onmouseover=\"alert(1))",
		"```html\n<script>alert(1)</script>\n```",
		"`<script>`",
		"| <b>x</b> |\n|---|\n| <i onclick=x> |",
		"# <svg onload=alert(1)>",
		"> <iframe src=javascript:alert(1)>",
		"- <style>body{display:none}</style>",
		"```\"><script>alert(1)</script>\nx\n```",
		"~~~ \" onmouseover=\"x\nbody\n~~~",
		"**<b>**",
		"<!-- comment --> & &amp; &lt;",
		"\x00<script>",
	}
	tagRe := regexp.MustCompile(`<[^>]*>?`)
	shapeRe := regexp.MustCompile(`^</?(p|h[1-6]|ul|ol|li|blockquote|hr|br|div|pre|code|table|thead|tbody|tr|th|td|strong|em|del|a|input)((?:\s+[a-z]+(?:="[^"<>]*")?)*)>$`)
	attrRe := regexp.MustCompile(`\s+([a-z]+)(?:="[^"]*")?`)
	allowedAttr := map[string]bool{"href": true, "rel": true, "target": true, "class": true, "type": true, "checked": true, "disabled": true, "start": true}
	for _, v := range vectors {
		out := md(v)
		for _, tag := range tagRe.FindAllString(out, -1) {
			m := shapeRe.FindStringSubmatch(tag)
			if !assert.NotNil(t, m, "vector %q produced tag %q in %q", v, tag, out) {
				continue
			}
			for _, a := range attrRe.FindAllStringSubmatch(m[2], -1) {
				assert.True(t, allowedAttr[a[1]], "vector %q produced attribute %q in %q", v, a[1], out)
			}
		}
		for _, href := range regexp.MustCompile(`href="([^"]*)"`).FindAllStringSubmatch(out, -1) {
			assert.Regexp(t, `^(https?://[^/]|mailto:)`, href[1], "vector %q", v)
		}
		for _, cls := range regexp.MustCompile(`class="([^"]*)"`).FindAllStringSubmatch(out, -1) {
			assert.Regexp(t, `^[a-z0-9_+#.-]+$`, cls[1], "vector %q", v)
		}
	}
}

func TestMarkdownNoRemoteImages(t *testing.T) {
	out := md("![tracker](https://t.example/p.gif) and ![](https://t.example/q.gif)")
	assert.NotContains(t, out, "<img")
	assert.Contains(t, out, ">tracker</a>")
	assert.Contains(t, out, ">Image</a>")
}

func TestMarkdownDeepNesting(t *testing.T) {
	quotes := strings.Repeat(">", 5000) + " deep"
	out := md(quotes)
	assert.LessOrEqual(t, strings.Count(out, "<blockquote>"), maxBlockDepth+1)
	assert.Contains(t, out, "deep")

	var list strings.Builder
	for i := 0; i < 400; i++ {
		_, _ = list.WriteString(strings.Repeat("  ", i) + "- item\n")
	}
	out = md(list.String())
	assert.LessOrEqual(t, strings.Count(out, "<ul>"), maxBlockDepth+2)

	emph := strings.Repeat("*a _b ~~c [d](https://x.example) ", 200) + strings.Repeat("~~_*", 200)
	assert.NotPanics(t, func() { md(emph) })
}

// TestMarkdownLinearTime feeds inputs that make naive delimiter and bracket
// scans quadratic; each must render quickly.
func TestMarkdownLinearTime(t *testing.T) {
	n := 60000
	inputs := map[string]string{
		"openers":     strings.Repeat("*a ", n),
		"underscores": strings.Repeat("_a ", n),
		"strong":      strings.Repeat("**a ", n),
		"brackets":    strings.Repeat("[", n) + strings.Repeat("]", n),
		"links":       strings.Repeat("[a](", n),
		"titles":      strings.Repeat("[a](b 'x ", n/2),
		"autolinks":   strings.Repeat("<a", n),
		"backticks":   strings.Repeat("`", n) + "x",
		"backtick runs": func() string {
			var b strings.Builder
			for i := 1; i < 350; i++ {
				_, _ = b.WriteString(strings.Repeat("`", i) + " x ")
			}
			return b.String()
		}(),
		"urls":          strings.Repeat("http://a/", n/2),
		"nested strong": "**" + strings.Repeat("*a ", n) + "**",
		"tildes":        strings.Repeat("~~a ", n),
		"lines":         strings.Repeat("- a\n  > b\n", n/4),
	}
	for name, in := range inputs {
		start := time.Now()
		out := md(in)
		require.NotEmpty(t, out, name)
		assert.Less(t, time.Since(start), 2*time.Second, name)
	}
}

func TestSafeURL(t *testing.T) {
	for _, ok := range []string{"https://a.example", "http://a.example/x?y#z", "mailto:a@b.example"} {
		_, good := safeURL(ok)
		assert.True(t, good, ok)
	}
	for _, bad := range []string{"", "javascript:alert(1)", "data:text/html,x", "/x", "//a.example", "https://", "file:///etc/passwd", "https://a.example/\x01", "mailto:", "https://a example"} {
		_, good := safeURL(bad)
		assert.False(t, good, bad)
	}
}
