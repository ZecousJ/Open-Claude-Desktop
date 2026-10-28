// Package cloud runs cloud environments for Cowork and Code in the web app.
//
// W-SITE installs it as an empty component so the module order, the
// component names and the route tables are fixed before the web packages
// fill it in.
package cloud

import "github.com/Wei-Shaw/sub2api/internal/claudex/core"

// Component is the cloud component.
type Component struct {
	env *core.Env
}

// New builds the component.
func New(env *core.Env) *Component { return &Component{env: env} }

// Name implements core.Feature.
func (c *Component) Name() string { return core.NameCloud }

var _ core.Feature = (*Component)(nil)
