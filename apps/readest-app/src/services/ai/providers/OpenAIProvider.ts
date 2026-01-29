import { createOpenAI } from '@ai-sdk/openai';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import type { LanguageModel, EmbeddingModel } from 'ai';
import type { AIProvider, AISettings, AIProviderName } from '../types';
import { aiLogger } from '../logger';
import { AI_TIMEOUTS } from '../utils/retry';

const INTERNAL_API_DOMAIN = 'newapi.prd.intenal';
const INTERNAL_API_IP = '12.0.216.216';

export class OpenAIProvider implements AIProvider {
  id: AIProviderName = 'openai';
  name = 'OpenAI Compatible';
  requiresAuth = false; // Bypass cloud auth since user provides key

  private openai: ReturnType<typeof createOpenAI>;
  private settings: AISettings;
  private effectiveBaseURL: string;
  private extraHeaders: Record<string, string> = {};

  constructor(settings: AISettings) {
    this.settings = settings;
    const rawBaseURL = settings.openAiBaseUrl || 'https://api.openai.com/v1';
    const apiKey = (settings.openAiApiKey || '').trim();

    // Hardcoded internal DNS resolution for newapi
    if (rawBaseURL.includes(INTERNAL_API_DOMAIN)) {
      this.effectiveBaseURL = rawBaseURL.replace(INTERNAL_API_DOMAIN, INTERNAL_API_IP);
      // Important: When hitting the IP directly, we MUST set the Host header
      // so the server knows which virtual host to serve.
      // We assume the port is included in the raw URL or effectively handled.
      // Host header should typically be "hostname:port" if non-standard, or just hostname.
      // We'll extract the authority from the raw URL to be accurate, or fallback to the domain.

      try {
        const urlObj = new URL(rawBaseURL);
        this.extraHeaders['Host'] = urlObj.host; // includes port if present
      } catch (e) {
        // Fallback if URL parsing fails (unlikely given it works in browser)
        this.extraHeaders['Host'] = INTERNAL_API_DOMAIN + ':6363';
      }
    } else {
      this.effectiveBaseURL = rawBaseURL;
    }

    // DEBUG: Log evaluated base URL
    console.log('[OpenAIProvider] Raw Base URL:', rawBaseURL);
    console.log('[OpenAIProvider] Effective Base URL:', this.effectiveBaseURL);

    const extraHeaders = this.extraHeaders;

    this.openai = createOpenAI({
      baseURL: this.effectiveBaseURL,
      apiKey,
      // We rely on fetchWrapper to inject headers, but passing them here helps SDK logic too
      headers: this.extraHeaders,
    });

    aiLogger.provider.init('openai', settings.openAiModel || 'gpt-4o-mini');
  }

  async *streamChat(
    messages: Array<{ role: string; content: string }>,
    systemPrompt: string,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<string> {
    const url = this.effectiveBaseURL
      .replace(/\/responses$/, '/chat/completions')
      .endsWith('/chat/completions')
      ? this.effectiveBaseURL
      : this.effectiveBaseURL.replace(/\/+$/, '') + '/chat/completions';

    console.log('[OpenAIProvider] streamChat to:', url);

    const headers = new Headers({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.settings.openAiApiKey}`,
      ...this.extraHeaders,
    });

    const body = JSON.stringify({
      model: this.settings.openAiModel || 'gpt-4o-mini',
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      stream: true,
    });

    console.log('[OpenAIProvider] Request Body:', body);

    const response = await tauriFetch(url, {
      method: 'POST',
      headers,
      body,
      signal: abortSignal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Chat API Error ${response.status}: ${error}`);
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
        buffer = lines.pop() || ''; // Keep the incomplete line in buffer

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6); // Remove 'data: '
          if (data === '[DONE]') return;

          try {
            const json = JSON.parse(data);
            const content = json.choices?.[0]?.delta?.content;
            if (content) {
              yield content;
            }
          } catch (e) {
            console.warn('[OpenAIProvider] Parse error:', e);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  getModel(): LanguageModel {
    const modelId = this.settings.openAiModel || 'gpt-4o-mini';
    return this.openai(modelId);
  }

  getEmbeddingModel(): EmbeddingModel {
    const embedModel = this.settings.openAiEmbeddingModel || 'text-embedding-3-small';
    return this.openai.embedding(embedModel);
  }

  async isAvailable(): Promise<boolean> {
    return !!this.settings.openAiBaseUrl && !!this.settings.openAiApiKey;
  }

  async healthCheck(): Promise<boolean> {
    if (!this.settings.openAiApiKey) return false;

    try {
      const modelId = this.settings.openAiModel || 'gpt-4o-mini';
      aiLogger.provider.init('openai', `healthCheck starting with model: ${modelId}`);

      // Use effectiveBaseURL which has the IP replaced if needed
      let url = this.effectiveBaseURL;
      if (!url.endsWith('/chat/completions')) {
        url = url.replace(/\/+$/, '') + '/chat/completions';
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), AI_TIMEOUTS.HEALTH_CHECK);

      console.log('Health checking OpenAI at', url, 'with headers', this.extraHeaders);

      const response = await tauriFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.settings.openAiApiKey}`,
          ...this.extraHeaders,
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        // cast response to any because tauriFetch response might slightly differ or be generic
        const error = await (response as unknown as Response)
          .json()
          .catch(() => ({ error: 'Unknown error' }));
        console.error('Health check failed', error);
        throw new Error(
          (error as { error?: { message: string } }).error?.message ||
            `Health check failed: ${response.status}`,
        );
      }

      return true;
    } catch (e) {
      const error = e as Error;
      aiLogger.provider.error('openai', `healthCheck failed: ${error.message}`);
      return false;
    }
  }
}
