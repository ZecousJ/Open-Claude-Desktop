package sharing

import (
	"encoding/json"
	"strings"
	"testing"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"

	"github.com/stretchr/testify/require"
)

var testLimits = limits{SnapshotBytes: 1 << 20, ArtifactBytes: 64 << 10}

func reasonOf(err error) string { return infraerrors.Reason(err) }

func TestNormalizeConversationSnapshot(t *testing.T) {
	s := &Snapshot{
		Kind: KindArtifact, Title: "ignored", Mode: " code ", ModelLabel: "GPT\n5",
		Messages: []SnapshotMessage{
			{Role: "user", Text: "hi\x00 there"},
			{Role: "assistant", Text: "", Activity: []string{" Ran a\ncommand ", "", "Edited 3 files"}, Artifacts: []int{1, 0}},
		},
		Artifacts: []SnapshotArtifact{
			{Title: " A ", Language: "HTML", CodeLanguage: "ts", Content: "<p>x</p>"},
			{Title: "B", Language: "code", CodeLanguage: "c++", Content: "int main(){}"},
		},
	}
	body, err := normalizeSnapshot(s, KindConversation, "  Title\twith  tabs ", testLimits)
	require.NoError(t, err)
	require.Equal(t, KindConversation, s.Kind, "the request kind wins")
	require.Equal(t, "Title with tabs", s.Title)
	require.Equal(t, "code", s.Mode)
	require.Equal(t, "GPT 5", s.ModelLabel)
	require.Equal(t, "hi there", s.Messages[0].Text, "NUL is dropped (JSONB cannot store it)")
	require.Equal(t, []string{"Ran a command", "Edited 3 files"}, s.Messages[1].Activity)
	require.Equal(t, "html", s.Artifacts[0].Language)
	require.Empty(t, s.Artifacts[0].CodeLanguage, "only code artifacts keep a code language")
	require.Equal(t, "c++", s.Artifacts[1].CodeLanguage)

	var back Snapshot
	require.NoError(t, json.Unmarshal(body, &back))
	require.Equal(t, *s, back)
}

func TestNormalizeRejects(t *testing.T) {
	user := func(text string) []SnapshotMessage { return []SnapshotMessage{{Role: "user", Text: text}} }
	art := func(lang, content string) []SnapshotArtifact {
		return []SnapshotArtifact{{Language: lang, Content: content}}
	}
	cases := []struct {
		name   string
		kind   Kind
		s      *Snapshot
		title  string
		reason string
		field  string
	}{
		{"nil", KindConversation, nil, "", "CLAUDEX_SHARE_INVALID", "snapshot"},
		{"no messages", KindConversation, &Snapshot{}, "", "CLAUDEX_SHARE_INVALID", "snapshot.messages"},
		{"bad role", KindConversation, &Snapshot{Messages: []SnapshotMessage{{Role: "tool", Text: "x"}}}, "", "CLAUDEX_SHARE_INVALID", "snapshot.messages[0].role"},
		{"empty message", KindConversation, &Snapshot{Messages: user("  ")}, "", "CLAUDEX_SHARE_INVALID", "snapshot.messages[0].text"},
		{"bad mode", KindConversation, &Snapshot{Mode: "web", Messages: user("x")}, "", "CLAUDEX_SHARE_INVALID", "snapshot.mode"},
		{"long title", KindConversation, &Snapshot{Messages: user("x")}, strings.Repeat("é", 201), "CLAUDEX_SHARE_INVALID", "title"},
		{"long label", KindConversation, &Snapshot{ModelLabel: strings.Repeat("m", 81), Messages: user("x")}, "", "CLAUDEX_SHARE_INVALID", "snapshot.model_label"},
		{"user text", KindConversation, &Snapshot{Messages: user(strings.Repeat("u", maxUserTextBytes+1))}, "", "CLAUDEX_SHARE_TOO_LARGE", "snapshot.messages[0].text"},
		{"assistant text", KindConversation, &Snapshot{Messages: []SnapshotMessage{{Role: "assistant", Text: strings.Repeat("a", maxAssistantTextBytes+1)}}}, "", "CLAUDEX_SHARE_TOO_LARGE", "snapshot.messages[0].text"},
		{"too many messages", KindConversation, &Snapshot{Messages: make([]SnapshotMessage, maxMessages+1)}, "", "CLAUDEX_SHARE_TOO_LARGE", "snapshot.messages"},
		{"activity count", KindConversation, &Snapshot{Messages: []SnapshotMessage{{Role: "assistant", Text: "x", Activity: make([]string, 21)}}}, "", "CLAUDEX_SHARE_INVALID", "snapshot.messages[0].activity"},
		{"activity length", KindConversation, &Snapshot{Messages: []SnapshotMessage{{Role: "assistant", Text: "x", Activity: []string{strings.Repeat("r", 121)}}}}, "", "CLAUDEX_SHARE_INVALID", "snapshot.messages[0].activity"},
		{"dangling artifact", KindConversation, &Snapshot{Messages: []SnapshotMessage{{Role: "assistant", Text: "x", Artifacts: []int{0}}}}, "", "CLAUDEX_SHARE_INVALID", "snapshot.messages[0].artifacts"},
		{"duplicate artifact ref", KindConversation, &Snapshot{Messages: []SnapshotMessage{{Role: "assistant", Text: "x", Artifacts: []int{0, 0}}}, Artifacts: art("svg", "<svg/>")}, "", "CLAUDEX_SHARE_INVALID", "snapshot.messages[0].artifacts"},
		{"bad language", KindArtifact, &Snapshot{Artifacts: art("pdf", "x")}, "", "CLAUDEX_SHARE_INVALID", "snapshot.artifacts[0].language"},
		{"empty artifact", KindArtifact, &Snapshot{Artifacts: art("html", " ")}, "", "CLAUDEX_SHARE_INVALID", "snapshot.artifacts[0].content"},
		{"bad code language", KindArtifact, &Snapshot{Artifacts: []SnapshotArtifact{{Language: "code", CodeLanguage: "a b", Content: "x"}}}, "", "CLAUDEX_SHARE_INVALID", "snapshot.artifacts[0].code_language"},
		{"artifact size", KindArtifact, &Snapshot{Artifacts: art("html", strings.Repeat("h", 64<<10+1))}, "", "CLAUDEX_SHARE_TOO_LARGE", "snapshot.artifacts[0].content"},
		{"artifact share with messages", KindArtifact, &Snapshot{Messages: user("x"), Artifacts: art("svg", "<svg/>")}, "", "CLAUDEX_SHARE_INVALID", "snapshot"},
		{"artifact share with two", KindArtifact, &Snapshot{Artifacts: append(art("svg", "<svg/>"), art("svg", "<svg/>")...)}, "", "CLAUDEX_SHARE_INVALID", "snapshot"},
		{"too many artifacts", KindConversation, &Snapshot{Messages: user("x"), Artifacts: make([]SnapshotArtifact, 21)}, "", "CLAUDEX_SHARE_INVALID", "snapshot.artifacts"},
		{"unknown kind", "blog", &Snapshot{Messages: user("x")}, "", "CLAUDEX_SHARE_INVALID", "kind"},
	}
	for _, c := range cases {
		_, err := normalizeSnapshot(c.s, c.kind, c.title, testLimits)
		require.Error(t, err, c.name)
		require.Equal(t, c.reason, reasonOf(err), c.name)
		var app *infraerrors.ApplicationError
		require.ErrorAs(t, err, &app, c.name)
		require.Equal(t, c.field, app.Metadata["field"], c.name)
	}

	// The whole snapshot is checked after encoding.
	many := &Snapshot{}
	for i := 0; i < 20; i++ {
		many.Messages = append(many.Messages, SnapshotMessage{Role: "user", Text: strings.Repeat("q", 60<<10)})
	}
	_, err := normalizeSnapshot(many, KindConversation, "", testLimits)
	require.Equal(t, "CLAUDEX_SHARE_TOO_LARGE", reasonOf(err))
}

func TestSourceKey(t *testing.T) {
	k, ok := SourceKey("conv-123")
	require.True(t, ok)
	require.Len(t, k, 64)
	again, _ := SourceKey(" conv-123 ")
	require.Equal(t, k, again)
	upper, ok := SourceKey(strings.ToUpper(k))
	require.True(t, ok)
	require.Equal(t, k, upper, "a hex digest is kept as is")
	_, ok = SourceKey("")
	require.False(t, ok)
	_, ok = SourceKey(strings.Repeat("x", maxSourceKeyBytes+1))
	require.False(t, ok)
}

func TestCleanLabel(t *testing.T) {
	require.Equal(t, "a b c", cleanLabel("  a\n\nb c\x00 "))
	require.Equal(t, "", cleanLabel("\n\t "))
}

func TestSettingsValidation(t *testing.T) {
	ok := func(mut func(*Settings)) error {
		s := defaultSettings()
		mut(&s)
		normalizeSettings(&s)
		return validateSettings(&s)
	}
	require.NoError(t, ok(func(s *Settings) { s.PublicBaseURL = "https://a.example.com/prefix/" }))
	require.NoError(t, ok(func(s *Settings) { s.PublicBaseURL = "http://localhost:5173" }))
	require.NoError(t, ok(func(s *Settings) { s.PublicBaseURL = "http://[::1]:8080" }))
	require.NoError(t, ok(func(s *Settings) {
		s.PublicBaseURL, s.ContentBaseURL = "https://a.example.com", "https://usercontent.example.com"
	}))
	require.Error(t, ok(func(s *Settings) { s.PublicBaseURL = "https://a.example.com#x" }))
	require.Error(t, ok(func(s *Settings) { s.PublicBaseURL = "https://a.example.com/ x" }))
	require.Error(t, ok(func(s *Settings) { s.PublicBaseURL = "//a.example.com" }))
	require.Error(t, ok(func(s *Settings) {
		s.PublicBaseURL, s.ContentBaseURL = "https://a.example.com", "https://A.example.com:8443"
	}))

	// A hand-edited document is clamped, never trusted.
	s := defaultSettings()
	s.MaxSnapshotBytes, s.MaxArtifactBytes, s.MaxActivePerUser, s.DefaultTTLDays = 1<<40, 1<<40, -3, -1
	normalizeSettings(&s)
	require.Equal(t, maxSnapshotBytes, s.MaxSnapshotBytes)
	require.Equal(t, maxSnapshotBytes, s.MaxArtifactBytes)
	require.Equal(t, 1, s.MaxActivePerUser)
	require.Zero(t, s.DefaultTTLDays)
}

func TestRawFileName(t *testing.T) {
	require.Equal(t, "My-chart.svg", rawFileName(SnapshotArtifact{Title: "My chart", Language: "svg"}, 0))
	require.Equal(t, "artifact-3.md", rawFileName(SnapshotArtifact{Title: "图表", Language: "markdown"}, 2))
	require.Equal(t, "x.txt", rawFileName(SnapshotArtifact{Title: "x", Language: "code"}, 0))
	require.Equal(t, "etcpasswd.html", rawFileName(SnapshotArtifact{Title: "../etc/passwd", Language: "html"}, 0))
}

func TestNoticeTexts(t *testing.T) {
	for _, k := range []NoticeKind{NoticeNotFound, NoticeRemoved, NoticeReportReceived, NoticeReportInvalid, NoticeRateLimited} {
		title, body := NoticeText(k)
		require.NotEmpty(t, title)
		require.NotEmpty(t, body)
	}
	for _, r := range ReportReasonOrder {
		require.True(t, reportReasons[r])
		require.NotEmpty(t, ReportReasonLabel(r))
	}
	require.Len(t, reportReasons, len(ReportReasonOrder))
}

func TestSnapshotSizeIgnoresHTMLEscaping(t *testing.T) {
	// 15000 bytes of markup: json.Marshal would count about 65000 bytes
	// (each <, > as <), well over the 20000-byte snapshot cap.
	content := strings.Repeat("<b>", 5000)
	s := &Snapshot{Artifacts: []SnapshotArtifact{{Language: "html", Content: content}}}
	body, err := normalizeSnapshot(s, KindArtifact, "Page", limits{SnapshotBytes: 20000, ArtifactBytes: 16000})
	require.NoError(t, err)
	require.Less(t, len(body), 20000)
	require.Contains(t, string(body), "<b>")
	require.False(t, strings.HasSuffix(string(body), "\n"))
	var back Snapshot
	require.NoError(t, json.Unmarshal(body, &back))
	require.Equal(t, content, back.Artifacts[0].Content)
}
