package sharing

import (
	"encoding/json"
	"io"
	"net/http"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"

	"github.com/gin-gonic/gin"
)

// POST /api/v1/claudex/shared/:token/reports {reason, detail,
// opt_out_of_training} (anonymous):
// the JSON twin of the page's Report form. 204 when accepted (duplicates
// from the same visitor too), 404 for a link that is not visible or when
// reports are off, 400 for an unknown reason, 429 over 10 reports an hour.
func (c *Component) postReportJSON(g *gin.Context) {
	if g.Request.Body == nil {
		g.Request.Body = http.NoBody
	}
	raw, err := io.ReadAll(http.MaxBytesReader(g.Writer, g.Request.Body, maxReportBodyBytes))
	if err != nil {
		response.ErrorFrom(g, invalidReport("body"))
		return
	}
	var body struct {
		Reason           string `json:"reason"`
		Detail           string `json:"detail"`
		OptOutOfTraining bool   `json:"opt_out_of_training"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		response.ErrorFrom(g, invalidReport("body"))
		return
	}
	in := reportInput{Reason: body.Reason, Detail: body.Detail, OptOutOfTraining: body.OptOutOfTraining}
	switch c.report(g.Request.Context(), g.Param("token"), in, middleware.SecurityClientIP(g)) {
	case reportAccepted:
		g.Status(http.StatusNoContent)
		g.Writer.WriteHeaderNow()
	case reportBadInput:
		response.ErrorFrom(g, invalidReport("reason"))
	case reportLimited:
		response.ErrorFrom(g, infraerrors.TooManyRequests("CLAUDEX_RATE_LIMITED", "Too many reports. Try again later."))
	case reportFailed:
		response.ErrorFrom(g, errStoreFailed)
	default:
		response.ErrorFrom(g, ErrShareNotFound)
	}
}
