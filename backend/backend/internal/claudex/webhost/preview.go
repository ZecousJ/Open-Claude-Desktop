package webhost

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"

	"github.com/gin-gonic/gin"
)

// Artifact previews (web plan §1.2): the runner keeps preview documents in
// memory and createArtifactPreview answers /api/v1/claudex/web/preview/<id>,
// where id is "<user id>.<uuid>". The relay adds a signature valid for
// webproto.PreviewSignatureTTL (?k=<expiry>.<mac>) to that answer, and serves
// GET /web/preview/<id>?k=… by asking the user's runner for the document
// (previewDocument, a runner-internal call never relayed from a browser).
// The response carries the preview's own CSP with `sandbox allow-scripts`
// (an opaque origin: the document cannot read the web app's storage or call
// its APIs) and may be framed by the web app only. blob: and srcdoc are not
// used because they would inherit the web app's CSP.

const (
	createPreviewMethod = "createArtifactPreview"
	previewMethod       = "previewDocument"
	previewTimeout      = 30 * time.Second
	// defaultPreviewCSP is electron/artifact-previews.ts previewCsp.
	defaultPreviewCSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; sandbox allow-scripts"
)

var previewIDPattern = regexp.MustCompile(`^([1-9][0-9]{0,15})\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// previewOwner returns the user id in a preview id, 0 for a malformed id.
func previewOwner(id string) int64 {
	m := previewIDPattern.FindStringSubmatch(id)
	if m == nil {
		return 0
	}
	n, err := strconv.ParseInt(m[1], 10, 64)
	if err != nil {
		return 0
	}
	return n
}

type signer struct{ key [32]byte }

func newSigner() *signer {
	s := &signer{}
	if _, err := rand.Read(s.key[:]); err != nil {
		panic("webhost: no randomness for the preview key")
	}
	return s
}

func (s *signer) mac(id string, exp int64) string {
	h := hmac.New(sha256.New, s.key[:])
	_, _ = h.Write([]byte("claudex-preview\n" + id + "\n" + strconv.FormatInt(exp, 10)))
	return base64.RawURLEncoding.EncodeToString(h.Sum(nil))
}

func (s *signer) sign(id string, now time.Time) string {
	exp := now.Add(webproto.PreviewSignatureTTL).Unix()
	return strconv.FormatInt(exp, 10) + "." + s.mac(id, exp)
}

func (s *signer) verify(id, k string, now time.Time) bool {
	expText, mac, ok := strings.Cut(k, ".")
	if !ok {
		return false
	}
	exp, err := strconv.ParseInt(expText, 10, 64)
	if err != nil || now.Unix() >= exp || exp > now.Add(webproto.PreviewSignatureTTL+time.Minute).Unix() {
		return false
	}
	return hmac.Equal([]byte(mac), []byte(s.mac(id, exp)))
}

// signPreviewValue adds the signature to a createArtifactPreview answer that
// names one of the user's previews; any other answer is left alone.
func (c *Component) signPreviewValue(userID int64, value json.RawMessage) json.RawMessage {
	var path string
	if json.Unmarshal(value, &path) != nil || !strings.HasPrefix(path, webproto.PathPreview) {
		return value
	}
	id, _, _ := strings.Cut(strings.TrimPrefix(path, webproto.PathPreview), "?")
	if previewOwner(id) != userID {
		return value
	}
	out, err := json.Marshal(webproto.PathPreview + id + "?k=" + c.signer.sign(id, c.now()))
	if err != nil {
		return value
	}
	return out
}

// safeCSP keeps the runner's policy when it is one header line with a
// sandbox directive; otherwise the default preview policy.
func safeCSP(csp string) string {
	csp = strings.TrimSpace(csp)
	if csp == "" || len(csp) > 4096 || strings.ContainsAny(csp, "\r\n\x00") {
		return defaultPreviewCSP
	}
	hasSandbox := false
	for _, d := range strings.Split(csp, ";") {
		f := strings.Fields(d)
		if len(f) > 0 && strings.EqualFold(f[0], "sandbox") {
			hasSandbox = true
			for _, token := range f[1:] {
				// Never give the document the web app's origin.
				if strings.EqualFold(token, "allow-same-origin") || strings.EqualFold(token, "allow-top-navigation") {
					return defaultPreviewCSP
				}
			}
		}
		if len(f) > 0 && strings.EqualFold(f[0], "frame-ancestors") {
			return defaultPreviewCSP
		}
	}
	if !hasSandbox {
		return defaultPreviewCSP
	}
	return csp
}

func previewNotFound(g *gin.Context) {
	g.Header("Cache-Control", "no-store")
	g.Header("Content-Type", "text/plain; charset=utf-8")
	g.String(http.StatusNotFound, "Preview unavailable")
	g.Abort()
}

// GET /web/preview/:id?k=<signature> (public group: an iframe sends no
// Authorization header; the signature is the capability).
func (c *Component) preview(g *gin.Context) {
	id := g.Param("id")
	owner := previewOwner(id)
	if owner == 0 || !c.signer.verify(id, g.Query("k"), c.now()) {
		previewNotFound(g)
		return
	}
	ctx, cancel := context.WithTimeout(g.Request.Context(), previewTimeout)
	defer cancel()
	if _, _, _, ok := c.admit(ctx, owner); !ok {
		previewNotFound(g)
		return
	}
	rc := c.reg.current(ctx, owner)
	if rc == nil {
		previewNotFound(g)
		return
	}
	// The runner reads no credential for previewDocument; the call frame
	// needs a token, so the newest one is passed when there is one.
	token := "preview"
	if tok, ok := c.tokens.get(owner, c.now()); ok {
		token = tok.raw
	}
	arg, _ := json.Marshal(id)
	res, err := rc.call(ctx, webproto.LinkUser{ID: owner, AccessToken: token}, previewMethod, []json.RawMessage{arg}, previewTimeout)
	if err != nil || res.OK == nil || !*res.OK {
		previewNotFound(g)
		return
	}
	var doc struct {
		Content *string `json:"content"`
		CSP     string  `json:"csp"`
	}
	if json.Unmarshal(res.Value, &doc) != nil || doc.Content == nil {
		previewNotFound(g)
		return
	}
	h := g.Writer.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Content-Security-Policy", safeCSP(doc.CSP)+"; frame-ancestors 'self'")
	h.Set("X-Frame-Options", "SAMEORIGIN")
	h.Set("Cache-Control", "no-store")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cross-Origin-Resource-Policy", "same-origin")
	g.Status(http.StatusOK)
	_, _ = g.Writer.WriteString(*doc.Content)
}
