package ghconn

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"

	"github.com/gin-gonic/gin"
)

const maxSettingsBody = 16 << 10

// ReasonEncryptionKeyMissing refuses storing the client secret while the
// server has no fixed secret encryption key.
const ReasonEncryptionKeyMissing = "CLAUDEX_GITHUB_ENCRYPTION_KEY_MISSING"

// AdminView is the answer of GET and PUT /api/v1/admin/claudex/github. The
// client secret is write-only.
type AdminView struct {
	Enabled            bool     `json:"enabled"`
	Kind               string   `json:"kind"`
	ClientID           string   `json:"client_id"`
	ClientSecretSet    bool     `json:"client_secret_configured"`
	ClientSecretMasked string   `json:"client_secret_masked"`
	PublicBaseURL      string   `json:"public_base_url"`
	CallbackURL        string   `json:"callback_url"`
	CanStoreSecret     bool     `json:"can_store_secret"`
	Warnings           []string `json:"warnings"`
}

// AdminUpdate is the body of PUT /api/v1/admin/claudex/github. Fields left
// out keep their stored values.
type AdminUpdate struct {
	Enabled           *bool   `json:"enabled"`
	Kind              *string `json:"kind"`
	ClientID          *string `json:"client_id"`
	ClientSecret      *string `json:"client_secret"`
	ClearClientSecret bool    `json:"clear_client_secret"`
	PublicBaseURL     *string `json:"public_base_url"`
}

func (c *Component) adminGet(g *gin.Context) {
	s, err := c.setting.Get(g.Request.Context())
	if err != nil {
		response.ErrorFrom(g, infraerrors.InternalServer("CLAUDEX_GITHUB_READ_FAILED", "Could not read the GitHub settings").WithCause(err))
		return
	}
	response.Success(g, c.view(g.Request.Context(), s))
}

func (c *Component) adminPut(g *gin.Context) {
	ctx := g.Request.Context()
	current, err := c.setting.Get(ctx)
	if err != nil {
		response.ErrorFrom(g, infraerrors.InternalServer("CLAUDEX_GITHUB_READ_FAILED", "Could not read the GitHub settings").WithCause(err))
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
		response.ErrorFrom(g, infraerrors.InternalServer("CLAUDEX_GITHUB_SAVE_FAILED", "Could not save the GitHub settings").WithCause(err))
		return
	}
	response.Success(g, c.view(ctx, saved))
}

func (c *Component) apply(s Settings, u AdminUpdate) (Settings, error) {
	newSecret := u.ClientSecret != nil && *u.ClientSecret != ""
	if u.ClientID != nil && s.SecretConfigured() && !newSecret && !u.ClearClientSecret &&
		strings.TrimSpace(*u.ClientID) != s.ClientID {
		// The stored secret belongs to the stored client id.
		return s, invalid("client_secret", "required_for_new_client", "Enter the client secret again when changing the client ID")
	}
	if u.Enabled != nil {
		s.Enabled = *u.Enabled
	}
	if u.Kind != nil {
		s.Kind = *u.Kind
	}
	if u.ClientID != nil {
		s.ClientID = *u.ClientID
	}
	if u.PublicBaseURL != nil {
		s.PublicBaseURL = *u.PublicBaseURL
	}
	switch {
	case u.ClearClientSecret && newSecret:
		return s, invalid("client_secret", "conflict", "Send either client_secret or clear_client_secret, not both")
	case u.ClearClientSecret:
		s.ClientSecretCiphertext, s.ClientSecretHint = "", ""
		s.Enabled = false
	case newSecret:
		secret := strings.TrimSpace(*u.ClientSecret)
		if err := validateSecret(secret); err != nil {
			return s, err
		}
		sealed, err := c.box.Seal(secret)
		if err != nil {
			if errors.Is(err, core.ErrSecretKeyMissing) {
				return s, infraerrors.BadRequest(ReasonEncryptionKeyMissing,
					"Cannot store the client secret: the server has no fixed secret encryption key. "+
						"Set TOTP_ENCRYPTION_KEY (for example `openssl rand -hex 32`) and try again").
					WithMetadata(map[string]string{"field": "client_secret", "rule": "encryption_key"})
			}
			return s, err
		}
		s.ClientSecretCiphertext, s.ClientSecretHint = sealed, secretHint(secret)
	}
	return s, nil
}

func (c *Component) view(ctx context.Context, s Settings) AdminView {
	masked := ""
	if s.SecretConfigured() {
		masked = "********" + s.ClientSecretHint
	}
	v := AdminView{
		Enabled: s.Enabled, Kind: s.Kind, ClientID: s.ClientID,
		ClientSecretSet: s.SecretConfigured(), ClientSecretMasked: masked,
		PublicBaseURL:  s.PublicBaseURL,
		CanStoreSecret: c.box.CanStore(),
		Warnings:       []string{},
	}
	base := c.publicBase(ctx, s)
	if base != "" {
		v.CallbackURL = base + CallbackPath
	} else {
		v.Warnings = append(v.Warnings, "Set the public address of this service: GitHub sends users back to it after they approve.")
	}
	if s.SecretConfigured() {
		if _, err := c.box.Open(s.ClientSecretCiphertext); err != nil {
			v.Warnings = append(v.Warnings, "The stored client secret cannot be decrypted (the server encryption key changed); enter it again.")
		}
	}
	if !c.box.CanStore() {
		v.Warnings = append(v.Warnings, "The server has no fixed secret encryption key (TOTP_ENCRYPTION_KEY), so a client secret cannot be stored.")
	}
	return v
}
