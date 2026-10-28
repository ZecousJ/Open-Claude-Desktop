package webstore

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"

	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
)

// RunnerStore is what the runner link (W-RELAY, internal/claudex/webhost)
// calls for a runner's `request` frame whose op starts with "store.": the
// relay has already checked that userID is a user it routes to that runner.
// The answer value becomes the response frame's value; an error is always
// an *OpError (RPCError gives the frame's error). The relay finds the
// component among core.Env.Components with a type assertion:
//
//	for _, f := range env.Components {
//		if s, ok := f.(webstore.RunnerStore); ok { ... }
//	}
type RunnerStore interface {
	ServeRunnerOp(ctx context.Context, userID int64, op string, body json.RawMessage) (any, error)
}

var _ RunnerStore = (*Component)(nil)

// Ops lists the ops ServeRunnerOp answers (webproto.RunnerOps without the
// key.* ops, which W-KEY answers).
func Ops() []string {
	out := make([]string, 0, len(webproto.RunnerOps))
	for _, op := range webproto.RunnerOps {
		if strings.HasPrefix(op, "store.") {
			out = append(out, op)
		}
	}
	return out
}

// The request bodies and answers (runner/src/cloud-store.ts and
// runner/src/attachments.ts send them). `position` is the row's index in
// the sidebar order (0 first); list answers carry `next` while more pages
// follow (pass it back as `cursor`). Byte values are {"$bytes": base64}.
//
//	store.settings.get        {}                                → {settings: object|null}
//	store.settings.put        {settings}                        → {}
//	store.projects.list       {cursor?}                         → {projects: Project[], next?}
//	store.projects.put        {project, position}               → {}
//	store.projects.delete     {id}                              → {}
//	store.conversations.list  {cursor?}                         → {items: [{doc, position}], next?}
//	store.conversations.get   {id}                              → {doc: ConversationDoc|null, position?}
//	store.conversations.put   {doc, position}                   → {revision}
//	store.conversations.delete {id}                             → {} (turns and artifacts go too)
//	store.turns.list          {conversationId, cursor?}         → {turns: TurnDoc[], next?}
//	store.turns.put           {turns: TurnDoc[]} (or one TurnDoc) → {revisions: {id: n}, revision?}
//	store.turns.delete        {conversationId, keys: [{branchId, turnId}]} → {}
//	store.artifacts.list      {conversationId?, cursor?}        → {artifacts: [{artifact, version, updatedAt}], next?}
//	                          {artifactId}                      → {versions: [{artifact, version, createdAt}]}
//	store.artifacts.put       {artifact: {id, conversationId?, title?, …}} → {version}
//	store.artifacts.delete    {id}                              → {}
//	store.files.get           {id, offset?, length?}            → {id, name, mime, size, bytes}
//	store.files.put           {id?, name?, mime?, size, offset, bytes} → FileInfo (complete with the last byte)
//	store.files.delete        {id}                              → {}
//	store.search              {query, mode?, includeArchived?, limit?} → {results: SearchHit[]}
func (c *Component) ServeRunnerOp(ctx context.Context, userID int64, op string, body json.RawMessage) (any, error) {
	if userID < 1 {
		return nil, badRequest("The request has no user.")
	}
	body = bytes.TrimSpace(body)
	if len(body) == 0 || string(body) == "null" {
		body = json.RawMessage(`{}`)
	}
	if !object(body) {
		return nil, badRequest("The request body must be an object.")
	}
	v, err := c.serve(ctx, userID, op, body)
	if err != nil {
		e := asOpError(err)
		if e.cause != nil {
			c.logf("webstore: user %d %s: %v", userID, op, e.cause)
		}
		return nil, e
	}
	return v, nil
}

type empty struct{}

func decode(body json.RawMessage, into any) error {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(into); err != nil {
		return badRequest("The request body is not valid.")
	}
	return nil
}

// wireBytes is a {"$bytes": base64} value.
type wireBytes struct {
	B64 *string `json:"$bytes"`
}

func (w *wireBytes) decode() ([]byte, error) {
	if w == nil || w.B64 == nil {
		return nil, badRequest("bytes must be {\"$bytes\": base64}.")
	}
	b, err := base64.StdEncoding.DecodeString(*w.B64)
	if err != nil {
		return nil, badRequest("bytes are not valid base64.")
	}
	return b, nil
}

func encodeBytes(b []byte) map[string]string {
	return map[string]string{"$bytes": base64.StdEncoding.EncodeToString(b)}
}

func validPosition(p int) bool { return p >= 0 && p < 1<<30 }

func (c *Component) serve(ctx context.Context, userID int64, op string, body json.RawMessage) (any, error) {
	switch op {
	case "store.settings.get":
		doc, err := c.store.getSettings(ctx, userID)
		if err != nil {
			return nil, err
		}
		if doc == nil {
			return map[string]any{"settings": nil}, nil
		}
		return map[string]json.RawMessage{"settings": doc}, nil

	case "store.settings.put":
		var req struct {
			Settings json.RawMessage `json:"settings"`
		}
		if err := decode(body, &req); err != nil {
			return nil, err
		}
		if !object(req.Settings) {
			return nil, badRequest("settings must be an object.")
		}
		if len(req.Settings) > settingsBytes {
			return nil, tooLarge("settings document")
		}
		return empty{}, c.store.putSettings(ctx, userID, req.Settings, c.Limits(ctx))

	case "store.projects.list":
		var req struct {
			Cursor string `json:"cursor"`
		}
		if err := decode(body, &req); err != nil {
			return nil, err
		}
		list, next, err := c.store.listProjects(ctx, userID, req.Cursor)
		if err != nil {
			return nil, err
		}
		if list == nil {
			list = []json.RawMessage{}
		}
		return page("projects", list, next), nil

	case "store.projects.put":
		var req struct {
			Project  json.RawMessage `json:"project"`
			Position int             `json:"position"`
		}
		if err := decode(body, &req); err != nil {
			return nil, err
		}
		if !object(req.Project) {
			return nil, badRequest("project must be an object.")
		}
		if len(req.Project) > projectBytes {
			return nil, tooLarge("project")
		}
		var head struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(req.Project, &head) != nil || !docID.MatchString(head.ID) {
			return nil, badRequest("project.id has the wrong shape.")
		}
		if !validPosition(req.Position) {
			return nil, badRequest("position is not valid.")
		}
		return empty{}, c.store.putProject(ctx, userID, head.ID, req.Position, req.Project, c.Limits(ctx))

	case "store.projects.delete":
		id, err := idBody(body)
		if err != nil {
			return nil, err
		}
		return empty{}, c.store.deleteProject(ctx, userID, id)

	case "store.conversations.list":
		var req struct {
			Cursor string `json:"cursor"`
		}
		if err := decode(body, &req); err != nil {
			return nil, err
		}
		items, next, err := c.store.listConversations(ctx, userID, req.Cursor)
		if err != nil {
			return nil, err
		}
		return page("items", items, next), nil

	case "store.conversations.get":
		id, err := idBody(body)
		if err != nil {
			return nil, err
		}
		row, err := c.store.getConversation(ctx, userID, id)
		if err != nil {
			return nil, err
		}
		if row == nil {
			return map[string]any{"doc": nil}, nil
		}
		return row, nil

	case "store.conversations.put":
		var req struct {
			Doc      json.RawMessage `json:"doc"`
			Position int             `json:"position"`
		}
		if err := decode(body, &req); err != nil {
			return nil, err
		}
		if len(req.Doc) > conversationBytes {
			return nil, tooLarge("conversation")
		}
		_, meta, err := webproto.DecodeConversationDoc(req.Doc)
		if err != nil {
			return nil, badRequest("%s", err.Error())
		}
		if !validPosition(req.Position) {
			return nil, badRequest("position is not valid.")
		}
		rev, err := c.store.putConversation(ctx, userID, req.Doc, meta, req.Position, c.Limits(ctx))
		if err != nil {
			return nil, err
		}
		return map[string]int64{"revision": rev}, nil

	case "store.conversations.delete":
		id, err := idBody(body)
		if err != nil {
			return nil, err
		}
		return empty{}, c.store.deleteConversation(ctx, userID, id)

	case "store.turns.list":
		var req struct {
			ConversationID string `json:"conversationId"`
			Cursor         string `json:"cursor"`
		}
		if err := decode(body, &req); err != nil {
			return nil, err
		}
		if !docID.MatchString(req.ConversationID) {
			return nil, badRequest("conversationId has the wrong shape.")
		}
		turns, next, err := c.store.listTurns(ctx, userID, req.ConversationID, req.Cursor)
		if err != nil {
			return nil, err
		}
		return page("turns", turns, next), nil

	case "store.turns.put":
		rows, err := decodeTurns(body)
		if err != nil {
			return nil, err
		}
		revs, err := c.store.putTurns(ctx, userID, rows, c.Limits(ctx))
		if err != nil {
			return nil, err
		}
		out := map[string]any{"revisions": revs}
		if len(revs) == 1 {
			for _, r := range revs {
				out["revision"] = r
			}
		}
		return out, nil

	case "store.turns.delete":
		var req struct {
			ConversationID string    `json:"conversationId"`
			Keys           []TurnKey `json:"keys"`
		}
		if err := decode(body, &req); err != nil {
			return nil, err
		}
		if !docID.MatchString(req.ConversationID) {
			return nil, badRequest("conversationId has the wrong shape.")
		}
		if len(req.Keys) > maxKeys {
			return nil, badRequest("Too many turns in one request.")
		}
		for _, k := range req.Keys {
			if !docID.MatchString(k.TurnID) || (k.BranchID != nil && !docID.MatchString(*k.BranchID)) {
				return nil, badRequest("keys has a turn with the wrong shape.")
			}
		}
		return empty{}, c.store.deleteTurns(ctx, userID, req.ConversationID, req.Keys)

	case "store.artifacts.list":
		var req struct {
			ConversationID *string `json:"conversationId"`
			ArtifactID     string  `json:"artifactId"`
			Cursor         string  `json:"cursor"`
		}
		if err := decode(body, &req); err != nil {
			return nil, err
		}
		if req.ArtifactID != "" {
			if !docID.MatchString(req.ArtifactID) {
				return nil, notFound("artifact")
			}
			versions, err := c.store.listArtifactVersions(ctx, userID, req.ArtifactID)
			if err != nil {
				return nil, err
			}
			return map[string]any{"versions": versions}, nil
		}
		if req.ConversationID != nil && *req.ConversationID != "" && !docID.MatchString(*req.ConversationID) {
			return nil, badRequest("conversationId has the wrong shape.")
		}
		list, next, err := c.store.listArtifacts(ctx, userID, req.ConversationID, req.Cursor)
		if err != nil {
			return nil, err
		}
		return page("artifacts", list, next), nil

	case "store.artifacts.put":
		var req struct {
			Artifact json.RawMessage `json:"artifact"`
		}
		if err := decode(body, &req); err != nil {
			return nil, err
		}
		if !object(req.Artifact) {
			return nil, badRequest("artifact must be an object.")
		}
		if len(req.Artifact) > artifactBytes {
			return nil, tooLarge("artifact")
		}
		var head struct {
			ID             string `json:"id"`
			ConversationID string `json:"conversationId"`
			Title          string `json:"title"`
		}
		if json.Unmarshal(req.Artifact, &head) != nil || !docID.MatchString(head.ID) {
			return nil, badRequest("artifact.id has the wrong shape.")
		}
		if head.ConversationID != "" && !docID.MatchString(head.ConversationID) {
			return nil, badRequest("artifact.conversationId has the wrong shape.")
		}
		v, err := c.store.putArtifact(ctx, userID, head.ID, head.ConversationID, truncateUTF8(clean(head.Title), 1024), req.Artifact, c.Limits(ctx))
		if err != nil {
			return nil, err
		}
		return map[string]int{"version": v}, nil

	case "store.artifacts.delete":
		id, err := idBody(body)
		if err != nil {
			return nil, err
		}
		return empty{}, c.store.deleteArtifact(ctx, userID, id)

	case "store.files.get":
		var req struct {
			ID     string `json:"id"`
			Offset int64  `json:"offset"`
			Length *int64 `json:"length"`
		}
		if err := decode(body, &req); err != nil {
			return nil, err
		}
		length := int64(fileReadBytes)
		if req.Length != nil {
			length = *req.Length
		}
		info, data, err := c.ReadFile(ctx, userID, req.ID, req.Offset, length)
		if err != nil {
			return nil, err
		}
		return map[string]any{"id": info.ID, "name": info.Name, "mime": info.Mime, "size": info.Size, "bytes": encodeBytes(data)}, nil

	case "store.files.put":
		var req struct {
			ID     string     `json:"id"`
			Name   string     `json:"name"`
			Mime   string     `json:"mime"`
			Size   *int64     `json:"size"`
			Offset int64      `json:"offset"`
			Bytes  *wireBytes `json:"bytes"`
		}
		if err := decode(body, &req); err != nil {
			return nil, err
		}
		data, err := req.Bytes.decode()
		if err != nil {
			return nil, err
		}
		if len(data) > fileWriteBytes {
			return nil, badRequest("Send at most 8 MiB per request.")
		}
		id := req.ID
		if id == "" {
			if req.Offset != 0 || req.Size == nil {
				return nil, badRequest("A new file starts at offset 0 and declares its size.")
			}
			info, err := c.beginFile(ctx, userID, req.Name, req.Mime, *req.Size, OriginRunner)
			if err != nil {
				return nil, err
			}
			if info.Complete || len(data) == 0 {
				return info, nil
			}
			id = info.ID
		}
		return c.WriteUpload(ctx, userID, id, req.Offset, data)

	case "store.files.delete":
		var req struct {
			ID string `json:"id"`
		}
		if err := decode(body, &req); err != nil {
			return nil, err
		}
		return empty{}, c.DeleteFile(ctx, userID, req.ID)

	case "store.search":
		var req struct {
			Query           string `json:"query"`
			Mode            string `json:"mode"`
			ProjectID       string `json:"projectId"`
			IncludeArchived bool   `json:"includeArchived"`
			Limit           int    `json:"limit"`
		}
		if err := decode(body, &req); err != nil {
			return nil, err
		}
		hits, err := c.Search(ctx, userID, req.Query, SearchOptions{Mode: req.Mode, ProjectID: req.ProjectID, IncludeArchived: req.IncludeArchived, Limit: req.Limit})
		if err != nil {
			return nil, err
		}
		return map[string]any{"results": hits}, nil
	}
	return nil, &OpError{Code: webproto.ErrCodeMethodUnavailable, Message: "The Claudex service doesn't know this request."}
}

func page(field string, list any, next string) map[string]any {
	out := map[string]any{field: list}
	if next != "" {
		out["next"] = next
	}
	return out
}

func idBody(body json.RawMessage) (string, error) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decode(body, &req); err != nil {
		return "", err
	}
	if !docID.MatchString(req.ID) {
		return "", badRequest("id has the wrong shape.")
	}
	return req.ID, nil
}

// decodeTurns reads the turns of a turns.put: {turns: [...]} or a single
// turn document.
func decodeTurns(body json.RawMessage) ([]turnRow, error) {
	var list []json.RawMessage
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(body, &probe); err != nil {
		return nil, badRequest("The request body is not valid.")
	}
	if raw, ok := probe["turns"]; ok && len(probe) == 1 {
		if err := json.Unmarshal(raw, &list); err != nil {
			return nil, badRequest("turns must be an array.")
		}
	} else {
		list = []json.RawMessage{body}
	}
	if len(list) > maxTurnsPut {
		return nil, badRequest("Too many turns in one request.")
	}
	rows := make([]turnRow, 0, len(list))
	seen := map[string]bool{}
	for _, raw := range list {
		if len(raw) > webproto.TurnDocBytes {
			return nil, tooLarge("reply")
		}
		doc, head, err := webproto.DecodeTurnDoc(raw)
		if err != nil {
			return nil, badRequest("%s", err.Error())
		}
		branch := strOr(doc.BranchID)
		key := doc.ConversationID + "\x00" + branch + "\x00" + doc.TurnID
		if seen[key] {
			return nil, badRequest("turn %s is in the request twice.", doc.TurnID)
		}
		seen[key] = true
		rows = append(rows, turnRow{raw: jsonbSafe(raw), doc: doc, head: head, branch: branch})
	}
	return rows, nil
}
