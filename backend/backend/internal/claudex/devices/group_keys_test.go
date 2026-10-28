//go:build unit

package devices

import (
	"context"
	"errors"
	"sort"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/stretchr/testify/require"
)

// memKeys is an in-memory apiKeyStore for the multi-group key tests.
type memKeys struct {
	apiKeyStore
	next      int64
	keys      map[int64]*service.APIKey
	deleted   []int64
	failGroup map[int64]error // Create in this group fails
}

func newMemKeys() *memKeys {
	return &memKeys{next: 100, keys: map[int64]*service.APIKey{}, failGroup: map[int64]error{}}
}

func (m *memKeys) add(userID, groupID int64, status string) *service.APIKey {
	m.next++
	g := groupID
	k := &service.APIKey{ID: m.next, UserID: userID, GroupID: &g, Status: status, Key: "sk-test-" + time.Now().String()}
	m.keys[k.ID] = k
	return k
}

func (m *memKeys) Create(_ context.Context, userID int64, req service.CreateAPIKeyRequest) (*service.APIKey, error) {
	if err := m.failGroup[*req.GroupID]; err != nil {
		return nil, err
	}
	k := m.add(userID, *req.GroupID, service.StatusAPIKeyActive)
	k.Name = req.Name
	return k, nil
}

func (m *memKeys) GetByID(_ context.Context, id int64) (*service.APIKey, error) {
	k, ok := m.keys[id]
	if !ok {
		return nil, service.ErrAPIKeyNotFound
	}
	return k, nil
}

func (m *memKeys) Delete(_ context.Context, id, userID int64) error {
	k, ok := m.keys[id]
	if !ok || k.UserID != userID {
		return service.ErrAPIKeyNotFound
	}
	delete(m.keys, id)
	m.deleted = append(m.deleted, id)
	return nil
}

func groupsOf(ids ...int64) []service.Group {
	out := make([]service.Group, 0, len(ids))
	for _, id := range ids {
		out = append(out, service.Group{ID: id, Name: "g", Platform: service.PlatformOpenAI, Status: service.StatusActive})
	}
	return out
}

func groupIDs(keys []GroupKey) []int64 {
	out := make([]int64, 0, len(keys))
	for _, k := range keys {
		out = append(out, k.Group.ID)
	}
	return out
}

func TestKeyGroupsFor(t *testing.T) {
	groups := []service.Group{
		{ID: 9, Status: service.StatusActive},
		{ID: 3, Status: service.StatusActive},
		{ID: 5, Status: "disabled"},
		{ID: 7, Status: service.StatusActive},
		{ID: 3, Status: service.StatusActive}, // listed twice
	}
	ids := func(gs []service.Group) []int64 {
		out := []int64{}
		for _, g := range gs {
			out = append(out, g.ID)
		}
		return out
	}
	p := defaultProvisioning()
	require.Equal(t, []int64{7, 3, 9}, ids(keyGroupsFor(p, groups, 7)), "plan group first, then by id, inactive left out")
	p.AllowedGroupIDs = []int64{7, 9}
	require.Equal(t, []int64{9, 7}, ids(keyGroupsFor(p, groups, 9)), "allowed groups only")

	var many []service.Group
	for id := int64(1); id <= 20; id++ {
		many = append(many, service.Group{ID: id, Status: service.StatusActive})
	}
	got := keyGroupsFor(defaultProvisioning(), many, 15)
	require.Len(t, got, MaxKeyGroups)
	require.Equal(t, int64(15), got[0].ID, "the plan group is always kept")
	require.Equal(t, int64(9), got[MaxKeyGroups-1].ID)
}

func syncWith(t *testing.T, c *Component, keys *memKeys, userID int64, row *deviceRow, extras []groupKeyRow, groups []service.Group, plan int64, rotateAll bool) (*keySync, error) {
	t.Helper()
	return c.syncKeys(context.Background(), keys, userID, row, extras, groups, plan, rotateAll,
		func(groupID int64, primary bool) (*service.APIKey, error) {
			k, err := keys.Create(context.Background(), userID, service.CreateAPIKeyRequest{Name: groupKeyName("claudex-device:x", groupID, primary), GroupID: &groupID})
			if err != nil {
				return nil, mapKeyError(err)
			}
			return k, nil
		})
}

func TestSyncKeysGivesEveryGroupOneKey(t *testing.T) {
	c := newTestComponent(core.Deps{})
	keys := newMemKeys()

	// A new device gets a key per group, the plan group's first.
	s, err := syncWith(t, c, keys, 7, nil, nil, groupsOf(4, 11), 4, false)
	require.NoError(t, err)
	require.Equal(t, []int64{4, 11}, groupIDs(s.Keys))
	require.True(t, s.Keys[0].Primary && !s.Keys[1].Primary)
	require.Equal(t, s.Keys[0].Key, s.Primary)
	require.Len(t, s.Created, 2)
	require.False(t, s.Rotated || s.Moved)
	require.Equal(t, "claudex-device:x", s.Keys[0].Key.Name)
	require.Equal(t, "claudex-device:x:g11", s.Keys[1].Key.Name)
	require.Equal(t, []groupKeyRow{{GroupID: 11, APIKeyID: s.Keys[1].Key.ID}}, s.extraRows())

	primaryID, grokID := s.Keys[0].Key.ID, s.Keys[1].Key.ID
	row := &deviceRow{ID: 1, UserID: 7, APIKeyID: &primaryID}
	extras := s.extraRows()

	// Idempotent: nothing is created or deleted the second time.
	again, err := syncWith(t, c, keys, 7, row, extras, groupsOf(4, 11), 4, false)
	require.NoError(t, err)
	require.Empty(t, again.Created)
	require.Empty(t, again.Deleted)
	require.Equal(t, primaryID, again.Primary.ID)

	// The plan moves to group 11: its existing key becomes the primary one,
	// group 4 keeps its key, no key moves between groups.
	moved, err := syncWith(t, c, keys, 7, row, extras, []service.Group{groupsOf(11)[0], groupsOf(4)[0]}, 11, false)
	require.NoError(t, err)
	require.Equal(t, grokID, moved.Primary.ID)
	require.True(t, moved.Moved)
	require.Empty(t, moved.Created)
	require.Equal(t, []groupKeyRow{{GroupID: 4, APIKeyID: primaryID}}, moved.extraRows())
	require.Equal(t, int64(4), *keys.keys[primaryID].GroupID, "the old primary key stays in its group")
}

func TestSyncKeysRotatesAndDropsKeys(t *testing.T) {
	c := newTestComponent(core.Deps{})
	keys := newMemKeys()
	primary := keys.add(7, 4, service.StatusAPIKeyActive)
	disabled := keys.add(7, 11, service.StatusAPIKeyDisabled)
	gone := keys.add(7, 12, service.StatusAPIKeyActive) // group no longer usable
	exhausted := keys.add(7, 13, service.StatusAPIKeyQuotaExhausted)
	foreign := keys.add(8, 14, service.StatusAPIKeyActive) // someone else's key
	row := &deviceRow{ID: 1, UserID: 7, APIKeyID: &primary.ID}
	extras := []groupKeyRow{{11, disabled.ID}, {12, gone.ID}, {13, exhausted.ID}, {14, foreign.ID}}

	s, err := syncWith(t, c, keys, 7, row, extras, groupsOf(4, 11, 13), 4, false)
	require.NoError(t, err)
	require.Equal(t, []int64{4, 11, 13}, groupIDs(s.Keys))
	require.Equal(t, primary.ID, s.Keys[0].Key.ID)
	require.NotEqual(t, disabled.ID, s.Keys[1].Key.ID, "the disabled key is replaced")
	require.True(t, s.Keys[1].Created)
	require.Equal(t, exhausted.ID, s.Keys[2].Key.ID, "a key that used up its quota is kept")
	deleted := append([]int64(nil), s.Deleted...)
	sort.Slice(deleted, func(i, j int) bool { return deleted[i] < deleted[j] })
	require.Equal(t, []int64{disabled.ID, gone.ID}, deleted)
	require.Contains(t, keys.keys, foreign.ID, "another user's key is never deleted")

	// A revoked device signing in again: every key is new.
	extras = s.extraRows()
	all, err := syncWith(t, c, keys, 7, row, extras, groupsOf(4, 11, 13), 4, true)
	require.NoError(t, err)
	require.Len(t, all.Created, 3)
	require.True(t, all.Rotated)
	require.NotContains(t, keys.keys, primary.ID)
	require.NotContains(t, keys.keys, exhausted.ID)
}

func TestSyncKeysGroupFailures(t *testing.T) {
	c := newTestComponent(core.Deps{})
	keys := newMemKeys()
	keys.failGroup[11] = service.ErrGroupNotAllowed
	s, err := syncWith(t, c, keys, 7, nil, nil, groupsOf(4, 11), 4, false)
	require.NoError(t, err, "a group that cannot be bound right now is skipped")
	require.Equal(t, []int64{4}, groupIDs(s.Keys))

	keys.failGroup[4] = service.ErrGroupNotAllowed
	_, err = syncWith(t, c, keys, 7, nil, nil, groupsOf(4), 4, false)
	require.ErrorIs(t, err, core.ErrNoPlan, "the plan group's key is required")

	keys = newMemKeys()
	keys.failGroup[11] = errors.New("db down")
	_, err = syncWith(t, c, keys, 7, nil, nil, groupsOf(4, 11), 4, false)
	require.Error(t, err)
}

// Balance only (owner decision, 2026-10-12): an account without a plan group
// still registers; its device keeps no key at all.
func TestSyncKeysWithoutAPlanKeepsNoKey(t *testing.T) {
	c := newTestComponent(core.Deps{})
	keys := newMemKeys()

	none, err := syncWith(t, c, keys, 7, nil, nil, nil, 0, false)
	require.NoError(t, err)
	require.Nil(t, none.Primary)
	require.Empty(t, none.Keys)
	require.Empty(t, none.Created)
	require.Empty(t, none.extraRows())

	// A device that held keys before the account lost its groups.
	primary := keys.add(7, 4, service.StatusAPIKeyActive)
	other := keys.add(7, 11, service.StatusAPIKeyActive)
	row := &deviceRow{ID: 1, UserID: 7, APIKeyID: &primary.ID}
	lost, err := syncWith(t, c, keys, 7, row, []groupKeyRow{{11, other.ID}}, nil, 0, false)
	require.NoError(t, err)
	require.Nil(t, lost.Primary)
	require.Empty(t, lost.Keys)
	require.False(t, lost.Moved || lost.Rotated)
	deleted := append([]int64(nil), lost.Deleted...)
	sort.Slice(deleted, func(i, j int) bool { return deleted[i] < deleted[j] })
	require.Equal(t, []int64{primary.ID, other.ID}, deleted, "the keys of groups the account lost are deleted")
	require.Empty(t, keys.keys)
}

func TestDeviceRowIDsWithoutAPlan(t *testing.T) {
	require.Equal(t, int64(0), planGroupOf(nil))
	require.Equal(t, int64(4), planGroupOf(&core.PlanRef{GroupID: 4}))

	keyID, groupID := keyAndGroupIDs(nil, nil)
	require.Nil(t, keyID, "no api_key_id without a plan group")
	require.Nil(t, groupID)

	keyID, groupID = keyAndGroupIDs(&service.APIKey{ID: 9}, &core.PlanRef{GroupID: 4})
	require.Equal(t, int64(9), *keyID)
	require.Equal(t, int64(4), *groupID)
}

func TestLookupByAPIKeyFindsGroupKeys(t *testing.T) {
	ctx := context.Background()
	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	defer func() { _ = db.Close() }()
	c := newTestComponent(core.Deps{DB: db})
	values := deviceRowValues(51, 7, 11, nil)
	values[len(values)-1] = int64(9)
	mock.ExpectQuery(`claudex_device_group_keys`).WithArgs(int64(13)).
		WillReturnRows(sqlmock.NewRows(deviceCols).AddRow(values...))
	dev, ok := c.LookupByAPIKey(ctx, 13)
	require.True(t, ok)
	require.Equal(t, int64(51), dev.ID)
	require.Equal(t, int64(13), dev.APIKeyID, "the key the request used")
	require.Equal(t, int64(9), *dev.GroupID, "the group of that key")
	require.NoError(t, mock.ExpectationsWereMet())
}

func TestWebKeyRegistrationShape(t *testing.T) {
	g4, g11 := int64(4), int64(11)
	w := &WebKey{
		DeviceID: 3, APIKeyID: 21, Key: "sk-plan", Plan: &core.PlanRef{GroupID: 4},
		Keys: []GroupKey{
			{Group: service.Group{ID: 4, Name: "openai", Platform: service.PlatformOpenAI}, Key: &service.APIKey{ID: 21, Key: "sk-plan", Status: "active", GroupID: &g4}, Primary: true},
			{Group: service.Group{ID: 11, Name: "grok", Platform: service.PlatformGrok}, Key: &service.APIKey{ID: 22, Key: "sk-grok", Status: "active", GroupID: &g11}},
		},
	}
	require.Equal(t, int64(22), w.KeyForGroup(11).ID)
	require.Nil(t, w.KeyForGroup(5))
	r := w.Registration()
	require.Equal(t, int64(21), r.APIKey.ID)
	require.Len(t, r.APIKeys, 2)
	require.Equal(t, GroupKeyJSON{ID: 22, Key: "sk-grok", Status: "active", GroupID: 11, GroupName: "grok", Platform: "grok", Protocol: "chat"}, r.APIKeys[1])
	require.True(t, r.APIKeys[0].Primary)
	require.Equal(t, "responses", r.APIKeys[0].Protocol)
}
