package catalog

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/stretchr/testify/require"
)

func TestDirectoryFeaturedMembersBounds(t *testing.T) {
	for _, test := range []struct {
		name    string
		members []string
		valid   bool
	}{
		{"empty", []string{}, true},
		{"members", []string{"public-a", "public-b"}, true},
		{"identity-boundary", []string{strings.Repeat("x", 256)}, true},
		{"identity-too-long", []string{strings.Repeat("x", 257)}, false},
		{"blank", []string{""}, false},
		{"whitespace", []string{" \t\n"}, false},
		{"collection-boundary", repeatedDirectoryMemberIDs(50), true},
		{"collection-too-large", repeatedDirectoryMemberIDs(51), false},
	} {
		t.Run(test.name, func(t *testing.T) {
			encoded, err := json.Marshal(map[string]any{"featured": map[string]any{"title": "Bundle", "subtitle": "Members", "memberIds": test.members}})
			require.NoError(t, err)
			var curation directoryCuration
			require.NoError(t, json.Unmarshal(encoded, &curation))
			require.Equal(t, test.valid, validDirectoryCuration(&curation))
		})
	}
	for _, raw := range []string{`"member"`, `{}`, `[1]`, `[false]`} {
		var curation directoryCuration
		require.Error(t, json.Unmarshal([]byte(`{"featured":{"title":"Bundle","subtitle":"Members","memberIds":`+raw+`}}`), &curation))
	}
}

func repeatedDirectoryMemberIDs(count int) []string {
	ids := make([]string, count)
	for index := range ids {
		ids[index] = "public-member"
	}
	return ids
}

func TestDirectoryFeaturedMembersJSONPresence(t *testing.T) {
	for _, raw := range []string{
		`{"featured":{"title":"Bundle","subtitle":"Members"}}`,
		`{"featured":{"title":"Bundle","subtitle":"Members","memberIds":[]}}`,
		`{"featured":{"title":"Bundle","subtitle":"Members","memberIds":["public-b","public-a"]}}`,
	} {
		var curation directoryCuration
		require.NoError(t, json.Unmarshal([]byte(raw), &curation))
		require.True(t, validDirectoryCuration(&curation))
		encoded, err := json.Marshal(curation)
		require.NoError(t, err)
		require.JSONEq(t, raw, string(encoded))
	}
}

func TestDirectoryFeaturedMembersReviewAndPublish(t *testing.T) {
	for _, members := range []string{`[]`, `["public-b","public-a","public-b"]`} {
		t.Run(members, func(t *testing.T) {
			r, mock := directoryFixture(t)
			id := "12345678-1234-4234-8234-123456789012"
			var curation directoryCuration
			require.NoError(t, json.Unmarshal([]byte(`{"featured":{"title":"Published bundle","subtitle":"Reviewed members","memberIds":`+members+`}}`), &curation))
			input := validSubmission()
			input.Curation = &curation
			curated, err := json.Marshal(input)
			require.NoError(t, err)
			metadata, err := json.Marshal(curation)
			require.NoError(t, err)
			columns := []string{"id", "user_id", "input", "status", "reviewer_note", "updated_at"}
			mock.ExpectQuery(`input=CASE WHEN \$5::jsonb IS NULL THEN input ELSE jsonb_set`).WithArgs(id, "approved", "", int64(7), string(metadata)).WillReturnRows(sqlmock.NewRows(columns).AddRow(id, 7, curated, "approved", "", time.Now()))
			response := directoryRequest(r, "PUT", "/admin/directory/submissions/"+id+"/review", `{"status":"approved","curation":`+string(metadata)+`}`)
			require.Equal(t, 200, response.Code, response.Body.String())
			mock.ExpectQuery(`WHERE status='approved' AND withdrawn_at IS NULL`).WillReturnRows(sqlmock.NewRows([]string{"id", "input", "updated_at"}).AddRow(id, curated, time.Now()))
			response = directoryRequest(r, "GET", "/user/directory", "")
			require.Equal(t, 200, response.Code, response.Body.String())
			var published struct {
				Data []struct {
					Curation *directoryCuration `json:"curation"`
				} `json:"data"`
			}
			require.NoError(t, json.Unmarshal(response.Body.Bytes(), &published))
			require.Len(t, published.Data, 1)
			require.NotNil(t, published.Data[0].Curation.Featured.MemberIDs)
			encoded, err := json.Marshal(*published.Data[0].Curation.Featured.MemberIDs)
			require.NoError(t, err)
			require.JSONEq(t, members, string(encoded))
			require.NotContains(t, response.Body.String(), "me@example.com")
		})
	}
}
