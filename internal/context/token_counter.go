package context

import "unicode/utf8"

const messageOverheadTokens = 6

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

func EstimateTextTokens(text string) int {
	if text == "" {
		return 0
	}

	runes := utf8.RuneCountInString(text)
	if runes < 4 {
		return 1
	}
	return (runes + 3) / 4
}

func EstimateMessageTokens(message Message) int {
	return messageOverheadTokens + EstimateTextTokens(message.Content)
}

func EstimateMessagesTokens(messages []Message) int {
	total := 0
	for _, message := range messages {
		total += EstimateMessageTokens(message)
	}
	return total
}
