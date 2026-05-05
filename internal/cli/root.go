package cli

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	contextbuilder "github.com/zilu-fuck/deepvibe/internal/context"
	"github.com/zilu-fuck/deepvibe/internal/config"
	"github.com/zilu-fuck/deepvibe/internal/engine"
	gitmanager "github.com/zilu-fuck/deepvibe/internal/git"
	"github.com/zilu-fuck/deepvibe/internal/plugins"
	"github.com/zilu-fuck/deepvibe/internal/repl"
	"github.com/zilu-fuck/deepvibe/internal/scanner"
	"github.com/zilu-fuck/deepvibe/internal/server"
)

const version = "0.1.0-go-dev"

type getwdFunc func() (string, error)

func Run(ctx context.Context, args []string, stdout io.Writer, stderr io.Writer, getwd getwdFunc) int {
	if len(args) <= 1 {
		printUsage(stdout)
		return 0
	}

	cwd, err := getwd()
	if err != nil {
		fmt.Fprintf(stderr, "failed to resolve current directory: %v\n", err)
		return 1
	}

	cmd := args[1]
	switch cmd {
	case "--help", "-h", "help":
		printUsage(stdout)
		return 0
	case "--version", "-v", "version":
		fmt.Fprintln(stdout, version)
		return 0
	case "config":
		return runConfig(args[2:], stdout, stderr, cwd)
	case "scan":
		return runScan(ctx, args[2:], stdout, stderr, cwd)
	case "context":
		return runContext(ctx, args[2:], stdout, stderr, cwd)
	case "plugins":
		return runPlugins(args[2:], stdout, stderr, cwd)
	case "undo":
		return runUndo(ctx, args[2:], stdout, stderr, cwd)
	case "chat", "repl":
		return runChat(ctx, args[2:], stdout, stderr, cwd)
	case "serve", "server":
		return runServe(ctx, args[2:], stdout, stderr, cwd)
	default:
		return runInstructionPreview(ctx, args[1:], stdout, stderr, cwd)
	}
}

func printUsage(w io.Writer) {
	fmt.Fprintln(w, "DeepVibe Core Go runtime (migration preview)")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "Usage:")
	fmt.Fprintln(w, "  deepvibe <instruction> [--dry-run]")
	fmt.Fprintln(w, "  deepvibe scan <instruction> [--json]")
	fmt.Fprintln(w, "  deepvibe context <instruction> [--json]")
	fmt.Fprintln(w, "  deepvibe chat [--mode auto|project|chat] [--profile default|flash|deep]")
	fmt.Fprintln(w, "  deepvibe plugins [--json]")
	fmt.Fprintln(w, "  deepvibe undo")
	fmt.Fprintln(w, "  deepvibe serve [--host 127.0.0.1] [--port 4242]")
	fmt.Fprintln(w, "  deepvibe config set <key> <value> [--project]")
	fmt.Fprintln(w, "  deepvibe --version")
}

func runConfig(args []string, stdout io.Writer, stderr io.Writer, cwd string) int {
	if len(args) == 0 {
		cfg, err := config.Load(config.LoadOptions{CWD: cwd})
		if err != nil {
			fmt.Fprintf(stderr, "config: %v\n", err)
			return 1
		}
		enc := json.NewEncoder(stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(cfg); err != nil {
			fmt.Fprintf(stderr, "config: %v\n", err)
			return 1
		}
		return 0
	}

	if args[0] != "set" {
		fmt.Fprintf(stderr, "unsupported config command %q\n", args[0])
		return 1
	}

	fs := flag.NewFlagSet("config set", flag.ContinueOnError)
	fs.SetOutput(stderr)
	project := fs.Bool("project", false, "write project config")
	if err := fs.Parse(args[1:]); err != nil {
		return 1
	}

	if fs.NArg() != 2 {
		fmt.Fprintln(stderr, "usage: deepvibe config set <key> <value> [--project]")
		return 1
	}

	target := config.TargetGlobal
	if *project {
		target = config.TargetProject
	}

	result, err := config.SetValue(config.SetValueOptions{
		CWD:    cwd,
		Key:    fs.Arg(0),
		Target: target,
		Value:  fs.Arg(1),
	})
	if err != nil {
		fmt.Fprintf(stderr, "config: %v\n", err)
		return 1
	}

	fmt.Fprintf(stdout, "Saved %s to %s\n", result.Key, result.ConfigPath)
	return 0
}

func runScan(ctx context.Context, args []string, stdout io.Writer, stderr io.Writer, cwd string) int {
	fs := flag.NewFlagSet("scan", flag.ContinueOnError)
	fs.SetOutput(stderr)
	asJSON := fs.Bool("json", false, "print JSON")
	maxCandidates := fs.Int("max", 5, "maximum candidate files")
	if err := fs.Parse(args); err != nil {
		return 1
	}

	instruction := strings.TrimSpace(strings.Join(fs.Args(), " "))
	if instruction == "" {
		fmt.Fprintln(stderr, "usage: deepvibe scan <instruction>")
		return 1
	}

	cfg, err := config.Load(config.LoadOptions{CWD: cwd})
	if err != nil {
		fmt.Fprintf(stderr, "config: %v\n", err)
		return 1
	}

	result, err := scanner.ScanProject(ctx, scanner.Options{
		RootDir:        cwd,
		Instruction:    instruction,
		MaxCandidates:  *maxCandidates,
		IgnorePatterns: cfg.Ignore,
	})
	if err != nil {
		fmt.Fprintf(stderr, "scan: %v\n", err)
		return 1
	}

	if *asJSON {
		return encodeJSON(stdout, stderr, result)
	}

	fmt.Fprintf(stdout, "Scanned files: %d\n", result.ScannedFiles)
	fmt.Fprintln(stdout, "Candidates:")
	for _, candidate := range result.Candidates {
		fmt.Fprintf(stdout, "- %s\n", candidate)
	}
	return 0
}

func runContext(ctx context.Context, args []string, stdout io.Writer, stderr io.Writer, cwd string) int {
	fs := flag.NewFlagSet("context", flag.ContinueOnError)
	fs.SetOutput(stderr)
	asJSON := fs.Bool("json", false, "print JSON")
	maxFiles := fs.Int("max-files", 12, "maximum files to include")
	if err := fs.Parse(args); err != nil {
		return 1
	}

	instruction := strings.TrimSpace(strings.Join(fs.Args(), " "))
	if instruction == "" {
		fmt.Fprintln(stderr, "usage: deepvibe context <instruction>")
		return 1
	}

	result, err := buildContextPreview(ctx, cwd, instruction, *maxFiles)
	if err != nil {
		fmt.Fprintf(stderr, "context: %v\n", err)
		return 1
	}

	if *asJSON {
		return encodeJSON(stdout, stderr, result)
	}

	fmt.Fprintf(stdout, "Token estimate: %d / %d\n", result.TokenEstimate, result.MaxPromptTokens)
	fmt.Fprintf(stdout, "Truncated: %t\n", result.Truncated)
	fmt.Fprintln(stdout, "Files:")
	for _, file := range result.Files {
		fmt.Fprintf(stdout, "- %s [%s, tokens=%d]\n", file.Path, file.Mode, file.TokenEstimate)
	}
	return 0
}

func runServe(ctx context.Context, args []string, stdout io.Writer, stderr io.Writer, cwd string) int {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.SetOutput(stderr)
	host := fs.String("host", "127.0.0.1", "HTTP host")
	port := fs.Int("port", 4242, "HTTP port")
	if err := fs.Parse(args); err != nil {
		return 1
	}
	if fs.NArg() != 0 {
		fmt.Fprintln(stderr, "usage: deepvibe serve [--host 127.0.0.1] [--port 4242]")
		return 1
	}

	srv := server.New(server.Options{
		CWD:  cwd,
		Host: *host,
		Port: *port,
	})
	fmt.Fprintf(stdout, "DeepVibe Go server listening on http://%s:%d\n", *host, *port)
	if err := srv.ListenAndServe(ctx); err != nil && !errors.Is(err, context.Canceled) {
		fmt.Fprintf(stderr, "serve: %v\n", err)
		return 1
	}
	return 0
}

func runUndo(ctx context.Context, args []string, stdout io.Writer, stderr io.Writer, cwd string) int {
	fs := flag.NewFlagSet("undo", flag.ContinueOnError)
	fs.SetOutput(stderr)
	if err := fs.Parse(args); err != nil {
		return 1
	}
	if fs.NArg() != 0 {
		fmt.Fprintln(stderr, "usage: deepvibe undo")
		return 1
	}

	result, err := gitmanager.UndoLastAIChange(ctx, cwd)
	if err != nil {
		fmt.Fprintf(stderr, "undo: %v\n", err)
		return 1
	}
	fmt.Fprintf(stdout, "Undo complete: kind=%s reference=%s\n", result.Kind, result.Reference)
	return 0
}

func runPlugins(args []string, stdout io.Writer, stderr io.Writer, cwd string) int {
	fs := flag.NewFlagSet("plugins", flag.ContinueOnError)
	fs.SetOutput(stderr)
	asJSON := fs.Bool("json", false, "print JSON")
	if err := fs.Parse(args); err != nil {
		return 1
	}
	if fs.NArg() != 0 {
		fmt.Fprintln(stderr, "usage: deepvibe plugins [--json]")
		return 1
	}

	info := plugins.InspectDiscovery(cwd)
	if *asJSON {
		return encodeJSON(stdout, stderr, info)
	}

	fmt.Fprintf(stdout, "Plugins: enabled=%d errors=%d\n", info.EnabledCount, info.ErrorCount)
	records, err := plugins.DiscoverManifests(cwd)
	if err != nil {
		fmt.Fprintf(stderr, "plugins: %v\n", err)
		return 1
	}
	for _, record := range records {
		fmt.Fprintf(stdout, "- %s [%s] entry=%s\n", record.Manifest.Name, record.Manifest.Kind, record.EntryPath)
	}
	return 0
}

func runChat(ctx context.Context, args []string, stdout io.Writer, stderr io.Writer, cwd string) int {
	fs := flag.NewFlagSet("chat", flag.ContinueOnError)
	fs.SetOutput(stderr)
	mode := fs.String("mode", string(repl.ModeAuto), "REPL mode: auto, project, or chat")
	profile := fs.String("profile", string(engine.ProfileDefault), "execution profile: default, flash, or deep")
	if err := fs.Parse(args); err != nil {
		return 1
	}
	if fs.NArg() != 0 {
		fmt.Fprintln(stderr, "usage: deepvibe chat [--mode auto|project|chat] [--profile default|flash|deep]")
		return 1
	}

	nextMode := repl.Mode(*mode)
	if nextMode != repl.ModeAuto && nextMode != repl.ModeProject && nextMode != repl.ModeChat {
		fmt.Fprintln(stderr, "usage: deepvibe chat [--mode auto|project|chat] [--profile default|flash|deep]")
		return 1
	}
	nextProfile := engine.ExecutionProfile(*profile)
	if nextProfile != engine.ProfileDefault && nextProfile != engine.ProfileFlash && nextProfile != engine.ProfileDeep {
		fmt.Fprintln(stderr, "usage: deepvibe chat [--mode auto|project|chat] [--profile default|flash|deep]")
		return 1
	}

	session := repl.New(repl.Options{
		CWD:         cwd,
		ErrorOutput: stderr,
		Input:       os.Stdin,
		Mode:        nextMode,
		Output:      stdout,
		Profile:     nextProfile,
	})
	if err := session.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		fmt.Fprintf(stderr, "chat: %v\n", err)
		return 1
	}
	return 0
}

func runInstructionPreview(ctx context.Context, args []string, stdout io.Writer, stderr io.Writer, cwd string) int {
	filtered := make([]string, 0, len(args))
	for _, arg := range args {
		if arg != "--dry-run" {
			filtered = append(filtered, arg)
		}
	}
	instruction := strings.TrimSpace(strings.Join(filtered, " "))
	if instruction == "" {
		printUsage(stdout)
		return 0
	}

	result, err := buildContextPreview(ctx, cwd, instruction, 12)
	if err != nil {
		fmt.Fprintf(stderr, "deepvibe: %v\n", err)
		return 1
	}

	fmt.Fprintln(stdout, "Go migration preview built request context.")
	fmt.Fprintf(stdout, "Instruction: %s\n", instruction)
	fmt.Fprintf(stdout, "Candidate files: %d\n", len(result.Files))
	fmt.Fprintf(stdout, "Token estimate: %d\n", result.TokenEstimate)
	fmt.Fprintln(stdout, "LLM execution is not wired in this migration phase yet.")
	return 0
}

func buildContextPreview(ctx context.Context, cwd string, instruction string, maxFiles int) (*contextbuilder.BuildResult, error) {
	cfg, err := config.Load(config.LoadOptions{CWD: cwd})
	if err != nil {
		return nil, err
	}

	scanResult, err := scanner.ScanProject(ctx, scanner.Options{
		RootDir:        cwd,
		Instruction:    instruction,
		MaxCandidates:  maxFiles,
		IgnorePatterns: cfg.Ignore,
	})
	if err != nil {
		return nil, err
	}

	projectPrompt, err := config.LoadProjectPrompt(cwd)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}

	return contextbuilder.Build(contextbuilder.BuildOptions{
		RootDir:       filepath.Clean(cwd),
		Instruction:   instruction,
		Candidates:    scanResult.Candidates,
		ExplicitPaths: scanResult.ExplicitPaths,
		MaxFiles:      maxFiles,
		ProjectPrompt: projectPrompt,
	})
}

func encodeJSON(stdout io.Writer, stderr io.Writer, value any) int {
	enc := json.NewEncoder(stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(value); err != nil {
		fmt.Fprintf(stderr, "json: %v\n", err)
		return 1
	}
	return 0
}
