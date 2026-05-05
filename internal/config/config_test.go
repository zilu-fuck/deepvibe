package config

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadMergesProjectWithTopLevelReplacement(t *testing.T) {
	home := t.TempDir()
	cwd := t.TempDir()
	writeFile(t, filepath.Join(home, ".deepvibe", "config.json"), `{
  "apiKey": "global-key",
  "defaultModel": "deepseek-v4-pro",
  "ignore": ["global/**"],
  "toolPermissions": {
    "command": {
      "allowedPrefixes": ["pnpm test"]
    }
  }
}`)
	writeFile(t, filepath.Join(cwd, ".deepvibe", "config.json"), `{
  "defaultModel": "deepseek-v4-flash",
  "ignore": ["project/**"]
}`)

	cfg, err := Load(LoadOptions{CWD: cwd, HomeDir: home})
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}

	if cfg.APIKey != "global-key" {
		t.Fatalf("expected global api key, got %q", cfg.APIKey)
	}
	if cfg.DefaultModel != ModelDeepSeekFlash {
		t.Fatalf("expected project model override, got %q", cfg.DefaultModel)
	}
	if len(cfg.Ignore) != 1 || cfg.Ignore[0] != "project/**" {
		t.Fatalf("expected project ignore replacement, got %#v", cfg.Ignore)
	}
	if cfg.ToolPermissions == nil || cfg.ToolPermissions.Command == nil {
		t.Fatal("expected global tool permissions to survive when project omits the field")
	}
}

func TestLoadRejectsUnknownKeys(t *testing.T) {
	cwd := t.TempDir()
	writeFile(t, filepath.Join(cwd, ".deepvibe", "config.json"), `{"unknown": true}`)

	_, err := Load(LoadOptions{CWD: cwd, HomeDir: t.TempDir()})
	var cfgErr *ConfigError
	if !errors.As(err, &cfgErr) {
		t.Fatalf("expected ConfigError, got %T %v", err, err)
	}
	if cfgErr.Code != "CONFIG_INVALID" {
		t.Fatalf("expected CONFIG_INVALID, got %q", cfgErr.Code)
	}
}

func TestSetValueWritesNormalizedKey(t *testing.T) {
	home := t.TempDir()
	cwd := t.TempDir()

	result, err := SetValue(SetValueOptions{
		CWD:     cwd,
		HomeDir: home,
		Key:     "default_model",
		Target:  TargetProject,
		Value:   "deepseek-v4-flash",
	})
	if err != nil {
		t.Fatalf("SetValue returned error: %v", err)
	}

	if result.Key != "defaultModel" {
		t.Fatalf("expected normalized key, got %q", result.Key)
	}

	cfg, err := Load(LoadOptions{CWD: cwd, HomeDir: home})
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.DefaultModel != ModelDeepSeekFlash {
		t.Fatalf("expected written model, got %q", cfg.DefaultModel)
	}
}

func writeFile(t *testing.T, path string, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(contents), 0644); err != nil {
		t.Fatal(err)
	}
}
