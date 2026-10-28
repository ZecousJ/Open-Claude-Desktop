# Codex marketplace cache

Codex 0.144.1 (`codex-rs/core-plugins/src/startup_sync.rs:27-30,
176-193, 525-580`) syncs the curated marketplace into `$CODEX_HOME/.tmp/plugins`.
Its SHA, OS lock and staging/backup directories are siblings. Linking only the
repository breaks atomic replacement and does not coordinate writers.

Claudex links every local Codex home's `.tmp` to `<profile>/codex-cache`.
Sessions, config, installed plugins, plugin data and workspaces remain private
to each home. The runner explicitly mounts the shared parent inside each
sandbox. Migration runs only before a home starts; old temporary copies are
removed, never workspaces or conversation data. At user-context startup the
runner also removes stopped spaces' legacy caches before opening the store,
so an already-full volume can recover without first writing a new chat.

gVisor's file locks are local to each sandbox. Host launcher leases therefore
elect one sync writer per profile; concurrent sandboxes get a read-only bind
of `plugins.sync.lock` so Codex skips its background curated sync, but can
still read the marketplace and write other temporary plugin-install helpers.
The lease lasts until the writer sandbox exits; a later launch recovers a
dead launcher's lease. Desktop/bubblewrap use Codex's shared OS lock directly.

Space shutdown/idle eviction unlinks `.tmp` without following it into the
shared cache. Once a minute and before bridge calls, the runner checks the
user quota, filesystem capacity and inode availability; at 85% usage it
removes only inactive spaces' temporary caches. The active-space set includes
sandboxes still stopping. The single shared cache stays intact for active
plugin/skill consumers. No automatic operation removes installed plugins,
plugin data, workspace files or conversations.

ENOSPC/EDQUOT failures are mapped before the runner's filesystem-error
sanitization. Desktop IPC, chat/Code turn failures and Codex startup failures
say “Your disk is full. Free up space and try again.” Existing error-card and toast styles are unchanged.
