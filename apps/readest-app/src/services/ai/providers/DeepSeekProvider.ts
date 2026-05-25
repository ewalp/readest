import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import type { LanguageModel, EmbeddingModel } from 'ai';
import type { AIProvider, AISettings, AIProviderName } from '../types';
import { aiLogger } from '../logger';

export class DeepSeekProvider implements AIProvider {
  id: AIProviderName = 'deepseek';
  name = 'DeepSeek';
  requiresAuth = false;

  private settings: AISettings;
  private effectiveBaseURL: string;

  constructor(settings: AISettings) {
    this.settings = settings;
    const rawBaseURL = settings.deepseekBaseUrl || 'https://api.deepseek.com';
    this.effectiveBaseURL = rawBaseURL;

    console.log('[DeepSeekProvider] Base URL:', this.effectiveBaseURL);
    aiLogger.provider.init('deepseek', settings.deepseekModel || 'deepseek-v4-pro');
  }

  async *streamChat(
    messages: Array<{ role: string; content: string }>,
    systemPrompt: string,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<string> {
    const url = this.effectiveBaseURL.endsWith('/chat/completions')
      ? this.effectiveBaseURL
      : this.effectiveBaseURL.replace(/\/+$/, '') + '/chat/completions';

    console.log('[DeepSeekProvider] streamChat to:', url);

    const headers = new Headers({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.settings.deepseekApiKey}`,
    });

    const body = JSON.stringify({
      model: this.settings.deepseekModel || 'deepseek-v4-pro',
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      stream: true,
      temperature: 0.0, // Minimum temperature to avoid wandering
      thinking: {
        type: 'disabled' // Disable thinking mode
      }
    });

    console.log('[DeepSeekProvider] Request Body:', body);

    const response = await tauriFetch(url, {
      method: 'POST',
      headers,
      body,
      signal: abortSignal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`DeepSeek API Error ${response.status}: ${error}`);
    }

    if (!response.body) throw new Error('No response body');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6);
          if (data === '[DONE]') return;

          try {
            const json = JSON.parse(data);
            const content = json.choices?.[0]?.delta?.content;
            if (content) {
              yield content;
            }
          } catch (e) {
            console.warn('[DeepSeekProvider] Parse error:', e);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  getModel(): LanguageModel {
    throw new Error('DeepSeekProvider.getModel() is deprecated. Use streamChat() instead.');
  }

  getEmbeddingModel(): EmbeddingModel {
    const modelId = this.settings.deepseekEmbeddingModel || 'deepseek-v4-flash';

    return {
      specificationVersion: 'v2',
      provider: 'deepseek',
      modelId,
      maxEmbeddingsPerCall: 9,
      supportsParallelCalls: true,
      doEmbed: async ({
        values,
        abortSignal,
      }: {
        values: Array<string>;
        abortSignal?: AbortSignal;
      }) => {
        const url = this.effectiveBaseURL.endsWith('/embeddings')
          ? this.effectiveBaseURL
          : this.effectiveBaseURL.replace(/\/+$/, '') + '/embeddings';

        const headers = new Headers({
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.settings.deepseekApiKey}`,
        });

        const body = JSON.stringify({
          model: modelId,
          input: values,
          encoding_format: 'float',
        });

        console.log('[DeepSeekProvider] Embedding request to:', url);

        try {
          const response = await tauriFetch(url, {
            method: 'POST',
            headers,
            body,
            signal: abortSignal,
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`DeepSeek Embedding API Error ${response.status}: ${errorText}`);
          }

          const data = (await response.json()) as {
            data: Array<{ embedding: number[]; index: number }>;
            usage?: { prompt_tokens: number; total_tokens: number };
          };

          const sorted = data.data.sort((a, b) => a.index - b.index);

          return {
            embeddings: sorted.map((d) => d.embedding),
            usage: { tokens: data.usage?.total_tokens ?? 0 },
          };
        } catch (error) {
          console.error('[DeepSeekProvider] Embedding failed:', error);
          throw error;
        }
      },
    };
  }

  async isAvailable(): Promise<boolean> {
    return !!this.settings.deepseekApiKey;
  }

  async healthCheck(): Promise<boolean> {
    if (!this.settings.deepseekApiKey) return false;

    try {
      const modelId = this.settings.deepseekModel || 'deepseek-v4-pro';
      let url = this.effectiveBaseURL;
      if (!url.endsWith('/chat/completions')) {
        url = url.replace(/\/+$/, '') + '/chat/completions';
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const response = await tauriFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.settings.deepseekApiKey}`,
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
          temperature: 0.0,
          thinking: { type: 'disabled' }
        }),
        signal: controller.signal,
      });

      const ok = response.ok;
      clearTimeout(timeout);
      return ok;
    } catch {
      return false;
    }
  }
}
