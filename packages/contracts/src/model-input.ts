export type ModelProtocol='chat_completions'|'openai_responses'|'anthropic_messages';
export const MODEL_PROTOCOLS=['chat_completions','openai_responses','anthropic_messages']as const;
/** Observed per saved model configuration, never inferred from a model name. */
export type ImageInputSupport = 'passed' | 'unsupported' | 'unknown';
export interface ModelInputCapabilities {
  text: 'passed';
  image: ImageInputSupport;
  testedAt: string;
  probeVersion: 1;
}
export function imageInputEnabled(value: { image?: unknown } | undefined): boolean {
  return value?.image === 'passed';
}
