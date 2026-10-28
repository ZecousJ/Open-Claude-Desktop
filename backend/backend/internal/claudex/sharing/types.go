package sharing

// Shared types of the sharing component and its viewer (design R1 3.1-3.2).
// Stub from the backend seam (B-S): R1-B stores and validates these, R1-V
// renders them (viewer.Render(w, Snapshot, Options)). Extend only; renaming
// or removing an export needs the main session.

// Kind is what a share holds (claudex_shares.kind).
type Kind string

const (
	KindConversation Kind = "conversation"
	KindArtifact     Kind = "artifact"
)

// Status is the life cycle of a share (claudex_shares.status). A revoked
// token is never reused; disabled means taken down by an administrator.
type Status string

const (
	StatusActive   Status = "active"
	StatusRevoked  Status = "revoked"
	StatusDisabled Status = "disabled"
)

// SnapshotSchema is the version of the stored snapshot body
// (claudex_share_contents.schema).
const SnapshotSchema = 1

// PathPrefix is the root path of the public pages; a share's path is
// PathPrefix + "/" + token. Links are built when read, never stored.
const PathPrefix = "/s"

// Snapshot is the body of a share (schema 1, stored as JSONB). A conversation
// share has Messages and the artifacts they reference; an artifact share has
// exactly one artifact and no messages.
type Snapshot struct {
	Repositories []string           `json:"repositories,omitempty"`
	Screenshot   string             `json:"screenshot,omitempty"`
	Comments     []SnapshotComment  `json:"comments,omitempty"`
	Kind         Kind               `json:"kind"`
	Title        string             `json:"title"`
	Mode         string             `json:"mode,omitempty"`        // chat | cowork | code
	ModelLabel   string             `json:"model_label,omitempty"` // display only
	Messages     []SnapshotMessage  `json:"messages,omitempty"`
	Artifacts    []SnapshotArtifact `json:"artifacts,omitempty"`
}

type SnapshotComment struct {
	Author string `json:"author"`
	Text   string `json:"text"`
}

// SnapshotMessage is one message: the user's prompt or the reply text, never
// tool commands or their output. Activity holds optional one-line summaries
// ("Ran a command"); Artifacts are indexes into Snapshot.Artifacts.
type SnapshotMessage struct {
	Role      string   `json:"role"` // user | assistant
	Text      string   `json:"text"` // Markdown
	Activity  []string `json:"activity,omitempty"`
	Artifacts []int    `json:"artifacts,omitempty"`
}

// SnapshotArtifact is one artifact of a snapshot.
type SnapshotArtifact struct {
	Title        string `json:"title"`
	Language     string `json:"language"`                // html | svg | markdown | mermaid | code
	CodeLanguage string `json:"code_language,omitempty"` // only for language "code"
	Content      string `json:"content"`
}
