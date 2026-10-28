package claudex

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/claudex/geoip"
	"github.com/stretchr/testify/require"
)

func TestLocationEndpointRequiresAuthenticationAndUsesCallerIP(t *testing.T) {
	r := testRouter(t, NewModule(Deps{}), nil, nil)
	unauthorized := do(r, http.MethodGet, "/api/v1/claudex/location", nil, "")
	require.Equal(t, http.StatusUnauthorized, unauthorized.Code)
	for _, ip := range []string{"1.1.1.1", "114.114.114.114", "127.0.0.1", "2001:4860:4860::8888"} {
		rec := do(r, http.MethodGet, "/api/v1/claudex/location", map[string]string{
			"Authorization": "Bearer test-token", "X-Real-IP": ip,
		}, "")
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		require.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
		var out struct {
			Data geoip.Location `json:"data"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
		require.Equal(t, geoip.Lookup(ip), out.Data)
	}
}
