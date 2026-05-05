package config

type ModelID string

const (
	ModelDeepSeekPro   ModelID = "deepseek-v4-pro"
	ModelDeepSeekFlash ModelID = "deepseek-v4-flash"
)

type SearchProviderID string

const (
	SearchProviderDuckDuckGo SearchProviderID = "duckduckgo"
	SearchProviderTavily     SearchProviderID = "tavily"
	SearchProviderBing       SearchProviderID = "bing"
)

type CommandRiskLevel string

const (
	CommandRiskLow    CommandRiskLevel = "low"
	CommandRiskMedium CommandRiskLevel = "medium"
	CommandRiskHigh   CommandRiskLevel = "high"
)

type ConfigTarget string

const (
	TargetGlobal  ConfigTarget = "global"
	TargetProject ConfigTarget = "project"
)

type CommandPolicyEntry struct {
	AllowInService           *bool            `json:"allowInService,omitempty"`
	AllowPersistentApproval  *bool            `json:"allowPersistentApproval,omitempty"`
	AllowedDirectories       []string         `json:"allowedDirectories,omitempty"`
	MaxOutputChars           *int             `json:"maxOutputChars,omitempty"`
	Prefix                   string           `json:"prefix"`
	RequireCleanGit          *bool            `json:"requireCleanGit,omitempty"`
	Risk                     CommandRiskLevel `json:"risk,omitempty"`
	TimeoutMs                *int             `json:"timeoutMs,omitempty"`
}

type DockerSandboxConfig struct {
	Enabled                *bool    `json:"enabled,omitempty"`
	Image                  string   `json:"image"`
	MountPath              string   `json:"mountPath,omitempty"`
	Network                string   `json:"network,omitempty"`
	ReadOnlyRootFilesystem *bool    `json:"readOnlyRootFilesystem,omitempty"`
	TmpfsPaths             []string `json:"tmpfsPaths,omitempty"`
}

type CommandToolPermissionConfig struct {
	AllowedPrefixes []string               `json:"allowedPrefixes,omitempty"`
	CommandPolicies []CommandPolicyEntry   `json:"commandPolicies,omitempty"`
	Enabled         *bool                  `json:"enabled,omitempty"`
	MaxOutputChars  *int                   `json:"maxOutputChars,omitempty"`
	PersistApprovals *bool                 `json:"persistApprovals,omitempty"`
	RequireApproval *bool                  `json:"requireApproval,omitempty"`
	Sandbox         *DockerSandboxConfig   `json:"sandbox,omitempty"`
	TimeoutMs       *int                   `json:"timeoutMs,omitempty"`
}

type ToolPermissionsConfig struct {
	Command *CommandToolPermissionConfig `json:"command,omitempty"`
}

type Config struct {
	APIKey            string                 `json:"apiKey,omitempty"`
	BingAPIKey        string                 `json:"bingApiKey,omitempty"`
	DefaultModel      ModelID                `json:"defaultModel,omitempty"`
	GlobalConfigPath  string                 `json:"globalConfigPath"`
	Ignore            []string               `json:"ignore,omitempty"`
	ProjectConfigPath string                 `json:"projectConfigPath,omitempty"`
	SearchProvider    SearchProviderID       `json:"searchProvider,omitempty"`
	TavilyAPIKey      string                 `json:"tavilyApiKey,omitempty"`
	ToolPermissions   *ToolPermissionsConfig `json:"toolPermissions,omitempty"`
}

type LoadOptions struct {
	CWD     string
	HomeDir string
}

type SetValueOptions struct {
	CWD     string
	HomeDir string
	Key     string
	Target  ConfigTarget
	Value   string
}

type SetValueResult struct {
	ConfigPath string
	Key        string
	Value      string
}
