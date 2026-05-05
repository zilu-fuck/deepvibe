package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/zilu-fuck/deepvibe/internal/config"
	contextstore "github.com/zilu-fuck/deepvibe/internal/context"
	"github.com/zilu-fuck/deepvibe/internal/engine"
	gitmanager "github.com/zilu-fuck/deepvibe/internal/git"
	"github.com/zilu-fuck/deepvibe/internal/llm"
	"github.com/zilu-fuck/deepvibe/internal/task"
)

const defaultHost = "127.0.0.1"
const defaultPort = 4242

type Options struct {
	CWD         string
	FIMRunner   FIMRunner
	Host        string
	Port        int
	Runner      Runner
	TaskManager *task.Manager
	Undoer      Undoer
}

type Server struct {
	fimRunner FIMRunner
	options   Options
	runner    Runner
	tasks     *task.Manager
	undoer    Undoer
}

type RunOptions struct {
	CWD         string `json:"cwd,omitempty"`
	DryRun      bool   `json:"dryRun,omitempty"`
	Instruction string `json:"instruction"`
	Profile     string `json:"profile,omitempty"`
}

type RunResult struct {
	Candidates      []string `json:"candidates"`
	ContextTokens   int      `json:"contextTokens"`
	MaxPromptTokens int      `json:"maxPromptTokens"`
	Message         string   `json:"message"`
	ScannedFiles    int      `json:"scannedFiles"`
}

type Runner func(ctx context.Context, options RunOptions, emit func(eventType string, payload map[string]any)) (*RunResult, error)

type FIMOptions struct {
	CWD         string   `json:"cwd,omitempty"`
	Echo        *bool    `json:"echo,omitempty"`
	Logprobs    *int     `json:"logprobs,omitempty"`
	MaxTokens   int      `json:"maxTokens,omitempty"`
	Model       string   `json:"model,omitempty"`
	Prompt      string   `json:"prompt"`
	Stop        any      `json:"stop,omitempty"`
	Stream      bool     `json:"stream,omitempty"`
	Suffix      string   `json:"suffix,omitempty"`
	Temperature *float64 `json:"temperature,omitempty"`
	TopP        *float64 `json:"topP,omitempty"`
}

type FIMRunner func(ctx context.Context, options FIMOptions) (*llm.DeepSeekFimCompletionResult, error)

type UndoOptions struct {
	CWD string `json:"cwd,omitempty"`
}

type Undoer func(ctx context.Context, options UndoOptions) (*gitmanager.UndoResult, error)

type Started struct {
	Host   string
	Port   int
	Server *http.Server
}

type JSONRPCRequest struct {
	ID      any    `json:"id,omitempty"`
	JSONRPC string `json:"jsonrpc,omitempty"`
	Method  string `json:"method,omitempty"`
	Params  any    `json:"params,omitempty"`
}

func New(options Options) *Server {
	if options.Host == "" {
		options.Host = defaultHost
	}
	if options.Port == 0 {
		options.Port = defaultPort
	}
	if options.CWD == "" {
		if cwd, err := os.Getwd(); err == nil {
			options.CWD = cwd
		}
	}
	tasks := options.TaskManager
	if tasks == nil {
		tasks = task.NewManager()
	}
	runner := options.Runner
	if runner == nil {
		runner = PreviewRunner
	}
	fimRunner := options.FIMRunner
	if fimRunner == nil {
		fimRunner = DeepSeekFIMRunner
	}
	undoer := options.Undoer
	if undoer == nil {
		undoer = GitUndoer
	}
	return &Server{
		fimRunner: fimRunner,
		options:   options,
		runner:    runner,
		tasks:     tasks,
		undoer:    undoer,
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/healthz", s.handleHealth)
	mux.HandleFunc("/run", s.handleRun)
	mux.HandleFunc("/v1/run", s.handleRun)
	mux.HandleFunc("/undo", s.handleUndo)
	mux.HandleFunc("/completions/fim", s.handleFIM)
	mux.HandleFunc("/sessions", s.handleSessions)
	mux.HandleFunc("/sessions/", s.handleSessionRoute)
	mux.HandleFunc("/tasks/run", s.handleTaskRun)
	mux.HandleFunc("/tasks/", s.handleTaskRoute)
	mux.HandleFunc("/rpc", s.handleRPC)
	return mux
}

func (s *Server) ListenAndServe(ctx context.Context) error {
	httpServer := &http.Server{
		Addr:    net.JoinHostPort(s.options.Host, strconv.Itoa(s.options.Port)),
		Handler: s.Handler(),
	}

	errCh := make(chan error, 1)
	go func() {
		errCh <- httpServer.ListenAndServe()
	}()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := httpServer.Shutdown(shutdownCtx); err != nil {
			return err
		}
		return ctx.Err()
	case err := <-errCh:
		if err == http.ErrServerClosed {
			return nil
		}
		return fmt.Errorf("listen on %s: %w", httpServer.Addr, err)
	}
}

func Start(ctx context.Context, options Options) (*Started, error) {
	srv := New(options)
	listener, err := net.Listen("tcp", net.JoinHostPort(srv.options.Host, strconv.Itoa(srv.options.Port)))
	if err != nil {
		return nil, err
	}

	httpServer := &http.Server{Handler: srv.Handler()}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownCtx)
	}()
	go func() {
		_ = httpServer.Serve(listener)
	}()

	address := listener.Addr().(*net.TCPAddr)
	return &Started{
		Host:   address.IP.String(),
		Port:   address.Port,
		Server: httpServer,
	}, nil
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		sendJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method not allowed"})
		return
	}
	sendJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"service": "deepvibe",
		"runtime": "go",
		"version": "0.1.0-go-dev",
	})
}

func (s *Server) handleRun(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		sendJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method not allowed"})
		return
	}
	options, err := s.readRunOptions(r)
	if err != nil {
		sendJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	result, err := s.runner(r.Context(), options, nil)
	if err != nil {
		sendJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	sendJSON(w, http.StatusOK, map[string]any{"ok": true, "result": result})
}

func (s *Server) handleFIM(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		sendJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method not allowed"})
		return
	}
	var options FIMOptions
	if err := readJSONBody(r, &options); err != nil {
		sendJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	if strings.TrimSpace(options.Prompt) == "" {
		sendJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "missing prompt for FIM completion"})
		return
	}
	if options.CWD == "" {
		options.CWD = s.options.CWD
	}
	result, err := s.fimRunner(r.Context(), options)
	if err != nil {
		sendJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	sendJSON(w, http.StatusOK, map[string]any{"ok": true, "result": result})
}

func (s *Server) handleUndo(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		sendJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method not allowed"})
		return
	}
	options, err := s.readUndoOptions(r)
	if err != nil {
		sendJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	result, err := s.undoer(r.Context(), options)
	if err != nil {
		sendJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	sendJSON(w, http.StatusOK, map[string]any{"ok": true, "result": result})
}

func (s *Server) handleTaskRun(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		sendJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method not allowed"})
		return
	}
	options, err := s.readRunOptions(r)
	if err != nil {
		sendJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	snapshot := s.startRunTask(r.Context(), options)
	sendJSON(w, http.StatusAccepted, map[string]any{"ok": true, "task": snapshot})
}

func (s *Server) handleSessions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		sendJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method not allowed"})
		return
	}
	store := contextstore.LoadStore(s.options.CWD)
	sendJSON(w, http.StatusOK, map[string]any{
		"ok":               true,
		"currentSessionId": store.CurrentSessionID,
		"sessions":         contextstore.ListSessions(store),
	})
}

func (s *Server) handleSessionRoute(w http.ResponseWriter, r *http.Request) {
	suffix := strings.Trim(strings.TrimPrefix(r.URL.Path, "/sessions/"), "/")
	switch {
	case r.Method == http.MethodPost && suffix == "new":
		store, err := contextstore.StartNewSession(s.options.CWD)
		if err != nil {
			sendJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		sendJSON(w, http.StatusOK, map[string]any{
			"ok":               true,
			"currentSessionId": store.CurrentSessionID,
			"sessions":         contextstore.ListSessions(store),
		})
	case r.Method == http.MethodPost && suffix == "switch":
		var body struct {
			SessionID string `json:"sessionId"`
		}
		if err := readJSONBody(r, &body); err != nil {
			sendJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		if strings.TrimSpace(body.SessionID) == "" {
			sendJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "missing sessionId"})
			return
		}
		store, err := contextstore.SwitchSession(s.options.CWD, body.SessionID)
		if err != nil {
			sendJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		if store == nil {
			sendJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "session not found: " + body.SessionID})
			return
		}
		sendJSON(w, http.StatusOK, map[string]any{
			"ok":               true,
			"currentSessionId": store.CurrentSessionID,
			"sessions":         contextstore.ListSessions(*store),
		})
	case r.Method == http.MethodGet && suffix == "history":
		store := contextstore.LoadStore(s.options.CWD)
		sessionID := r.URL.Query().Get("sessionId")
		if sessionID == "" {
			sessionID = store.CurrentSessionID
		}
		if !contextstore.HasSession(store, sessionID) {
			sendJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "session not found: " + sessionID})
			return
		}
		sendJSON(w, http.StatusOK, map[string]any{
			"ok":        true,
			"sessionId": sessionID,
			"messages":  contextstore.LoadChatHistory(store, sessionID),
		})
	default:
		sendJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "route not found"})
	}
}

func (s *Server) handleTaskRoute(w http.ResponseWriter, r *http.Request) {
	taskID, suffix := parseTaskRoute(r.URL.Path)
	if taskID == "" {
		sendJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "task id is missing"})
		return
	}

	switch {
	case r.Method == http.MethodGet && suffix == "":
		if !s.tasks.Exists(taskID) {
			sendJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "unknown task: " + taskID})
			return
		}
		sendJSON(w, http.StatusOK, map[string]any{"ok": true, "task": s.tasks.Get(taskID)})
	case r.Method == http.MethodPost && suffix == "cancel":
		snapshot, err := s.tasks.Cancel(taskID)
		if err != nil {
			sendJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		sendJSON(w, http.StatusAccepted, map[string]any{"ok": true, "task": snapshot})
	case r.Method == http.MethodGet && suffix == "events":
		s.streamTaskEvents(w, r, taskID)
	default:
		sendJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "route not found"})
	}
}

func (s *Server) handleRPC(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		sendJSON(w, http.StatusMethodNotAllowed, map[string]any{"jsonrpc": "2.0", "id": nil, "error": rpcError(-32600, "method not allowed")})
		return
	}
	var request JSONRPCRequest
	if err := readJSONBody(r, &request); err != nil {
		sendJSON(w, http.StatusOK, rpcErrorResponse(nil, -32700, err.Error()))
		return
	}
	response := s.handleRPCRequest(r.Context(), request)
	sendJSON(w, http.StatusOK, response)
}

func (s *Server) handleRPCRequest(ctx context.Context, request JSONRPCRequest) map[string]any {
	id := request.ID
	if id == nil {
		id = nil
	}
	if request.JSONRPC != "2.0" || request.Method == "" {
		return rpcErrorResponse(id, -32600, "invalid JSON-RPC request")
	}

	switch request.Method {
	case "deepvibe.health":
		return rpcResult(id, map[string]any{"ok": true, "service": "deepvibe", "runtime": "go"})
	case "deepvibe.run":
		options, err := s.runOptionsFromParams(request.Params)
		if err != nil {
			return rpcErrorResponse(id, -32602, err.Error())
		}
		result, err := s.runner(ctx, options, nil)
		if err != nil {
			return rpcErrorResponse(id, -32000, err.Error())
		}
		return rpcResult(id, result)
	case "deepvibe.completion.fim":
		options, err := s.fimOptionsFromParams(request.Params)
		if err != nil {
			return rpcErrorResponse(id, -32602, err.Error())
		}
		result, err := s.fimRunner(ctx, options)
		if err != nil {
			return rpcErrorResponse(id, -32000, err.Error())
		}
		return rpcResult(id, result)
	case "deepvibe.undo":
		options, err := s.undoOptionsFromParams(request.Params)
		if err != nil {
			return rpcErrorResponse(id, -32602, err.Error())
		}
		result, err := s.undoer(ctx, options)
		if err != nil {
			return rpcErrorResponse(id, -32000, err.Error())
		}
		return rpcResult(id, result)
	case "deepvibe.session.list":
		store := contextstore.LoadStore(s.options.CWD)
		return rpcResult(id, map[string]any{
			"currentSessionId": store.CurrentSessionID,
			"sessions":         contextstore.ListSessions(store),
		})
	case "deepvibe.session.new":
		store, err := contextstore.StartNewSession(s.options.CWD)
		if err != nil {
			return rpcErrorResponse(id, -32000, err.Error())
		}
		return rpcResult(id, map[string]any{
			"currentSessionId": store.CurrentSessionID,
			"sessions":         contextstore.ListSessions(store),
		})
	case "deepvibe.session.switch":
		sessionID, err := sessionIDFromParams(request.Params)
		if err != nil {
			return rpcErrorResponse(id, -32602, err.Error())
		}
		store, err := contextstore.SwitchSession(s.options.CWD, sessionID)
		if err != nil {
			return rpcErrorResponse(id, -32000, err.Error())
		}
		if store == nil {
			return rpcErrorResponse(id, -32004, "session not found: "+sessionID)
		}
		return rpcResult(id, map[string]any{
			"currentSessionId": store.CurrentSessionID,
			"sessions":         contextstore.ListSessions(*store),
		})
	case "deepvibe.session.history":
		store := contextstore.LoadStore(s.options.CWD)
		sessionID := optionalSessionIDFromParams(request.Params)
		if sessionID == "" {
			sessionID = store.CurrentSessionID
		}
		if !contextstore.HasSession(store, sessionID) {
			return rpcErrorResponse(id, -32004, "session not found: "+sessionID)
		}
		return rpcResult(id, map[string]any{
			"sessionId": sessionID,
			"messages":  contextstore.LoadChatHistory(store, sessionID),
		})
	case "deepvibe.session.updateHistory":
		sessionID, messages, err := updateHistoryParams(request.Params)
		if err != nil {
			return rpcErrorResponse(id, -32602, err.Error())
		}
		store := contextstore.LoadStore(s.options.CWD)
		if !contextstore.HasSession(store, sessionID) {
			return rpcErrorResponse(id, -32004, "session not found: "+sessionID)
		}
		if err := contextstore.UpdateChatHistory(s.options.CWD, sessionID, messages); err != nil {
			return rpcErrorResponse(id, -32000, err.Error())
		}
		return rpcResult(id, map[string]any{"ok": true})
	case "deepvibe.task.start":
		options, err := s.runOptionsFromParams(request.Params)
		if err != nil {
			return rpcErrorResponse(id, -32602, err.Error())
		}
		return rpcResult(id, s.startRunTask(ctx, options))
	case "deepvibe.task.get":
		taskID, err := taskIDFromParams(request.Params)
		if err != nil {
			return rpcErrorResponse(id, -32602, err.Error())
		}
		if !s.tasks.Exists(taskID) {
			return rpcErrorResponse(id, -32004, "unknown task: "+taskID)
		}
		return rpcResult(id, s.tasks.Get(taskID))
	case "deepvibe.task.cancel":
		taskID, err := taskIDFromParams(request.Params)
		if err != nil {
			return rpcErrorResponse(id, -32602, err.Error())
		}
		snapshot, err := s.tasks.Cancel(taskID)
		if err != nil {
			return rpcErrorResponse(id, -32004, err.Error())
		}
		return rpcResult(id, snapshot)
	default:
		return rpcErrorResponse(id, -32601, "method not found: "+request.Method)
	}
}

func (s *Server) startRunTask(ctx context.Context, options RunOptions) task.Snapshot {
	return s.tasks.Start(ctx, options.Instruction, func(taskCtx context.Context, emit func(eventType string, payload map[string]any, source string)) (any, error) {
		return s.runner(taskCtx, options, func(eventType string, payload map[string]any) {
			emit(eventType, payload, "engine")
		})
	})
}

func (s *Server) streamTaskEvents(w http.ResponseWriter, r *http.Request, taskID string) {
	events, ok := s.tasks.Events(taskID)
	if !ok {
		sendJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "unknown task: " + taskID})
		return
	}

	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	for _, event := range events {
		writeSSE(w, event)
	}
	if snapshot := s.tasks.Get(taskID); task.IsTerminal(snapshot.Status) {
		return
	}

	flusher, _ := w.(http.Flusher)
	done := make(chan struct{})
	var doneOnce sync.Once
	unsubscribe, ok := s.tasks.Subscribe(taskID, func(event task.Event) {
		writeSSE(w, event)
		if flusher != nil {
			flusher.Flush()
		}
		if task.IsTerminal(event.Status) {
			doneOnce.Do(func() {
				close(done)
			})
		}
	})
	if !ok {
		return
	}
	defer unsubscribe()

	select {
	case <-r.Context().Done():
	case <-done:
	}
}

func (s *Server) readRunOptions(r *http.Request) (RunOptions, error) {
	var options RunOptions
	if err := readJSONBody(r, &options); err != nil {
		return RunOptions{}, err
	}
	return s.normalizeRunOptions(options)
}

func (s *Server) readUndoOptions(r *http.Request) (UndoOptions, error) {
	var options UndoOptions
	if err := readJSONBody(r, &options); err != nil {
		return UndoOptions{}, err
	}
	return s.normalizeUndoOptions(options), nil
}

func (s *Server) normalizeRunOptions(options RunOptions) (RunOptions, error) {
	if strings.TrimSpace(options.Instruction) == "" {
		return RunOptions{}, errors.New(`run request requires a non-empty "instruction" string`)
	}
	if options.CWD == "" {
		options.CWD = s.options.CWD
	}
	if options.Profile == "" {
		options.Profile = "default"
	}
	if options.Profile != "default" && options.Profile != "flash" && options.Profile != "deep" {
		return RunOptions{}, errors.New(`run request "profile" must be one of default|flash|deep`)
	}
	return options, nil
}

func (s *Server) runOptionsFromParams(params any) (RunOptions, error) {
	data, err := json.Marshal(params)
	if err != nil {
		return RunOptions{}, err
	}
	var options RunOptions
	if len(data) > 0 && string(data) != "null" {
		if err := json.Unmarshal(data, &options); err != nil {
			return RunOptions{}, err
		}
	}
	return s.normalizeRunOptions(options)
}

func (s *Server) normalizeUndoOptions(options UndoOptions) UndoOptions {
	if strings.TrimSpace(options.CWD) == "" {
		options.CWD = s.options.CWD
	}
	return options
}

func (s *Server) undoOptionsFromParams(params any) (UndoOptions, error) {
	data, err := json.Marshal(params)
	if err != nil {
		return UndoOptions{}, err
	}
	var options UndoOptions
	if len(data) > 0 && string(data) != "null" {
		if err := json.Unmarshal(data, &options); err != nil {
			return UndoOptions{}, err
		}
	}
	return s.normalizeUndoOptions(options), nil
}

func (s *Server) fimOptionsFromParams(params any) (FIMOptions, error) {
	data, err := json.Marshal(params)
	if err != nil {
		return FIMOptions{}, err
	}
	var options FIMOptions
	if len(data) > 0 && string(data) != "null" {
		if err := json.Unmarshal(data, &options); err != nil {
			return FIMOptions{}, err
		}
	}
	if strings.TrimSpace(options.Prompt) == "" {
		return FIMOptions{}, errors.New("missing prompt for FIM completion")
	}
	if options.CWD == "" {
		options.CWD = s.options.CWD
	}
	return options, nil
}

func PreviewRunner(ctx context.Context, options RunOptions, emit func(eventType string, payload map[string]any)) (*RunResult, error) {
	core := engine.New(engine.Dependencies{
		ExecutionMode: "service",
		EmitEvent: func(event engine.Event) {
			if emit != nil {
				emit(event.Type, event.Payload)
			}
		},
	})
	result, err := core.Run(ctx, engine.RunOptions{
		CWD:         options.CWD,
		DryRun:      true,
		Instruction: options.Instruction,
		Profile:     engine.ExecutionProfile(options.Profile),
	})
	if err != nil {
		return nil, err
	}

	return &RunResult{
		Candidates:      result.Candidates,
		ContextTokens:   result.ContextTokens,
		MaxPromptTokens: result.MaxPromptTokens,
		Message:         result.Message,
		ScannedFiles:    result.ScannedFiles,
	}, nil
}

func DeepSeekFIMRunner(ctx context.Context, options FIMOptions) (*llm.DeepSeekFimCompletionResult, error) {
	cfg, err := config.Load(config.LoadOptions{CWD: options.CWD})
	if err != nil {
		return nil, err
	}
	apiKey, err := config.RequireAPIKey(cfg)
	if err != nil {
		return nil, err
	}
	model := options.Model
	if model == "" {
		model = "deepseek-v4-pro"
	}
	client := llm.NewDeepSeekClient(llm.DeepSeekClientOptions{APIKey: apiKey})
	return client.CreateDeepSeekFimCompletion(ctx, llm.CreateFimCompletionOptions{
		Echo:        options.Echo,
		Logprobs:    options.Logprobs,
		MaxTokens:   options.MaxTokens,
		Model:       model,
		Prompt:      options.Prompt,
		Stop:        options.Stop,
		Stream:      options.Stream,
		Suffix:      options.Suffix,
		Temperature: options.Temperature,
		TopP:        options.TopP,
	})
}

func GitUndoer(ctx context.Context, options UndoOptions) (*gitmanager.UndoResult, error) {
	return gitmanager.UndoLastAIChange(ctx, options.CWD)
}

func readJSONBody(r *http.Request, target any) error {
	defer r.Body.Close()
	data, err := io.ReadAll(io.LimitReader(r.Body, 2_000_000))
	if err != nil {
		return err
	}
	if len(data) == 0 {
		data = []byte("{}")
	}
	if err := json.Unmarshal(data, target); err != nil {
		return fmt.Errorf("invalid JSON body: %w", err)
	}
	return nil
}

func sendJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeSSE(w http.ResponseWriter, event task.Event) {
	fmt.Fprintf(w, "id: %d\n", event.ID)
	fmt.Fprintf(w, "event: %s\n", event.Type)
	data, _ := json.Marshal(event)
	fmt.Fprintf(w, "data: %s\n\n", data)
}

func rpcResult(id any, result any) map[string]any {
	return map[string]any{"jsonrpc": "2.0", "id": id, "result": result}
}

func rpcErrorResponse(id any, code int, message string) map[string]any {
	return map[string]any{"jsonrpc": "2.0", "id": id, "error": rpcError(code, message)}
}

func rpcError(code int, message string) map[string]any {
	return map[string]any{"code": code, "message": message}
}

func parseTaskRoute(pathname string) (string, string) {
	trimmed := strings.TrimPrefix(pathname, "/tasks/")
	parts := strings.Split(strings.Trim(trimmed, "/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		return "", ""
	}
	if len(parts) == 1 {
		return parts[0], ""
	}
	return parts[0], parts[1]
}

func taskIDFromParams(params any) (string, error) {
	record, ok := params.(map[string]any)
	if !ok {
		return "", errors.New(`task method requires params object`)
	}
	taskID, ok := record["taskId"].(string)
	if !ok || strings.TrimSpace(taskID) == "" {
		return "", errors.New(`task method requires a non-empty "taskId" string`)
	}
	return taskID, nil
}

func sessionIDFromParams(params any) (string, error) {
	record, ok := params.(map[string]any)
	if !ok {
		return "", errors.New(`session method requires params object`)
	}
	sessionID, ok := record["sessionId"].(string)
	if !ok || strings.TrimSpace(sessionID) == "" {
		return "", errors.New(`session method requires a non-empty "sessionId" string`)
	}
	return sessionID, nil
}

func optionalSessionIDFromParams(params any) string {
	record, ok := params.(map[string]any)
	if !ok {
		return ""
	}
	sessionID, _ := record["sessionId"].(string)
	return strings.TrimSpace(sessionID)
}

func updateHistoryParams(params any) (string, []llm.ChatMessage, error) {
	sessionID, err := sessionIDFromParams(params)
	if err != nil {
		return "", nil, err
	}
	record := params.(map[string]any)
	rawMessages, ok := record["messages"]
	if !ok {
		return "", nil, errors.New(`session updateHistory requires "messages" array`)
	}
	data, err := json.Marshal(rawMessages)
	if err != nil {
		return "", nil, err
	}
	var messages []llm.ChatMessage
	if err := json.Unmarshal(data, &messages); err != nil {
		return "", nil, err
	}
	return sessionID, messages, nil
}
