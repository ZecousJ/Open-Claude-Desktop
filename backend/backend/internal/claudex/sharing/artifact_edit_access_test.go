package sharing

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func (s *memStore) editAccessRequests(_ context.Context, id int64) ([]EditAccessRequest, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := []EditAccessRequest{}
	for _, request := range s.editRequests[id] {
		result = append(result, request)
	}
	return result, nil
}
func (s *memStore) editAccess(_ context.Context, id int64, email, decision string, now time.Time) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	row := s.find(id)
	if row == nil || row.Status != StatusActive || row.expired(now) {
		return "unavailable", nil
	}
	for _, invited := range s.inviteList[id] {
		if email == invited && decision == "" {
			if s.roleOf(id, email) == "edit" {
				return "already_granted", nil
			}
			return "unavailable", nil
		}
	}
	if s.editRequests == nil {
		s.editRequests = map[int64]map[string]EditAccessRequest{}
	}
	if s.editRequests[id] == nil {
		s.editRequests[id] = map[string]EditAccessRequest{}
	}
	previous := s.editRequests[id][email]
	if decision != "" && previous.Status != "pending" {
		return "unavailable", nil
	}
	status := decision
	if decision == "" {
		if previous.Status == "pending" {
			return "already_pending", nil
		}
		if previous.Status == "declined" && now.Before(previous.UpdatedAt.Add(24*time.Hour)) {
			return "cooldown", nil
		}
		status = "pending"
	}
	if status == "granted" {
		s.inviteList[id] = append(s.inviteList[id], email)
	}
	s.editRequests[id][email] = EditAccessRequest{Email: email, Status: status, UpdatedAt: now}
	return status, nil
}

func TestArtifactEditAccessRequestLifecycle(t *testing.T) {
	f, _ := inviteFixture(t)
	res := f.do(http.MethodPost, "/api/v1/claudex/shares", artifactBody("access-request"))
	require.Equal(t, http.StatusCreated, res.Status, res.Raw)
	var share ShareDTO
	res.into(t, &share)
	token := strings.TrimPrefix(share.Path, PathPrefix+"/")
	read := "/api/v1/claudex/sharing/shared-with-me/" + token
	endpoint := read + "/artifact-access"
	f.userID = 8
	res = f.do(http.MethodGet, read, "")
	require.Equal(t, http.StatusOK, res.Status, res.Raw)
	var content SharedContentDTO
	res.into(t, &content)
	require.False(t, content.CanEdit)
	require.Equal(t, http.StatusNotFound, f.do(http.MethodPut, read+"/artifact", `{"content":"unauthorized"}`).Status)
	require.Contains(t, f.do(http.MethodPost, endpoint, `{}`).Raw, "pending")
	require.Contains(t, f.do(http.MethodPost, endpoint, `{}`).Raw, "already_pending")
	require.Equal(t, http.StatusNotFound, f.do(http.MethodPost, endpoint, `{"email":"u8@example.com","decision":"granted"}`).Status)
	f.userID = 7
	require.Contains(t, f.do(http.MethodPost, endpoint, `{"email":"u8@example.com","decision":"declined"}`).Raw, "declined")
	f.userID = 8
	require.Equal(t, http.StatusTooManyRequests, f.do(http.MethodPost, endpoint, `{}`).Status)
	f.store.editRequests[share.ID]["u8@example.com"] = EditAccessRequest{Email: "u8@example.com", Status: "declined", UpdatedAt: time.Time{}}
	require.Contains(t, f.do(http.MethodPost, endpoint, `{}`).Raw, "pending")
	f.userID = 7
	require.Contains(t, f.do(http.MethodPost, endpoint, `{"email":"u8@example.com","decision":"granted"}`).Raw, "granted")
	f.userID = 8
	require.Contains(t, f.do(http.MethodPost, endpoint, `{}`).Raw, "already_granted")
	require.Equal(t, http.StatusOK, f.do(http.MethodPut, read+"/artifact", `{"content":"approved"}`).Status)
}
