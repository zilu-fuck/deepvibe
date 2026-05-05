package task

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestManagerCompletesAndRecordsEvents(t *testing.T) {
	manager := NewManager()
	snapshot := manager.Start(context.Background(), "scan project", func(ctx context.Context, emit func(string, map[string]any, string)) (any, error) {
		emit("engine.progress", map[string]any{"step": "scan"}, "engine")
		return map[string]any{"ok": true}, nil
	})

	completed := waitForStatus(t, manager, snapshot.TaskID, StatusCompleted)
	if completed.Status != StatusCompleted {
		t.Fatalf("expected completed task, got %s", completed.Status)
	}
	if completed.Result == nil {
		t.Fatal("expected task result")
	}

	events, ok := manager.Events(snapshot.TaskID)
	if !ok {
		t.Fatal("expected task events")
	}
	if len(events) < 3 {
		t.Fatalf("expected start/progress/completed events, got %d", len(events))
	}
	if events[0].Type != "task.started" {
		t.Fatalf("expected first event to be task.started, got %s", events[0].Type)
	}
	if events[len(events)-1].Type != "task.completed" || !events[len(events)-1].Terminal {
		t.Fatalf("expected terminal completion event, got %#v", events[len(events)-1])
	}
}

func TestManagerCancel(t *testing.T) {
	manager := NewManager()
	snapshot := manager.Start(context.Background(), "long task", func(ctx context.Context, emit func(string, map[string]any, string)) (any, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	})

	if _, err := manager.Cancel(snapshot.TaskID); err != nil {
		t.Fatalf("cancel task: %v", err)
	}

	canceled := waitForStatus(t, manager, snapshot.TaskID, StatusCanceled)
	if canceled.Status != StatusCanceled {
		t.Fatalf("expected canceled task, got %s", canceled.Status)
	}

	events, _ := manager.Events(snapshot.TaskID)
	var sawCancelRequested bool
	for _, event := range events {
		if event.Type == "task.cancel_requested" {
			sawCancelRequested = true
		}
	}
	if !sawCancelRequested {
		t.Fatal("expected task.cancel_requested event")
	}
}

func TestManagerUnknownCancel(t *testing.T) {
	manager := NewManager()
	if _, err := manager.Cancel("missing"); err == nil {
		t.Fatal("expected unknown task error")
	}
}

func waitForStatus(t *testing.T, manager *Manager, taskID string, status Status) Snapshot {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		snapshot := manager.Get(taskID)
		if snapshot.Status == status {
			return snapshot
		}
		if snapshot.Status == StatusFailed && status != StatusFailed {
			t.Fatalf("task failed: %s", snapshot.Error)
		}
		time.Sleep(10 * time.Millisecond)
	}
	snapshot := manager.Get(taskID)
	t.Fatalf("timed out waiting for status %s, last status %s", status, snapshot.Status)
	return Snapshot{}
}

func TestManagerPropagatesFailure(t *testing.T) {
	manager := NewManager()
	snapshot := manager.Start(context.Background(), "fail", func(ctx context.Context, emit func(string, map[string]any, string)) (any, error) {
		return nil, errors.New("boom")
	})

	failed := waitForStatus(t, manager, snapshot.TaskID, StatusFailed)
	if failed.Error != "boom" {
		t.Fatalf("expected error boom, got %q", failed.Error)
	}
}
