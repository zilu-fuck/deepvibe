package llm

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
)

type FileAction string

const (
	FileActionModify FileAction = "modify"
	FileActionCreate FileAction = "create"
	FileActionDelete FileAction = "delete"
)

type ParsedFileChange struct {
	Action FileAction `json:"action"`
	Diff   string     `json:"diff"`
	Path   string     `json:"path"`
}

type ParsedModelResponse struct {
	Files   []ParsedFileChange `json:"files"`
	Summary string             `json:"summary"`
}

type ParseFailureCode string

const (
	ParseEmptyContent  ParseFailureCode = "EMPTY_CONTENT"
	ParseTruncated     ParseFailureCode = "TRUNCATED"
	ParseInvalidJSON   ParseFailureCode = "INVALID_JSON"
	ParseInvalidSchema ParseFailureCode = "INVALID_SCHEMA"
)

type ParseFailure struct {
	CanRetry   bool             `json:"canRetry"`
	Code       ParseFailureCode `json:"code"`
	Message    string           `json:"message"`
	RawContent string           `json:"rawContent"`
}

type ParseOutcome struct {
	OK    bool                 `json:"ok"`
	Value *ParsedModelResponse `json:"value,omitempty"`
	Error *ParseFailure        `json:"error,omitempty"`
}

func ParseResponse(result DeepSeekCompletionResult) ParseOutcome {
	content := strings.TrimSpace(result.Content)
	if content == "" {
		return parseFailure(ParseEmptyContent, "Model returned an empty content payload.", result.Content, true)
	}
	if result.FinishReason == "length" {
		return parseFailure(ParseTruncated, "Model output was truncated before completion.", result.Content, true)
	}

	var parsed any
	if err := json.Unmarshal([]byte(content), &parsed); err != nil {
		return parseFailure(ParseInvalidJSON, "Model content was not valid JSON.", result.Content, true)
	}

	value, validationError := decodeParsedResponse(parsed)
	if validationError != "" {
		return parseFailure(ParseInvalidSchema, validationError, result.Content, true)
	}

	return ParseOutcome{OK: true, Value: value}
}

func decodeParsedResponse(value any) (*ParsedModelResponse, string) {
	record, ok := value.(map[string]any)
	if !ok {
		return nil, "Top-level response must be a JSON object."
	}

	summary, ok := record["summary"].(string)
	if !ok {
		return nil, `Top-level field "summary" must be a string.`
	}

	rawFiles, ok := record["files"].([]any)
	if !ok {
		return nil, `Top-level field "files" must be an array.`
	}

	files := make([]ParsedFileChange, 0, len(rawFiles))
	for _, rawFile := range rawFiles {
		fileRecord, ok := rawFile.(map[string]any)
		if !ok {
			return nil, `Each item in "files" must be an object.`
		}

		path, ok := fileRecord["path"].(string)
		if !ok || strings.TrimSpace(path) == "" {
			return nil, `Each file item must contain a non-empty string "path".`
		}

		diff, ok := fileRecord["diff"].(string)
		if !ok {
			return nil, `Each file item must contain a string "diff".`
		}

		actionString, ok := fileRecord["action"].(string)
		action := FileAction(actionString)
		if !ok || (action != FileActionModify && action != FileActionCreate && action != FileActionDelete) {
			return nil, `Each file item must contain a valid "action" value.`
		}

		files = append(files, ParsedFileChange{
			Path:   path,
			Action: action,
			Diff:   diff,
		})
	}

	return &ParsedModelResponse{
		Files:   files,
		Summary: summary,
	}, ""
}

func parseFailure(code ParseFailureCode, message string, rawContent string, canRetry bool) ParseOutcome {
	return ParseOutcome{
		OK: false,
		Error: &ParseFailure{
			Code:       code,
			Message:    message,
			RawContent: rawContent,
			CanRetry:   canRetry,
		},
	}
}

type PlanStep struct {
	Index            int      `json:"index"`
	Description      string   `json:"description"`
	Files            []string `json:"files"`
	EstimatedChanges string   `json:"estimatedChanges"`
}

type ParsedPlan struct {
	Overview string     `json:"overview"`
	Steps    []PlanStep `json:"steps"`
	Notes    string     `json:"notes"`
}

type ParsePlanFailureCode string

const (
	ParsePlanEmptyContent  ParsePlanFailureCode = "EMPTY_CONTENT"
	ParsePlanTruncated     ParsePlanFailureCode = "TRUNCATED"
	ParsePlanInvalidJSON   ParsePlanFailureCode = "INVALID_JSON"
	ParsePlanInvalidSchema ParsePlanFailureCode = "INVALID_PLAN_SCHEMA"
)

type ParsePlanFailure struct {
	CanRetry   bool                 `json:"canRetry"`
	Code       ParsePlanFailureCode `json:"code"`
	Message    string               `json:"message"`
	RawContent string               `json:"rawContent"`
}

type ParsePlanOutcome struct {
	OK    bool              `json:"ok"`
	Value *ParsedPlan       `json:"value,omitempty"`
	Error *ParsePlanFailure `json:"error,omitempty"`
}

func ParsePlan(result DeepSeekCompletionResult) ParsePlanOutcome {
	content := strings.TrimSpace(result.Content)
	if content == "" {
		return planFailure(ParsePlanEmptyContent, "Model returned an empty content payload.", result.Content, true)
	}
	if result.FinishReason == "length" {
		return planFailure(ParsePlanTruncated, "Model output was truncated before completion.", result.Content, true)
	}

	var parsed any
	if err := json.Unmarshal([]byte(content), &parsed); err != nil {
		return planFailure(ParsePlanInvalidJSON, "Model content was not valid JSON.", result.Content, true)
	}

	value, validationError := decodePlan(parsed)
	if validationError != "" {
		return planFailure(ParsePlanInvalidSchema, validationError, result.Content, true)
	}

	return ParsePlanOutcome{OK: true, Value: value}
}

func decodePlan(value any) (*ParsedPlan, string) {
	record, ok := value.(map[string]any)
	if !ok {
		return nil, "Plan must be a JSON object."
	}

	overview, ok := record["overview"].(string)
	if !ok || strings.TrimSpace(overview) == "" {
		return nil, `Field "overview" must be a non-empty string.`
	}

	rawSteps, ok := record["steps"].([]any)
	if !ok || len(rawSteps) == 0 {
		return nil, `Field "steps" must be a non-empty array.`
	}

	notes := ""
	if rawNotes, exists := record["notes"]; exists {
		var ok bool
		notes, ok = rawNotes.(string)
		if !ok {
			return nil, `Field "notes" must be a string.`
		}
	}

	steps := make([]PlanStep, 0, len(rawSteps))
	for i, rawStep := range rawSteps {
		stepRecord, ok := rawStep.(map[string]any)
		if !ok {
			return nil, fmt.Sprintf("Step at index %d must be an object.", i)
		}

		indexFloat, ok := stepRecord["index"].(float64)
		if !ok || math.Trunc(indexFloat) != indexFloat || indexFloat < 1 {
			return nil, fmt.Sprintf(`Step at index %d must have a positive integer "index".`, i)
		}

		description, ok := stepRecord["description"].(string)
		if !ok || strings.TrimSpace(description) == "" {
			return nil, fmt.Sprintf(`Step at index %d must have a non-empty "description".`, i)
		}

		rawFiles, ok := stepRecord["files"].([]any)
		if !ok {
			return nil, fmt.Sprintf(`Step at index %d must have a "files" array.`, i)
		}

		files := make([]string, 0, len(rawFiles))
		for j, rawFile := range rawFiles {
			file, ok := rawFile.(string)
			if !ok || strings.TrimSpace(file) == "" {
				return nil, fmt.Sprintf("Step at index %d, file at index %d must be a non-empty string.", i, j)
			}
			files = append(files, file)
		}

		estimatedChanges, ok := stepRecord["estimatedChanges"].(string)
		if !ok {
			return nil, fmt.Sprintf(`Step at index %d must have a string "estimatedChanges".`, i)
		}

		steps = append(steps, PlanStep{
			Index:            int(indexFloat),
			Description:      description,
			Files:            files,
			EstimatedChanges: estimatedChanges,
		})
	}

	return &ParsedPlan{
		Overview: overview,
		Steps:    steps,
		Notes:    notes,
	}, ""
}

func planFailure(code ParsePlanFailureCode, message string, rawContent string, canRetry bool) ParsePlanOutcome {
	return ParsePlanOutcome{
		OK: false,
		Error: &ParsePlanFailure{
			Code:       code,
			Message:    message,
			RawContent: rawContent,
			CanRetry:   canRetry,
		},
	}
}
