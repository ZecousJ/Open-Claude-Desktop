package devices

import (
	"context"
	"errors"
	"fmt"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/service"
)

// OnSignup implements core.SignupHooker (H7): with provisioning on and
// on_signup.grant_default_group set, a self-registered user gets the default
// group when it is an exclusive standard group (public groups need no grant;
// subscription groups come from the upstream default subscriptions). It is
// idempotent; the module logs and ignores its errors.
func (c *Component) OnSignup(ctx context.Context, userID int64) error {
	p := c.settings(ctx)
	if !p.Enabled || !p.OnSignup.GrantDefaultGroup || p.DefaultGroupID == nil {
		return nil
	}
	if c.env.GroupRepo == nil || c.env.UserRepo == nil || c.env.Admin == nil {
		return errors.New("claudex devices: signup grant needs the group, user and admin services")
	}
	group, err := c.env.GroupRepo.GetByID(ctx, *p.DefaultGroupID)
	if err != nil {
		return fmt.Errorf("claudex devices: load default group: %w", err)
	}
	if group.Status != service.StatusActive || group.IsSubscriptionType() || !group.IsExclusive {
		return nil
	}
	user, err := c.env.UserRepo.GetByID(ctx, userID)
	if err != nil {
		return fmt.Errorf("claudex devices: load user: %w", err)
	}
	if containsID(user.AllowedGroups, group.ID) {
		return nil
	}
	allowed := append(append([]int64(nil), user.AllowedGroups...), group.ID)
	if _, err := c.env.Admin.UpdateUser(ctx, userID, &service.UpdateUserInput{AllowedGroups: &allowed}); err != nil {
		return fmt.Errorf("claudex devices: grant default group: %w", err)
	}
	return nil
}

// AllowUserAPIKeyCreate implements core.APIKeyCreateGate (owner decision 17):
// users may create API keys through /api/v1/keys only when the administrator
// turned user_api_keys_enabled on; administrators always may. Device keys are
// created by this component and never pass this gate.
func (c *Component) AllowUserAPIKeyCreate(ctx context.Context, _ int64, isAdmin bool) error {
	if isAdmin || c.settings(ctx).UserAPIKeysEnabled {
		return nil
	}
	return core.ErrUserAPIKeysDisabled
}
