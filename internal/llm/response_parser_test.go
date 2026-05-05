package llm

import (
	"encoding/json"
	"testing"
)

func TestParseResponseValidStructuredResponse(t *testing.T) {
	content, _ := json.Marshal(ParsedModelResponse{
		Files: []ParsedFileChange{
			{
				Path:   "src/api.ts",
				Action: FileActionModify,
				Diff:   "@@ -1 +1 @@",
			},
		},
		Summary: "Updated API handling",
	})
	result := ParseResponse(DeepSeekCompletionResult{
		ID:      "test",
		Content: string(content),
	})

	if !result.OK {
		t.Fatalf("expected success, got %#v", result.Error)
	}
	if result.Value.Summary != "Updated API handling" || len(result.Value.Files) != 1 {
		t.Fatalf("unexpected value: %#v", result.Value)
	}
}

func TestParseResponseFailures(t *testing.T) {
	cases := []struct {
		name         string
		result       DeepSeekCompletionResult
		expectedCode ParseFailureCode
	}{
		{
			name:         "empty",
			result:       DeepSeekCompletionResult{Content: "   "},
			expectedCode: ParseEmptyContent,
		},
		{
			name:         "truncated",
			result:       DeepSeekCompletionResult{Content: `{"files":`, FinishReason: "length"},
			expectedCode: ParseTruncated,
		},
		{
			name:         "invalid json",
			result:       DeepSeekCompletionResult{Content: `{not json}`},
			expectedCode: ParseInvalidJSON,
		},
		{
			name: "invalid schema",
			result: DeepSeekCompletionResult{Content: `{
				"files": [{"path": "src/api.ts", "action": "rewrite", "diff": "@@"}],
				"summary": "bad"
			}`},
			expectedCode: ParseInvalidSchema,
		},
		{
			name: "summary wrong type",
			result: DeepSeekCompletionResult{Content: `{
				"files": [],
				"summary": 123
			}`},
			expectedCode: ParseInvalidSchema,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			result := ParseResponse(tc.result)
			if result.OK {
				t.Fatalf("expected failure, got success")
			}
			if result.Error.Code != tc.expectedCode {
				t.Fatalf("expected %s, got %s", tc.expectedCode, result.Error.Code)
			}
			if !result.Error.CanRetry {
				t.Fatalf("expected retryable failure")
			}
		})
	}
}

func TestParsePlanValid(t *testing.T) {
	result := ParsePlan(DeepSeekCompletionResult{Content: `{
		"overview": "Add auth",
		"steps": [
			{
				"index": 1,
				"description": "Create user model",
				"files": ["src/models/user.ts"],
				"estimatedChanges": "~40 lines"
			}
		],
		"notes": "Requires follow-up"
	}`})

	if !result.OK {
		t.Fatalf("expected success, got %#v", result.Error)
	}
	if result.Value.Overview != "Add auth" || result.Value.Notes != "Requires follow-up" {
		t.Fatalf("unexpected plan: %#v", result.Value)
	}
}

func TestParsePlanAllowsMissingNotes(t *testing.T) {
	result := ParsePlan(DeepSeekCompletionResult{Content: `{
		"overview": "Simple task",
		"steps": [
			{"index": 1, "description": "Do it", "files": [], "estimatedChanges": "~10 lines"}
		]
	}`})

	if !result.OK {
		t.Fatalf("expected success, got %#v", result.Error)
	}
	if result.Value.Notes != "" {
		t.Fatalf("expected empty notes, got %q", result.Value.Notes)
	}
}

func TestParsePlanFailures(t *testing.T) {
	cases := []struct {
		name         string
		result       DeepSeekCompletionResult
		expectedCode ParsePlanFailureCode
	}{
		{"empty", DeepSeekCompletionResult{Content: "  "}, ParsePlanEmptyContent},
		{"truncated", DeepSeekCompletionResult{Content: `{"overview":`, FinishReason: "length"}, ParsePlanTruncated},
		{"invalid json", DeepSeekCompletionResult{Content: `{bad json`}, ParsePlanInvalidJSON},
		{"missing overview", DeepSeekCompletionResult{Content: `{"steps":[{"index":1,"description":"test","files":[],"estimatedChanges":"0"}]}`}, ParsePlanInvalidSchema},
		{"empty steps", DeepSeekCompletionResult{Content: `{"overview":"test","steps":[]}`}, ParsePlanInvalidSchema},
		{"bad index", DeepSeekCompletionResult{Content: `{"overview":"test","steps":[{"index":0,"description":"test","files":[],"estimatedChanges":"0"}]}`}, ParsePlanInvalidSchema},
		{"bad notes", DeepSeekCompletionResult{Content: `{"overview":"test","steps":[{"index":1,"description":"test","files":[],"estimatedChanges":"0"}],"notes":123}`}, ParsePlanInvalidSchema},
		{"bad estimated changes", DeepSeekCompletionResult{Content: `{"overview":"test","steps":[{"index":1,"description":"test","files":[],"estimatedChanges":0}]}`}, ParsePlanInvalidSchema},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			result := ParsePlan(tc.result)
			if result.OK {
				t.Fatal("expected failure")
			}
			if result.Error.Code != tc.expectedCode {
				t.Fatalf("expected %s, got %s", tc.expectedCode, result.Error.Code)
			}
		})
	}
}
