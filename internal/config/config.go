package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

type ConfigError struct {
	Code    string
	Message string
}

func (e *ConfigError) Error() string {
	return e.Message
}

type rawConfig struct {
	APIKey          *string                 `json:"apiKey,omitempty"`
	BingAPIKey      *string                 `json:"bingApiKey,omitempty"`
	DefaultModel    *ModelID                `json:"defaultModel,omitempty"`
	Ignore          *[]string               `json:"ignore,omitempty"`
	SearchProvider  *SearchProviderID       `json:"searchProvider,omitempty"`
	TavilyAPIKey    *string                 `json:"tavilyApiKey,omitempty"`
	ToolPermissions *ToolPermissionsConfig  `json:"toolPermissions,omitempty"`
}

var knownConfigKeys = []string{
	"apiKey",
	"bingApiKey",
	"defaultModel",
	"ignore",
	"searchProvider",
	"tavilyApiKey",
	"toolPermissions",
}

func Load(options LoadOptions) (*Config, error) {
	paths, err := resolvePaths(options)
	if err != nil {
		return nil, err
	}

	cfg := &Config{
		GlobalConfigPath: paths.global,
	}

	global, _, err := readRawConfig(paths.global)
	if err != nil {
		return nil, err
	}
	applyRawConfig(cfg, global)

	project, exists, err := readRawConfig(paths.project)
	if err != nil {
		return nil, err
	}
	if exists {
		applyRawConfig(cfg, project)
		cfg.ProjectConfigPath = paths.project
	}

	return cfg, nil
}

func RequireAPIKey(cfg *Config) (string, error) {
	if cfg.APIKey == "" {
		projectPath := cfg.ProjectConfigPath
		if projectPath == "" {
			projectPath = "project .deepvibe/config.json"
		}
		return "", &ConfigError{
			Code: "API_KEY_MISSING",
			Message: fmt.Sprintf(
				"DeepSeek API key not found. Expected config at %s or %s.",
				cfg.GlobalConfigPath,
				projectPath,
			),
		}
	}
	return cfg.APIKey, nil
}

func LoadProjectPrompt(rootDir string) (string, error) {
	promptPath := filepath.Join(rootDir, ".deepvibe", "prompt.md")
	data, err := os.ReadFile(promptPath)
	if err != nil {
		return "", err
	}

	prompt := strings.TrimSpace(string(data))
	if prompt == "" {
		return "", nil
	}
	return prompt, nil
}

func SetValue(options SetValueOptions) (*SetValueResult, error) {
	paths, err := resolvePaths(LoadOptions{
		CWD:     options.CWD,
		HomeDir: options.HomeDir,
	})
	if err != nil {
		return nil, err
	}

	key, err := normalizeKey(options.Key)
	if err != nil {
		return nil, err
	}

	value, err := normalizeValue(key, options.Value)
	if err != nil {
		return nil, err
	}

	targetPath := paths.global
	if options.Target == TargetProject {
		targetPath = paths.project
	}

	current, err := readConfigMap(targetPath)
	if err != nil {
		return nil, err
	}
	current[key] = value

	if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
		return nil, err
	}

	data, err := json.MarshalIndent(current, "", "  ")
	if err != nil {
		return nil, err
	}
	data = append(data, '\n')

	if err := os.WriteFile(targetPath, data, 0644); err != nil {
		return nil, err
	}

	return &SetValueResult{
		ConfigPath: targetPath,
		Key:        key,
		Value:      value,
	}, nil
}

func readRawConfig(filePath string) (*rawConfig, bool, error) {
	data, err := os.ReadFile(filePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, false, nil
		}
		return nil, false, err
	}

	var keys map[string]json.RawMessage
	if err := json.Unmarshal(data, &keys); err != nil {
		return nil, true, invalidConfig(filePath, "failed to parse JSON config")
	}

	for key := range keys {
		if !slices.Contains(knownConfigKeys, key) {
			return nil, true, invalidConfig(filePath, fmt.Sprintf("unknown config key %q", key))
		}
	}

	var parsed rawConfig
	if err := json.Unmarshal(data, &parsed); err != nil {
		return nil, true, invalidConfig(filePath, "failed to decode config")
	}

	if err := validateRawConfig(filePath, &parsed); err != nil {
		return nil, true, err
	}

	return &parsed, true, nil
}

func readConfigMap(filePath string) (map[string]any, error) {
	data, err := os.ReadFile(filePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return map[string]any{}, nil
		}
		return nil, err
	}

	var result map[string]any
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, invalidConfig(filePath, "failed to parse JSON config")
	}

	for key := range result {
		if !slices.Contains(knownConfigKeys, key) {
			return nil, invalidConfig(filePath, fmt.Sprintf("unknown config key %q", key))
		}
	}

	return result, nil
}

func applyRawConfig(cfg *Config, raw *rawConfig) {
	if raw == nil {
		return
	}
	if raw.APIKey != nil {
		cfg.APIKey = *raw.APIKey
	}
	if raw.BingAPIKey != nil {
		cfg.BingAPIKey = *raw.BingAPIKey
	}
	if raw.DefaultModel != nil {
		cfg.DefaultModel = *raw.DefaultModel
	}
	if raw.Ignore != nil {
		cfg.Ignore = append([]string(nil), (*raw.Ignore)...)
	}
	if raw.SearchProvider != nil {
		cfg.SearchProvider = *raw.SearchProvider
	}
	if raw.TavilyAPIKey != nil {
		cfg.TavilyAPIKey = *raw.TavilyAPIKey
	}
	if raw.ToolPermissions != nil {
		cfg.ToolPermissions = raw.ToolPermissions
	}
}

func validateRawConfig(filePath string, cfg *rawConfig) error {
	if cfg.DefaultModel != nil && *cfg.DefaultModel != ModelDeepSeekPro && *cfg.DefaultModel != ModelDeepSeekFlash {
		return invalidConfig(filePath, fmt.Sprintf("unsupported defaultModel %q", *cfg.DefaultModel))
	}

	if cfg.SearchProvider != nil {
		switch *cfg.SearchProvider {
		case SearchProviderDuckDuckGo, SearchProviderTavily, SearchProviderBing:
		default:
			return invalidConfig(filePath, fmt.Sprintf("unsupported searchProvider %q", *cfg.SearchProvider))
		}
	}

	if cfg.Ignore != nil {
		for _, pattern := range *cfg.Ignore {
			if strings.TrimSpace(pattern) == "" {
				return invalidConfig(filePath, "ignore entries must be non-empty strings")
			}
		}
	}

	if cfg.ToolPermissions != nil && cfg.ToolPermissions.Command != nil {
		return validateCommandPermissions(filePath, cfg.ToolPermissions.Command)
	}

	return nil
}

func validateCommandPermissions(filePath string, cfg *CommandToolPermissionConfig) error {
	for _, prefix := range cfg.AllowedPrefixes {
		if strings.TrimSpace(prefix) == "" {
			return invalidConfig(filePath, "allowedPrefixes entries must be non-empty strings")
		}
	}

	if cfg.TimeoutMs != nil && *cfg.TimeoutMs <= 0 {
		return invalidConfig(filePath, "timeoutMs must be positive")
	}
	if cfg.MaxOutputChars != nil && *cfg.MaxOutputChars <= 0 {
		return invalidConfig(filePath, "maxOutputChars must be positive")
	}

	for _, policy := range cfg.CommandPolicies {
		if strings.TrimSpace(policy.Prefix) == "" {
			return invalidConfig(filePath, "commandPolicies entries require a non-empty prefix")
		}
		if policy.Risk != "" && policy.Risk != CommandRiskLow && policy.Risk != CommandRiskMedium && policy.Risk != CommandRiskHigh {
			return invalidConfig(filePath, fmt.Sprintf("unsupported command policy risk %q", policy.Risk))
		}
		if policy.TimeoutMs != nil && *policy.TimeoutMs <= 0 {
			return invalidConfig(filePath, "command policy timeoutMs must be positive")
		}
		if policy.MaxOutputChars != nil && *policy.MaxOutputChars <= 0 {
			return invalidConfig(filePath, "command policy maxOutputChars must be positive")
		}
		for _, directory := range policy.AllowedDirectories {
			if strings.TrimSpace(directory) == "" {
				return invalidConfig(filePath, "allowedDirectories entries must be non-empty strings")
			}
		}
	}

	if cfg.Sandbox != nil {
		if strings.TrimSpace(cfg.Sandbox.Image) == "" {
			return invalidConfig(filePath, "sandbox.image must be a non-empty string")
		}
		if cfg.Sandbox.Network != "" && cfg.Sandbox.Network != "bridge" && cfg.Sandbox.Network != "none" {
			return invalidConfig(filePath, "sandbox.network must be bridge or none")
		}
	}

	return nil
}

func normalizeKey(key string) (string, error) {
	switch strings.TrimSpace(key) {
	case "api_key", "apiKey":
		return "apiKey", nil
	case "default_model", "defaultModel":
		return "defaultModel", nil
	case "search_provider", "searchProvider":
		return "searchProvider", nil
	case "tavily_api_key", "tavilyApiKey":
		return "tavilyApiKey", nil
	case "bing_api_key", "bingApiKey":
		return "bingApiKey", nil
	default:
		return "", &ConfigError{
			Code: "CONFIG_INVALID",
			Message: fmt.Sprintf(
				"Unsupported config key %q. Supported keys: api_key, apiKey, default_model, defaultModel, search_provider, searchProvider, tavily_api_key, tavilyApiKey, bing_api_key, bingApiKey.",
				key,
			),
		}
	}
}

func normalizeValue(key string, value string) (string, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", &ConfigError{Code: "CONFIG_INVALID", Message: fmt.Sprintf("Config value for %q must not be empty.", key)}
	}

	if key == "defaultModel" && trimmed != string(ModelDeepSeekPro) && trimmed != string(ModelDeepSeekFlash) {
		return "", &ConfigError{Code: "CONFIG_INVALID", Message: fmt.Sprintf("Unsupported default model %q.", trimmed)}
	}

	if key == "searchProvider" && trimmed != string(SearchProviderDuckDuckGo) && trimmed != string(SearchProviderTavily) && trimmed != string(SearchProviderBing) {
		return "", &ConfigError{Code: "CONFIG_INVALID", Message: fmt.Sprintf("Unsupported search provider %q.", trimmed)}
	}

	return trimmed, nil
}

type resolvedPaths struct {
	global  string
	project string
}

func resolvePaths(options LoadOptions) (*resolvedPaths, error) {
	cwd := options.CWD
	if cwd == "" {
		var err error
		cwd, err = os.Getwd()
		if err != nil {
			return nil, err
		}
	}

	absCWD, err := filepath.Abs(cwd)
	if err != nil {
		return nil, err
	}

	home := options.HomeDir
	if home == "" {
		home, err = os.UserHomeDir()
		if err != nil || home == "" {
			home = absCWD
		}
	}

	return &resolvedPaths{
		global:  filepath.Join(home, ".deepvibe", "config.json"),
		project: filepath.Join(absCWD, ".deepvibe", "config.json"),
	}, nil
}

func invalidConfig(filePath string, message string) error {
	return &ConfigError{
		Code:    "CONFIG_INVALID",
		Message: fmt.Sprintf("%s in %s.", message, filePath),
	}
}
