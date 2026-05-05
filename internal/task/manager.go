package task

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sync"
	"time"
)

type Status string

const (
	StatusRunning   Status = "running"
	StatusCompleted Status = "completed"
	StatusFailed    Status = "failed"
	StatusCanceled  Status = "canceled"
)

type Event struct {
	ID        int            `json:"id"`
	Payload   map[string]any `json:"payload,omitempty"`
	Source    string         `json:"source"`
	Status    Status         `json:"status"`
	TaskID    string         `json:"taskId"`
	Terminal  bool           `json:"terminal"`
	Timestamp string         `json:"timestamp"`
	Type      string         `json:"type"`
	Version   int            `json:"version"`
}

type Snapshot struct {
	Error  string `json:"error,omitempty"`
	Result any    `json:"result,omitempty"`
	Status Status `json:"status"`
	TaskID string `json:"taskId"`
}

type Manager struct {
	mu    sync.RWMutex
	tasks map[string]*managedTask
}

type managedTask struct {
	cancel    context.CancelFunc
	events    []Event
	listeners map[int]func(Event)
	nextEvent int
	nextSubID int
	result    any
	err       string
	status    Status
	taskID    string
}

type Func func(ctx context.Context, emit func(eventType string, payload map[string]any, source string)) (any, error)

func NewManager() *Manager {
	return &Manager{tasks: map[string]*managedTask{}}
}

func (m *Manager) Start(parent context.Context, instruction string, fn Func) Snapshot {
	taskID := newTaskID()
	ctx, cancel := context.WithCancel(parent)
	task := &managedTask{
		cancel:    cancel,
		listeners: map[int]func(Event){},
		nextEvent: 1,
		status:    StatusRunning,
		taskID:    taskID,
	}

	m.mu.Lock()
	m.tasks[taskID] = task
	m.mu.Unlock()

	m.emit(taskID, "task.started", map[string]any{"instruction": instruction}, "task")

	go func() {
		result, err := fn(ctx, func(eventType string, payload map[string]any, source string) {
			if source == "" {
				source = "engine"
			}
			m.emit(taskID, eventType, payload, source)
		})

		m.mu.Lock()
		task := m.tasks[taskID]
		if task == nil {
			m.mu.Unlock()
			return
		}
		if ctx.Err() != nil {
			task.status = StatusCanceled
			task.err = "Execution was canceled."
			m.mu.Unlock()
			m.emit(taskID, "task.canceled", map[string]any{"message": task.err, "error": task.err}, "task")
			return
		}
		if err != nil {
			task.status = StatusFailed
			task.err = err.Error()
			m.mu.Unlock()
			m.emit(taskID, "task.failed", map[string]any{"message": task.err, "error": task.err}, "task")
			return
		}
		task.status = StatusCompleted
		task.result = result
		m.mu.Unlock()
		m.emit(taskID, "task.completed", map[string]any{"result": result}, "task")
	}()

	return m.Get(taskID)
}

func (m *Manager) Cancel(taskID string) (Snapshot, error) {
	m.mu.Lock()
	task := m.tasks[taskID]
	if task == nil {
		m.mu.Unlock()
		return Snapshot{}, fmt.Errorf("unknown task: %s", taskID)
	}
	if task.status != StatusRunning {
		snapshot := m.snapshot(task)
		m.mu.Unlock()
		return snapshot, nil
	}
	cancel := task.cancel
	m.mu.Unlock()

	cancel()
	m.emit(taskID, "task.cancel_requested", nil, "task")
	return m.Get(taskID), nil
}

func (m *Manager) Get(taskID string) Snapshot {
	m.mu.RLock()
	defer m.mu.RUnlock()
	task := m.tasks[taskID]
	if task == nil {
		return Snapshot{}
	}
	return m.snapshot(task)
}

func (m *Manager) Exists(taskID string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.tasks[taskID] != nil
}

func (m *Manager) Events(taskID string) ([]Event, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	task := m.tasks[taskID]
	if task == nil {
		return nil, false
	}
	events := append([]Event(nil), task.events...)
	return events, true
}

func (m *Manager) Subscribe(taskID string, listener func(Event)) (func(), bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	task := m.tasks[taskID]
	if task == nil {
		return nil, false
	}
	id := task.nextSubID
	task.nextSubID++
	task.listeners[id] = listener
	return func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		if task := m.tasks[taskID]; task != nil {
			delete(task.listeners, id)
		}
	}, true
}

func (m *Manager) emit(taskID string, eventType string, payload map[string]any, source string) {
	m.mu.Lock()
	task := m.tasks[taskID]
	if task == nil {
		m.mu.Unlock()
		return
	}
	event := Event{
		ID:        task.nextEvent,
		Payload:   payload,
		Source:    source,
		Status:    task.status,
		TaskID:    task.taskID,
		Terminal:  task.status == StatusCompleted || task.status == StatusFailed || task.status == StatusCanceled,
		Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
		Type:      eventType,
		Version:   1,
	}
	task.nextEvent++
	task.events = append(task.events, event)
	listeners := make([]func(Event), 0, len(task.listeners))
	for _, listener := range task.listeners {
		listeners = append(listeners, listener)
	}
	m.mu.Unlock()

	for _, listener := range listeners {
		listener(event)
	}
}

func (m *Manager) snapshot(task *managedTask) Snapshot {
	return Snapshot{
		Error:  task.err,
		Result: task.result,
		Status: task.status,
		TaskID: task.taskID,
	}
}

func IsTerminal(status Status) bool {
	return status == StatusCompleted || status == StatusFailed || status == StatusCanceled
}

func newTaskID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err == nil {
		return hex.EncodeToString(bytes[:])
	}
	return fmt.Sprintf("task_%d", time.Now().UnixNano())
}
