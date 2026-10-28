-- claudex_0081_web_store.sql (W-STORE, web plan §0.3, §2 #1)
-- The web app's account data: settings, projects, conversations (one row
-- each, without turns), turns (one JSONB row each, live transcript and saved
-- branches), artifacts with their versions, and uploaded or generated files
-- (bytes on disk under the store directory, one row each here).
--
-- Every row carries user_id and every key starts with it, so no query can
-- reach another user's rows by id alone. The only writer is the runner that
-- serves the user (runner link, store.* ops); the browser reads files and
-- exports through the webstore download routes.
-- Text is stored in the clear (web plan Q13: search needs it); the console
-- only ever shows sizes and counts.

CREATE TABLE IF NOT EXISTS claudex_web_settings (
    user_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    doc        JSONB NOT NULL,
    bytes      INTEGER NOT NULL DEFAULT 0 CHECK (bytes >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS claudex_web_projects (
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id         VARCHAR(128) NOT NULL,
    position   INTEGER NOT NULL DEFAULT 0,
    doc        JSONB NOT NULL,
    bytes      INTEGER NOT NULL DEFAULT 0 CHECK (bytes >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, id)
);

-- doc is webproto.ConversationDoc (schema 1): the conversation without turns.
CREATE TABLE IF NOT EXISTS claudex_web_conversations (
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id         VARCHAR(128) NOT NULL,
    position   INTEGER NOT NULL DEFAULT 0,
    mode       VARCHAR(16) NOT NULL CHECK (mode IN ('chat', 'cowork', 'code')),
    project_id VARCHAR(128) NOT NULL DEFAULT '',
    title      TEXT NOT NULL DEFAULT '',
    model      VARCHAR(256) NOT NULL DEFAULT '',
    pinned     BOOLEAN NOT NULL DEFAULT FALSE,
    archived   BOOLEAN NOT NULL DEFAULT FALSE,
    doc        JSONB NOT NULL,
    bytes      INTEGER NOT NULL DEFAULT 0 CHECK (bytes >= 0),
    -- bumped by every write of the conversation or one of its turns
    revision   BIGINT NOT NULL DEFAULT 1,
    -- the conversation's own createdAt / updatedAt (ms since the epoch)
    created_ms BIGINT NOT NULL DEFAULT 0,
    updated_ms BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_claudex_web_conversations_order ON claudex_web_conversations (user_id, position, id);

-- doc is webproto.TurnDoc (schema 1). branch_id '' is the live transcript.
CREATE TABLE IF NOT EXISTS claudex_web_turns (
    user_id         BIGINT NOT NULL,
    conversation_id VARCHAR(128) NOT NULL,
    branch_id       VARCHAR(128) NOT NULL DEFAULT '',
    turn_id         VARCHAR(128) NOT NULL,
    ordinal         INTEGER NOT NULL DEFAULT 0 CHECK (ordinal >= 0),
    status          VARCHAR(16) NOT NULL,
    doc             JSONB NOT NULL,
    bytes           INTEGER NOT NULL DEFAULT 0 CHECK (bytes >= 0),
    -- prompt and reply text for search (capped)
    search_text     TEXT NOT NULL DEFAULT '',
    created_ms      BIGINT NOT NULL DEFAULT 0,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, conversation_id, branch_id, turn_id),
    FOREIGN KEY (user_id, conversation_id) REFERENCES claudex_web_conversations (user_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_claudex_web_turns_order ON claudex_web_turns (user_id, conversation_id, branch_id, ordinal, turn_id);

-- The latest version of each artifact; claudex_web_artifact_versions keeps
-- the last versions (doc is the artifact object the runner sent).
CREATE TABLE IF NOT EXISTS claudex_web_artifacts (
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id              VARCHAR(128) NOT NULL,
    conversation_id VARCHAR(128) NOT NULL DEFAULT '',
    title           TEXT NOT NULL DEFAULT '',
    version         INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    doc             JSONB NOT NULL,
    bytes           INTEGER NOT NULL DEFAULT 0 CHECK (bytes >= 0),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_claudex_web_artifacts_conversation ON claudex_web_artifacts (user_id, conversation_id);

CREATE TABLE IF NOT EXISTS claudex_web_artifact_versions (
    user_id     BIGINT NOT NULL,
    artifact_id VARCHAR(128) NOT NULL,
    version     INTEGER NOT NULL CHECK (version >= 1),
    doc         JSONB NOT NULL,
    bytes       INTEGER NOT NULL DEFAULT 0 CHECK (bytes >= 0),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, artifact_id, version),
    FOREIGN KEY (user_id, artifact_id) REFERENCES claudex_web_artifacts (user_id, id) ON DELETE CASCADE
);

-- Files: the bytes live on disk (<store dir>/<user_id>/blobs/<sha256>, or
-- tmp/<id> while uploading). size is the declared size, reserved against
-- the quota from the first chunk on.
CREATE TABLE IF NOT EXISTS claudex_web_files (
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id         VARCHAR(64) NOT NULL,
    name       VARCHAR(255) NOT NULL DEFAULT '',
    mime       VARCHAR(128) NOT NULL DEFAULT '',
    size       BIGINT NOT NULL CHECK (size >= 0),
    received   BIGINT NOT NULL DEFAULT 0 CHECK (received >= 0),
    sha256     VARCHAR(64) NOT NULL DEFAULT '',
    state      VARCHAR(12) NOT NULL DEFAULT 'uploading' CHECK (state IN ('uploading', 'ready')),
    origin     VARCHAR(12) NOT NULL DEFAULT 'upload' CHECK (origin IN ('upload', 'runner')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_claudex_web_files_sha ON claudex_web_files (user_id, sha256);
CREATE INDEX IF NOT EXISTS idx_claudex_web_files_stale ON claudex_web_files (updated_at) WHERE state = 'uploading';

-- Bytes each user stores (documents and files), kept in step with every
-- write so quota checks never sum the tables.
CREATE TABLE IF NOT EXISTS claudex_web_store_usage (
    user_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    doc_bytes  BIGINT NOT NULL DEFAULT 0,
    file_bytes BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
