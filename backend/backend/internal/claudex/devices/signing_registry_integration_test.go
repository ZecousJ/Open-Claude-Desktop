//go:build integration

package devices_test

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

const signingDevicesURL = "/api/v1/claudex/signing-devices"

type signingDeviceReply struct {
	ID               string  `json:"id"`
	DeviceID         string  `json:"device_id"`
	DisplayName      string  `json:"display_name"`
	PublicKey        *string `json:"public_key"`
	IsHardwareBacked bool    `json:"is_hardware_backed"`
}

func signingDeviceKey(t *testing.T) string {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(t, err)
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	require.NoError(t, err)
	return base64.StdEncoding.EncodeToString(der)
}

func signingDeviceRequest(deviceID, key string) string {
	return fmt.Sprintf(`{"device_id":%q,"display_name":"Host name","platform":"darwin","public_key":%q,"is_hardware_backed":true}`, deviceID, key)
}

func decodeSigningDevice(t *testing.T, rec *httptest.ResponseRecorder) signingDeviceReply {
	t.Helper()
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	env := decodeEnv(t, rec)
	require.Zero(t, env.Code)
	var device signingDeviceReply
	require.NoError(t, json.Unmarshal(env.Data, &device))
	require.NotEmpty(t, device.ID)
	return device
}

func TestSigningDeviceRegistryLifecycle(t *testing.T) {
	h := newHarness(t)
	owner := h.user()
	ownerToken, otherToken := h.token(owner), h.token(h.user())
	install, newInstall := newDeviceID(), newDeviceID()
	key, newKey := signingDeviceKey(t), signingDeviceKey(t)
	require.Equal(t, http.StatusUnauthorized, h.do(http.MethodGet, signingDevicesURL, "", nil, "").Code)
	invalid := h.do(http.MethodPost, signingDevicesURL, ownerToken, nil, signingDeviceRequest(install, "AAAA"))
	require.Equal(t, http.StatusBadRequest, invalid.Code)

	d := decodeSigningDevice(t, h.do(http.MethodPost, signingDevicesURL, ownerToken, nil, signingDeviceRequest(install, key)))
	require.Equal(t, install, d.DeviceID)
	require.Equal(t, &key, d.PublicKey)
	require.True(t, d.IsHardwareBacked)
	otherList := h.do(http.MethodGet, signingDevicesURL, otherToken, nil, "")
	require.Equal(t, http.StatusOK, otherList.Code)
	require.JSONEq(t, `{"devices":[]}`, string(decodeEnv(t, otherList).Data))

	path := signingDevicesURL + "/" + d.ID
	name := strings.Repeat("🖥", 255)
	nameBody, err := json.Marshal(map[string]string{"display_name": name})
	require.NoError(t, err)
	require.Equal(t, http.StatusNotFound, h.do(http.MethodPatch, path, otherToken, nil, string(nameBody)).Code)
	require.Equal(t, http.StatusNotFound, h.do(http.MethodDelete, path, otherToken, nil, "").Code)
	require.Equal(t, http.StatusBadRequest, h.do(http.MethodPatch, path, ownerToken, nil, `{"display_name":"A\u202eB"}`).Code)
	renamed := decodeSigningDevice(t, h.do(http.MethodPatch, path, ownerToken, nil, string(nameBody)))
	require.Equal(t, name, renamed.DisplayName)
	continued := decodeSigningDevice(t, h.do(http.MethodPost, signingDevicesURL, ownerToken, nil, signingDeviceRequest(install, key)))
	require.Equal(t, renamed, continued)
	otherID := decodeSigningDevice(t, h.do(http.MethodPost, signingDevicesURL, ownerToken, nil, signingDeviceRequest(newInstall, key)))
	require.Equal(t, d.ID, otherID.ID)
	conflict := h.do(http.MethodPost, signingDevicesURL, ownerToken, nil, signingDeviceRequest(install, newKey))
	require.Equal(t, http.StatusConflict, conflict.Code)
	require.Equal(t, "cowork_remote_device_key_mismatch", decodeEnv(t, conflict).Reason)
	recovered := decodeSigningDevice(t, h.do(http.MethodPost, signingDevicesURL, ownerToken, nil, signingDeviceRequest(newInstall, newKey)))
	require.Equal(t, newInstall, recovered.DeviceID)
	require.Equal(t, recovered, decodeSigningDevice(t, h.do(http.MethodPost, signingDevicesURL, ownerToken, nil, signingDeviceRequest(install, newKey))))

	require.Equal(t, http.StatusOK, h.do(http.MethodDelete, path, ownerToken, nil, "").Code)
	require.Equal(t, http.StatusOK, h.do(http.MethodDelete, path, ownerToken, nil, "").Code)
	for _, id := range []string{install, newInstall} {
		revoked := h.do(http.MethodPost, signingDevicesURL, ownerToken, nil, signingDeviceRequest(id, key))
		require.Equal(t, http.StatusConflict, revoked.Code)
		require.Equal(t, "cowork_remote_device_registration_revoked", decodeEnv(t, revoked).Reason)
	}
	replacement := decodeSigningDevice(t, h.do(http.MethodPost, signingDevicesURL, ownerToken, nil, signingDeviceRequest(install, signingDeviceKey(t))))
	require.NotEqual(t, d.ID, replacement.ID)
	ownerList := h.do(http.MethodGet, signingDevicesURL, ownerToken, nil, "")
	require.Equal(t, http.StatusOK, ownerList.Code)
	var listed struct {
		Devices []signingDeviceReply `json:"devices"`
	}
	require.NoError(t, json.Unmarshal(decodeEnv(t, ownerList).Data, &listed))
	require.ElementsMatch(t, []signingDeviceReply{recovered, replacement}, listed.Devices)
}

func TestSigningDeviceKeylessUpgradeAndConcurrentLimit(t *testing.T) {
	h := newHarness(t)
	user := h.user()
	token := h.token(user)
	_, err := itDB.ExecContext(h.ctx, `INSERT INTO claudex_user_device_limits (user_id, max_devices) VALUES ($1, 1)`, user.ID)
	require.NoError(t, err)
	keyless := func(id string) *httptest.ResponseRecorder {
		body := `{"display_name":"Host name","platform":"linux","credential_class":"keyless"`
		if id != "" {
			body += fmt.Sprintf(`,"device_id":%q`, id)
		}
		return h.do(http.MethodPost, signingDevicesURL, token, nil, body+"}")
	}
	require.Equal(t, http.StatusNotFound, keyless(newDeviceID()).Code)
	d := decodeSigningDevice(t, keyless(""))
	require.NotEmpty(t, d.DeviceID)
	require.Nil(t, d.PublicKey)
	require.False(t, d.IsHardwareBacked)
	require.Equal(t, d, decodeSigningDevice(t, keyless(d.DeviceID)))
	key := signingDeviceKey(t)
	upgraded := decodeSigningDevice(t, h.do(http.MethodPost, signingDevicesURL, token, nil, signingDeviceRequest(d.DeviceID, key)))
	require.Equal(t, d.ID, upgraded.ID)
	require.Equal(t, &key, upgraded.PublicKey)
	downgrade := keyless(d.DeviceID)
	require.Equal(t, http.StatusConflict, downgrade.Code)
	require.Equal(t, "cowork_remote_device_keyed", decodeEnv(t, downgrade).Reason)
	require.Equal(t, http.StatusOK, h.do(http.MethodDelete, signingDevicesURL+"/"+d.ID, token, nil, "").Code)

	results := make(chan *httptest.ResponseRecorder, 2)
	start := make(chan struct{})
	for range 2 {
		body := signingDeviceRequest(newDeviceID(), signingDeviceKey(t))
		go func() {
			<-start
			results <- h.do(http.MethodPost, signingDevicesURL, token, nil, body)
		}()
	}
	close(start)
	statuses := []int{}
	for range 2 {
		rec := <-results
		statuses = append(statuses, rec.Code)
		if rec.Code == http.StatusBadRequest {
			require.Equal(t, "cowork_remote_device_limit_reached", decodeEnv(t, rec).Reason)
		}
	}
	require.ElementsMatch(t, []int{http.StatusOK, http.StatusBadRequest}, statuses)
}
