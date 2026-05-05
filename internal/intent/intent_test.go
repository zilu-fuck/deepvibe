package intent

import "testing"

func TestDetectHeuristicallyClassifiesWriteRequests(t *testing.T) {
	for _, input := range []string{
		"implement a new api endpoint",
		"fix the failing tests",
		"\u7ee7\u7eed\u91cd\u6784\u8fd9\u4e2a\u6a21\u5757",
	} {
		decision := DetectHeuristically(input)
		if !decision.EngineeringIntent || !decision.RequiresWriteAccess || decision.Intent != IntentWrite {
			t.Fatalf("expected write intent for %q, got %#v", input, decision)
		}
	}
}

func TestDetectHeuristicallyClassifiesDiscussionRequests(t *testing.T) {
	for _, input := range []string{
		"explain how this module works",
		"what is the current architecture?",
		"\u89e3\u91ca\u4e00\u4e0b\u8fd9\u6bb5\u4ee3\u7801\u7684\u601d\u8def",
	} {
		decision := DetectHeuristically(input)
		if decision.RequiresWriteAccess {
			t.Fatalf("expected read-only intent for %q, got %#v", input, decision)
		}
	}
}

func TestDetectHeuristicallyClassifiesWritelessEngineering(t *testing.T) {
	decision := DetectHeuristically("design the migration approach")
	if !decision.EngineeringIntent || decision.RequiresWriteAccess || decision.Intent != IntentRead {
		t.Fatalf("expected read engineering intent, got %#v", decision)
	}
}

func TestDetectHeuristicallyClassifiesEmptyAsChat(t *testing.T) {
	decision := DetectHeuristically("  ")
	if decision.EngineeringIntent || decision.RequiresWriteAccess || decision.Intent != IntentChat {
		t.Fatalf("expected empty chat intent, got %#v", decision)
	}
}
