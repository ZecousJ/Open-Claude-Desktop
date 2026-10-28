// Package claudex holds the Claudex additions to the Sub2API fork.
//
// Claudex keeps every upstream Sub2API feature and adds its own server-side
// features under this directory, so that upstream files carry only small,
// marked hooks (each one is commented with "CLAUDEX: Hn ..." and listed in
// backend/CLAUDEX_CHANGES.md).
//
// # Layout
//
//   - core: the frozen contract — Deps, Env and Peers, the component
//     interfaces, JSONSetting, HTTP and version helpers, rate limits, errors;
//   - hook (package claudexhook): the registry behind the service, handler
//     and middleware hooks (usage billed, sessions revoked, JWT revocation,
//     device keys in /api/v1/keys, WebSocket turn precheck, key creation);
//   - gatewayhook: the registry behind the gateway hooks (key marker, request
//     guards before every c.Next() of the API-key middlewares, the refusal
//     rewriter, request body limits, request model and billability helpers);
//   - one package per component: webconsole and release (B1), policy (B2),
//     catalog (B3), devices (B4), usage (B5), refusal (B6), voice (B7),
//     feedback (B8), bootstrap (B9), payment (B10).
//
// A Module is built once by Wire (ProvideModule) from Deps. It installs every
// component (each package exports New(env *core.Env) *Component), binds the
// peers, checks the bootstrap section ownership and wires the optional
// interfaces a component implements: routes (public, user, admin with a
// step-up middleware), the signup hook, settings keys, background work,
// bootstrap sections, the claudexhook providers and the gatewayhook markers,
// guards and describers. Components never edit this package.
//
// Settings are stored one JSON document per component in the upstream
// settings table through core.JSONSetting (keys start with "claudex_").
//
// Database changes go in backend/backend/migrations as claudex_NNNN_name.sql
// with the numbers allocated per package (see migrations/claudex_migrations_test.go);
// the runner applies migrations in file-name order, so Claudex migrations run
// after every numbered upstream migration of the same release.
package claudex
