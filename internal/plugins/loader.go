package plugins

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const pluginsDir = ".deepvibe/plugins"
const manifestFile = "plugin.json"

type Kind string

const (
	KindJS   Kind = "js"
	KindWasm Kind = "wasm"
)

type Manifest struct {
	Enabled     *bool        `json:"enabled,omitempty"`
	Entry       string       `json:"entry"`
	Kind        Kind         `json:"kind,omitempty"`
	Name        string       `json:"name"`
	Permissions *Permissions `json:"permissions,omitempty"`
	Runtime     *Runtime     `json:"runtime,omitempty"`
	Version     string       `json:"version,omitempty"`
}

type Permissions struct {
	AllowInService *bool `json:"allowInService,omitempty"`
	RunCommands    *bool `json:"runCommands,omitempty"`
	WebSearch      *bool `json:"webSearch,omitempty"`
	WriteProject   *bool `json:"writeProject,omitempty"`
}

type Runtime struct {
	MaxResultChars *int `json:"maxResultChars,omitempty"`
	MemoryLimitMB  *int `json:"memoryLimitMb,omitempty"`
	TimeoutMS      *int `json:"timeoutMs,omitempty"`
}

type ManifestRecord struct {
	Dir          string
	EntryPath    string
	Manifest     Manifest
	ManifestPath string
}

type DiscoveryInfo struct {
	EnabledCount int `json:"enabledCount"`
	ErrorCount   int `json:"errorCount"`
}

type LoadError struct {
	Message string
}

func (e *LoadError) Error() string {
	return e.Message
}

func DiscoverManifests(rootDir string) ([]ManifestRecord, error) {
	root := filepath.Join(rootDir, filepath.FromSlash(pluginsDir))
	entries, err := os.ReadDir(root)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}

	sort.Slice(entries, func(i int, j int) bool {
		return entries[i].Name() < entries[j].Name()
	})
	records := []ManifestRecord{}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		pluginDir := filepath.Join(root, entry.Name())
		manifestPath := filepath.Join(pluginDir, manifestFile)
		if _, err := os.Stat(manifestPath); err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return nil, err
		}

		manifest, err := ReadManifest(manifestPath)
		if err != nil {
			return nil, err
		}
		if manifest.Enabled != nil && !*manifest.Enabled {
			continue
		}
		entryPath, err := ResolveEntry(pluginDir, manifest.Entry)
		if err != nil {
			return nil, err
		}
		records = append(records, ManifestRecord{
			Dir:          pluginDir,
			EntryPath:    entryPath,
			Manifest:     manifest,
			ManifestPath: manifestPath,
		})
	}
	return records, nil
}

func InspectDiscovery(rootDir string) DiscoveryInfo {
	root := filepath.Join(rootDir, filepath.FromSlash(pluginsDir))
	entries, err := os.ReadDir(root)
	if err != nil {
		return DiscoveryInfo{}
	}

	info := DiscoveryInfo{}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		pluginDir := filepath.Join(root, entry.Name())
		manifestPath := filepath.Join(pluginDir, manifestFile)
		if _, err := os.Stat(manifestPath); err != nil {
			continue
		}
		manifest, err := ReadManifest(manifestPath)
		if err != nil {
			info.ErrorCount++
			continue
		}
		if _, err := ResolveEntry(pluginDir, manifest.Entry); err != nil {
			info.ErrorCount++
			continue
		}
		if manifest.Enabled == nil || *manifest.Enabled {
			info.EnabledCount++
		}
	}
	return info
}

func ReadManifest(manifestPath string) (Manifest, error) {
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return Manifest{}, err
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return Manifest{}, loadError("Failed to parse plugin manifest %s.", manifestPath)
	}
	for key := range raw {
		if !allowedManifestKeys[key] {
			return Manifest{}, loadError("Unknown plugin manifest key in %s: %s.", manifestPath, key)
		}
	}

	manifest := Manifest{Kind: KindJS}
	if err := requiredString(raw, "name", manifestPath, &manifest.Name); err != nil {
		return Manifest{}, err
	}
	if err := requiredString(raw, "entry", manifestPath, &manifest.Entry); err != nil {
		return Manifest{}, err
	}
	if value, ok := raw["enabled"]; ok {
		enabled, err := optionalBool(value, manifestPath, "enabled")
		if err != nil {
			return Manifest{}, err
		}
		manifest.Enabled = &enabled
	}
	if value, ok := raw["version"]; ok {
		version, err := stringValue(value, manifestPath, "version", false)
		if err != nil {
			return Manifest{}, err
		}
		manifest.Version = version
	}
	if value, ok := raw["kind"]; ok {
		kind, err := stringValue(value, manifestPath, "kind", true)
		if err != nil {
			return Manifest{}, err
		}
		manifest.Kind = Kind(kind)
		if manifest.Kind != KindJS && manifest.Kind != KindWasm {
			return Manifest{}, loadError("Plugin manifest %s field \"kind\" must be \"js\" or \"wasm\".", manifestPath)
		}
	}
	if value, ok := raw["permissions"]; ok {
		permissions, err := readPermissions(value, manifestPath)
		if err != nil {
			return Manifest{}, err
		}
		manifest.Permissions = permissions
	}
	if value, ok := raw["runtime"]; ok {
		runtime, err := readRuntime(value, manifestPath)
		if err != nil {
			return Manifest{}, err
		}
		manifest.Runtime = runtime
	}
	return manifest, nil
}

func ResolveEntry(pluginDir string, entry string) (string, error) {
	if strings.TrimSpace(entry) == "" {
		return "", loadError("Plugin entry must not be empty.")
	}
	if filepath.IsAbs(entry) {
		return "", loadError("Plugin entry must be relative: %s.", entry)
	}
	pluginRoot, err := filepath.Abs(pluginDir)
	if err != nil {
		return "", err
	}
	pluginRoot, err = filepath.EvalSymlinks(pluginRoot)
	if err != nil {
		return "", err
	}
	entryPath := filepath.Join(pluginRoot, filepath.Clean(entry))
	if _, err := os.Stat(entryPath); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", loadError("Plugin entry does not exist: %s.", entryPath)
		}
		return "", err
	}
	entryPath, err = filepath.EvalSymlinks(entryPath)
	if err != nil {
		return "", err
	}

	normalizedRoot := normalizePath(pluginRoot)
	normalizedEntry := normalizePath(entryPath)
	if normalizedEntry != normalizedRoot && !strings.HasPrefix(normalizedEntry, normalizedRoot+string(filepath.Separator)) {
		return "", loadError("Plugin entry escapes plugin directory: %s.", entry)
	}
	return entryPath, nil
}

var allowedManifestKeys = map[string]bool{
	"enabled":     true,
	"entry":       true,
	"kind":        true,
	"name":        true,
	"permissions": true,
	"runtime":     true,
	"version":     true,
}

var allowedPermissionKeys = map[string]bool{
	"allowInService": true,
	"runCommands":    true,
	"webSearch":      true,
	"writeProject":   true,
}

var allowedRuntimeKeys = map[string]bool{
	"maxResultChars": true,
	"memoryLimitMb":  true,
	"timeoutMs":      true,
}

func requiredString(raw map[string]json.RawMessage, key string, manifestPath string, target *string) error {
	value, ok := raw[key]
	if !ok {
		return loadError("Plugin manifest %s requires a non-empty %q.", manifestPath, key)
	}
	text, err := stringValue(value, manifestPath, key, true)
	if err != nil {
		return err
	}
	*target = text
	return nil
}

func stringValue(value json.RawMessage, manifestPath string, key string, required bool) (string, error) {
	var text string
	if err := json.Unmarshal(value, &text); err != nil {
		return "", loadError("Plugin manifest %s field %q must be a string.", manifestPath, key)
	}
	text = strings.TrimSpace(text)
	if required && text == "" {
		return "", loadError("Plugin manifest %s requires a non-empty %q.", manifestPath, key)
	}
	return text, nil
}

func optionalBool(value json.RawMessage, manifestPath string, key string) (bool, error) {
	var result bool
	if err := json.Unmarshal(value, &result); err != nil {
		return false, loadError("Plugin manifest %s field %q must be boolean.", manifestPath, key)
	}
	return result, nil
}

func readPermissions(value json.RawMessage, manifestPath string) (*Permissions, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(value, &raw); err != nil {
		return nil, loadError("Plugin manifest %s field \"permissions\" must be an object.", manifestPath)
	}
	permissions := &Permissions{}
	for key, entry := range raw {
		if !allowedPermissionKeys[key] {
			return nil, loadError("Unknown plugin permission key in %s: %s.", manifestPath, key)
		}
		value, err := optionalBool(entry, manifestPath, "permissions."+key)
		if err != nil {
			return nil, err
		}
		switch key {
		case "allowInService":
			permissions.AllowInService = &value
		case "runCommands":
			permissions.RunCommands = &value
		case "webSearch":
			permissions.WebSearch = &value
		case "writeProject":
			permissions.WriteProject = &value
		}
	}
	return permissions, nil
}

func readRuntime(value json.RawMessage, manifestPath string) (*Runtime, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(value, &raw); err != nil {
		return nil, loadError("Plugin manifest %s field \"runtime\" must be an object.", manifestPath)
	}
	runtime := &Runtime{}
	for key, entry := range raw {
		if !allowedRuntimeKeys[key] {
			return nil, loadError("Unknown plugin runtime key in %s: %s.", manifestPath, key)
		}
		value, err := positiveInt(entry, manifestPath, "runtime."+key)
		if err != nil {
			return nil, err
		}
		switch key {
		case "maxResultChars":
			runtime.MaxResultChars = &value
		case "memoryLimitMb":
			runtime.MemoryLimitMB = &value
		case "timeoutMs":
			runtime.TimeoutMS = &value
		}
	}
	return runtime, nil
}

func positiveInt(value json.RawMessage, manifestPath string, key string) (int, error) {
	var number int
	if err := json.Unmarshal(value, &number); err != nil {
		return 0, loadError("Plugin manifest %s field %q must be a positive number.", manifestPath, key)
	}
	if number <= 0 {
		return 0, loadError("Plugin manifest %s field %q must be a positive number.", manifestPath, key)
	}
	return number, nil
}

func normalizePath(path string) string {
	return strings.ToLower(filepath.Clean(path))
}

func loadError(format string, args ...any) error {
	return &LoadError{Message: fmt.Sprintf(format, args...)}
}
