package claudex

// Added by B9 (bootstrap): module construction must refuse bootstrap
// sections that are duplicated, foreign, unknown or reserved for B9's own
// keys, with the real bootstrap component installed. Test only; uses the
// helpers of module_test.go.

import (
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/claudex/bootstrap"
	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/memory"

	"github.com/stretchr/testify/require"
)

func TestBootstrapSectionsAreCheckedAtModuleConstruction(t *testing.T) {
	build := func(extra ...Feature) *Module {
		m := NewModule(Deps{})
		m.Install(append([]Feature{releaseFeature{got: new([]string)}, deviceStub{}, bootstrap.New(m.env)}, extra...)...)
		return m
	}

	// Every section declared once by its owner is accepted, and B9 finds the
	// contributors (not itself) in env.
	var owners []Feature
	for section, owner := range core.SectionOwners {
		if owner == core.NameDevices || owner == core.NameRelease {
			continue // the peers above stand in for B4 and B1
		}
		owners = append(owners, sectionFeature{name: owner, sections: []string{section}})
	}
	ok := build(owners...)
	require.NoError(t, ok.bind())
	require.Len(t, ok.env.Contributors, len(owners))
	for _, c := range ok.env.Contributors {
		f, isFeature := c.(Feature)
		require.True(t, isFeature)
		require.NotEqual(t, core.NameBootstrap, f.Name())
	}

	for name, tc := range map[string]struct {
		feature Feature
		err     string
	}{
		"declared twice":        {sectionFeature{name: core.NameVoice, sections: []string{core.SectionVoice, core.SectionVoice}}, "declared twice"},
		"foreign section":       {sectionFeature{name: core.NameVoice, sections: []string{core.SectionPolicy}}, "belongs to"},
		"unknown section":       {sectionFeature{name: core.NameVoice, sections: []string{"voices"}}, "unknown bootstrap section"},
		"B9 key server":         {sectionFeature{name: core.NameVoice, sections: []string{"server"}}, "unknown bootstrap section"},
		"B9 key features":       {sectionFeature{name: core.NameFeedback, sections: []string{"features"}}, "unknown bootstrap section"},
		"B9 key errors":         {sectionFeature{name: core.NameUsage, sections: []string{"errors"}}, "unknown bootstrap section"},
		"B9 key generated_at":   {sectionFeature{name: core.NamePolicy, sections: []string{"generated_at"}}, "unknown bootstrap section"},
		"B9 key schema_version": {sectionFeature{name: core.NameCatalog, sections: []string{"schema_version"}}, "unknown bootstrap section"},
	} {
		require.ErrorContains(t, build(tc.feature).bind(), tc.err, name)
	}

	// The bootstrap component itself cannot declare a section either.
	m := NewModule(Deps{})
	m.Install(releaseFeature{got: new([]string)}, deviceStub{}, sectionFeature{name: core.NameBootstrap, sections: []string{core.SectionPlan}})
	require.ErrorContains(t, m.bind(), "belongs to")
}

// R3-S1: the memory component contributes exactly its own section, and a
// foreign component cannot claim it.
func TestMemorySectionOwnership(t *testing.T) {
	m := NewModule(Deps{})
	m.Install(releaseFeature{got: new([]string)}, deviceStub{}, memory.New(m.env), bootstrap.New(m.env))
	require.NoError(t, m.bind())
	var found bool
	for _, c := range m.env.Contributors {
		if f, ok := c.(Feature); ok && f.Name() == core.NameMemory {
			require.Equal(t, []string{core.SectionMemory}, c.Sections())
			found = true
		}
	}
	require.True(t, found, "memory is a bootstrap contributor")
	require.Equal(t, core.NameMemory, core.SectionOwners[core.SectionMemory])

	foreign := NewModule(Deps{})
	foreign.Install(releaseFeature{got: new([]string)}, deviceStub{}, bootstrap.New(foreign.env),
		sectionFeature{name: core.NameFeedback, sections: []string{core.SectionMemory}})
	require.ErrorContains(t, foreign.bind(), "belongs to")
}
