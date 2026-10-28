package service

import (
	"testing"

	"github.com/stretchr/testify/require"
)

// A model the allowlist names is in the catalog when the group's accounts
// can serve it although /v1/models does not list it: accounts that declare
// no models take any; otherwise a mapping key (or wildcard) must name it.
func TestAllowlistListingNamesTheAllowlistsModels(t *testing.T) {
	allowlist := GroupModelAllowlist{Enabled: true, Models: []string{"gpt-6-sol", "gpt-5*", "gpt-6.1-sol", " ", "GPT-6-SOL"}}
	source := []string{"gpt-6-sol", "gpt-5.5", "gpt-5.6-luna", "o3"}
	// No account declares models (passthrough): every named model.
	require.Equal(t, []string{"gpt-6-sol", "gpt-5.5", "gpt-5.6-luna", "gpt-6.1-sol"}, AllowlistListing(allowlist, source, nil))
	// Mapped by a wildcard: listed.
	require.Equal(t, []string{"gpt-6-sol", "gpt-5.5", "gpt-5.6-luna", "gpt-6.1-sol"}, AllowlistListing(allowlist, source, []string{"gpt-6*", "gpt-5.5"}))

	off := GroupModelAllowlist{Enabled: false, Models: []string{"gpt-6.1-sol"}}
	require.Equal(t, source, AllowlistListing(off, source, nil))
}

// The codex group of 2026-10-02: the allowlist names eighteen models, the
// accounts map six; only the six the accounts serve are listed.
func TestAllowlistListingLeavesOutModelsNoAccountMaps(t *testing.T) {
	allowlist := GroupModelAllowlist{Enabled: true, Models: []string{"gpt-5.6-sol", "gpt-6", "gpt-5.4", "gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol"}}
	mapped := []string{"gpt-6-sol", "gpt-5.6-sol", "gpt-6.1-sol", "codex-auto-review"}
	// In the allowlist's order (FilterForListing), the reviewer model left out.
	require.Equal(t, []string{"gpt-5.6-sol", "gpt-6-sol", "gpt-6.1-sol"}, AllowlistListing(allowlist, mapped, mapped))
}
