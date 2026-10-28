package webproto

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

func readGolden(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name+".json"))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func generic(t *testing.T, data []byte) any {
	t.Helper()
	var v any
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatalf("not JSON: %v", err)
	}
	return v
}

// roundTrip decodes a sample, encodes the result and expects the same JSON.
func roundTrip[T any](t *testing.T, name string, decode func([]byte) (T, error)) {
	t.Helper()
	data := readGolden(t, name)
	frame, err := decode(data)
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	out, err := json.Marshal(frame)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := generic(t, out), generic(t, data); !reflect.DeepEqual(got, want) {
		t.Fatalf("%s changed on the way through:\n got %s\nwant %s", name, out, data)
	}
}

func decodeTurn(data []byte) (TurnDoc, error) {
	doc, _, err := DecodeTurnDoc(data)
	return doc, err
}

func decodeConversation(data []byte) (ConversationDoc, error) {
	doc, _, err := DecodeConversationDoc(data)
	return doc, err
}

type statusBody struct {
	Status int             `json:"status"`
	Body   json.RawMessage `json:"body"`
}

var goldenChecks = []struct {
	prefix string
	check  func(t *testing.T, name string)
}{
	{"events.browser.", func(t *testing.T, n string) { roundTrip(t, n, DecodeBrowserFrame) }},
	{"events.server.", func(t *testing.T, n string) { roundTrip(t, n, DecodeServerFrame) }},
	{"link.runner.", func(t *testing.T, n string) { roundTrip(t, n, DecodeRunnerFrame) }},
	{"link.go.", func(t *testing.T, n string) { roundTrip(t, n, DecodeGoFrame) }},
	{"doc.turn.", func(t *testing.T, n string) { roundTrip(t, n, decodeTurn) }},
	{"doc.conversation.", func(t *testing.T, n string) { roundTrip(t, n, decodeConversation) }},
	{"rpc.request", func(t *testing.T, n string) { roundTrip(t, n, DecodeRPCRequest) }},
	{"rpc.response.", func(t *testing.T, n string) {
		var sample statusBody
		if err := json.Unmarshal(readGolden(t, n), &sample); err != nil {
			t.Fatal(err)
		}
		var resp RPCResponse
		if err := json.Unmarshal(sample.Body, &resp); err != nil {
			t.Fatal(err)
		}
		if err := resp.Validate(); err != nil {
			t.Fatalf("%s: %v", n, err)
		}
		if resp.OK != (sample.Status == 200 && resp.Error == nil) {
			t.Fatalf("%s: ok %v with status %d", n, resp.OK, sample.Status)
		}
		out, _ := json.Marshal(resp)
		if !reflect.DeepEqual(generic(t, out), generic(t, sample.Body)) {
			t.Fatalf("%s changed: %s", n, out)
		}
	}},
	{"ticket.request", func(t *testing.T, n string) {
		var req TicketRequest
		if err := json.Unmarshal(readGolden(t, n), &req); err != nil || !ValidTabID(req.TabID) {
			t.Fatalf("%s: %v %q", n, err, req.TabID)
		}
	}},
	{"ticket.response", func(t *testing.T, n string) {
		roundTrip(t, n, func(data []byte) (TicketResponse, error) {
			var r TicketResponse
			if err := json.Unmarshal(data, &r); err != nil {
				return r, err
			}
			return r, r.Validate()
		})
	}},
	// Checked by their own tests below.
	{"ticket.subprotocols", func(*testing.T, string) {}},
	{"doc.split", func(*testing.T, string) {}},
	{"bytes", func(*testing.T, string) {}},
	{"invalid", func(*testing.T, string) {}},
	{"constants", func(*testing.T, string) {}},
}

func TestGoldenSamples(t *testing.T) {
	entries, err := os.ReadDir("testdata")
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, entry := range entries {
		name, ok := strings.CutSuffix(entry.Name(), ".json")
		if !ok {
			continue
		}
		count++
		found := false
		for _, c := range goldenChecks {
			if strings.HasPrefix(name, c.prefix) {
				found = true
				t.Run(name, func(t *testing.T) { c.check(t, name) })
				break
			}
		}
		if !found {
			t.Errorf("%s.json is not registered in goldenChecks", name)
		}
	}
	if count < 30 {
		t.Fatalf("only %d samples", count)
	}
}

func TestConstantsMatchTheSharedSample(t *testing.T) {
	var c struct {
		Version                 int               `json:"version"`
		DocSchema               int               `json:"docSchema"`
		Paths                   map[string]string `json:"paths"`
		AuthRoutes              map[string]string `json:"authRoutes"`
		Headers                 map[string]string `json:"headers"`
		ClientName              string            `json:"clientName"`
		RefreshCookie           string            `json:"refreshCookie"`
		EventsSubprotocol       string            `json:"eventsSubprotocol"`
		TicketSubprotocolPrefix string            `json:"ticketSubprotocolPrefix"`
		RunnerLinkSubprotocol   string            `json:"runnerLinkSubprotocol"`
		Limits                  map[string]int64  `json:"limits"`
		CloseCodes              map[string]int    `json:"closeCodes"`
		ErrorCodes              map[string]string `json:"errorCodes"`
		RunnerOps               []string          `json:"runnerOps"`
	}
	if err := json.Unmarshal(readGolden(t, "constants"), &c); err != nil {
		t.Fatal(err)
	}
	ms := func(d time.Duration) int64 { return d.Milliseconds() }
	checks := []struct {
		name      string
		got, want any
	}{
		{"version", Version, c.Version},
		{"docSchema", DocSchema, c.DocSchema},
		{"paths", map[string]string{
			"base": PathBase, "rpc": PathRPC, "events": PathEvents, "uploads": PathUploads,
			"preview": PathPreview, "auth": PathAuth, "downloads": PathDownloads, "runnerLink": PathRunnerLink,
		}, c.Paths},
		{"authRoutes", map[string]string{
			"login": AuthLogin, "twoFactor": AuthTwoFactor, "cancelTwoFactor": AuthCancelTwoFactor,
			"register": AuthRegister, "sendCode": AuthSendCode, "forgotPassword": AuthForgotPassword,
			"resetPassword": AuthResetPassword, "refresh": AuthRefresh, "logout": AuthLogout,
			"revokeAll": AuthRevokeAll, "eventsTicket": AuthEventsTicket, "voiceTicket": AuthVoiceTicket,
			"emailCodeSend": AuthEmailCodeSend, "emailCodeLogin": AuthEmailCodeLogin,
			"googleLogin":  AuthGoogleLogin,
			"passkeyBegin": AuthPasskeyBegin, "passkeyFinish": AuthPasskeyFinish,
			"accounts": AuthAccounts,
		}, c.AuthRoutes},
		{"headers", map[string]string{"web": HeaderWeb, "tab": HeaderTab, "client": HeaderClient, "eventSeq": EventSeqHeader}, c.Headers},
		{"clientName", ClientName, c.ClientName},
		{"refreshCookie", RefreshCookie, c.RefreshCookie},
		{"eventsSubprotocol", EventsSubprotocol, c.EventsSubprotocol},
		{"ticketSubprotocolPrefix", TicketSubprotocolPrefix, c.TicketSubprotocolPrefix},
		{"runnerLinkSubprotocol", RunnerLinkSubprotocol, c.RunnerLinkSubprotocol},
		{"limits", map[string]int64{
			"rpcBodyBytes": RPCBodyBytes, "uploadChunkBytes": UploadChunkBytes,
			"linkFrameBytes": LinkFrameBytes, "turnDocBytes": TurnDocBytes,
			"ticketTtlMs": ms(TicketTTL), "previewSignatureTtlMs": ms(PreviewSignatureTTL),
			"heartbeatMs": ms(Heartbeat), "eventRing": EventRing, "coalesceMs": ms(Coalesce),
			"callTimeoutMs": ms(CallTimeout), "methodNameLength": MethodNameLength,
			"runnerMethods": RunnerMethods, "browserAccounts": BrowserAccounts,
		}, c.Limits},
		{"closeCodes", map[string]int{
			"normal": CloseNormal, "goingAway": CloseGoingAway, "badTicket": CloseBadTicket,
			"forbidden": CloseForbidden, "signedOut": CloseSignedOut, "protocolError": CloseProtocolError,
			"unavailable": CloseUnavailable, "runnerRejected": CloseRunnerRejected, "replaced": CloseReplaced,
		}, c.CloseCodes},
		{"errorCodes", map[string]string{
			"disabled": ErrCodeDisabled, "notAllowed": ErrCodeNotAllowed, "capacity": ErrCodeCapacity,
			"methodUnavailable": ErrCodeMethodUnavailable, "badRequest": ErrCodeBadRequest,
			"tooLarge": ErrCodeTooLarge, "runnerUnavailable": ErrCodeRunnerUnavailable,
			"timeout": ErrCodeTimeout, "badTicket": ErrCodeBadTicket,
			"quotaExceeded": ErrCodeQuotaExceeded, "handlerFailed": ErrCodeHandlerFailed,
		}, c.ErrorCodes},
		{"runnerOps", RunnerOps, c.RunnerOps},
	}
	for _, check := range checks {
		if !reflect.DeepEqual(check.got, check.want) {
			t.Errorf("%s: Go %v, sample %v", check.name, check.got, check.want)
		}
	}
	for _, op := range RunnerOps {
		if !ValidOp(op) {
			t.Errorf("op %q has the wrong shape", op)
		}
	}
}

func TestInvalidSamplesAreRefused(t *testing.T) {
	var sample struct {
		Cases []struct {
			Kind  string          `json:"kind"`
			Why   string          `json:"why"`
			Frame json.RawMessage `json:"frame"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(readGolden(t, "invalid"), &sample); err != nil {
		t.Fatal(err)
	}
	decoders := map[string]func([]byte) error{
		"browser":      func(d []byte) error { _, err := DecodeBrowserFrame(d); return err },
		"server":       func(d []byte) error { _, err := DecodeServerFrame(d); return err },
		"runner":       func(d []byte) error { _, err := DecodeRunnerFrame(d); return err },
		"go":           func(d []byte) error { _, err := DecodeGoFrame(d); return err },
		"turn":         func(d []byte) error { _, err := decodeTurn(d); return err },
		"conversation": func(d []byte) error { _, err := decodeConversation(d); return err },
		"rpc-request":  func(d []byte) error { _, err := DecodeRPCRequest(d); return err },
	}
	for _, c := range sample.Cases {
		decode, ok := decoders[c.Kind]
		if !ok {
			t.Fatalf("unknown kind %q", c.Kind)
		}
		err := decode(c.Frame)
		if err == nil {
			t.Errorf("%s: %s was accepted", c.Kind, c.Why)
		} else if !errors.Is(err, ErrProtocol) {
			t.Errorf("%s: %s: error %v does not wrap ErrProtocol", c.Kind, c.Why, err)
		}
	}
	for _, data := range []string{"not json", "[1]", `{"t":3}`, `{}`} {
		if _, err := DecodeRunnerFrame([]byte(data)); err == nil {
			t.Errorf("runner frame %s was accepted", data)
		}
	}
}

func TestSplitSampleRowsAreValid(t *testing.T) {
	var sample struct {
		Doc   json.RawMessage   `json:"doc"`
		Turns []json.RawMessage `json:"turns"`
	}
	if err := json.Unmarshal(readGolden(t, "doc.split"), &sample); err != nil {
		t.Fatal(err)
	}
	_, meta, err := DecodeConversationDoc(sample.Doc)
	if err != nil {
		t.Fatal(err)
	}
	if meta.ID != "conv-1" || meta.Mode != "chat" || len(meta.SavedBranches) != 1 {
		t.Fatalf("meta %+v", meta)
	}
	branches := map[string]bool{}
	for _, raw := range sample.Turns {
		doc, head, err := DecodeTurnDoc(raw)
		if err != nil {
			t.Fatal(err)
		}
		if doc.ConversationID != meta.ID || head.ID != doc.TurnID {
			t.Fatalf("row %s does not belong", doc.TurnID)
		}
		key := "live"
		if doc.BranchID != nil {
			key = *doc.BranchID
		}
		branches[key] = true
	}
	if !branches["live"] || !branches["branch-old"] {
		t.Fatalf("branches %v", branches)
	}
}

func TestTurnDocKeepsUnknownFieldsAndLimits(t *testing.T) {
	data := readGolden(t, "doc.turn.in-progress")
	doc, head, err := DecodeTurnDoc(data)
	if err != nil {
		t.Fatal(err)
	}
	if head.Status != "inProgress" || len(head.Items) != 1 || head.Items[0].Type != "commandExecution" {
		t.Fatalf("head %+v", head)
	}
	if !strings.Contains(string(doc.Turn), `"futureField"`) {
		t.Fatal("unknown item fields must survive")
	}
	big := strings.Replace(string(data), `"Now draft a reply."`,
		`"`+strings.Repeat("x", TurnDocBytes)+`"`, 1)
	if _, _, err := DecodeTurnDoc([]byte(big)); err == nil {
		t.Fatal("a turn over 4 MiB was accepted")
	}
}

func TestTickets(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 50; i++ {
		ticket, err := NewTicket()
		if err != nil {
			t.Fatal(err)
		}
		if !ValidTicket(ticket) || seen[ticket] {
			t.Fatalf("ticket %q", ticket)
		}
		seen[ticket] = true
	}
	var sample struct {
		Cases []struct {
			Header []string `json:"header"`
			Ticket *string  `json:"ticket"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(readGolden(t, "ticket.subprotocols"), &sample); err != nil {
		t.Fatal(err)
	}
	for _, c := range sample.Cases {
		got, ok := TicketFromSubprotocols(c.Header)
		if c.Ticket == nil {
			if ok {
				t.Errorf("%v gave ticket %q", c.Header, got)
			}
		} else if !ok || got != *c.Ticket {
			t.Errorf("%v gave %q, %v", c.Header, got, ok)
		}
	}
}

// Go relays {"$bytes": …} untouched; the samples must still be standard
// padded base64 so a Go handler can read them with base64.StdEncoding.
func TestByteSamplesAreStandardBase64(t *testing.T) {
	var sample struct {
		Cases []struct {
			Hex    string `json:"hex"`
			Base64 string `json:"base64"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(readGolden(t, "bytes"), &sample); err != nil {
		t.Fatal(err)
	}
	for _, c := range sample.Cases {
		raw, err := hex.DecodeString(c.Hex)
		if err != nil {
			t.Fatal(err)
		}
		if got := base64.StdEncoding.EncodeToString(raw); got != c.Base64 {
			t.Errorf("%s: %s, sample %s", c.Hex, got, c.Base64)
		}
	}
}

func TestValidators(t *testing.T) {
	for _, name := range []string{"send", "snapshot", "getFavicons"} {
		if !ValidMethodName(name) {
			t.Errorf("%s refused", name)
		}
	}
	for _, name := range []string{"", "Send", "../x", "send/x", strings.Repeat("a", 65)} {
		if ValidMethodName(name) {
			t.Errorf("%q accepted", name)
		}
	}
	for _, u := range []string{"https://pay.example.com/x", "/desktop-pay?order=1"} {
		if !OpenableURL(u) {
			t.Errorf("%s refused", u)
		}
	}
	for _, u := range []string{"http://x.test/", "//evil.test/", "javascript:alert(1)", "https:///x", "",
		"/\\evil.test/", "/\t/evil.test/", "/\n/evil.test/", "HTTPS://pay.example.com/x", "https://pay.example.com/a b"} {
		if OpenableURL(u) {
			t.Errorf("%q accepted", u)
		}
	}
}

func TestBuilders(t *testing.T) {
	frames := []ServerFrame{
		ReadyFrame(0, false),
		EventFrame(5, json.RawMessage(`{"type":"engine","engine":{"state":"ready"}}`)),
		SnapshotFrame(5, json.RawMessage(`{"conversations":[]}`)),
		ErrorFrame(ErrCodeBadTicket, "Reload the page."),
	}
	for _, f := range frames {
		if err := f.Validate(); err != nil {
			t.Fatalf("%s: %v", f.T, err)
		}
		out, _ := json.Marshal(f)
		if _, err := DecodeServerFrame(out); err != nil {
			t.Fatalf("%s: %v", out, err)
		}
	}
	if out, _ := json.Marshal(ReadyFrame(0, false)); string(out) != `{"t":"ready","v":1,"seq":0,"resumed":false}` {
		t.Fatalf("ready %s", out)
	}
	call, err := CallFrame("g-1", LinkUser{ID: 7, AccessToken: "t"}, "snapshot", nil, 30000)
	if err != nil {
		t.Fatal(err)
	}
	if out, _ := json.Marshal(call); !strings.Contains(string(out), `"args":[]`) {
		t.Fatalf("call %s", out)
	}
	if _, err := CallFrame("g-1", LinkUser{ID: 7}, "snapshot", nil, 1); err == nil {
		t.Fatal("a call without an access token was accepted")
	}
	ok, err := OKResponse(map[string]int{"n": 1})
	if err != nil || ok.Validate() != nil || string(ok.Value) != `{"n":1}` {
		t.Fatalf("ok %+v %v", ok, err)
	}
	if none, _ := OKResponse(nil); none.Value != nil {
		t.Fatal("OKResponse(nil) has a value")
	}
	if ErrorResponse(ErrCodeTimeout, "Timed out.").Validate() != nil {
		t.Fatal("error response invalid")
	}
	if (RPCResponse{OK: false}).Validate() == nil {
		t.Fatal("an error answer without error was accepted")
	}
	if _, err := DecodeRPCRequest(make([]byte, RPCBodyBytes+1)); err == nil {
		t.Fatal("an oversized request was accepted")
	}
	if _, err := DecodeRPCRequest([]byte(`{"args":[]} {}`)); err == nil {
		t.Fatal("trailing data was accepted")
	}
}

func TestSampleNamesAreSorted(t *testing.T) {
	// The TypeScript test registers the same prefixes; keep both lists in step.
	var prefixes []string
	for _, c := range goldenChecks {
		prefixes = append(prefixes, c.prefix)
	}
	want := []string{
		"bytes", "constants", "doc.conversation.", "doc.split", "doc.turn.",
		"events.browser.", "events.server.", "invalid", "link.go.", "link.runner.",
		"rpc.request", "rpc.response.", "ticket.request", "ticket.response", "ticket.subprotocols",
	}
	sort.Strings(prefixes)
	if !reflect.DeepEqual(prefixes, want) {
		t.Fatalf("prefixes %v", prefixes)
	}
}

func TestAccountCookieNames(t *testing.T) {
	if got := AccountCookie(42); got != "__Secure-claudex_web_rt_42" {
		t.Fatalf("AccountCookie(42) = %q", got)
	}
	for name, want := range map[string]int64{
		AccountCookie(42):                       42,
		AccountCookie(1):                        1,
		RefreshCookie:                           0,
		RefreshCookie + "_":                     0,
		RefreshCookie + "_0":                    0,
		RefreshCookie + "_-3":                   0,
		RefreshCookie + "_007":                  0,
		RefreshCookie + "_12a":                  0,
		"other_42":                              0,
		RefreshCookie + "_99999999999999999999": 0,
	} {
		if got := AccountOfCookie(name); got != want {
			t.Errorf("AccountOfCookie(%q) = %d, want %d", name, got, want)
		}
	}
}
