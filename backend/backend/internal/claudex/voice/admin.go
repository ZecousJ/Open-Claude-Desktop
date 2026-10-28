package voice

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"

	"github.com/gin-gonic/gin"
)

// maxSettingsBody bounds PUT /admin/claudex/voice (design 7.2 item 9).
const maxSettingsBody = 64 << 10

// maxSessionPageSize bounds GET /admin/claudex/voice/estimated-usage.
const maxSessionPageSize = 100

// AdminView is the answer of GET and PUT /api/v1/admin/claudex/voice. The
// upstream API key is write-only: the view only says whether one is stored
// and shows its last four characters.
type AdminView struct {
	Transcription AdminTranscription `json:"transcription"`
	Billing       AdminBilling       `json:"billing"`
	Warnings      []string           `json:"warnings"`
}

// AdminTranscription is the transcription settings without the key.
type AdminTranscription struct {
	Enabled            bool   `json:"enabled"`
	UpstreamURL        string `json:"upstream_url"`
	APIKeyConfigured   bool   `json:"api_key_configured"`
	APIKeyMasked       string `json:"api_key_masked"` // "" when no key is stored
	MaxSessionSeconds  int    `json:"max_session_seconds"`
	MaxBytes           int64  `json:"max_bytes"`
	IdleTimeoutSeconds int    `json:"idle_timeout_seconds"`
}

// AdminBilling explains how sessions are billed (read-only).
type AdminBilling struct {
	BilledModel    string `json:"billed_model"`
	BytesPerSecond int    `json:"bytes_per_second"`
	AudioFormat    string `json:"audio_format"`
	SampleRate     int    `json:"sample_rate"`
	Channels       int    `json:"channels"`
	// CanStoreAPIKey is false while the server has no fixed secret
	// encryption key: saving a key would then fail.
	CanStoreAPIKey bool `json:"can_store_api_key"`
}

// AdminUpdate is the body of PUT /api/v1/admin/claudex/voice. Fields left
// out keep their stored values. api_key replaces the stored key;
// clear_api_key removes it (and so turns dictation off).
type AdminUpdate struct {
	Transcription *struct {
		Enabled            *bool   `json:"enabled"`
		UpstreamURL        *string `json:"upstream_url"`
		APIKey             *string `json:"api_key"`
		ClearAPIKey        bool    `json:"clear_api_key"`
		MaxSessionSeconds  *int    `json:"max_session_seconds"`
		MaxBytes           *int64  `json:"max_bytes"`
		IdleTimeoutSeconds *int    `json:"idle_timeout_seconds"`
	} `json:"transcription"`
}

func (c *Component) adminGet(g *gin.Context) {
	s, err := c.setting.Get(g.Request.Context())
	if err != nil {
		response.ErrorFrom(g, infraerrors.InternalServer("CLAUDEX_VOICE_READ_FAILED", "Could not read the voice settings").WithCause(err))
		return
	}
	response.Success(g, c.view(g.Request.Context(), s))
}

func (c *Component) adminPut(g *gin.Context) {
	ctx := g.Request.Context()
	current, err := c.setting.Get(ctx)
	if err != nil {
		response.ErrorFrom(g, infraerrors.InternalServer("CLAUDEX_VOICE_READ_FAILED", "Could not read the voice settings").WithCause(err))
		return
	}
	g.Request.Body = http.MaxBytesReader(g.Writer, g.Request.Body, maxSettingsBody)
	var body AdminUpdate
	dec := json.NewDecoder(g.Request.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			response.ErrorFrom(g, invalid("body", "size", "The settings document is too large"))
			return
		}
		response.ErrorFrom(g, invalid("body", "json", "The settings document is not valid JSON or has unknown fields"))
		return
	}
	next, err := c.apply(current, body)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	saved, err := c.setting.Set(ctx, next)
	if err != nil {
		if infraerrors.Reason(err) == ReasonInvalid {
			response.ErrorFrom(g, err)
			return
		}
		response.ErrorFrom(g, infraerrors.InternalServer("CLAUDEX_VOICE_SAVE_FAILED", "Could not save the voice settings").WithCause(err))
		return
	}
	response.Success(g, c.view(ctx, saved))
}

// apply merges an update into the stored settings, encrypting a new key.
func (c *Component) apply(s Settings, body AdminUpdate) (Settings, error) {
	u := body.Transcription
	if u == nil {
		return s, nil
	}
	t := &s.Transcription
	newKey := u.APIKey != nil && *u.APIKey != ""
	if u.UpstreamURL != nil && t.KeyConfigured() && !newKey && !u.ClearAPIKey &&
		upstreamOrigin(strings.TrimSpace(*u.UpstreamURL)) != upstreamOrigin(t.UpstreamURL) {
		// The stored key is write-only: pointing it at another host without
		// entering it again would hand it to that host.
		return s, invalid("transcription.api_key", "required_for_new_upstream",
			"Enter the upstream API key again when changing the upstream host")
	}
	if u.Enabled != nil {
		t.Enabled = *u.Enabled
	}
	if u.UpstreamURL != nil {
		t.UpstreamURL = *u.UpstreamURL
	}
	if u.MaxSessionSeconds != nil {
		t.MaxSessionSeconds = *u.MaxSessionSeconds
	}
	if u.MaxBytes != nil {
		t.MaxBytes = *u.MaxBytes
	}
	if u.IdleTimeoutSeconds != nil {
		t.IdleTimeoutSeconds = *u.IdleTimeoutSeconds
	}
	switch {
	case u.ClearAPIKey && u.APIKey != nil && *u.APIKey != "":
		return s, invalid("transcription.api_key", "conflict", "Send either api_key or clear_api_key, not both")
	case u.ClearAPIKey:
		t.APIKeyCiphertext, t.APIKeyHint = "", ""
		t.Enabled = false
	case u.APIKey != nil && *u.APIKey != "":
		key := strings.TrimSpace(*u.APIKey)
		if err := validateAPIKey(key); err != nil {
			return s, err
		}
		sealed, err := c.box.seal(key)
		if err != nil {
			return s, err
		}
		t.APIKeyCiphertext, t.APIKeyHint = sealed, keyHint(key)
	}
	return s, nil
}

func (c *Component) view(ctx context.Context, s Settings) AdminView {
	t := s.Transcription
	masked := ""
	if t.KeyConfigured() {
		masked = "********" + t.APIKeyHint
	}
	return AdminView{
		Transcription: AdminTranscription{
			Enabled:            t.Enabled,
			UpstreamURL:        t.UpstreamURL,
			APIKeyConfigured:   t.KeyConfigured(),
			APIKeyMasked:       masked,
			MaxSessionSeconds:  t.MaxSessionSeconds,
			MaxBytes:           t.MaxBytes,
			IdleTimeoutSeconds: t.IdleTimeoutSeconds,
		},
		Billing: AdminBilling{
			BilledModel:    BilledModel,
			BytesPerSecond: BytesPerSecond,
			AudioFormat:    AudioFormat,
			SampleRate:     SampleRate,
			Channels:       Channels,
			CanStoreAPIKey: c.box.canStore(),
		},
		Warnings: c.warnings(ctx, t),
	}
}

// Built-in price of the upstream billing service (BillingService.CalculateAudioCost)
// used when a group has no transcription price.
const builtinSTTPricePerHour = "$0.10/hour"

// warnings lists problems an administrator should know about: a key that
// cannot be decrypted, and active groups whose transcription price is unset
// (the built-in default applies) or explicitly 0 (free).
func (c *Component) warnings(ctx context.Context, t TranscriptionSettings) []string {
	warnings := []string{}
	if t.KeyConfigured() {
		if _, err := c.box.open(t.APIKeyCiphertext); err != nil {
			warnings = append(warnings,
				"The stored upstream API key cannot be decrypted (the server encryption key changed); enter the key again.")
		}
	}
	if !c.box.canStore() {
		warnings = append(warnings,
			"The server has no fixed secret encryption key (TOTP_ENCRYPTION_KEY), so an upstream API key cannot be stored.")
	}
	if c.env.GroupRepo == nil {
		return warnings
	}
	groups, err := c.env.GroupRepo.ListActive(ctx)
	if err != nil {
		slog.Warn("claudex voice: listing groups for price warnings failed", "error", err)
		return append(warnings, "Group prices could not be checked; try again later.")
	}
	for i := range groups {
		g := &groups[i]
		name := strings.TrimSpace(g.Name)
		if name == "" {
			name = "#" + strconv.FormatInt(g.ID, 10)
		}
		switch {
		case g.AudioSTTPricePerHour == nil:
			warnings = append(warnings, fmt.Sprintf(
				"Group %s has no audio_stt_price_per_hour; dictation uses the built-in default price (%s).", name, builtinSTTPricePerHour))
		case *g.AudioSTTPricePerHour == 0:
			warnings = append(warnings, fmt.Sprintf(
				"Group %s has audio_stt_price_per_hour set to 0; dictation is free in this group.", name))
		}
	}
	return warnings
}

// adminSessions lists dictation sessions, newest first:
// GET /voice/estimated-usage?user_id=&page=&page_size=.
func (c *Component) adminSessions(g *gin.Context) {
	var userID *int64
	if raw := strings.TrimSpace(g.Query("user_id")); raw != "" {
		id, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || id <= 0 {
			response.ErrorFrom(g, infraerrors.BadRequest(ReasonInvalid, "user_id must be a positive integer").
				WithMetadata(map[string]string{"field": "user_id", "rule": "positive_integer"}))
			return
		}
		userID = &id
	}
	page, pageSize := response.ParsePagination(g)
	if pageSize > maxSessionPageSize {
		pageSize = maxSessionPageSize
	}
	if c.env.DB == nil {
		response.ErrorFrom(g, infraerrors.ServiceUnavailable("CLAUDEX_VOICE_READ_FAILED", "The session list is unavailable"))
		return
	}
	items, total, err := listSessions(g.Request.Context(), c.env.DB, userID, page, pageSize)
	if err != nil {
		response.ErrorFrom(g, infraerrors.InternalServer("CLAUDEX_VOICE_READ_FAILED", "Could not read the session list").WithCause(err))
		return
	}
	response.Paginated(g, items, total, page, pageSize)
}

// upstreamOrigin is the scheme and host of an upstream URL ("" when it does
// not parse): the stored key may only follow a URL change on the same origin.
func upstreamOrigin(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return ""
	}
	return strings.ToLower(u.Scheme) + "://" + strings.ToLower(u.Host)
}
