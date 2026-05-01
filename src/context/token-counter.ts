import { encodingForModel } from "js-tiktoken";

export interface ContextMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const MESSAGE_OVERHEAD_TOKENS = 6;

let encoder: ReturnType<typeof encodingForModel> | null = null;

function getEncoder(): ReturnType<typeof encodingForModel> {
  if (!encoder) {
    encoder = encodingForModel("gpt-4");
  }

  return encoder;
}

export function estimateTextTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  return getEncoder().encode(text).length;
}

export function estimateMessageTokens(message: ContextMessage): number {
  return MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(message.content);
}

export function estimateMessagesTokens(messages: ContextMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

export function estimateLooseMessageTokens(message: { content?: string | null }): number {
  return MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(message.content ?? "");
}
