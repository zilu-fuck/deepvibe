package repl

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	contextstore "github.com/zilu-fuck/deepvibe/internal/context"
	"github.com/zilu-fuck/deepvibe/internal/engine"
	"github.com/zilu-fuck/deepvibe/internal/intent"
	"github.com/zilu-fuck/deepvibe/internal/llm"
)

type Mode string

const (
	ModeAuto    Mode = "auto"
	ModeChat    Mode = "chat"
	ModeProject Mode = "project"
)

type Runner interface {
	Run(ctx context.Context, opts engine.RunOptions) (*engine.Result, error)
}

type Options struct {
	CWD         string
	Engine      Runner
	ErrorOutput io.Writer
	Input       io.Reader
	Mode        Mode
	Output      io.Writer
	Profile     engine.ExecutionProfile
}

type REPL struct {
	cwd         string
	engine      Runner
	errorOutput io.Writer
	input       io.Reader
	mode        Mode
	output      io.Writer
	profile     engine.ExecutionProfile
}

func New(options Options) *REPL {
	cwd := options.CWD
	if cwd == "" {
		if current, err := os.Getwd(); err == nil {
			cwd = current
		}
	}
	if cwd == "" {
		cwd = "."
	}
	input := options.Input
	if input == nil {
		input = os.Stdin
	}
	output := options.Output
	if output == nil {
		output = os.Stdout
	}
	errorOutput := options.ErrorOutput
	if errorOutput == nil {
		errorOutput = output
	}
	runner := options.Engine
	if runner == nil {
		runner = engine.New(engine.Dependencies{})
	}
	mode := normalizeMode(options.Mode)
	profile := options.Profile
	if profile == "" {
		profile = engine.ProfileDefault
	}
	return &REPL{
		cwd:         filepath.Clean(cwd),
		engine:      runner,
		errorOutput: errorOutput,
		input:       input,
		mode:        mode,
		output:      output,
		profile:     profile,
	}
}

func (r *REPL) Run(ctx context.Context) error {
	store, err := contextstore.EnsureStore(r.cwd)
	if err != nil {
		return err
	}
	fmt.Fprintf(r.output, "DeepVibe REPL session started. session=%s mode=%s\n", store.CurrentSessionID, r.mode)
	fmt.Fprintln(r.output, "Type /help for commands.")

	scanner := bufio.NewScanner(r.input)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		fmt.Fprint(r.output, "deepvibe> ")
		if !scanner.Scan() {
			break
		}
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "/") {
			done, err := r.handleSlash(line)
			if err != nil {
				fmt.Fprintf(r.errorOutput, "%v\n", err)
			}
			if done {
				return nil
			}
			continue
		}
		if err := r.runInstruction(ctx, line); err != nil {
			fmt.Fprintf(r.errorOutput, "engine: %v\n", err)
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	return nil
}

func (r *REPL) handleSlash(line string) (bool, error) {
	fields := strings.Fields(line)
	command := fields[0]
	switch command {
	case "/quit", "/exit":
		fmt.Fprintln(r.output, "Goodbye.")
		return true, nil
	case "/help":
		r.printHelp()
	case "/sessions":
		r.printSessions()
	case "/new":
		store, err := contextstore.StartNewSession(r.cwd)
		if err != nil {
			return false, err
		}
		fmt.Fprintf(r.output, "Started session %s\n", store.CurrentSessionID)
	case "/switch":
		if len(fields) != 2 {
			return false, fmt.Errorf("usage: /switch <session-id>")
		}
		store, err := contextstore.SwitchSession(r.cwd, fields[1])
		if err != nil {
			return false, err
		}
		if store == nil {
			return false, fmt.Errorf("session not found: %s", fields[1])
		}
		fmt.Fprintf(r.output, "Switched session %s\n", store.CurrentSessionID)
	case "/history":
		r.printHistory()
	case "/mode":
		if len(fields) == 1 {
			fmt.Fprintf(r.output, "mode=%s\n", r.mode)
			return false, nil
		}
		next := normalizeMode(Mode(fields[1]))
		if next == "" {
			return false, fmt.Errorf("usage: /mode auto|chat|project")
		}
		r.mode = next
		fmt.Fprintf(r.output, "mode=%s\n", r.mode)
	default:
		return false, fmt.Errorf("unknown command: %s", command)
	}
	return false, nil
}

func (r *REPL) printHelp() {
	fmt.Fprintln(r.output, "Commands:")
	fmt.Fprintln(r.output, "  /help")
	fmt.Fprintln(r.output, "  /sessions")
	fmt.Fprintln(r.output, "  /new")
	fmt.Fprintln(r.output, "  /switch <session-id>")
	fmt.Fprintln(r.output, "  /history")
	fmt.Fprintln(r.output, "  /mode auto|chat|project")
	fmt.Fprintln(r.output, "  /quit")
}

func (r *REPL) printSessions() {
	store := contextstore.LoadStore(r.cwd)
	sessions := contextstore.ListSessions(store)
	for _, session := range sessions {
		marker := "  "
		if session.ID == store.CurrentSessionID {
			marker = "* "
		}
		fmt.Fprintf(r.output, "%s%s turns=%d updated=%s\n", marker, session.ID, session.TurnCount, session.UpdatedAt)
	}
}

func (r *REPL) printHistory() {
	store := contextstore.LoadStore(r.cwd)
	history := contextstore.LoadChatHistory(store, store.CurrentSessionID)
	if len(history) == 0 {
		fmt.Fprintln(r.output, "No chat history.")
		return
	}
	for _, message := range history {
		content := ""
		if message.Content != nil {
			content = *message.Content
		}
		fmt.Fprintf(r.output, "%s: %s\n", message.Role, content)
	}
}

func (r *REPL) runInstruction(ctx context.Context, instruction string) error {
	store := contextstore.LoadStore(r.cwd)
	sessionID := store.CurrentSessionID
	result, err := r.engine.Run(ctx, engine.RunOptions{
		CWD:         r.cwd,
		DryRun:      r.shouldDryRun(instruction),
		Instruction: instruction,
		Profile:     r.profile,
	})
	if err != nil {
		_, _ = contextstore.AppendTurn(contextstore.AppendTurnOptions{
			RootDir:     r.cwd,
			Instruction: instruction,
			Result:      contextstore.TurnResult{OK: false, Kind: "error"},
			Summary:     err.Error(),
		})
		return err
	}

	message := strings.TrimSpace(result.Message)
	if message == "" {
		message = "Done."
	}
	fmt.Fprintln(r.output, message)

	history := contextstore.LoadChatHistory(store, sessionID)
	history = append(history,
		llm.ChatMessage{Role: "user", Content: llm.StringContent(instruction)},
		llm.ChatMessage{Role: "assistant", Content: llm.StringContent(message)},
	)
	if err := contextstore.UpdateChatHistory(r.cwd, sessionID, history); err != nil {
		return err
	}

	files := result.FilesChanged
	if len(files) == 0 {
		files = result.Candidates
	}
	kind := result.ChangeKind
	if kind == "" {
		kind = "dry-run"
	}
	_, err = contextstore.AppendTurn(contextstore.AppendTurnOptions{
		Files:       files,
		Instruction: instruction,
		Result: contextstore.TurnResult{
			AppliedFiles:  len(result.FilesChanged),
			Kind:          kind,
			OK:            true,
			Reference:     firstNonEmpty(result.ChangeReference, result.CommitHash),
			ToolCallsUsed: result.ToolCallsUsed,
		},
		RootDir: r.cwd,
		Summary: message,
	})
	return err
}

func normalizeMode(mode Mode) Mode {
	switch mode {
	case "", ModeAuto:
		return ModeAuto
	case ModeProject:
		return ModeProject
	case ModeChat:
		return ModeChat
	default:
		return ""
	}
}

func (r *REPL) shouldDryRun(instruction string) bool {
	switch r.mode {
	case ModeChat:
		return true
	case ModeProject:
		return false
	default:
		decision := intent.DetectHeuristically(instruction)
		return !decision.RequiresWriteAccess
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
