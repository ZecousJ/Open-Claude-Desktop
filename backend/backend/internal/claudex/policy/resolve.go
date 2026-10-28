package policy

import (
	"math"
	"strings"
)

// Fallbacks are upstream settings the links fall back to (design 1.6.1):
// help → doc_url; plans and get_more_usage → purchase_subscription_url when
// purchase_subscription_enabled. Only https URLs are used.
type Fallbacks struct {
	DocURL                  *string `json:"doc_url"`
	PurchaseSubscriptionURL *string `json:"purchase_subscription_url"`
}

// Layers returns the patches that apply to a client, lowest first: defaults,
// the plan group's override, the user's override. groupID nil means no plan;
// userID 0 means no user (group-only preview).
func (d Document) Layers(groupID *int64, userID int64) []Patch {
	layers := []Patch{d.Defaults}
	if groupID != nil {
		if p, ok := d.GroupOverrides[overrideKey(*groupID)]; ok {
			layers = append(layers, p)
		}
	}
	if userID > 0 {
		if p, ok := d.UserOverrides[overrideKey(userID)]; ok {
			layers = append(layers, p)
		}
	}
	return layers
}

// Resolve merges built-in defaults ← defaults ← group override ← user
// override (design 2.3): scalars and lists replace, links, attachments,
// usage_banner and scheduled_tasks merge field by field, links.learn_more
// replaces. Then permission_modes is picked for the platform (its own key,
// else "default", else the built-in list), max_megabytes becomes max_bytes
// and empty links fall back to the upstream settings. memory, research,
// browser and computer_use also merge field by field (see mergeRound2);
// memory off turns its switches off, and web_search off turns Research and
// X search off.
func (d Document) Resolve(groupID *int64, userID int64, platform string, fb Fallbacks) Resolved {
	f := Builtin()
	var modes *ModeSpec
	var maxMB Nullable[float64]
	for _, p := range d.Layers(groupID, userID) {
		if p.PermissionModes != nil {
			modes = p.PermissionModes
		}
		setBool(&f.Incognito, p.Incognito)
		setBool(&f.WebSearch, p.WebSearch)
		setBool(&f.WebSearchDefault, p.WebSearchDefault)
		setBool(&f.Voice, p.Voice)
		setBool(&f.LocalMCPEditing, p.LocalMCPEditing)
		setBool(&f.DeveloperModeEnabled, p.DeveloperModeEnabled)
		setBool(&f.DesktopExtensionsEnabled, p.DesktopExtensionsEnabled)
		setBool(&f.DeveloperMCPEnabled, p.DeveloperMCPEnabled)
		setBool(&f.RemoteImages, p.RemoteImages)
		setBool(&f.ExternalLinks, p.ExternalLinks)
		setBool(&f.ApprovalsAlwaysAllow, p.ApprovalsAlwaysAllow)
		if p.RemoteImageDomains.Set {
			f.RemoteImageDomains = nil
			if p.RemoteImageDomains.Valid {
				f.RemoteImageDomains = cloneStrings(p.RemoteImageDomains.Value)
			}
		}
		if p.TrustedLinkDomains != nil {
			f.TrustedLinkDomains = cloneStrings(*p.TrustedLinkDomains)
		}
		if p.Connectors.Set {
			f.Connectors = nil
			if p.Connectors.Valid {
				f.Connectors = cloneConnectors(p.Connectors.Value)
			}
		}
		if a := p.Attachments; a != nil {
			if a.MaxMegabytes.Set {
				maxMB = a.MaxMegabytes
			}
			if a.Types != nil {
				f.Attachments.Types = cloneStrings(*a.Types)
			}
		}
		if l := p.Links; l != nil {
			setLink(&f.Links.Help, l.Help)
			setLink(&f.Links.Plans, l.Plans)
			setLink(&f.Links.Apps, l.Apps)
			setLink(&f.Links.GetMoreUsage, l.GetMoreUsage)
			setLink(&f.Links.UsageLearnMore, l.UsageLearnMore)
			if l.LearnMore != nil {
				f.Links.LearnMore = append(make([]Link, 0, len(*l.LearnMore)), (*l.LearnMore)...)
			}
		}
		if u := p.UsageBanner; u != nil && u.WarnPercent != nil {
			f.UsageBanner.WarnPercent = *u.WarnPercent
		}
		if p.PlanLabel.Set {
			f.PlanLabel = nil
			if p.PlanLabel.Valid {
				label := p.PlanLabel.Value
				f.PlanLabel = &label
			}
		}
		if s := p.ScheduledTasks; s != nil {
			if s.ApprovalLifetimeDays.Set {
				f.ScheduledTasks.ApprovalLifetimeDays = nil
				if s.ApprovalLifetimeDays.Valid {
					n := s.ApprovalLifetimeDays.Value
					f.ScheduledTasks.ApprovalLifetimeDays = &n
				}
			}
			setBool(&f.ScheduledTasks.Enabled, s.Enabled)
			if s.MaxTasks.Set {
				f.ScheduledTasks.MaxTasks = nil
				if s.MaxTasks.Valid {
					n := s.MaxTasks.Value
					f.ScheduledTasks.MaxTasks = &n
				}
			}
		}
		mergeRound2(&f, p)
	}
	// Switches that only mean something together with another one.
	if !f.Memory.Enabled {
		f.Memory.SearchChats, f.Memory.Generate, f.Memory.DefaultOn = false, false, false
	}
	if !f.WebSearch {
		f.Research.Enabled, f.Research.XSearch = false, false
	}
	if list, ok := modes.forPlatform(platform); ok && len(list) > 0 {
		f.PermissionModes = cloneStrings(list)
	}
	if maxMB.Set && maxMB.Valid {
		n := int64(math.Round(maxMB.Value * bytesPerMegabyte))
		f.Attachments.MaxBytes = &n
	}
	if f.Links.Help == nil {
		f.Links.Help = cloneString(fb.DocURL)
	}
	if f.Links.Plans == nil {
		f.Links.Plans = cloneString(fb.PurchaseSubscriptionURL)
	}
	if f.Links.GetMoreUsage == nil {
		f.Links.GetMoreUsage = cloneString(fb.PurchaseSubscriptionURL)
	}
	var gid *int64
	if groupID != nil {
		id := *groupID
		gid = &id
	}
	return Resolved{Revision: d.Revision, GroupID: gid, Fields: f}
}

// mergeRound2 lays one layer's memory, research, browser, ssh_remote,
// codex_runtime_mirror and computer_use over f. Every sub-field inherits on
// its own; the two deny lists (browser.blocked_domains and
// computer_use.denied_apps) only grow, so a plan or user override can add
// to what the defaults block but never allow it again.
func mergeRound2(f *Fields, p Patch) {
	if m := p.Memory; m != nil {
		setBool(&f.Memory.Enabled, m.Enabled)
		setBool(&f.Memory.SearchChats, m.SearchChats)
		setBool(&f.Memory.Generate, m.Generate)
		setBool(&f.Memory.DefaultOn, m.DefaultOn)
		setLink(&f.Memory.Model, m.Model)
	}
	if r := p.Research; r != nil {
		setBool(&f.Research.Enabled, r.Enabled)
		setBool(&f.Research.XSearch, r.XSearch)
		if r.MaxSearchesPerTurn != nil {
			f.Research.MaxSearchesPerTurn = *r.MaxSearchesPerTurn
		}
	}
	if b := p.Browser; b != nil {
		setBool(&f.Browser.Enabled, b.Enabled)
		setBool(&f.Browser.ExternalSites, b.ExternalSites)
		setBool(&f.Browser.AllowScript, b.AllowScript)
		setBool(&f.Browser.DevServers, b.DevServers)
		if b.BlockedDomains != nil {
			f.Browser.BlockedDomains = unionStrings(f.Browser.BlockedDomains, *b.BlockedDomains)
		}
	}
	setBool(&f.SSHRemote, p.SSHRemote)
	setBool(&f.Workflows, p.Workflows)
	setBool(&f.WorkflowApprovalRequired, p.WorkflowApprovalRequired)
	setLink(&f.CodexRuntimeMirror, p.CodexRuntimeMirror)
	if c := p.ComputerUse; c != nil {
		setBool(&f.ComputerUse.Enabled, c.Enabled)
		setBool(&f.ComputerUse.AllowFullControl, c.AllowFullControl)
		if c.DeniedApps != nil {
			f.ComputerUse.DeniedApps = unionStrings(f.ComputerUse.DeniedApps, *c.DeniedApps)
		}
		if c.MaxActionsPerTurn.Set {
			f.ComputerUse.MaxActionsPerTurn = nil
			if c.MaxActionsPerTurn.Valid {
				n := c.MaxActionsPerTurn.Value
				f.ComputerUse.MaxActionsPerTurn = &n
			}
		}
	}
}

// unionStrings returns base followed by the entries of add it lacks (compared
// without case, like app names and host names), in a new slice.
func unionStrings(base, add []string) []string {
	out := cloneStrings(base)
	seen := make(map[string]bool, len(base)+len(add))
	for _, s := range base {
		seen[strings.ToLower(s)] = true
	}
	for _, s := range add {
		if key := strings.ToLower(s); !seen[key] {
			seen[key] = true
			out = append(out, s)
		}
	}
	return out
}

func setBool(dst *bool, v *bool) {
	if v != nil {
		*dst = *v
	}
}

func setLink(dst **string, v Nullable[string]) {
	if !v.Set {
		return
	}
	*dst = nil
	if v.Valid {
		s := v.Value
		*dst = &s
	}
}

func cloneStrings(s []string) []string {
	return append(make([]string, 0, len(s)), s...)
}

func cloneConnectors(rules []ConnectorRule) []ConnectorRule {
	out := make([]ConnectorRule, 0, len(rules))
	for _, r := range rules {
		if r.Args != nil {
			r.Args = cloneStrings(r.Args)
		}
		out = append(out, r)
	}
	return out
}

func cloneString(s *string) *string {
	if s == nil {
		return nil
	}
	v := *s
	return &v
}
