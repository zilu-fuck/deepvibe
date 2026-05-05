package context

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/zilu-fuck/deepvibe/internal/llm"
)

const contextDir = ".deepvibe"
const contextFile = "context.json"
const maxStoredTurns = 50
const defaultHistoryTurns = 5
const maxSessions = 20
const maxChatHistoryMessages = 200

type Store struct {
	CurrentSessionID string    `json:"currentSessionId"`
	Sessions         []Session `json:"sessions"`
	Version          int       `json:"version"`
}

type Session struct {
	ChatHistory    []llm.ChatMessage `json:"chatHistory,omitempty"`
	DisplayHistory []llm.ChatMessage `json:"displayHistory,omitempty"`
	CreatedAt      string            `json:"createdAt"`
	ID             string            `json:"id"`
	Turns          []Turn            `json:"turns"`
	UpdatedAt      string            `json:"updatedAt"`
}

type Turn struct {
	CreatedAt   string      `json:"createdAt"`
	Files       []string    `json:"files"`
	ID          string      `json:"id"`
	Instruction string      `json:"instruction"`
	Result      TurnResult  `json:"result"`
	Search      *TurnSearch `json:"search,omitempty"`
	Summary     string      `json:"summary"`
	Tools       *TurnTools  `json:"tools,omitempty"`
}

type TurnResult struct {
	AppliedFiles  int    `json:"appliedFiles"`
	Kind          string `json:"kind"`
	OK            bool   `json:"ok"`
	Reference     string `json:"reference,omitempty"`
	ToolCallsUsed bool   `json:"toolCallsUsed"`
}

type TurnSearch struct {
	Query   string             `json:"query"`
	Results []TurnSearchResult `json:"results"`
}

type TurnSearchResult struct {
	Title string `json:"title"`
	URL   string `json:"url"`
}

type TurnTools struct {
	Names []string `json:"names"`
}

type AppendTurnOptions struct {
	Files       []string
	Instruction string
	Result      TurnResult
	RootDir     string
	Search      *TurnSearch
	Summary     string
	Tools       *TurnTools
}

type SessionSummary struct {
	CreatedAt string `json:"createdAt"`
	ID        string `json:"id"`
	TurnCount int    `json:"turnCount"`
	UpdatedAt string `json:"updatedAt"`
}

func LoadStore(rootDir string) Store {
	storePath := storePath(rootDir)
	data, err := os.ReadFile(storePath)
	if err != nil {
		return createEmptyStore()
	}

	var store Store
	if err := json.Unmarshal(data, &store); err != nil {
		return createEmptyStore()
	}
	if store.Version != 1 || store.CurrentSessionID == "" || len(store.Sessions) == 0 {
		return createEmptyStore()
	}

	sessions := make([]Session, 0, len(store.Sessions))
	for _, session := range store.Sessions {
		if isValidSession(session) {
			sessions = append(sessions, session)
		}
	}
	if len(sessions) == 0 {
		return createEmptyStore()
	}
	store.Sessions = sessions
	if !hasSession(store, store.CurrentSessionID) {
		store.CurrentSessionID = store.Sessions[0].ID
	}
	return store
}

func EnsureStore(rootDir string) (Store, error) {
	store := LoadStore(rootDir)
	if err := persistStore(rootDir, store); err != nil {
		return Store{}, err
	}
	return store, nil
}

func AppendTurn(options AppendTurnOptions) (Store, error) {
	store := LoadStore(options.RootDir)
	session := getOrCreateActiveSession(&store)
	now := timestamp()
	turn := Turn{
		CreatedAt:   now,
		Files:       dedupeStrings(options.Files),
		ID:          createTurnID(),
		Instruction: options.Instruction,
		Result:      options.Result,
		Search:      options.Search,
		Summary:     options.Summary,
		Tools:       options.Tools,
	}
	session.UpdatedAt = now
	session.Turns = append(session.Turns, turn)
	if len(session.Turns) > maxStoredTurns {
		session.Turns = session.Turns[len(session.Turns)-maxStoredTurns:]
	}
	replaceSession(&store, session)
	if err := persistStore(options.RootDir, store); err != nil {
		return Store{}, err
	}
	return store, nil
}

func BuildSessionHistorySummary(store Store, maxTurns int) string {
	if maxTurns <= 0 {
		maxTurns = defaultHistoryTurns
	}
	session := activeSession(store)
	if session == nil || len(session.Turns) == 0 {
		return ""
	}
	turns := session.Turns
	dropped := 0
	if len(turns) > maxTurns {
		dropped = len(turns) - maxTurns
		turns = turns[len(turns)-maxTurns:]
	}

	lines := []string{"Recent session summary:"}
	if dropped > 0 {
		lines = append(lines, "- Earlier turns omitted: "+itoa(int64(dropped)))
	}
	for _, turn := range turns {
		parts := []string{
			"Instruction: " + turn.Instruction,
			"Result: " + turn.Result.Kind + formatReference(turn.Result.Reference),
			"Files: " + filesLabel(turn.Files),
		}
		if turn.Search != nil {
			parts = append(parts, "Search: "+turn.Search.Query)
		}
		if turn.Tools != nil && len(turn.Tools.Names) > 0 {
			parts = append(parts, "Tools: "+strings.Join(turn.Tools.Names, ", "))
		}
		parts = append(parts, "Summary: "+turn.Summary)
		lines = append(lines, "- "+strings.Join(parts, " | "))
	}
	return strings.Join(lines, "\n")
}

func StartNewSession(rootDir string) (Store, error) {
	store := LoadStore(rootDir)
	session := createSession()
	store.Sessions = append(store.Sessions, session)
	if len(store.Sessions) > maxSessions {
		store.Sessions = store.Sessions[len(store.Sessions)-maxSessions:]
	}
	store.CurrentSessionID = session.ID
	if err := persistStore(rootDir, store); err != nil {
		return Store{}, err
	}
	return store, nil
}

func ListSessions(store Store) []SessionSummary {
	result := make([]SessionSummary, 0, len(store.Sessions))
	for _, session := range store.Sessions {
		result = append(result, SessionSummary{
			CreatedAt: session.CreatedAt,
			ID:        session.ID,
			TurnCount: len(session.Turns),
			UpdatedAt: session.UpdatedAt,
		})
	}
	return result
}

func SwitchSession(rootDir string, sessionID string) (*Store, error) {
	store := LoadStore(rootDir)
	if !hasSession(store, sessionID) {
		return nil, nil
	}
	store.CurrentSessionID = sessionID
	if err := persistStore(rootDir, store); err != nil {
		return nil, err
	}
	return &store, nil
}

func LoadChatHistory(store Store, sessionID string) []llm.ChatMessage {
	if sessionID == "" {
		sessionID = store.CurrentSessionID
	}
	for _, session := range store.Sessions {
		if session.ID == sessionID {
			return append([]llm.ChatMessage(nil), session.ChatHistory...)
		}
	}
	return nil
}

func UpdateChatHistory(rootDir string, sessionID string, messages []llm.ChatMessage) error {
	store := LoadStore(rootDir)
	updated := false
	now := timestamp()
	for i := range store.Sessions {
		if store.Sessions[i].ID == sessionID {
			store.Sessions[i].ChatHistory = trimChatMessages(messages)
			store.Sessions[i].UpdatedAt = now
			updated = true
			break
		}
	}
	if !updated {
		return os.ErrNotExist
	}
	return persistStore(rootDir, store)
}

func HasSession(store Store, sessionID string) bool {
	return hasSession(store, sessionID)
}

func persistStore(rootDir string, store Store) error {
	path := storePath(rootDir)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(store, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return os.WriteFile(path, data, 0644)
}

func storePath(rootDir string) string {
	return filepath.Join(rootDir, contextDir, contextFile)
}

func createEmptyStore() Store {
	session := createSession()
	return Store{
		CurrentSessionID: session.ID,
		Sessions:         []Session{session},
		Version:          1,
	}
}

func createSession() Session {
	now := timestamp()
	return Session{
		ChatHistory: []llm.ChatMessage{},
		CreatedAt:   now,
		ID:          createSessionID(),
		Turns:       []Turn{},
		UpdatedAt:   now,
	}
}

func getOrCreateActiveSession(store *Store) Session {
	if session := activeSession(*store); session != nil {
		return *session
	}
	session := createSession()
	store.CurrentSessionID = session.ID
	store.Sessions = append(store.Sessions, session)
	return session
}

func activeSession(store Store) *Session {
	for i := range store.Sessions {
		if store.Sessions[i].ID == store.CurrentSessionID {
			return &store.Sessions[i]
		}
	}
	return nil
}

func replaceSession(store *Store, next Session) {
	for i := range store.Sessions {
		if store.Sessions[i].ID == next.ID {
			store.Sessions[i] = next
			return
		}
	}
	store.Sessions = append(store.Sessions, next)
}

func isValidSession(session Session) bool {
	return session.ID != "" && session.CreatedAt != "" && session.UpdatedAt != ""
}

func hasSession(store Store, sessionID string) bool {
	for _, session := range store.Sessions {
		if session.ID == sessionID {
			return true
		}
	}
	return false
}

func trimChatMessages(messages []llm.ChatMessage) []llm.ChatMessage {
	if len(messages) > maxChatHistoryMessages {
		messages = messages[len(messages)-maxChatHistoryMessages:]
	}
	return append([]llm.ChatMessage(nil), messages...)
}

func timestamp() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
}

func createSessionID() string {
	return "session_" + randomID()
}

func createTurnID() string {
	return "turn_" + randomID()
}

func randomID() string {
	var bytes [6]byte
	if _, err := rand.Read(bytes[:]); err == nil {
		return hex.EncodeToString(bytes[:])
	}
	return itoa(time.Now().UnixNano())
}

func dedupeStrings(values []string) []string {
	seen := map[string]bool{}
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	return result
}

func formatReference(reference string) string {
	if reference == "" {
		return ""
	}
	return "(" + reference + ")"
}

func filesLabel(files []string) string {
	if len(files) == 0 {
		return "none"
	}
	return strings.Join(files, ", ")
}

func itoa(value int64) string {
	if value == 0 {
		return "0"
	}
	const digits = "0123456789"
	var out []byte
	for value > 0 {
		out = append([]byte{digits[int(value%10)]}, out...)
		value /= 10
	}
	return string(out)
}
