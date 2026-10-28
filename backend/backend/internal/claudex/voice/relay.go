package voice

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	coderws "github.com/coder/websocket"
)

// Wire protocol of GET /v1/audio/realtime/transcriptions (owner decision 18,
// upstream schema documented in impl/b7.md). The client sends
//
//	{"type":"start","requestId":"…","audio":{"format":"pcm_s16le","sampleRate":16000,"channels":1},
//	 "vad":{"enabled":true,"threshold":0.2,"prefixPaddingMs":300,"silenceDurationMs":800}}
//
// then binary PCM chunks, then {"type":"finish","requestId":"…"}. The relay
// forwards a rebuilt start frame (only the fields above plus an optional
// "language"), the audio up to the byte limit and the finish frame, and
// passes every upstream frame to the client unchanged. Errors the relay
// itself reports use the upstream's error frame shape:
//
//	{"type":"error","requestId":"…","code":"CLAUDEX_AUDIO_…","message":"…"}

// Codes of the relay's own error frames and close reasons.
const (
	CodeBadStart          = "CLAUDEX_AUDIO_BAD_START"
	CodeUnsupportedFormat = "CLAUDEX_AUDIO_UNSUPPORTED_FORMAT"
	CodeBadFrame          = "CLAUDEX_AUDIO_BAD_FRAME"
	CodeTooLarge          = "CLAUDEX_AUDIO_TOO_LARGE"
	CodeTooLong           = "CLAUDEX_AUDIO_TOO_LONG"
	CodeIdleTimeout       = "CLAUDEX_AUDIO_IDLE_TIMEOUT"
	CodeUpstreamFailed    = "CLAUDEX_AUDIO_UPSTREAM_FAILED"
)

// End reasons of a session (RelayResult.EndReason, the session log).
const (
	EndFinished       = "finished"        // the upstream closed after the client's finish
	EndClientClosed   = "client_closed"   // the client went away
	EndUpstreamClosed = "upstream_closed" // the upstream closed first
	EndUpstreamFailed = "upstream_failed" // the upstream connection broke
	EndIdle           = "idle_timeout"
	EndMaxBytes       = "max_bytes"
	EndMaxDuration    = "max_duration"
	EndBadStart       = "bad_start"
	EndCanceled       = "canceled" // the server is shutting down
)

// Limits bound one session.
type Limits struct {
	MaxBytes    int64
	MaxDuration time.Duration
	IdleTimeout time.Duration
}

// RelayResult describes a finished session.
type RelayResult struct {
	RequestID string
	// AudioBytes is the audio written to the upstream; the session is billed
	// for AudioBytes / BytesPerSecond seconds.
	AudioBytes int64
	// UpstreamRejected is true when the upstream's first frame was an error
	// (for example MODEL_NOT_FOUND): nothing was transcribed.
	UpstreamRejected  bool
	UpstreamErrorCode string
	EndReason         string
	Duration          time.Duration
}

// Seconds is the billed audio length.
func (r RelayResult) Seconds() float64 { return float64(r.AudioBytes) / BytesPerSecond }

// Billable reports whether the session is charged: audio reached the
// upstream and the upstream did not reject the session outright.
func (r RelayResult) Billable() bool { return r.AudioBytes > 0 && !r.UpstreamRejected }

// Conn is the part of *coderws.Conn the relay uses.
type Conn interface {
	Read(ctx context.Context) (coderws.MessageType, []byte, error)
	Write(ctx context.Context, typ coderws.MessageType, p []byte) error
	Close(code coderws.StatusCode, reason string) error
}

const relayWriteTimeout = 10 * time.Second

var requestIDPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)
var languagePattern = regexp.MustCompile(`^[A-Za-z]{2,8}([-_][A-Za-z0-9]{1,8}){0,2}$`)

type startFrame struct {
	Type      string          `json:"type"`
	RequestID string          `json:"requestId"`
	Audio     *audioSpec      `json:"audio"`
	VAD       json.RawMessage `json:"vad"`
	Language  string          `json:"language"`
}

type audioSpec struct {
	Format     string `json:"format"`
	SampleRate int    `json:"sampleRate"`
	Channels   int    `json:"channels"`
}

type vadSpec struct {
	Enabled           *bool    `json:"enabled,omitempty"`
	Threshold         *float64 `json:"threshold,omitempty"`
	PrefixPaddingMs   *int     `json:"prefixPaddingMs,omitempty"`
	SilenceDurationMs *int     `json:"silenceDurationMs,omitempty"`
}

type upstreamStart struct {
	Type      string    `json:"type"`
	RequestID string    `json:"requestId"`
	Audio     audioSpec `json:"audio"`
	VAD       *vadSpec  `json:"vad,omitempty"`
	Language  string    `json:"language,omitempty"`
}

type errorFrame struct {
	Type      string `json:"type"`
	RequestID string `json:"requestId,omitempty"`
	Code      string `json:"code"`
	Message   string `json:"message"`
}

// parseStart validates the client's start frame and builds the one sent
// upstream. It returns an error code and message on failure.
func parseStart(data []byte) (upstreamStart, string, string) {
	var in startFrame
	if err := json.Unmarshal(data, &in); err != nil || in.Type != "start" {
		return upstreamStart{}, CodeBadStart, `The first message must be a JSON start message ({"type":"start",...})`
	}
	out := upstreamStart{Type: "start", RequestID: in.RequestID,
		Audio: audioSpec{Format: AudioFormat, SampleRate: SampleRate, Channels: Channels}}
	if out.RequestID == "" {
		out.RequestID = newRequestID()
	} else if !requestIDPattern.MatchString(out.RequestID) {
		return upstreamStart{}, CodeBadStart, "requestId must be 1-128 letters, digits, '.', '_', ':' or '-'"
	}
	if a := in.Audio; a != nil {
		if (a.Format != "" && a.Format != AudioFormat) || (a.SampleRate != 0 && a.SampleRate != SampleRate) ||
			(a.Channels != 0 && a.Channels != Channels) {
			return upstreamStart{}, CodeUnsupportedFormat, "Only 16 kHz mono pcm_s16le audio is accepted"
		}
	}
	if len(in.VAD) > 0 && string(in.VAD) != "null" {
		var v vadSpec
		if err := json.Unmarshal(in.VAD, &v); err != nil {
			return upstreamStart{}, CodeBadStart, "vad must be an object"
		}
		if (v.Threshold != nil && (*v.Threshold < 0 || *v.Threshold > 1)) ||
			(v.PrefixPaddingMs != nil && (*v.PrefixPaddingMs < 0 || *v.PrefixPaddingMs > 10000)) ||
			(v.SilenceDurationMs != nil && (*v.SilenceDurationMs < 0 || *v.SilenceDurationMs > 10000)) {
			return upstreamStart{}, CodeBadStart, "vad values are out of range"
		}
		out.VAD = &v
	}
	if in.Language != "" {
		if !languagePattern.MatchString(in.Language) {
			return upstreamStart{}, CodeBadStart, "language must be a language tag such as en or zh-CN"
		}
		out.Language = in.Language
	}
	return out, "", ""
}

func newRequestID() string {
	var b [12]byte
	_, _ = rand.Read(b[:])
	return "req_" + hex.EncodeToString(b[:])
}

type relayEvent struct {
	from  string // "client", "upstream" or "limit"
	err   error
	limit string // End* reason of a reached limit
}

type relay struct {
	client, upstream Conn
	lim              Limits
	requestID        string

	audioBytes   atomic.Int64
	lastActivity atomic.Int64 // unix nanos
	finishing    atomic.Bool  // finish sent upstream; audio is dropped
	finishOnce   sync.Once
	limitReason  atomic.Value // string

	mu            sync.Mutex
	sawUpstream   bool
	rejected      bool
	upstreamError string
}

func (r *relay) touch() { r.lastActivity.Store(time.Now().UnixNano()) }

func (r *relay) write(ctx context.Context, c Conn, typ coderws.MessageType, p []byte) error {
	wctx, cancel := context.WithTimeout(ctx, relayWriteTimeout)
	defer cancel()
	return c.Write(wctx, typ, p)
}

func (r *relay) sendError(ctx context.Context, code, message string) {
	b, _ := json.Marshal(errorFrame{Type: "error", RequestID: r.requestID, Code: code, Message: message})
	_ = r.write(ctx, r.client, coderws.MessageText, b)
}

// finish sends the finish frame upstream once; later audio is dropped.
func (r *relay) finish(ctx context.Context) error {
	var err error
	r.finishOnce.Do(func() {
		r.finishing.Store(true)
		b, _ := json.Marshal(map[string]string{"type": "finish", "requestId": r.requestID})
		err = r.write(ctx, r.upstream, coderws.MessageText, b)
	})
	return err
}

// Relay runs one session between the accepted client connection and the
// upstream connection until either side closes, a limit ends it or ctx is
// cancelled. It closes both connections before it returns.
func Relay(ctx context.Context, client, upstream Conn, lim Limits) RelayResult {
	started := time.Now()
	r := &relay{client: client, upstream: upstream, lim: lim}
	r.touch()
	res := func(reason string) RelayResult {
		r.mu.Lock()
		defer r.mu.Unlock()
		if v, ok := r.limitReason.Load().(string); ok && v != "" && reason != EndClientClosed && reason != EndCanceled {
			reason = v
		}
		return RelayResult{RequestID: r.requestID, AudioBytes: r.audioBytes.Load(), UpstreamRejected: r.rejected,
			UpstreamErrorCode: r.upstreamError, EndReason: reason, Duration: time.Since(started)}
	}

	// The start frame.
	startCtx, cancelStart := context.WithTimeout(ctx, lim.IdleTimeout)
	typ, data, err := client.Read(startCtx)
	cancelStart()
	if err != nil {
		reason := EndClientClosed
		switch {
		case ctx.Err() != nil:
			reason = EndCanceled
		case errors.Is(err, context.DeadlineExceeded):
			reason = EndIdle
			r.sendError(ctx, CodeIdleTimeout, "No start message was received in time")
		}
		closeBoth(client, coderws.StatusPolicyViolation, CodeIdleTimeout, upstream)
		return res(reason)
	}
	if typ != coderws.MessageText {
		r.sendError(ctx, CodeBadStart, "The first message must be a JSON start message")
		closeBoth(client, coderws.StatusPolicyViolation, CodeBadStart, upstream)
		return res(EndBadStart)
	}
	start, code, message := parseStart(data)
	if code != "" {
		r.sendError(ctx, code, message)
		closeBoth(client, coderws.StatusPolicyViolation, code, upstream)
		return res(EndBadStart)
	}
	r.requestID = start.RequestID
	startJSON, _ := json.Marshal(start)
	if err := r.write(ctx, upstream, coderws.MessageText, startJSON); err != nil {
		r.sendError(ctx, CodeUpstreamFailed, "The transcription service connection failed")
		closeBoth(client, coderws.StatusInternalError, CodeUpstreamFailed, upstream)
		return res(EndUpstreamFailed)
	}
	r.touch()

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	events := make(chan relayEvent, 8)
	var pumps sync.WaitGroup
	pumps.Add(2)
	go func() { defer pumps.Done(); r.pumpClient(ctx, events) }()
	go func() { defer pumps.Done(); r.pumpUpstream(ctx, events) }()

	maxTimer := time.NewTimer(lim.MaxDuration)
	defer maxTimer.Stop()
	hardStop := time.NewTimer(lim.MaxDuration + lim.IdleTimeout)
	defer hardStop.Stop()
	tick := lim.IdleTimeout / 4
	if tick > time.Second {
		tick = time.Second
	}
	if tick < 10*time.Millisecond {
		tick = 10 * time.Millisecond
	}
	ticker := time.NewTicker(tick)
	defer ticker.Stop()

	reachLimit := func(reason string) {
		if r.finishing.Load() {
			return // the client already finished, or another limit was reached
		}
		r.limitReason.Store(reason)
		code, msg := CodeTooLarge, "The recording reached the server's size limit; the rest was not transcribed"
		if reason == EndMaxDuration {
			code, msg = CodeTooLong, "The recording reached the server's time limit; the rest was not transcribed"
		}
		r.sendError(ctx, code, msg)
		_ = r.finish(ctx)
		r.touch() // the idle timeout is now the grace period for the final results
	}

	var reason string
loop:
	for {
		select {
		case ev := <-events:
			switch ev.from {
			case "limit":
				reachLimit(ev.limit)
				continue
			case "client":
				reason = EndClientClosed
				if ctx.Err() != nil {
					reason = EndCanceled
				}
				closeConn(upstream, coderws.StatusNormalClosure, "")
			case "upstream":
				status := coderws.CloseStatus(ev.err)
				switch status {
				case -1:
					reason = EndUpstreamFailed
					r.sendError(ctx, CodeUpstreamFailed, "The transcription service connection failed")
					closeConn(client, coderws.StatusInternalError, CodeUpstreamFailed)
				default:
					reason = EndUpstreamClosed
					if r.finishing.Load() {
						reason = EndFinished
					}
					text := ""
					var ce coderws.CloseError
					if errors.As(ev.err, &ce) {
						text = ce.Reason
					}
					code, text := clientCloseFor(status, text)
					closeConn(client, code, text)
				}
			}
			break loop
		case <-maxTimer.C:
			reachLimit(EndMaxDuration)
		case <-hardStop.C:
			reason = EndMaxDuration
			closeBoth(client, coderws.StatusPolicyViolation, CodeTooLong, upstream)
			break loop
		case <-ticker.C:
			if time.Since(time.Unix(0, r.lastActivity.Load())) > lim.IdleTimeout {
				reason = EndIdle
				if !r.finishing.Load() {
					r.sendError(ctx, CodeIdleTimeout, "The session was idle for too long")
				}
				closeBoth(client, coderws.StatusPolicyViolation, CodeIdleTimeout, upstream)
				break loop
			}
		case <-ctx.Done():
			reason = EndCanceled
			closeBoth(client, coderws.StatusGoingAway, "", upstream)
			break loop
		}
	}
	cancel()
	pumps.Wait()
	return res(reason)
}

func (r *relay) pumpClient(ctx context.Context, events chan<- relayEvent) {
	limited := false
	for {
		typ, data, err := r.client.Read(ctx)
		if err != nil {
			events <- relayEvent{from: "client", err: err}
			return
		}
		r.touch()
		if typ == coderws.MessageText {
			var f struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(data, &f) != nil || f.Type != "finish" {
				r.sendError(ctx, CodeBadFrame, `Only binary audio and {"type":"finish"} may follow the start message`)
				continue
			}
			if err := r.finish(ctx); err != nil {
				events <- relayEvent{from: "upstream", err: err}
				return
			}
			continue
		}
		if limited || r.finishing.Load() {
			continue // audio after finish or after a limit is dropped
		}
		room := r.lim.MaxBytes - r.audioBytes.Load()
		over := int64(len(data)) >= room
		if over {
			data = data[:max(room, 0)]
		}
		if len(data) > 0 {
			if err := r.write(ctx, r.upstream, coderws.MessageBinary, data); err != nil {
				events <- relayEvent{from: "upstream", err: err}
				return
			}
			r.audioBytes.Add(int64(len(data)))
		}
		if over {
			limited = true
			events <- relayEvent{from: "limit", limit: EndMaxBytes}
		}
	}
}

func (r *relay) pumpUpstream(ctx context.Context, events chan<- relayEvent) {
	for {
		typ, data, err := r.upstream.Read(ctx)
		if err != nil {
			events <- relayEvent{from: "upstream", err: err}
			return
		}
		r.touch()
		if typ == coderws.MessageText {
			var f struct {
				Type string `json:"type"`
				Code string `json:"code"`
			}
			_ = json.Unmarshal(data, &f)
			r.mu.Lock()
			if f.Type == "error" {
				if !r.sawUpstream {
					r.rejected = true
				}
				if r.upstreamError == "" {
					r.upstreamError = truncateUTF8(f.Code, 64)
				}
			}
			r.sawUpstream = true
			r.mu.Unlock()
		}
		if err := r.write(ctx, r.client, typ, data); err != nil {
			events <- relayEvent{from: "client", err: err}
			return
		}
	}
}

// clientCloseFor maps the upstream close to one the relay may send: codes
// that must not appear in a close frame become 1011 (upstream failure).
func clientCloseFor(code coderws.StatusCode, reason string) (coderws.StatusCode, string) {
	switch {
	case code == coderws.StatusNoStatusRcvd, code == coderws.StatusAbnormalClosure, code == coderws.StatusTLSHandshake,
		code < 1000, code >= 5000:
		return coderws.StatusInternalError, CodeUpstreamFailed
	}
	return code, truncateUTF8(reason, 120)
}

func truncateUTF8(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

func closeConn(c Conn, code coderws.StatusCode, reason string) {
	_ = c.Close(code, reason)
}

// closeBoth closes the client with code/reason and the upstream normally, in
// parallel (each close waits for the peer's close frame).
func closeBoth(client Conn, code coderws.StatusCode, reason string, upstream Conn) {
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); closeConn(client, code, reason) }()
	go func() { defer wg.Done(); closeConn(upstream, coderws.StatusNormalClosure, "") }()
	wg.Wait()
}

// DialTimeout bounds the upstream handshake.
const DialTimeout = 10 * time.Second

// UpstreamReadLimit bounds one upstream frame (transcript events are small).
const UpstreamReadLimit = 1 << 20

// ClientReadLimit bounds one client frame (audio chunks of 100 ms are 3200
// bytes).
const ClientReadLimit = 256 << 10

// DialError is a failed upstream handshake. It never contains the API key
// or the upstream response body.
type DialError struct {
	StatusCode int // 0 when no HTTP response arrived
	Err        error
}

func (e *DialError) Error() string {
	if e.StatusCode > 0 {
		return "voice: upstream handshake answered HTTP " + strconv.Itoa(e.StatusCode)
	}
	return "voice: upstream handshake failed: " + e.Err.Error()
}

func (e *DialError) Unwrap() error { return e.Err }

// DialUpstream opens the upstream WebSocket with the stored key in the
// Authorization header.
func DialUpstream(ctx context.Context, up Upstream) (*coderws.Conn, error) {
	dctx, cancel := context.WithTimeout(ctx, DialTimeout)
	defer cancel()
	header := make(map[string][]string, 1)
	header["Authorization"] = []string{"Bearer " + up.APIKey}
	conn, resp, err := coderws.Dial(dctx, up.URL, &coderws.DialOptions{
		HTTPHeader:      header,
		CompressionMode: coderws.CompressionContextTakeover,
	})
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		de := &DialError{Err: err}
		if resp != nil && resp.StatusCode != 101 {
			de.StatusCode = resp.StatusCode
		}
		return nil, de
	}
	conn.SetReadLimit(UpstreamReadLimit)
	return conn, nil
}
