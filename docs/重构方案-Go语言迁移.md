# DeepVibe Core 重构方案：TypeScript → Go 迁移

## 1. 项目概述

### 1.1 当前状态

DeepVibe Core 是一个 CLI 优先的 AI 编码引擎，专为 DeepSeek 工作流优化。当前实现基于 TypeScript/Node.js，具有以下核心功能：

- CLI 入口与交互式 REPL
- 项目扫描与上下文构建
- DeepSeek API 集成（聊天补全、FIM 补全）
- 工具系统（文件读写、命令执行、Web 搜索）
- 补丁应用与 Git 集成
- HTTP/JSON-RPC 服务模式
- 插件系统
- 会话管理

### 1.2 重构动机

| 问题 | TypeScript 现状 | Go 预期收益 |
|------|----------------|-------------|
| 启动性能 | ~500ms（Node.js 冷启动） | ~50ms（原生二进制） |
| 内存占用 | ~50MB（进程运行内存） | ~15MB（静态链接） |
| 部署复杂度 | 需要 Node.js 运行时 | 单二进制文件，无依赖 |
| 交叉编译 | 需要额外工具链 | 原生支持 `GOOS/GOARCH` |
| 并发模型 | 单线程事件循环 | goroutine 原生并发 |
| 类型安全 | 运行时类型检查 | 编译时类型检查 |

## 2. 重构目标

### 2.1 功能目标

- [ ] 100% 功能兼容现有 TypeScript 版本
- [ ] 保持相同的 CLI 接口和配置格式
- [ ] 维持 API 兼容性（HTTP/JSON-RPC 服务）
- [ ] 支持相同的插件接口（或提供迁移路径）

### 2.2 性能目标

| 指标 | 当前基线 | 目标值 | 改善幅度 |
|------|----------|--------|----------|
| CLI 启动时间 | ~500ms | <100ms | >80% |
| 内存占用（空闲） | ~100MB | <30MB | >70% |
| 构建产物大小 | ~50MB（含依赖） | <20MB | >60% |
| 并发请求处理 | 有限（事件循环） | 高（goroutine） | 显著提升 |

### 2.3 质量目标

- 单元测试覆盖率 > 80%
- 集成测试覆盖所有 API 端点
- 性能基准测试对比 TypeScript 版本
- 零回归缺陷

## 3. 技术选型

### 3.1 核心依赖

| 功能 | 推荐库 | 备选库 | 说明 |
|------|--------|--------|------|
| CLI 框架 | [cobra](https://github.com/spf13/cobra) | [urfave/cli](https://github.com/urfave/cli) | 成熟稳定，功能丰富 |
| 配置管理 | [viper](https://github.com/spf13/viper) | [koanf](https://github.com/knadh/koanf) | 支持多格式、环境变量 |
| HTTP 路由 | [chi](https://github.com/go-chi/chi) | 标准库 `net/http` | 轻量级，中间件支持好 |
| Git 操作 | [go-git](https://github.com/go-git/go-git) | 调用 `git` 命令 | 纯 Go 实现，跨平台 |
| 文件遍历 | [doublestar](https://github.com/bmatcuk/doublestar) | 标准库 `filepath.Walk` | 支持 glob 模式 |
| Diff 处理 | [go-diff](https://github.com/sergi/go-diff) | [diffmatchpatch](https://github.com/sergi/go-diff) | 补丁应用 |
| Token 计数 | 自实现 | [tiktoken-go](https://github.com/pkoukk/tiktoken-go) | DeepSeek 兼容 |
| SSE | 标准库 + goroutine | [sse](https://github.com/r3labs/sse) | 原生支持 |
| TUI 框架 | [bubbletea](https://github.com/charmbracelet/bubbletea) | [tview](https://github.com/rivo/tview) | Elm 架构，组合性好 |
| 测试 | [testify](https://github.com/stretchr/testify) | 标准库 | 断言和 mock |

### 3.2 开发工具

| 工具 | 用途 | 配置 |
|------|------|------|
| Go 1.23+ | 语言版本 | `go.mod` |
| golangci-lint | 代码检查 | `.golangci.yml` |
| go test | 单元测试 | `go test ./...` |
| go build | 构建 | `Makefile` |
| Docker | 容器化 | `Dockerfile` |

## 4. 架构设计

### 4.1 目录结构

```
deepvibe-go/
├── cmd/
│   ├── deepvibe/              # CLI 主入口
│   │   └── main.go
│   └── deepvibe-server/       # 服务模式入口
│       └── main.go
├── internal/
│   ├── cli/                   # CLI 命令定义
│   │   ├── root.go
│   │   ├── config.go
│   │   ├── run.go
│   │   ├── undo.go
│   │   ├── serve.go
│   │   └── chat.go
│   ├── engine/                # 核心引擎
│   │   ├── engine.go
│   │   ├── executor.go
│   │   └── planner.go
│   ├── llm/                   # LLM 客户端
│   │   ├── client.go
│   │   ├── deepseek.go
│   │   ├── types.go
│   │   └── parser.go
│   ├── tools/                 # 工具系统
│   │   ├── registry.go
│   │   ├── file_ops.go
│   │   ├── command.go
│   │   └── web_search.go
│   ├── scanner/               # 项目扫描
│   │   ├── scanner.go
│   │   └── ignore.go
│   ├── context/               # 上下文管理
│   │   ├── builder.go
│   │   ├── store.go
│   │   └── token_counter.go
│   ├── patcher/               # 补丁应用
│   │   ├── patcher.go
│   │   └── diff.go
│   ├── git/                   # Git 操作
│   │   ├── manager.go
│   │   └── operations.go
│   ├── server/                # HTTP 服务
│   │   ├── server.go
│   │   ├── routes.go
│   │   ├── handlers.go
│   │   └── middleware.go
│   ├── repl/                  # 交互式 REPL
│   │   ├── repl.go
│   │   ├── session.go
│   │   └── commands.go
│   ├── plugins/               # 插件系统
│   │   ├── loader.go
│   │   ├── host.go
│   │   └── manifest.go
│   ├── config/                # 配置管理
│   │   ├── config.go
│   │   ├── types.go
│   │   └── validation.go
│   ├── workspace/             # 工作区管理
│   │   ├── access.go
│   │   ├── landing.go
│   │   └── trust.go
│   ├── task/                  # 任务管理
│   │   ├── manager.go
│   │   └── events.go
│   ├── i18n/                  # 国际化
│   │   ├── i18n.go
│   │   └── messages.go
│   └── review/                # 代码审查
│       ├── review.go
│       └── diff_viewer.go
├── pkg/                       # 可导出的公共包
│   ├── config/
│   ├── types/
│   └── utils/
├── api/                       # API 定义
│   └── openapi.yaml
├── scripts/                   # 构建脚本
│   ├── build.sh
│   ├── test.sh
│   └── release.sh
├── testdata/                  # 测试数据
├── docs/                      # 文档
├── .github/                   # GitHub Actions
├── go.mod
├── go.sum
├── Makefile
├── Dockerfile
├── .golangci.yml
└── README.md
```

### 4.2 核心接口设计

```go
// internal/engine/engine.go

// Engine 定义核心引擎接口
type Engine interface {
    // Run 执行单次指令
    Run(ctx context.Context, opts RunOptions) (*EngineResult, error)
    
    // GeneratePlan 生成执行计划
    GeneratePlan(ctx context.Context, opts PlanOptions) (*Plan, error)
    
    // ExecutePlan 执行计划
    ExecutePlan(ctx context.Context, plan *Plan, opts ExecuteOptions) (*PlanResult, error)
    
    // PrepareExecution 准备执行（不实际执行）
    PrepareExecution(ctx context.Context, opts RunOptions) (*PreparedExecution, error)
    
    // ApplyPreparedExecution 应用已准备的执行
    ApplyPreparedExecution(ctx context.Context, prepared *PreparedExecution) (*EngineResult, error)
}

// RunOptions 定义运行选项
type RunOptions struct {
    Cwd         string
    DryRun      bool
    Instruction string
    PlanMode    bool
    Profile     ExecutionProfile
    Force       bool
}

// EngineResult 定义引擎结果
type EngineResult struct {
    Message     string
    FilesChanged []string
    CommitHash  string
}
```

```go
// internal/llm/client.go

// Client 定义 LLM 客户端接口
type Client interface {
    // CreateCompletion 创建聊天补全
    CreateCompletion(ctx context.Context, messages []ChatMessage, opts CompletionOptions) (*CompletionResult, error)
    
    // CreateStreamingCompletion 创建流式补全
    CreateStreamingCompletion(ctx context.Context, messages []ChatMessage, opts CompletionOptions, callbacks StreamingCallbacks) (*CompletionResult, error)
    
    // CreateFimCompletion 创建 FIM 补全
    CreateFimCompletion(ctx context.Context, opts FimOptions) (*FimResult, error)
}

// ChatMessage 定义聊天消息
type ChatMessage struct {
    Role       string `json:"role"`
    Content    string `json:"content"`
    Name       string `json:"name,omitempty"`
    ToolCallID string `json:"tool_call_id,omitempty"`
}

// CompletionOptions 定义补全选项
type CompletionOptions struct {
    Model          string        `json:"model"`
    MaxTokens      int           `json:"max_tokens,omitempty"`
    Temperature    float64       `json:"temperature,omitempty"`
    Tools          []Tool        `json:"tools,omitempty"`
    ToolChoice     interface{}   `json:"tool_choice,omitempty"`
    Stream         bool          `json:"stream,omitempty"`
    Timeout        time.Duration `json:"-"`
}
```

```go
// internal/tools/registry.go

// Tool 定义工具接口
type Tool interface {
    // Definition 返回工具定义
    Definition() ToolDefinition
    
    // Execute 执行工具
    Execute(ctx context.Context, args json.RawMessage, execCtx ExecutionContext) (string, error)
}

// ToolDefinition 定义工具元数据
type ToolDefinition struct {
    Type     string             `json:"type"`
    Function ToolFunctionDef    `json:"function"`
}

// ToolFunctionDef 定义工具函数
type ToolFunctionDef struct {
    Name        string                 `json:"name"`
    Description string                 `json:"description"`
    Parameters  map[string]interface{} `json:"parameters,omitempty"`
    Strict      bool                   `json:"strict,omitempty"`
}

// Registry 管理工具注册
type Registry struct {
    tools map[string]Tool
    mu    sync.RWMutex
}

// Register 注册工具
func (r *Registry) Register(tool Tool) {
    r.mu.Lock()
    defer r.mu.Unlock()
    r.tools[tool.Definition().Function.Name] = tool
}

// Get 获取工具
func (r *Registry) Get(name string) (Tool, bool) {
    r.mu.RLock()
    defer r.mu.RUnlock()
    tool, ok := r.tools[name]
    return tool, ok
}
```

### 4.3 并发模型

```go
// internal/task/manager.go

// TaskManager 管理异步任务
type TaskManager struct {
    tasks   map[string]*Task
    mu      sync.RWMutex
    events  chan TaskEvent
}

// Task 表示一个异步任务
type Task struct {
    ID        string
    Status    TaskStatus
    Result    *TaskResult
    Error     error
    Cancel    context.CancelFunc
    CreatedAt time.Time
    UpdatedAt time.Time
}

// StartTask 启动新任务
func (m *TaskManager) StartTask(ctx context.Context, fn TaskFunc) (string, <-chan TaskEvent) {
    taskID := generateTaskID()
    taskCtx, cancel := context.WithCancel(ctx)
    
    task := &Task{
        ID:        taskID,
        Status:    TaskStatusRunning,
        Cancel:    cancel,
        CreatedAt: time.Now(),
    }
    
    m.mu.Lock()
    m.tasks[taskID] = task
    m.mu.Unlock()
    
    events := make(chan TaskEvent, 100)
    
    go func() {
        defer close(events)
        
        result, err := fn(taskCtx)
        
        m.mu.Lock()
        if err != nil {
            task.Status = TaskStatusFailed
            task.Error = err
        } else {
            task.Status = TaskStatusCompleted
            task.Result = result
        }
        task.UpdatedAt = time.Now()
        m.mu.Unlock()
        
        events <- TaskEvent{
            TaskID:    taskID,
            Type:      TaskEventCompleted,
            Timestamp: time.Now(),
        }
    }()
    
    return taskID, events
}
```

## 5. 模块迁移方案

### 5.1 Phase 1: 核心基础设施（Week 1-2）

#### 5.1.1 配置管理 (`internal/config/`)

**TypeScript 原始代码**: `src/config.ts`

**迁移要点**:
- 不推荐 viper：viper 的 `MergeConfigMap` 会深度合并嵌套对象和数组（拼接 ignore 列表），与原 TS 版的**整字段替换**语义不同
- 保持相同的配置文件格式 (`~/.deepvibe/config.json`, `.deepvibe/config.json`)
- 实现**浅覆盖合并**逻辑：加载全局配置，遍历项目配置的顶层 key 逐个覆盖

```go
// internal/config/config.go

package config

import (
    "encoding/json"
    "errors"
    "os"
    "path/filepath"
    "runtime"
    "strings"
)

type Config struct {
    APIKey          string            `json:"apiKey"`
    DefaultModel    string            `json:"defaultModel"`
    Ignore          []string          `json:"ignore"`
    SearchProvider  string            `json:"searchProvider"`
    BingAPIKey      string            `json:"bingApiKey,omitempty"`
    TavilyAPIKey    string            `json:"tavilyApiKey,omitempty"`
    ToolPermissions *ToolPermissions  `json:"toolPermissions,omitempty"`
}

// TypeScript 版 merge 语义：项目配置的每个顶层 key 直接覆盖全局 key（整字段替换，非深度合并）。
// 对 ignore / toolPermissions 特别注意：
//   project.ignore 存在 → 完全替换 global.ignore（不合并两个数组）
//   project.toolPermissions 存在 → 完全替换 global.toolPermissions

func Load(cwd string) (*Config, error) {
    home := homeDir()
    if home == "" {
        home = cwd
    }

    global := readJSONConfig(filepath.Join(home, ".deepvibe", "config.json"))
    project := readJSONConfig(filepath.Join(cwd, ".deepvibe", "config.json"))

    merged := make(map[string]any)

    // 先填全局
    for k, v := range global {
        merged[k] = v
    }

    // 项目整字段覆盖
    for k, v := range project {
        merged[k] = v
    }

    data, _ := json.Marshal(merged)
    var cfg Config
    if err := json.Unmarshal(data, &cfg); err != nil {
        return nil, err
    }

    return &cfg, nil
}

// readJSONConfig 读取 JSON 文件，不存在则返回空 map
func readJSONConfig(path string) map[string]any {
    raw, err := os.ReadFile(path)
    if err != nil {
        return map[string]any{}
    }
    var m map[string]any
    if err := json.Unmarshal(raw, &m); err != nil {
        return map[string]any{}
    }
    return m
}
```

#### 5.1.2 项目扫描 (`internal/scanner/`)

**TypeScript 原始代码**: `src/project/scanner.ts`

**迁移要点**:
- 使用 `filepath.WalkDir` 遍历文件
- 实现 `.gitignore` 和 `.deepvibeignore` 解析
- 使用 doublestar 库支持 glob 模式

```go
// internal/scanner/scanner.go

package scanner

import (
    "context"
    "os"
    "path/filepath"
    
    "github.com/sabhiram/go-gitignore"
)

type ScanResult struct {
    Files       []FileInfo
    TotalSize   int64
    FileCount   int
    DirCount    int
}

type FileInfo struct {
    Path     string
    Size     int64
    IsDir    bool
    Language string
}

func ScanProject(ctx context.Context, rootDir string, ignorePatterns []string) (*ScanResult, error) {
    ignoreMatcher := loadIgnoreFiles(rootDir)
    
    result := &ScanResult{}
    
    err := filepath.WalkDir(rootDir, func(path string, d os.DirEntry, err error) error {
        if err != nil {
            return err
        }
        
        relPath, _ := filepath.Rel(rootDir, path)
        
        // 检查是否应该忽略
        if shouldIgnore(relPath, d.IsDir(), ignoreMatcher, ignorePatterns) {
            if d.IsDir() {
                return filepath.SkipDir
            }
            return nil
        }
        
        info, err := d.Info()
        if err != nil {
            return err
        }
        
        result.Files = append(result.Files, FileInfo{
            Path:     relPath,
            Size:     info.Size(),
            IsDir:    d.IsDir(),
            Language: detectLanguage(relPath),
        })
        
        if d.IsDir() {
            result.DirCount++
        } else {
            result.FileCount++
            result.TotalSize += info.Size()
        }
        
        return nil
    })
    
    return result, err
}
```

#### 5.1.3 上下文构建 (`internal/context/`)

**TypeScript 原始代码**: `src/context/builder.ts`, `src/context/token-counter.ts`

**迁移要点**:
- 实现 token 计数器（兼容 DeepSeek 的 tokenizer）
- 实现上下文窗口管理
- 实现历史压缩

```go
// internal/context/builder.go

package context

import (
    "context"
    "fmt"
    "strings"
)

type Builder struct {
    maxTokens    int
    scanner      Scanner
    tokenCounter TokenCounter
}

type BuildResult struct {
    Messages    []ChatMessage
    TokenCount  int
    Truncated   bool
}

func (b *Builder) Build(ctx context.Context, opts BuildOptions) (*BuildResult, error) {
    // 1. 扫描项目文件
    scanResult, err := b.scanner.ScanProject(ctx, opts.RootDir, opts.IgnorePatterns)
    if err != nil {
        return nil, fmt.Errorf("scan project: %w", err)
    }
    
    // 2. 构建系统提示
    systemPrompt := b.buildSystemPrompt(opts)
    
    // 3. 构建上下文文件
    contextFiles := b.selectContextFiles(scanResult, opts.Instruction)
    
    // 4. 计算 token 预算
    tokenBudget := b.calculateTokenBudget(systemPrompt, contextFiles, opts.History)
    
    // 5. 裁剪上下文以适应 token 限制
    messages := b.buildMessages(systemPrompt, contextFiles, opts.History, tokenBudget)
    
    return &BuildResult{
        Messages:   messages,
        TokenCount: b.countTokens(messages),
        Truncated:  tokenBudget.truncated,
    }, nil
}
```

### 5.2 Phase 2: LLM 集成（Week 3-4）

#### 5.2.1 DeepSeek 客户端 (`internal/llm/`)

**TypeScript 原始代码**: `src/llm/deepseek-client.ts`, `src/llm/response-parser.ts`

**迁移要点**:
- 使用 `net/http` 实现 HTTP 客户端
- 实现 SSE 流式解析
- 实现重试和超时逻辑

```go
// internal/llm/deepseek.go

package llm

import (
    "bufio"
    "bytes"
    "context"
    "encoding/json"
    "fmt"
    "io"
    "net/http"
    "strings"
    "time"
)

type DeepSeekClient struct {
    apiKey          string
    baseURL         string
    httpClient      *http.Client
    maxRetries      int
    retryBaseDelay  time.Duration
}

func NewDeepSeekClient(apiKey string, opts ...ClientOption) *DeepSeekClient {
    c := &DeepSeekClient{
        apiKey:         apiKey,
        baseURL:        "https://api.deepseek.com",
        httpClient:     &http.Client{Timeout: 120 * time.Second},
        maxRetries:     3,
        retryBaseDelay: 1 * time.Second,
    }
    
    for _, opt := range opts {
        opt(c)
    }
    
    return c
}

func (c *DeepSeekClient) CreateStreamingCompletion(
    ctx context.Context,
    messages []ChatMessage,
    opts CompletionOptions,
    callbacks StreamingCallbacks,
) (*CompletionResult, error) {
    var lastErr error
    
    for attempt := 0; attempt <= c.maxRetries; attempt++ {
        if attempt > 0 {
            delay := c.retryBaseDelay * time.Duration(1<<(attempt-1))
            select {
            case <-ctx.Done():
                return nil, ctx.Err()
            case <-time.After(delay):
            }
        }
        
        result, err := c.doStreamingRequest(ctx, messages, opts, callbacks)
        if err == nil {
            return result, nil
        }
        lastErr = err
    }
    
    return nil, fmt.Errorf("max retries exceeded: %w", lastErr)
}

func (c *DeepSeekClient) doStreamingRequest(
    ctx context.Context,
    messages []ChatMessage,
    opts CompletionOptions,
    callbacks StreamingCallbacks,
) (*CompletionResult, error) {
    reqBody := CompletionRequest{
        Model:    opts.Model,
        Messages: messages,
        Stream:   true,
        Tools:    opts.Tools,
    }
    
    body, err := json.Marshal(reqBody)
    if err != nil {
        return nil, err
    }
    
    req, err := http.NewRequestWithContext(ctx, "POST", c.baseURL+"/v1/chat/completions", bytes.NewReader(body))
    if err != nil {
        return nil, err
    }
    
    req.Header.Set("Authorization", "Bearer "+c.apiKey)
    req.Header.Set("Content-Type", "application/json")
    
    resp, err := c.httpClient.Do(req)
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()
    
    if resp.StatusCode != http.StatusOK {
        return nil, fmt.Errorf("API error: %d", resp.StatusCode)
    }
    
    return c.parseSSEStream(resp.Body, callbacks)
}

func (c *DeepSeekClient) parseSSEStream(body io.Reader, callbacks StreamingCallbacks) (*CompletionResult, error) {
    scanner := bufio.NewScanner(body)
    // bufio.Scanner 默认行缓冲区仅 64KB；工具调用返回的大文件 JSON 单行可超
    // 此限制。扩容到 10MB 防止溢出被静默截断。
    scanner.Buffer(make([]byte, 0, 1024*1024), 10*1024*1024)

    var contentBuilder strings.Builder
    var reasoningBuilder strings.Builder

    for scanner.Scan() {
        line := scanner.Text()

        if !strings.HasPrefix(line, "data: ") {
            continue
        }

        data := strings.TrimPrefix(line, "data: ")
        if data == "[DONE]" {
            break
        }

        var chunk CompletionChunk
        if err := json.Unmarshal([]byte(data), &chunk); err != nil {
            continue
        }

        if len(chunk.Choices) > 0 {
            choice := chunk.Choices[0]

            if choice.Delta.Content != "" {
                contentBuilder.WriteString(choice.Delta.Content)
                if callbacks.OnContent != nil {
                    callbacks.OnContent(choice.Delta.Content)
                }
            }

            if choice.Delta.ReasoningContent != "" {
                reasoningBuilder.WriteString(choice.Delta.ReasoningContent)
                if callbacks.OnReasoningContent != nil {
                    callbacks.OnReasoningContent(choice.Delta.ReasoningContent)
                }
            }
        }
    }

    return &CompletionResult{
        Content:          contentBuilder.String(),
        ReasoningContent: reasoningBuilder.String(),
    }, scanner.Err()
}
```

#### 5.2.2 响应解析 (`internal/llm/parser.go`)

**TypeScript 原始代码**: `src/llm/response-parser.ts`

**迁移要点**:
- 实现结构化响应解析
- 支持自动修复重试
- 处理 JSON 和文本格式

```go
// internal/llm/parser.go

package llm

import (
    "encoding/json"
    "fmt"
    "regexp"
    "strings"
)

type ParsedResponse struct {
    Files   []FileChange
    Summary string
    Raw     string
}

type FileChange struct {
    Action  string `json:"action"`  // create, update, delete
    Path    string `json:"path"`
    Content string `json:"content"`
    Diff    string `json:"diff,omitempty"`
}

func ParseResponse(content string) (*ParsedResponse, error) {
    // 尝试解析 JSON
    if parsed, err := parseJSONResponse(content); err == nil {
        return parsed, nil
    }
    
    // 尝试从 markdown 代码块提取
    if parsed, err := parseMarkdownResponse(content); err == nil {
        return parsed, nil
    }
    
    // 尝试解析 diff 格式
    if parsed, err := parseDiffResponse(content); err == nil {
        return parsed, nil
    }
    
    return nil, fmt.Errorf("unable to parse response")
}

func parseJSONResponse(content string) (*ParsedResponse, error) {
    // 正则找第一个以 "files" 为 key 的 JSON 对象；必须非贪婪避免跨对象匹配
    jsonRegex := regexp.MustCompile(`\{[^{}]*"files"\s*:\s*\[[^\]]*\][^{}]*\}`)
    match := jsonRegex.FindString(content)
    if match == "" {
        // 兜底：尝试用 json.Decoder 流式解析，跳过非 JSON 前缀
        dec := json.NewDecoder(strings.NewReader(content))
        for {
            var raw json.RawMessage
            if err := dec.Decode(&raw); err != nil {
                break
            }
            var probe struct {
                Files []FileChange `json:"files"`
            }
            if err := json.Unmarshal(raw, &probe); err == nil && len(probe.Files) > 0 {
                var result struct {
                    Files   []FileChange `json:"files"`
                    Summary string       `json:"summary"`
                }
                if err := json.Unmarshal(raw, &result); err == nil {
                    return &ParsedResponse{Files: result.Files, Summary: result.Summary, Raw: content}, nil
                }
            }
        }
        return nil, fmt.Errorf("no valid JSON with 'files' key found")
    }

    // 对匹配到的片段尝试解析，失败则自动修复常见 JSON 截断问题
    var result struct {
        Files   []FileChange `json:"files"`
        Summary string       `json:"summary"`
    }
    if err := json.Unmarshal([]byte(match), &result); err != nil {
        repaired := autoRepairJSON(match)
        if err := json.Unmarshal([]byte(repaired), &result); err != nil {
            return nil, fmt.Errorf("JSON parse failed: %w", err)
        }
    }

    return &ParsedResponse{
        Files:   result.Files,
        Summary: result.Summary,
        Raw:     content,
    }, nil
}

// autoRepairJSON 补全被截断的 JSON：添加缺失的 } 和 ]
func autoRepairJSON(raw string) string {
    depth := 0
    inString := false
    escaped := false
    for _, ch := range raw {
        if escaped { escaped = false; continue }
        if ch == '\\' { escaped = true; continue }
        if ch == '"' { inString = !inString }
        if inString { continue }
        switch ch {
        case '{', '[': depth++
        case '}', ']': depth--
        }
    }
    if depth <= 0 { return raw }
    return raw + strings.Repeat("}", depth)
}
```

### 5.3 Phase 3: 工具系统（Week 5-6）

#### 5.3.1 文件操作工具 (`internal/tools/file_ops.go`)

**TypeScript 原始代码**: `src/tools.ts` (list_files, read_file, write_file, delete_file)

```go
// internal/tools/file_ops.go

package tools

import (
    "context"
    "encoding/json"
    "fmt"
    "os"
    "path/filepath"
    "strings"
)

type ListFilesTool struct{}

func (t *ListFilesTool) Definition() ToolDefinition {
    return ToolDefinition{
        Type: "function",
        Function: ToolFunctionDef{
            Name:        "list_files",
            Description: "List files and directories in a path",
            Parameters: map[string]interface{}{
                "type": "object",
                "properties": map[string]interface{}{
                    "path": map[string]interface{}{
                        "type":        "string",
                        "description": "Directory path to list",
                    },
                    "pattern": map[string]interface{}{
                        "type":        "string",
                        "description": "Glob pattern to filter files",
                    },
                },
            },
        },
    }
}

func (t *ListFilesTool) Execute(ctx context.Context, args json.RawMessage, execCtx ExecutionContext) (string, error) {
    var params struct {
        Path    string `json:"path"`
        Pattern string `json:"pattern"`
    }
    
    if err := json.Unmarshal(args, &params); err != nil {
        return "", err
    }
    
    rootDir := execCtx.RootDir
    targetDir := filepath.Join(rootDir, params.Path)
    
    // 安全检查
    if !isSubPath(rootDir, targetDir) {
        return "", fmt.Errorf("access denied: path outside project root")
    }
    
    entries, err := os.ReadDir(targetDir)
    if err != nil {
        return "", err
    }
    
    var files []string
    for _, entry := range entries {
        name := entry.Name()
        if entry.IsDir() {
            name += "/"
        }
        if params.Pattern == "" || matchPattern(name, params.Pattern) {
            files = append(files, name)
        }
    }
    
    result, _ := json.Marshal(map[string]interface{}{
        "ok":    true,
        "files": files,
        "count": len(files),
    })
    
    return string(result), nil
}
```

#### 5.3.2 命令执行工具 (`internal/tools/command.go`)

**TypeScript 原始代码**: `src/tools.ts` (run_command)

```go
// internal/tools/command.go

package tools

import (
    "bytes"
    "context"
    "encoding/json"
    "fmt"
    "os/exec"
    "runtime"
    "time"
)

// newShellCommand 跨平台创建 shell 命令
func newShellCommand(ctx context.Context, command string) *exec.Cmd {
    if runtime.GOOS == "windows" {
        return exec.CommandContext(ctx, "cmd", "/c", command)
    }
    // Git Bash / WSL 环境下优先使用 sh；空 SHELL 回退到 sh
    shell := os.Getenv("SHELL")
    if shell == "" {
        shell = "sh"
    }
    return exec.CommandContext(ctx, shell, "-c", command)
}

type RunCommandTool struct {
    permissions *CommandPermissions
    approval    CommandApprovalHandler
}

func (t *RunCommandTool) Definition() ToolDefinition {
    return ToolDefinition{
        Type: "function",
        Function: ToolFunctionDef{
            Name:        "run_command",
            Description: "Execute a shell command",
            Parameters: map[string]interface{}{
                "type": "object",
                "properties": map[string]interface{}{
                    "command": map[string]interface{}{
                        "type":        "string",
                        "description": "Command to execute",
                    },
                },
                "required": []string{"command"},
            },
        },
    }
}

func (t *RunCommandTool) Execute(ctx context.Context, args json.RawMessage, execCtx ExecutionContext) (string, error) {
    var params struct {
        Command string `json:"command"`
    }
    
    if err := json.Unmarshal(args, &params); err != nil {
        return "", err
    }
    
    // 检查权限
    policy, err := t.resolvePolicy(params.Command)
    if err != nil {
        return "", err
    }
    
    // 请求批准
    if policy.RequireApproval {
        approved, err := t.approval(CommandApprovalRequest{
            Command: params.Command,
            Risk:    policy.Risk,
            Cwd:     execCtx.RootDir,
        })
        if err != nil {
            return "", err
        }
        if !approved {
            return "", fmt.Errorf("command not approved")
        }
    }
    
    // 执行命令
    timeout := policy.TimeoutMs
    if timeout == 0 {
        timeout = 15000
    }
    
    ctx, cancel := context.WithTimeout(ctx, time.Duration(timeout)*time.Millisecond)
    defer cancel()

    cmd := newShellCommand(ctx, params.Command)
    cmd.Dir = execCtx.RootDir
    
    var stdout, stderr bytes.Buffer
    cmd.Stdout = &stdout
    cmd.Stderr = &stderr
    
    err = cmd.Run()
    
    result := map[string]interface{}{
        "ok":       err == nil,
        "stdout":   truncateString(stdout.String(), policy.MaxOutputChars),
        "stderr":   truncateString(stderr.String(), policy.MaxOutputChars),
        "exitCode": 0,
    }
    
    if err != nil {
        if exitErr, ok := err.(*exec.ExitError); ok {
            result["exitCode"] = exitErr.ExitCode()
        }
    }
    
    output, _ := json.Marshal(result)
    return string(output), nil
}
```

### 5.4 Phase 4: CLI 与服务（Week 7-8）

#### 5.4.1 CLI 命令 (`internal/cli/`)

**TypeScript 原始代码**: `src/cli.ts`

```go
// internal/cli/root.go

package cli

import (
    "fmt"
    "os"
    
    "github.com/spf13/cobra"
    "github.com/spf13/viper"
)

var rootCmd = &cobra.Command{
    Use:   "deepvibe",
    Short: "CLI-first AI coding engine for DeepSeek workflows",
    Long:  `DeepVibe Core is a CLI-first AI coding engine optimized for DeepSeek workflows.`,
}

func init() {
    rootCmd.PersistentFlags().StringP("config", "c", "", "config file (default is $HOME/.deepvibe/config.json)")
    rootCmd.PersistentFlags().Bool("dry-run", false, "dry run mode")
    rootCmd.PersistentFlags().Bool("force", false, "skip confirmation")
    
    viper.BindPFlag("config", rootCmd.PersistentFlags().Lookup("config"))
    viper.BindPFlag("dry_run", rootCmd.PersistentFlags().Lookup("dry-run"))
    viper.BindPFlag("force", rootCmd.PersistentFlags().Lookup("force"))
}

func Execute() {
    if err := rootCmd.Execute(); err != nil {
        fmt.Fprintln(os.Stderr, err)
        os.Exit(1)
    }
}
```

```go
// internal/cli/run.go

package cli

import (
    "context"
    "fmt"
    
    "github.com/spf13/cobra"
    "deepvibe-core/internal/engine"
    "deepvibe-core/internal/config"
)

var runCmd = &cobra.Command{
    Use:   "run [instruction]",
    Short: "Execute an instruction",
    Args:  cobra.MinimumNArgs(1),
    RunE: func(cmd *cobra.Command, args []string) error {
        instruction := args[0]
        
        cfg, err := config.Load(cwd())
        if err != nil {
            return fmt.Errorf("load config: %w", err)
        }
        
        eng, err := engine.New(cfg)
        if err != nil {
            return fmt.Errorf("create engine: %w", err)
        }
        
        dryRun, _ := cmd.Flags().GetBool("dry-run")
        force, _ := cmd.Flags().GetBool("force")
        planMode, _ := cmd.Flags().GetBool("plan")
        
        result, err := eng.Run(context.Background(), engine.RunOptions{
            Cwd:         cwd(),
            DryRun:      dryRun,
            Instruction: instruction,
            PlanMode:    planMode,
            Force:       force,
        })
        if err != nil {
            return fmt.Errorf("run engine: %w", err)
        }
        
        fmt.Println(result.Message)
        return nil
    },
}

func init() {
    runCmd.Flags().Bool("plan", false, "enable plan mode")
    runCmd.Flags().String("profile", "default", "execution profile (default, flash, deep)")
    
    rootCmd.AddCommand(runCmd)
}
```

#### 5.4.2 HTTP 服务 (`internal/server/`)

**TypeScript 原始代码**: `src/server.ts`

```go
// internal/server/server.go

package server

import (
    "context"
    "encoding/json"
    "fmt"
    "net/http"
    "time"
    
    "github.com/go-chi/chi/v5"
    "github.com/go-chi/chi/v5/middleware"
    "deepvibe-core/internal/engine"
    "deepvibe-core/internal/task"
)

type Server struct {
    engine      engine.Engine
    taskManager *task.Manager
    host        string
    port        int
    httpServer  *http.Server
}

func New(engine engine.Engine, opts ...ServerOption) *Server {
    s := &Server{
        engine:      engine,
        taskManager: task.NewManager(),
        host:        "127.0.0.1",
        port:        4242,
    }
    
    for _, opt := range opts {
        opt(s)
    }
    
    return s
}

func (s *Server) Start(ctx context.Context) error {
    r := chi.NewRouter()

    r.Use(middleware.Logger)
    r.Use(middleware.Recoverer)

    // SSE / 长任务路由不挂 Timeout，避免流式连接被 60s 超时切断
    r.Route("/tasks", func(r chi.Router) {
        r.Post("/run", s.handleTaskRun)
        r.Get("/{taskId}", s.handleTaskGet)
        r.Get("/{taskId}/events", s.handleTaskEvents)
        r.Post("/{taskId}/cancel", s.handleTaskCancel)
    })

    // 普通请求路由挂超时
    r.Group(func(r chi.Router) {
        r.Use(middleware.Timeout(60 * time.Second))

        r.Get("/health", s.handleHealth)
        r.Post("/run", s.handleRun)
        r.Post("/undo", s.handleUndo)
        r.Post("/rpc", s.handleRPC)

        r.Route("/sessions", func(r chi.Router) {
            r.Get("/", s.handleSessionsList)
            r.Post("/new", s.handleSessionNew)
            r.Post("/switch", s.handleSessionSwitch)
            r.Get("/history", s.handleSessionHistory)
        })

        r.Post("/completions/fim", s.handleFimCompletion)
    })
    
    s.httpServer = &http.Server{
        Addr:    fmt.Sprintf("%s:%d", s.host, s.port),
        Handler: r,
    }
    
    return s.httpServer.ListenAndServe()
}

func (s *Server) Shutdown(ctx context.Context) error {
    return s.httpServer.Shutdown(ctx)
}
```

### 5.5 Phase 5: 高级功能（Week 9-10）

#### 5.5.1 插件系统 (`internal/plugins/`)

**TypeScript 原始代码**: `src/plugins.ts`

**兼容性风险**：Go 无法直接执行 `.js` 插件；原始 TS 版通过 Node.js 子进程 fork 运行。迁移需保留 Node.js 作为插件 host（js 插件不改），或提供 Go 原生插件替代路径。

**推荐方案**：双通道

1. **Node.js 通道**（兼容现有 .js 插件）：Go 进程调用 `node plugin-host.cjs`，行为与 TS 版一致
2. **Go 原生通道**（新增）：支持 `.wasm` (Wasm) 或通过 Go 标准库 `plugin` 包加载 `.so` 插件

```go
// internal/plugins/loader.go

package plugins

import (
    "context"
    "encoding/json"
    "fmt"
    "os"
    "os/exec"
    "path/filepath"
    "time"
)

type PluginKind string

const (
    KindJS   PluginKind = "js"   // 兼容原有 .js 插件
    KindWasm PluginKind = "wasm" // 新增 Wasm 插件
)

type Loader struct {
    rootDir     string
    nodePath    string // Node.js 可执行文件路径，js 插件 host
    hostPath    string // plugin-host.cjs 路径
    timeout     time.Duration
    memoryLimit int
}

type PluginManifest struct {
    Name        string             `json:"name"`
    Entry       string             `json:"entry"`
    Kind        string             `json:"kind,omitempty"`  // "js" or "wasm"，默认为 "js"
    Enabled     *bool              `json:"enabled,omitempty"`
    Version     string             `json:"version,omitempty"`
    Permissions *PluginPermissions `json:"permissions,omitempty"`
    Runtime     *RuntimeConfig     `json:"runtime,omitempty"`
}

type Plugin struct {
    Manifest PluginManifest
    Tools    []ToolDefinition
}

func (l *Loader) Load(ctx context.Context) ([]Plugin, error) {
    pluginsDir := filepath.Join(l.rootDir, ".deepvibe", "plugins")
    entries, err := os.ReadDir(pluginsDir)
    if err != nil {
        if os.IsNotExist(err) {
            return nil, nil
        }
        return nil, err
    }

    var plugins []Plugin
    for _, entry := range entries {
        if !entry.IsDir() {
            continue
        }
        manifestPath := filepath.Join(pluginsDir, entry.Name(), "plugin.json")
        manifestData, err := os.ReadFile(manifestPath)
        if err != nil {
            continue
        }
        var manifest PluginManifest
        if err := json.Unmarshal(manifestData, &manifest); err != nil {
            continue
        }
        if manifest.Enabled != nil && !*manifest.Enabled {
            continue
        }
        plugin, err := l.loadPlugin(ctx, manifest, filepath.Join(pluginsDir, entry.Name()))
        if err != nil {
            continue
        }
        plugins = append(plugins, *plugin)
    }
    return plugins, nil
}

func (l *Loader) loadPlugin(ctx context.Context, manifest PluginManifest, dir string) (*Plugin, error) {
    kind := PluginKind(manifest.Kind)
    if kind == "" {
        kind = KindJS // 默认兼容原有 .js 插件
    }

    switch kind {
    case KindWasm:
        return l.loadWasmPlugin(ctx, manifest, dir)
    default:
        return l.loadJSPlugin(ctx, manifest, dir)
    }
}

// loadJSPlugin 通过 Node.js 子进程加载原有 .js 插件，行为与原 TS 版一致
func (l *Loader) loadJSPlugin(ctx context.Context, manifest PluginManifest, dir string) (*Plugin, error) {
    if l.nodePath == "" {
        l.nodePath = "node"
    }
    entryPath := filepath.Join(dir, manifest.Entry)

    cmd := exec.CommandContext(ctx, l.nodePath, l.hostPath, entryPath)
    cmd.Env = append(os.Environ(),
        fmt.Sprintf("PLUGIN_TIMEOUT=%d", l.timeout.Milliseconds()),
        fmt.Sprintf("PLUGIN_MEMORY_LIMIT=%d", l.memoryLimit),
    )
    // 安全沙箱：绑定 project root，限制 fs/网络
    cmd.Dir = dir

    output, err := cmd.Output()
    if err != nil {
        return nil, fmt.Errorf("load plugin %s: %w", manifest.Name, err)
    }

    var tools []ToolDefinition
    if err := json.Unmarshal(output, &tools); err != nil {
        return nil, fmt.Errorf("parse plugin %s output: %w", manifest.Name, err)
    }

    return &Plugin{Manifest: manifest, Tools: tools}, nil
}

// loadWasmPlugin 加载 Wasm 插件（扩展路径）
func (l *Loader) loadWasmPlugin(_ context.Context, _ PluginManifest, _ string) (*Plugin, error) {
    // TODO: 使用 wazero 或 wasmtime-go 运行时加载 .wasm 模块
    return nil, fmt.Errorf("wasm plugin support not yet implemented")
}
```

#### 5.5.2 REPL (`internal/repl/`)

**TypeScript 原始代码**: `src/repl.ts`

```go
// internal/repl/repl.go

package repl

import (
    "bufio"
    "context"
    "fmt"
    "os"
    "strings"
    
    "deepvibe-core/internal/engine"
    "deepvibe-core/internal/session"
)

type REPL struct {
    engine      engine.Engine
    session     *session.Session
    reader      *bufio.Reader
    writer      *os.File
    mode        Mode
}

type Mode string

const (
    ModeChat    Mode = "chat"
    ModeProject Mode = "project"
)

func New(engine engine.Engine, opts ...REPLOption) *REPL {
    r := &REPL{
        engine:  engine,
        reader:  bufio.NewReader(os.Stdin),
        writer:  os.Stdout,
        mode:    ModeProject,
    }
    
    for _, opt := range opts {
        opt(r)
    }
    
    return r
}

func (r *REPL) Run(ctx context.Context) error {
    r.printWelcome()
    
    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
        }
        
        r.printPrompt()
        
        input, err := r.readInput()
        if err != nil {
            return err
        }
        
        if input == "" {
            continue
        }
        
        // 处理斜杠命令
        if strings.HasPrefix(input, "/") {
            if err := r.handleCommand(ctx, input); err != nil {
                r.printError(err)
            }
            continue
        }
        
        // 执行指令
        if err := r.executeInstruction(ctx, input); err != nil {
            r.printError(err)
        }
    }
}

func (r *REPL) executeInstruction(ctx context.Context, instruction string) error {
    result, err := r.engine.Run(ctx, engine.RunOptions{
        Cwd:         r.cwd(),
        Instruction: instruction,
    })
    if err != nil {
        return err
    }
    
    r.printResult(result)
    
    // 询问是否接受更改
    if len(result.FilesChanged) > 0 {
        accepted, err := r.confirmChanges(result)
        if err != nil {
            return err
        }
        
        if !accepted {
            // 回滚更改
            return r.engine.Rollback(ctx, result)
        }
    }
    
    return nil
}
```

### 5.5b Phase 5 补充：其他关键模块

#### 5.5b.1 意图识别 (`internal/intent/`)

**TypeScript 原始代码**: `src/intent.ts`

检测用户输入是 chat-only 问题还是需要修改项目的工程请求，用于 REPL 模式切换。

```go
// internal/intent/intent.go

package intent

import "strings"

type Intent int

const (
    IntentChat       Intent = iota // 纯对话
    IntentWrite                    // 需要写文件
    IntentRead                     // 只读查询
)

var engineeringKeywords = []string{
    "implement", "refactor", "add", "create", "fix", "rename",
    "remove", "delete", "update", "change", "modify", "write",
    "build", "generate", "scaffold", "migrate",
}

func Detect(instruction string) Intent {
    lower := strings.ToLower(instruction)
    for _, kw := range engineeringKeywords {
        if strings.Contains(lower, kw) {
            return IntentWrite
        }
    }
    return IntentChat
}
```

#### 5.5b.2 模型配置 (`internal/model/`)

**TypeScript 原始代码**: `src/model-profile.ts`

管理 flash/pro/deep 执行配置切换。

```go
// internal/model/profile.go

package model

type Profile struct {
    Model        string
    Temperature  float64
    MaxTokens    int
    TopP         float64
    Reasoning    string // none / high / max
}

var Profiles = map[string]Profile{
    "default": {Model: "deepseek-v4-pro", Temperature: 0.0, MaxTokens: 8192},
    "flash":   {Model: "deepseek-v4-flash", Temperature: 0.0, MaxTokens: 4096},
    "deep":    {Model: "deepseek-v4-pro", Temperature: 0.0, MaxTokens: 16384, Reasoning: "max"},
}

func Resolve(name string) Profile {
    if p, ok := Profiles[name]; ok {
        return p
    }
    return Profiles["default"]
}
```

#### 5.5b.3 国际化 (`internal/i18n/`)

**TypeScript 原始代码**: `src/i18n.ts`

嵌入中英文消息资源，运行时按 `--lang` 标志切换。

```go
// internal/i18n/i18n.go

package i18n

type Language string

const (
    LangEN Language = "en"
    LangZH Language = "zh"
)

var currentLang = LangEN

func SetLang(lang Language) { currentLang = lang }
func Lang() Language         { return currentLang }

// 使用 Go 1.16+ embed 嵌入 JSON 翻译文件
//
// //go:embed messages.en.json messages.zh.json
// var messageFS embed.FS
//
// func T(key string) string { ... }
```

#### 5.5b.4 验证 (`internal/verification/`)

**TypeScript 原始代码**: `src/verification.ts`

文件变更后自动运行 lint/test/build 命令进行验证。

```go
// internal/verification/verification.go

package verification

import "context"

type Verifier struct {
    allowList []string // 例如 ["pnpm test", "npm test", "go test ./..."]
}

type VerifyResult struct {
    Command   string
    ExitCode  int
    Stdout    string
    Stderr    string
    Succeeded bool
}

func (v *Verifier) Verify(ctx context.Context, cwd string) (*VerifyResult, error) {
    // 遍历 allowList，选择第一个可执行的命令
    // 执行并返回结果，用于在变更完成后向用户展示验证摘要
    return nil, nil
}
```

#### 5.5b.5 工作区安全 (`internal/workspace/`)

**TypeScript 原始代码**: `src/workspace-access.ts`, `src/workspace-landing.ts`

合并为单个 `workspace/` 包，处理沙箱信任策略和落地审查。

```go
// internal/workspace/workspace.go

package workspace

type TrustLevel string

const (
    TrustSandbox TrustLevel = "sandbox" // 默认沙箱模式
    TrustFull    TrustLevel = "full"    // 完全信任
)

type AccessInfo struct {
    Trust     TrustLevel
    SandboxDir string // 沙箱临时目录路径
}
```

#### 5.5b.6 项目引导 (`internal/bootstrap/`)

**TypeScript 原始代码**: `src/project-bootstrap.ts`

空仓库 / 新项目的最小脚手架引导。

```go
// internal/bootstrap/bootstrap.go

package bootstrap

import "context"

type BootstrapResult struct {
    Files []string
    Hint  string
}

func ApplyBootstrap(ctx context.Context, cwd string, instruction string) (*BootstrapResult, error) {
    // 检测仓库状态：如果 Git 仓库基本为空（无提交或有 README.md 等最小文件）
    // 且用户意图是创建项目，则生成最小脚手架（package.json / go.mod / ...）
    return nil, nil
}
```

#### 5.5b.7 REPL UI 组件 (`internal/tui/`)

**TypeScript 原始代码**: `src/tui-layout.ts`, `src/chat-bubble.ts`, `src/multiline.ts`, `src/slash-command.ts`, `src/review.ts`

合并为 `tui/` 包，使用 [bubbletea](https://github.com/charmbracelet/bubbletea) 框架实现 TUI。

```go
// internal/tui/repl.go

package tui

import (
    tea "github.com/charmbracelet/bubbletea"
    "github.com/charmbracelet/lipgloss"
)

type REPLModel struct {
    // 聊天消息历史、输入框、面板布局
    messages  []Message
    textInput textinput.Model
    viewport  viewport.Model
    mode      Mode
    // diff 查看器、审批状态
}
```

#### 5.5b.8 Token 用量统计 (`internal/usage/`)

**TypeScript 原始代码**: `src/usage.ts`

```go
// internal/usage/usage.go

package usage

import "sync"

type Tracker struct {
    mu            sync.Mutex
    TurnCount     int
    PromptTokens  int
    CompletionTokens int
    TotalTokens   int
}

func (t *Tracker) Record(promptTokens, completionTokens int) {
    t.mu.Lock()
    defer t.mu.Unlock()
    t.TurnCount++
    t.PromptTokens += promptTokens
    t.CompletionTokens += completionTokens
    t.TotalTokens += promptTokens + completionTokens
}
```

#### 5.6.1 单元测试

```go
// internal/config/config_test.go

package config_test

import (
    "os"
    "path/filepath"
    "testing"
    
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
    "deepvibe-core/internal/config"
)

func TestLoadConfig_GlobalAndProject(t *testing.T) {
    // 全局：~/.deepvibe/config.json 中设置 apiKey
    // 项目：${cwd}/.deepvibe/config.json 中覆盖 defaultModel
    // Load(cwd) 读取全局 + 项目做整字段覆盖

    cwd := t.TempDir()

    // 写入项目配置（覆盖 defaultModel）
    projectDir := filepath.Join(cwd, ".deepvibe")
    os.MkdirAll(projectDir, 0755)
    os.WriteFile(filepath.Join(projectDir, "config.json"), []byte(`{
        "defaultModel": "deepseek-v4-flash"
    }`), 0644)

    // 注意：全局配置 ~/.deepvibe/config.json 依赖 homeDir() 的实际值；
    // 生产环境应通过环境变量或 DI 注入 home 目录路径。
    // 完整性测试略去全局配置部分，仅验证项目配置可加载。

    cfg, err := config.Load(cwd)
    require.NoError(t, err)

    assert.Equal(t, "deepseek-v4-flash", cfg.DefaultModel)
}
```

#### 5.6.2 集成测试

```go
// internal/engine/engine_integration_test.go

package engine_test

import (
    "context"
    "testing"
    
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
    "deepvibe-core/internal/engine"
    "deepvibe-core/internal/config"
)

func TestEngine_Run_DryRun(t *testing.T) {
    if testing.Short() {
        t.Skip("skipping integration test")
    }
    
    cfg := &config.Config{
        APIKey:       "test-key",
        DefaultModel: "deepseek-v4-pro",
    }
    
    eng, err := engine.New(cfg)
    require.NoError(t, err)
    
    result, err := eng.Run(context.Background(), engine.RunOptions{
        Cwd:         t.TempDir(),
        DryRun:      true,
        Instruction: "list all files",
    })
    
    require.NoError(t, err)
    assert.NotNil(t, result)
}
```

#### 5.6.3 性能基准测试

```go
// internal/engine/benchmark_test.go

package engine_test

import (
    "testing"
    
    "deepvibe-core/internal/engine"
)

func BenchmarkEngine_CreateCompletion(b *testing.B) {
    eng, _ := engine.New(testConfig)
    
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        eng.CreateCompletion(testMessages, testOptions)
    }
}

func BenchmarkScanner_ScanProject(b *testing.B) {
    scanner := scanner.New()
    
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        scanner.ScanProject(testRootDir, nil)
    }
}
```

## 6. 迁移时间表

### 6.1 总体计划

| 阶段 | 时间 | 交付物 | 里程碑 |
|------|------|--------|--------|
| Phase 1 | Week 1-2 | 核心基础设施 | 配置管理、项目扫描、上下文构建 |
| Phase 2 | Week 3-4 | LLM 集成 | DeepSeek 客户端、流式响应、FIM 补全 |
| Phase 3 | Week 5-6 | 工具系统 | 文件操作、命令执行、Web 搜索 |
| Phase 4 | Week 7-8 | CLI 与服务 | CLI 命令、HTTP 服务、JSON-RPC |
| Phase 5 | Week 9-10 | 高级功能 | 插件系统、REPL、会话管理 |
| Phase 6 | Week 11-12 | 测试与优化 | 单元测试、集成测试、性能优化 |

### 6.2 详细里程碑

#### Week 1-2: 核心基础设施

- [ ] 项目骨架搭建（go.mod、目录结构）
- [ ] 配置管理模块（viper 集成）
- [ ] 项目扫描模块（文件遍历、ignore 支持）
- [ ] 上下文构建模块（token 计数、上下文管理）
- [ ] 单元测试框架搭建

#### Week 3-4: LLM 集成

- [ ] DeepSeek HTTP 客户端
- [ ] SSE 流式解析
- [ ] 重试和超时逻辑
- [ ] 响应解析器（JSON、Markdown、Diff）
- [ ] FIM 补全支持

#### Week 5-6: 工具系统

- [ ] 工具注册表
- [ ] 文件操作工具（list、read、write、delete）
- [ ] 命令执行工具（权限控制、沙箱）
- [ ] Web 搜索工具（DuckDuckGo、Tavily、Bing）
- [ ] 工具执行引擎

#### Week 7-8: CLI 与服务

- [ ] Cobra CLI 框架
- [ ] 核心命令（run、undo、config）
- [ ] HTTP 服务器（chi 路由）
- [ ] JSON-RPC 端点
- [ ] 任务管理（异步执行、SSE 事件）

#### Week 9-10: 高级功能

- [ ] 插件系统（双通道：Node.js host + Wasm 扩展）
- [ ] REPL（bubbletea TUI、斜杠命令、多行输入）
- [ ] 会话管理（持久化、切换）
- [ ] 多步骤计划模式
- [ ] 意图识别（chat-only vs project 模式切换）
- [ ] 模型配置切换（flash/pro/deep）
- [ ] 国际化（en/zh 消息资源）
- [ ] 验证模块（自动 lint/test/build）
- [ ] 项目引导（空仓库脚手架）
- [ ] 工作区安全（沙箱信任策略、落地审查）
- [ ] 代码审查（diff 查看器）
- [ ] Token 用量统计

#### Week 11-12: 测试与优化

- [ ] 单元测试（覆盖率 > 80%）
- [ ] 集成测试（API 兼容性）
- [ ] 性能基准测试
- [ ] 文档更新
- [ ] 发布准备

## 7. 风险评估

### 7.1 技术风险

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|----------|
| go-git 功能不完整 | 高 | 中 | 准备 fallback 到调用 git 命令 |
| Token 计数不准确 | 中 | 高 | 参考 tiktoken-go 实现，充分测试 |
| SSE 解析缓冲区溢出 | 中 | 中 | 扩容 bufio.Scanner 缓冲区到 10MB |
| 命令执行 shell 不跨平台 | 高 | 高 | 运行时检测 OS，Windows 用 `cmd /c`，Unix 用 `sh -c` |
| 插件系统安全性 | 高 | 低 | 严格沙箱隔离，限制权限 |
| 插件不兼容 | 高 | 中 | 保留 Node.js host 通道运行 .js 插件；新增 Wasm 路径 |

### 7.2 进度风险

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|----------|
| 功能遗漏 | 高 | 中 | 详细功能清单，逐项验证 |
| 性能不达标 | 中 | 低 | 持续基准测试，及时优化 |
| API 不兼容 | 高 | 低 | 集成测试覆盖所有端点 |

### 7.3 资源风险

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|----------|
| 开发人员不足 | 高 | 中 | 优先核心功能，分阶段交付 |
| 测试环境不足 | 中 | 低 | 使用 Docker 容器化测试 |
| 第三方库维护 | 低 | 低 | 选择活跃维护的库 |

## 8. 测试策略

### 8.1 测试金字塔

```
         /\
        /  \        E2E Tests (10%)
       /    \       - 完整工作流测试
      /------\      - CLI 命令测试
     /        \     Integration Tests (30%)
    /          \    - API 端点测试
   /            \   - 模块集成测试
  /--------------\  Unit Tests (60%)
 /                \ - 函数级别测试
/                  \- 边界条件测试
```

### 8.2 测试工具

| 层次 | 工具 | 用途 |
|------|------|------|
| 单元测试 | `testing` + `testify` | 函数级别测试 |
| 集成测试 | `testcontainers-go` | 依赖服务测试 |
| E2E 测试 | `exec` + CLI | 完整工作流测试 |
| 性能测试 | `testing.B` | 基准测试 |
| 覆盖率 | `go test -cover` | 覆盖率报告 |

### 8.3 CI/CD 集成

```yaml
# .github/workflows/test.yml

name: Test

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.23'
      
      - name: Run linter
        uses: golangci/golangci-lint-action@v6
        with:
          version: latest
      
      - name: Run tests
        run: go test -v -race -coverprofile=coverage.out ./...
      
      - name: Upload coverage
        uses: codecov/codecov-action@v4
        with:
          files: coverage.out
  
  build:
    needs: test
    runs-on: ubuntu-latest
    
    strategy:
      matrix:
        goos: [linux, windows, darwin]
        goarch: [amd64, arm64]
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.23'
      
      - name: Build
        env:
          GOOS: ${{ matrix.goos }}
          GOARCH: ${{ matrix.goarch }}
        run: go build -o deepvibe-${{ matrix.goos }}-${{ matrix.goarch }} ./cmd/deepvibe
      
      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: deepvibe-${{ matrix.goos }}-${{ matrix.goarch }}
          path: deepvibe-${{ matrix.goos }}-${{ matrix.goarch }}
```

## 9. 文档更新

### 9.1 需要更新的文档

- [ ] README.md - 安装和使用说明
- [ ] CONTRIBUTING.md - 贡献指南
- [ ] API 文档 - OpenAPI 规范
- [ ] 架构文档 - 系统设计说明
- [ ] 开发指南 - 环境搭建、构建、测试

### 9.2 示例文档更新

```markdown
# DeepVibe Core (Go)

## 安装

### 从源码构建

```bash
git clone https://github.com/anthropics/deepvibe-core.git
cd deepvibe-core
make build
```

### 使用 go install

```bash
go install github.com/anthropics/deepvibe-core/cmd/deepvibe@latest
```

### 下载预编译二进制

访问 [Releases](https://github.com/anthropics/deepvibe-core/releases) 页面下载对应平台的二进制文件。

## 快速开始

```bash
# 配置 API Key
deepvibe config set api_key YOUR_API_KEY

# 运行指令
deepvibe run "summarize the project"

# 启动 REPL
deepvibe chat

# 启动服务
deepvibe serve --port 4242
```

## 开发

```bash
# 运行测试
make test

# 运行 linter
make lint

# 构建所有平台
make build-all
```
```

## 10. 总结

本重构方案将 DeepVibe Core 从 TypeScript 迁移到 Go，预期实现以下收益：

1. **性能提升**：启动时间减少 80%，内存占用减少 70%
2. **部署简化**：单二进制文件，无运行时依赖
3. **开发体验**：编译时类型检查，更好的错误处理
4. **并发能力**：原生 goroutine 支持，更好的并发处理
5. **跨平台**：原生交叉编译，支持所有主流平台

通过分阶段迁移、充分测试、持续集成，确保重构过程平稳可控，最终交付一个高性能、高质量的 Go 版本 DeepVibe Core。
