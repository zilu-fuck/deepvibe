package model

import (
	"github.com/zilu-fuck/deepvibe/internal/config"
	"github.com/zilu-fuck/deepvibe/internal/llm"
)

const oneMillionTokens = 1_000_000
const sixtyFourKTokens = 64_000

type ExecutionProfile string

const (
	ProfileDefault ExecutionProfile = "default"
	ProfileFlash   ExecutionProfile = "flash"
	ProfileDeep    ExecutionProfile = "deep"
)

type Profile struct {
	ContextLengthTokens   int
	DefaultScanCandidates int
	MaxContextFiles       int
	Model                 config.ModelID
	ReasoningEffort       llm.ReasoningEffort
	ReservedResponseTokens int
}

func ResolveProfile(profile ExecutionProfile) Profile {
	switch profile {
	case ProfileFlash:
		return Profile{
			ContextLengthTokens:   oneMillionTokens,
			DefaultScanCandidates: 12,
			MaxContextFiles:       12,
			Model:                 config.ModelDeepSeekFlash,
			ReasoningEffort:       llm.ReasoningHigh,
			ReservedResponseTokens: sixtyFourKTokens,
		}
	case ProfileDeep:
		return Profile{
			ContextLengthTokens:   oneMillionTokens,
			DefaultScanCandidates: 16,
			MaxContextFiles:       16,
			Model:                 config.ModelDeepSeekPro,
			ReasoningEffort:       llm.ReasoningMax,
			ReservedResponseTokens: sixtyFourKTokens,
		}
	default:
		return Profile{
			ContextLengthTokens:   oneMillionTokens,
			DefaultScanCandidates: 12,
			MaxContextFiles:       12,
			Model:                 config.ModelDeepSeekPro,
			ReasoningEffort:       llm.ReasoningHigh,
			ReservedResponseTokens: sixtyFourKTokens,
		}
	}
}
