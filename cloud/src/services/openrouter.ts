import { config } from '../config.js';

export type OpenRouterContent =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type Message = {
  role: 'user' | 'assistant' | 'system';
  content: string | OpenRouterContent[];
};

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/**
 * Tiny OpenRouter chat-completions client built on Node 20's native fetch.
 * Avoids axios so the runtime image stays small.
 */
export async function chat(
  messages: Message[],
  opts: { maxTokens?: number; temperature?: number } = {},
): Promise<string | null> {
  const { maxTokens = 8192, temperature = 0.2 } = opts;
  if (!config.openRouterApiKey) {
    throw new Error('OPENROUTER_API_KEY is not configured on this Cloud Run service.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(config.openRouterUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openRouterApiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://voiceido.app',
        'X-Title': 'Voiceido Capture',
      },
      body: JSON.stringify({
        model: config.analysisModel,
        messages,
        max_tokens: maxTokens,
        temperature,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const hint =
        response.status === 404
          ? ' (model not found or wrong endpoint — check OPENROUTER_MODEL)'
          : '';
      throw new Error(
        `OpenRouter ${response.status}${hint}: ${detail.slice(0, 240)}`,
      );
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content ?? null;
  } finally {
    clearTimeout(timer);
  }
}
