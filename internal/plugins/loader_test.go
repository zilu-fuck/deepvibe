package plugins

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDiscoverManifestsLoadsEnabledPlugins(t *testing.T) {
	root := t.TempDir()
	writePlugin(t, root, "alpha", `{
  "name": "alpha",
  "entry": "index.js",
  "permissions": {"runCommands": true, "writeProject": false},
  "runtime": {"timeoutMs": 1500, "memoryLimitMb": 128, "maxResultChars": 4096}
}`)
	writePlugin(t, root, "disabled", `{
  "name": "disabled",
  "entry": "index.js",
  "enabled": false
}`)

	records, err := DiscoverManifests(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 {
		t.Fatalf("expected 1 enabled plugin, got %#v", records)
	}
	record := records[0]
	if record.Manifest.Name != "alpha" || record.Manifest.Kind != KindJS {
		t.Fatalf("unexpected manifest: %#v", record.Manifest)
	}
	if record.Manifest.Permissions == nil ||
		record.Manifest.Permissions.RunCommands == nil ||
		!*record.Manifest.Permissions.RunCommands ||
		record.Manifest.Permissions.WriteProject == nil ||
		*record.Manifest.Permissions.WriteProject {
		t.Fatalf("unexpected permissions: %#v", record.Manifest.Permissions)
	}
	if record.Manifest.Runtime == nil ||
		record.Manifest.Runtime.TimeoutMS == nil ||
		*record.Manifest.Runtime.TimeoutMS != 1500 {
		t.Fatalf("unexpected runtime: %#v", record.Manifest.Runtime)
	}
	if !strings.HasSuffix(filepath.ToSlash(record.EntryPath), "/alpha/index.js") {
		t.Fatalf("unexpected entry path: %s", record.EntryPath)
	}
}

func TestInspectDiscoveryCountsValidEnabledAndErrors(t *testing.T) {
	root := t.TempDir()
	writePlugin(t, root, "alpha", `{"name":"alpha","entry":"index.js"}`)
	writePlugin(t, root, "bad", `{"name":"bad","entry":"index.js","runtime":{"timeoutMs":0}}`)
	writePlugin(t, root, "disabled", `{"name":"disabled","entry":"index.js","enabled":false}`)

	info := InspectDiscovery(root)
	if info.EnabledCount != 1 || info.ErrorCount != 1 {
		t.Fatalf("unexpected discovery info: %#v", info)
	}
}

func TestReadManifestRejectsUnknownKeys(t *testing.T) {
	root := t.TempDir()
	manifestPath := writePlugin(t, root, "bad", `{"name":"bad","entry":"index.js","surprise":true}`)

	_, err := ReadManifest(manifestPath)
	var loadErr *LoadError
	if !errors.As(err, &loadErr) {
		t.Fatalf("expected LoadError, got %v", err)
	}
	if !strings.Contains(loadErr.Error(), "Unknown plugin manifest key") {
		t.Fatalf("unexpected error: %v", loadErr)
	}
}

func TestResolveEntryRejectsEscapes(t *testing.T) {
	root := t.TempDir()
	pluginsRoot := filepath.Join(root, ".deepvibe", "plugins")
	pluginDir := filepath.Join(pluginsRoot, "escape")
	if err := os.MkdirAll(pluginDir, 0755); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(pluginsRoot, "outside.js")
	if err := os.WriteFile(outside, []byte("module.exports = {};"), 0644); err != nil {
		t.Fatal(err)
	}

	_, err := ResolveEntry(pluginDir, "../outside.js")
	var loadErr *LoadError
	if !errors.As(err, &loadErr) {
		t.Fatalf("expected LoadError, got %v", err)
	}
	if !strings.Contains(loadErr.Error(), "escapes plugin directory") {
		t.Fatalf("unexpected error: %v", loadErr)
	}
}

func TestDiscoverManifestsMissingDirectoryReturnsEmpty(t *testing.T) {
	records, err := DiscoverManifests(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 0 {
		t.Fatalf("expected no records, got %#v", records)
	}
}

func writePlugin(t *testing.T, root string, name string, manifest string) string {
	t.Helper()
	pluginDir := filepath.Join(root, ".deepvibe", "plugins", name)
	if err := os.MkdirAll(pluginDir, 0755); err != nil {
		t.Fatal(err)
	}
	entryPath := filepath.Join(pluginDir, "index.js")
	if err := os.WriteFile(entryPath, []byte("module.exports = {};"), 0644); err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(pluginDir, "plugin.json")
	if err := os.WriteFile(manifestPath, []byte(manifest), 0644); err != nil {
		t.Fatal(err)
	}
	return manifestPath
}
