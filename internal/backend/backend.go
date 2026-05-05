package backend

import "context"

type Backend interface {
	DeleteFile(ctx context.Context, request DeleteFileRequest) (*DeleteFileResult, error)
	Execute(ctx context.Context, request ExecuteRequest) (*ExecuteResult, error)
	ListFiles(ctx context.Context, request ListFilesRequest) (*ListFilesResult, error)
	ReadFile(ctx context.Context, request ReadFileRequest) (*ReadFileResult, error)
	Root() string
	WriteFile(ctx context.Context, request WriteFileRequest) (*WriteFileResult, error)
}

type ListFilesRequest struct {
	Directory string
	Limit     int
	Pattern   string
}

type ListFilesResult struct {
	Directory string
	Files     []string
}

type ReadFileRequest struct {
	MaxChars int
	Path     string
}

type ReadFileResult struct {
	Content   string
	Path      string
	Truncated bool
}

type WriteFileRequest struct {
	Content string
	Path    string
}

type WriteFileResult struct {
	Action        string
	AfterContent *string
	BeforeContent *string
	Bytes         int
	Path          string
}

type DeleteFileRequest struct {
	Path string
}

type DeleteFileResult struct {
	BeforeContent *string
	Path          string
}

type ExecuteRequest struct {
	Command        string
	CWD            string
	MaxOutputChars int
	TimeoutMs      int
}

type ExecuteResult struct {
	ExitCode int
	Stderr   string
	Stdout   string
}
