package sharing

import (
	"encoding/base64"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

func (c *Component) getScreenshot(g *gin.Context) {
	res, err := c.resolveToken(g.Request.Context(), g.Param("token"), true)
	if err != nil {
		c.pageError(g, err)
		return
	}
	image, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(res.snapshot.Screenshot, "data:image/png;base64,"))
	if err != nil || len(image) == 0 {
		g.Status(http.StatusNotFound)
		return
	}
	setPageHeaders(g.Writer)
	g.Header("Content-Security-Policy", "default-src 'none'; sandbox")
	g.Data(http.StatusOK, "image/png", image)
}
