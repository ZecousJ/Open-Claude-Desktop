package memory

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"

	"github.com/gin-gonic/gin"
)

const maxMelangeStateBytes = 1 << 20

var errMelangeTooLarge = infraerrors.New(http.StatusRequestEntityTooLarge, "CLAUDEX_MEMORY_TOO_LARGE",
	"Classified memory is too large. Remove something and try again.").
	WithMetadata(map[string]string{"limit": "state_bytes", "max": strconv.Itoa(maxMelangeStateBytes)})

type melangeView struct {
	Revision int64           `json:"revision"`
	State    json.RawMessage `json:"state"`
}

type melangeMode string

const (
	modeClassic melangeMode = "classic"
	modeMelange melangeMode = "melange"
	modeOff     melangeMode = "off"
)

type melangeStateMode struct {
	Mode melangeMode `json:"mode"`
}

func (c *Component) getMelange(g *gin.Context) {
	userID, ok := subject(g)
	if !ok {
		return
	}
	if !c.box.CanStore() {
		response.ErrorFrom(g, ErrEncryptionKeyMissing)
		return
	}
	row, err := c.store.melange(g.Request.Context(), userID)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	view := melangeView{Revision: row.Revision}
	if row.StateEnc.Valid {
		plain, err := c.box.Open(row.StateEnc.String)
		if err != nil {
			response.ErrorFrom(g, errStoreFailed.WithCause(err))
			return
		}
		view.State = json.RawMessage(plain)
	}
	g.Header("Cache-Control", "no-store")
	response.Success(g, view)
}

func (c *Component) putMelange(g *gin.Context) {
	userID, ok := subject(g)
	if !ok {
		return
	}
	var body struct {
		BaseRevision *int64          `json:"base_revision"`
		State        json.RawMessage `json:"state"`
	}
	if err := readBoundedJSON(g, &body, maxMelangeStateBytes+1024, errMelangeTooLarge); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	switch {
	case body.BaseRevision == nil || *body.BaseRevision < 0:
		response.ErrorFrom(g, invalid("base_revision", "min", "base_revision must be 0 (new) or the current revision."))
		return
	case len(body.State) == 0 || body.State[0] != '{':
		response.ErrorFrom(g, invalid("state", "object", "state must be a JSON object."))
		return
	case len(body.State) > maxMelangeStateBytes:
		response.ErrorFrom(g, errMelangeTooLarge)
		return
	}
	var next melangeStateMode
	if err := json.Unmarshal(body.State, &next); err != nil ||
		(next.Mode != modeClassic && next.Mode != modeMelange && next.Mode != modeOff) {
		response.ErrorFrom(g, invalid("state.mode", "enum", "mode must be classic, melange or off."))
		return
	}
	ctx := g.Request.Context()
	platform, _, _, _ := core.ClientInfo(g)
	policy, err := c.policy(ctx, userID, nil, platform)
	if err != nil {
		response.ErrorFrom(g, errPolicyUnavailable.WithCause(err))
		return
	}
	if !policy.Enabled {
		response.ErrorFrom(g, disabledFor("memory"))
		return
	}
	if next.Mode != modeOff && !policy.Generate {
		response.ErrorFrom(g, disabledFor("generate"))
		return
	}
	if !c.box.CanStore() {
		response.ErrorFrom(g, ErrEncryptionKeyMissing)
		return
	}
	row, err := c.store.melange(ctx, userID)
	if err != nil {
		response.ErrorFrom(g, errStoreFailed.WithCause(err))
		return
	}
	if row.Revision != *body.BaseRevision {
		response.ErrorFrom(g, conflict(row.Revision))
		return
	}
	var previous melangeStateMode
	if row.StateEnc.Valid {
		plain, err := c.box.Open(row.StateEnc.String)
		if err != nil {
			response.ErrorFrom(g, errStoreFailed.WithCause(err))
			return
		}
		if err := json.Unmarshal([]byte(plain), &previous); err != nil {
			response.ErrorFrom(g, errStoreFailed.WithCause(err))
			return
		}
	}
	sealed, err := c.box.Seal(string(body.State))
	if err != nil {
		response.ErrorFrom(g, sealError(err))
		return
	}
	write := melangeWrite{BaseRevision: row.Revision, StateEnc: sealed, StateBytes: len(body.State)}
	if previous.Mode != next.Mode {
		generate := next.Mode == modeClassic
		write.Prefs = prefsWrite{Generate: &generate, DefaultOn: policy.DefaultOn}
	}
	revision, err := c.store.saveMelange(ctx, userID, write)
	if err != nil {
		response.ErrorFrom(g, writeError(err))
		return
	}
	g.Header("Cache-Control", "no-store")
	response.Success(g, melangeView{Revision: revision, State: body.State})
}
