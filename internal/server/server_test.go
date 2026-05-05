package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	gitmanager "github.com/zilu-fuck/deepvibe/internal/git"
	"github.com/zilu-fuck/deepvibe/internal/llm"
)

func TestHealthAndRun(t *testing.T) {
	cwd := t.TempDir()
	srv := New(Options{
		CWD: cwd,
		Runner: func(ctx context.Context, options RunOptions, emit func(string, map[string]any)) (*RunResult, error) {
			if options.CWD != cwd {
				t.Fatalf("expected cwd %s, got %s", cwd, options.CWD)
			}
			if options.Instruction != "scan api" {
				t.Fatalf("unexpected instruction %q", options.Instruction)
			}
			return &RunResult{
				Candidates:      []string{"src/api.ts"},
				ContextTokens:   10,
				MaxPromptTokens: 100,
				Message:         "ok",
				ScannedFiles:    1,
			}, nil
		},
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("health status = %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	req = jsonRequest(http.MethodPost, "/run", map[string]any{"instruction": "scan api"})
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("run status = %d body=%s", rec.Code, rec.Body.String())
	}

	var body map[string]any
	decodeBody(t, rec, &body)
	if body["ok"] != true {
		t.Fatalf("expected ok response, got %#v", body)
	}
	result := body["result"].(map[string]any)
	if result["message"] != "ok" {
		t.Fatalf("unexpected run result: %#v", result)
	}
}

func TestFIMUsesInjectedRunner(t *testing.T) {
	srv := New(Options{
		CWD: t.TempDir(),
		FIMRunner: func(ctx context.Context, options FIMOptions) (*llm.DeepSeekFimCompletionResult, error) {
			if options.Prompt != "func main" {
				t.Fatalf("unexpected prompt %q", options.Prompt)
			}
			return &llm.DeepSeekFimCompletionResult{Content: "() {}"}, nil
		},
	})

	rec := httptest.NewRecorder()
	req := jsonRequest(http.MethodPost, "/completions/fim", map[string]any{"prompt": "func main"})
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("fim status = %d body=%s", rec.Code, rec.Body.String())
	}

	var body map[string]any
	decodeBody(t, rec, &body)
	result := body["result"].(map[string]any)
	if result["content"] != "() {}" {
		t.Fatalf("unexpected fim result: %#v", result)
	}
}

func TestUndoUsesInjectedUndoer(t *testing.T) {
	cwd := t.TempDir()
	srv := New(Options{
		CWD: cwd,
		Undoer: func(ctx context.Context, options UndoOptions) (*gitmanager.UndoResult, error) {
			if options.CWD != cwd {
				t.Fatalf("expected cwd %s, got %s", cwd, options.CWD)
			}
			return &gitmanager.UndoResult{Kind: "operation", Reference: "op_test"}, nil
		},
	})

	rec := httptest.NewRecorder()
	req := jsonRequest(http.MethodPost, "/undo", map[string]any{})
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("undo status = %d body=%s", rec.Code, rec.Body.String())
	}

	var body map[string]any
	decodeBody(t, rec, &body)
	result := body["result"].(map[string]any)
	if result["kind"] != "operation" || result["reference"] != "op_test" {
		t.Fatalf("unexpected undo result: %#v", result)
	}
}

func TestSessionHTTPRoutes(t *testing.T) {
	cwd := t.TempDir()
	srv := New(Options{CWD: cwd})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/sessions", nil)
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("sessions status = %d body=%s", rec.Code, rec.Body.String())
	}
	var listBody map[string]any
	decodeBody(t, rec, &listBody)
	firstSessionID := listBody["currentSessionId"].(string)
	if firstSessionID == "" {
		t.Fatal("expected current session id")
	}

	rec = httptest.NewRecorder()
	req = jsonRequest(http.MethodPost, "/sessions/new", map[string]any{})
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("new session status = %d body=%s", rec.Code, rec.Body.String())
	}
	var newBody map[string]any
	decodeBody(t, rec, &newBody)
	secondSessionID := newBody["currentSessionId"].(string)
	if secondSessionID == "" || secondSessionID == firstSessionID {
		t.Fatalf("expected distinct new session, got %q first=%q", secondSessionID, firstSessionID)
	}

	rec = httptest.NewRecorder()
	req = jsonRequest(http.MethodPost, "/sessions/switch", map[string]any{"sessionId": firstSessionID})
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("switch session status = %d body=%s", rec.Code, rec.Body.String())
	}
	var switchBody map[string]any
	decodeBody(t, rec, &switchBody)
	if switchBody["currentSessionId"] != firstSessionID {
		t.Fatalf("expected switched session %s, got %#v", firstSessionID, switchBody)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/sessions/history?sessionId="+firstSessionID, nil)
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("history status = %d body=%s", rec.Code, rec.Body.String())
	}
	var historyBody map[string]any
	decodeBody(t, rec, &historyBody)
	if historyBody["sessionId"] != firstSessionID {
		t.Fatalf("unexpected history body: %#v", historyBody)
	}
}

func TestTaskRunAndEventStream(t *testing.T) {
	srv := New(Options{
		CWD: t.TempDir(),
		Runner: func(ctx context.Context, options RunOptions, emit func(string, map[string]any)) (*RunResult, error) {
			emit("engine.step", map[string]any{"name": "scan"})
			return &RunResult{Message: "done"}, nil
		},
	})

	rec := httptest.NewRecorder()
	req := jsonRequest(http.MethodPost, "/tasks/run", map[string]any{"instruction": "migrate"})
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("task run status = %d body=%s", rec.Code, rec.Body.String())
	}

	var body struct {
		Task struct {
			TaskID string `json:"taskId"`
		} `json:"task"`
	}
	decodeBody(t, rec, &body)
	if body.Task.TaskID == "" {
		t.Fatal("expected task id")
	}

	waitForTaskStatus(t, srv, body.Task.TaskID, "completed")

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/tasks/"+body.Task.TaskID+"/events", nil)
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("events status = %d body=%s", rec.Code, rec.Body.String())
	}
	stream := rec.Body.String()
	if !strings.Contains(stream, "event: engine.step") || !strings.Contains(stream, "event: task.completed") {
		t.Fatalf("unexpected event stream:\n%s", stream)
	}
}

func TestJSONRPC(t *testing.T) {
	srv := New(Options{
		CWD: t.TempDir(),
		Runner: func(ctx context.Context, options RunOptions, emit func(string, map[string]any)) (*RunResult, error) {
			return &RunResult{Message: filepath.Base(options.CWD)}, nil
		},
	})

	rec := httptest.NewRecorder()
	req := jsonRequest(http.MethodPost, "/rpc", map[string]any{
		"jsonrpc": "2.0",
		"id":      7,
		"method":  "deepvibe.run",
		"params":  map[string]any{"instruction": "preview"},
	})
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("rpc status = %d", rec.Code)
	}

	var body map[string]any
	decodeBody(t, rec, &body)
	if body["error"] != nil {
		t.Fatalf("unexpected rpc error: %#v", body["error"])
	}
	if body["id"].(float64) != 7 {
		t.Fatalf("unexpected rpc id: %#v", body["id"])
	}
}

func TestJSONRPCUndo(t *testing.T) {
	srv := New(Options{
		CWD: t.TempDir(),
		Undoer: func(ctx context.Context, options UndoOptions) (*gitmanager.UndoResult, error) {
			return &gitmanager.UndoResult{Kind: "commit", Reference: "abc123"}, nil
		},
	})

	rec := httptest.NewRecorder()
	req := jsonRequest(http.MethodPost, "/rpc", map[string]any{
		"jsonrpc": "2.0",
		"id":      "undo-1",
		"method":  "deepvibe.undo",
		"params":  map[string]any{},
	})
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("rpc status = %d", rec.Code)
	}

	var body map[string]any
	decodeBody(t, rec, &body)
	if body["error"] != nil {
		t.Fatalf("unexpected rpc error: %#v", body["error"])
	}
	result := body["result"].(map[string]any)
	if result["kind"] != "commit" || result["reference"] != "abc123" {
		t.Fatalf("unexpected rpc undo result: %#v", result)
	}
}

func TestJSONRPCSessionUpdateHistory(t *testing.T) {
	srv := New(Options{CWD: t.TempDir()})
	sessionID := currentSessionIDViaRPC(t, srv)

	rec := httptest.NewRecorder()
	req := jsonRequest(http.MethodPost, "/rpc", map[string]any{
		"jsonrpc": "2.0",
		"id":      "history-update",
		"method":  "deepvibe.session.updateHistory",
		"params": map[string]any{
			"sessionId": sessionID,
			"messages": []map[string]any{
				{"role": "user", "content": "hello"},
			},
		},
	})
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("rpc status = %d", rec.Code)
	}
	var updateBody map[string]any
	decodeBody(t, rec, &updateBody)
	if updateBody["error"] != nil {
		t.Fatalf("unexpected update error: %#v", updateBody["error"])
	}

	rec = httptest.NewRecorder()
	req = jsonRequest(http.MethodPost, "/rpc", map[string]any{
		"jsonrpc": "2.0",
		"id":      "history-read",
		"method":  "deepvibe.session.history",
		"params":  map[string]any{"sessionId": sessionID},
	})
	srv.Handler().ServeHTTP(rec, req)
	var historyBody map[string]any
	decodeBody(t, rec, &historyBody)
	if historyBody["error"] != nil {
		t.Fatalf("unexpected history error: %#v", historyBody["error"])
	}
	result := historyBody["result"].(map[string]any)
	messages := result["messages"].([]any)
	if len(messages) != 1 {
		t.Fatalf("expected one message, got %#v", messages)
	}
	message := messages[0].(map[string]any)
	if message["role"] != "user" || message["content"] != "hello" {
		t.Fatalf("unexpected message: %#v", message)
	}
}

func currentSessionIDViaRPC(t *testing.T, srv *Server) string {
	t.Helper()
	rec := httptest.NewRecorder()
	req := jsonRequest(http.MethodPost, "/rpc", map[string]any{
		"jsonrpc": "2.0",
		"id":      "session-list",
		"method":  "deepvibe.session.list",
		"params":  map[string]any{},
	})
	srv.Handler().ServeHTTP(rec, req)
	var body map[string]any
	decodeBody(t, rec, &body)
	result := body["result"].(map[string]any)
	sessionID := result["currentSessionId"].(string)
	if sessionID == "" {
		t.Fatalf("empty session id in %#v", result)
	}
	return sessionID
}

func jsonRequest(method string, path string, payload any) *http.Request {
	data, _ := json.Marshal(payload)
	req := httptest.NewRequest(method, path, bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	return req
}

func decodeBody(t *testing.T, rec *httptest.ResponseRecorder, target any) {
	t.Helper()
	if err := json.NewDecoder(rec.Body).Decode(target); err != nil {
		t.Fatalf("decode response: %v\n%s", err, rec.Body.String())
	}
}

func waitForTaskStatus(t *testing.T, srv *Server, taskID string, want string) {
	t.Helper()
	for i := 0; i < 100; i++ {
		snapshot := srv.tasks.Get(taskID)
		if string(snapshot.Status) == want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("task %s did not reach status %s", taskID, want)
}
