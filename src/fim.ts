import { loadConfig, requireApiKey } from "./config.js";
import { DeepSeekClient, type CreateFimCompletionOptions, type DeepSeekClient as DeepSeekClientType, type DeepSeekFimCompletionResult } from "./llm/deepseek-client.js";

export interface FimCompletionOptions {
  cwd: string;
  echo?: boolean;
  logprobs?: number;
  maxTokens?: number;
  model?: "deepseek-v4-pro";
  prompt: string;
  stop?: string | string[];
  stream?: boolean;
  suffix?: string;
  temperature?: number;
  topP?: number;
}

export interface FimDependencies {
  createClient?: (apiKey: string) => Partial<Pick<DeepSeekClientType, "createFimCompletion">>;
}

export async function createFimCompletion(
  options: FimCompletionOptions,
  dependencies: FimDependencies = {}
): Promise<DeepSeekFimCompletionResult> {
  const config = loadConfig({ cwd: options.cwd });
  const apiKey = requireApiKey(config);
  const request = {
    echo: options.echo,
    logprobs: options.logprobs,
    maxTokens: options.maxTokens,
    model: options.model ?? "deepseek-v4-pro",
    prompt: options.prompt,
    stop: options.stop,
    stream: options.stream,
    suffix: options.suffix,
    temperature: options.temperature,
    topP: options.topP
  } satisfies CreateFimCompletionOptions;
  const injectedClient = dependencies.createClient?.(apiKey);

  if (injectedClient?.createFimCompletion) {
    return injectedClient.createFimCompletion(request);
  }

  const client = new DeepSeekClient({
    apiKey
  });

  return client.createFimCompletion(request);
}
