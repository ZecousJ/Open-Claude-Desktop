package memory

import (
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/gin-gonic/gin"
)

// putControls replaces the complete ordered list in one transaction. No
// deletion happens until validation, encryption and the version check pass.
func (c *Component) putControls(g *gin.Context) {
	userID, ok := subject(g)
	if !ok {
		return
	}
	scope, err := scopeParam(g.Param("scope"))
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	var body struct {
		Controls    *[]string `json:"controls"`
		BaseVersion *string   `json:"base_controls_version"`
	}
	if err := readJSON(g, &body); err != nil {
		response.ErrorFrom(g, err)
		return
	}
	if body.Controls == nil || body.BaseVersion == nil || len(*body.BaseVersion) > 200 {
		response.ErrorFrom(g, invalid("body", "required", "controls and base_controls_version are required."))
		return
	}
	if len(*body.Controls) > MaxEditsPerScope {
		response.ErrorFrom(g, limitReached("edits_per_scope", MaxEditsPerScope))
		return
	}
	st, err := c.requestStatus(g, userID)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	if !st.Effective.Generate {
		response.ErrorFrom(g, disabledFor("generate"))
		return
	}
	edits := make([]editWrite, 0, len(*body.Controls))
	device := c.deviceID(g, userID)
	for _, raw := range *body.Controls {
		text := cleanEdit(raw)
		if text == "" {
			response.ErrorFrom(g, invalid("controls", "empty", "A memory edit cannot be empty."))
			return
		}
		if runeLen(text) > MaxEditChars {
			response.ErrorFrom(g, limitReached("edit_chars", MaxEditChars))
			return
		}
		if looksSecret(text) {
			response.ErrorFrom(g, ErrSensitive)
			return
		}
		sealed, err := c.box.Seal(text)
		if err != nil {
			response.ErrorFrom(g, sealError(err))
			return
		}
		edits = append(edits, editWrite{Scope: scope, TextEnc: sealed, TextBytes: len(text), DeviceID: device})
	}
	saved, version, err := c.store.replaceControls(g.Request.Context(), userID, scope, edits, *body.BaseVersion)
	if err != nil {
		response.ErrorFrom(g, writeError(err))
		return
	}
	views := make([]EditView, 0, len(saved))
	for _, edit := range saved {
		views = append(views, c.editView(edit))
	}
	g.Header("Cache-Control", "no-store")
	response.Success(g, struct {
		Edits   []EditView `json:"edits"`
		Version string     `json:"controls_version"`
	}{views, version})
}
