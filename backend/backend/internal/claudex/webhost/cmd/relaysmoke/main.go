// Command relaysmoke runs the web relay (internal/claudex/webhost) on its own
// for the end-to-end smoke test tests/web-relay-smoke.test.ts: the real
// relay code (RPC, events socket, runner link, previews, affinity, runs)
// between a browser client and a real claudex-runner, with the services
// the relay only calls (webstore, the web key) answered by the test
// driver, and every other request (the runner's Sub2API user calls and the
// /v1 gateway) passed to the Sub2API mock.
//
// Development tool only; it is not part of the server.
//
//	relaysmoke -listen 127.0.0.1:0 -mock http://127.0.0.1:<p> -driver http://127.0.0.1:<q> -token <local runner token>
//
// It prints "listening <address>" once it serves.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webhost"
	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

type smoke struct {
	mock   string
	driver string
	client *http.Client

	mu      sync.Mutex
	users   map[string]int64 // access token -> user id (from the mock's /auth/me)
	tickets map[string]string
}

func main() {
	listen := flag.String("listen", "127.0.0.1:0", "address to listen on")
	mock := flag.String("mock", "", "Sub2API mock base URL")
	driver := flag.String("driver", "", "test driver base URL (store and key requests)")
	token := flag.String("token", "", "local runner token")
	flag.Parse()
	if *mock == "" || *driver == "" || len(*token) < 16 {
		log.Fatal("relaysmoke: -mock, -driver and -token are required")
	}
	s := &smoke{mock: strings.TrimRight(*mock, "/"), driver: strings.TrimRight(*driver, "/"),
		client: &http.Client{Timeout: 30 * time.Second}, users: map[string]int64{}, tickets: map[string]string{}}

	c := webhost.NewWithBackends(&core.Env{}, webhost.Backends{
		ParseToken:   s.parseToken,
		CheckAccess:  func(context.Context, int64, string, bool) error { return nil },
		RedeemTicket: s.redeem,
		LookupUser: func(_ context.Context, id int64) (webhost.UserInfo, error) {
			return webhost.UserInfo{Email: fmt.Sprintf("user%d@example.test", id), Active: true}, nil
		},
		BackendMode:      func(context.Context) bool { return false },
		Store:            storeOps{s},
		WebKey:           s.webKey,
		LocalRunnerToken: *token,
	})

	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())
	public := r.Group("/api/v1/claudex")
	c.RegisterPublicRoutes(public)
	public.POST("/web/auth/events-ticket", s.issueTicket)
	user := r.Group("/api/v1/claudex", s.jwt)
	c.RegisterUserRoutes(user)
	target, err := url.Parse(s.mock)
	if err != nil {
		log.Fatal(err)
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	r.NoRoute(func(g *gin.Context) { proxy.ServeHTTP(g.Writer, g.Request) })
	c.Start(context.Background())

	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("listening %s\n", ln.Addr().String())
	srv := &http.Server{Handler: r, ReadHeaderTimeout: 10 * time.Second}
	log.Fatal(srv.Serve(ln))
}

// parseToken asks the mock who the token belongs to.
func (s *smoke) parseToken(token string) (webhost.Claims, error) {
	s.mu.Lock()
	uid, ok := s.users[token]
	s.mu.Unlock()
	if !ok {
		req, _ := http.NewRequest(http.MethodGet, s.mock+"/api/v1/auth/me", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		res, err := s.client.Do(req)
		if err != nil {
			return webhost.Claims{}, err
		}
		defer func() { _ = res.Body.Close() }()
		var body struct {
			Data struct {
				ID int64 `json:"id"`
			} `json:"data"`
		}
		if res.StatusCode != http.StatusOK || json.NewDecoder(res.Body).Decode(&body) != nil || body.Data.ID <= 0 {
			return webhost.Claims{}, errors.New("token refused")
		}
		uid = body.Data.ID
		s.mu.Lock()
		s.users[token] = uid
		s.mu.Unlock()
	}
	now := time.Now()
	return webhost.Claims{UserID: uid, SessionID: "smoke", IssuedAt: now, ExpiresAt: now.Add(time.Hour)}, nil
}

// jwt stands in for the user group's JWT middleware.
func (s *smoke) jwt(g *gin.Context) {
	parts := strings.SplitN(g.GetHeader("Authorization"), " ", 2)
	if len(parts) != 2 {
		g.AbortWithStatus(http.StatusUnauthorized)
		return
	}
	claims, err := s.parseToken(strings.TrimSpace(parts[1]))
	if err != nil {
		g.AbortWithStatus(http.StatusUnauthorized)
		return
	}
	g.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: claims.UserID})
	g.Set(string(middleware.ContextKeyUserRole), service.RoleUser)
	g.Next()
}

// issueTicket stands in for W-AUTH's POST auth/events-ticket.
func (s *smoke) issueTicket(g *gin.Context) {
	parts := strings.SplitN(g.GetHeader("Authorization"), " ", 2)
	if len(parts) != 2 {
		g.AbortWithStatus(http.StatusUnauthorized)
		return
	}
	claims, err := s.parseToken(strings.TrimSpace(parts[1]))
	var in webproto.TicketRequest
	if err != nil || g.ShouldBindJSON(&in) != nil || !webproto.ValidTabID(in.TabID) {
		g.AbortWithStatus(http.StatusBadRequest)
		return
	}
	t, _ := webproto.NewTicket()
	s.mu.Lock()
	s.tickets[t] = strconv.FormatInt(claims.UserID, 10) + ":" + in.TabID
	s.mu.Unlock()
	g.JSON(http.StatusOK, gin.H{"code": 0, "data": webproto.TicketResponse{Ticket: t, ExpiresIn: 30}})
}

func (s *smoke) redeem(_ context.Context, ticket, tab string) (int64, error) {
	s.mu.Lock()
	v, ok := s.tickets[ticket]
	delete(s.tickets, ticket)
	s.mu.Unlock()
	uid, wantTab, _ := strings.Cut(v, ":")
	if !ok || wantTab != tab {
		return 0, errors.New("bad ticket")
	}
	return strconv.ParseInt(uid, 10, 64)
}

// driverCall posts to the driver and returns its value or error.
func (s *smoke) driverCall(ctx context.Context, path string, body any) (json.RawMessage, error) {
	raw, _ := json.Marshal(body)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, s.driver+path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	res, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = res.Body.Close() }()
	data, _ := io.ReadAll(res.Body)
	var out webproto.RPCResponse
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("driver: %s", data)
	}
	if !out.OK {
		msg := "driver error"
		if out.Error != nil {
			msg = out.Error.Message
		}
		return nil, infraerrors.BadRequest("CLAUDEX_SMOKE_DRIVER", msg)
	}
	return out.Value, nil
}

func (s *smoke) webKey(ctx context.Context, req webhost.KeyRequest) (any, error) {
	return s.driverCall(ctx, "/key", map[string]any{"userId": req.UserID})
}

type storeOps struct{ s *smoke }

func (o storeOps) ServeRunnerOp(ctx context.Context, userID int64, op string, body json.RawMessage) (any, error) {
	if len(body) == 0 {
		body = json.RawMessage("{}")
	}
	return o.s.driverCall(ctx, "/store", map[string]any{"userId": userID, "op": op, "body": body})
}
