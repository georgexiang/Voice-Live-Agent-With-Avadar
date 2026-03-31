export interface OpenClawMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OpenClawStreamOptions {
  model: string;
  messages: OpenClawMessage[];
  temperature?: number;
  stream: true;
  signal?: AbortSignal;
  gateway_url?: string;
  auth_token?: string;
}

/**
 * OpenClaw Gateway SSE streaming client.
 * Protocol: OpenAI-compatible /v1/chat/completions with SSE.
 */
export async function* streamOpenClawChat(
  url: string,
  options: OpenClawStreamOptions,
): AsyncGenerator<string, void, unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: options.model,
      messages: options.messages,
      temperature: options.temperature ?? 0.7,
      stream: true,
      ...(options.gateway_url ? { gateway_url: options.gateway_url } : {}),
      ...(options.auth_token ? { auth_token: options.auth_token } : {}),
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(`OpenClaw error: ${response.status} ${response.statusText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      const data = trimmed.slice(6);
      if (data === '[DONE]') return;

      try {
        const parsed = JSON.parse(data);
        const token = parsed.choices?.[0]?.delta?.content;
        if (token) yield token;
      } catch {
        // skip malformed SSE chunks
      }
    }
  }
}

/**
 * Sentence-level buffer: splits a token stream into complete sentences
 * at Chinese/English punctuation boundaries.
 */
export class SentenceBuffer {
  private buffer = '';
  private readonly boundaryPattern = /[。！？.!?\n]/;

  /** Append token, return completed sentences (may be empty array). */
  push(token: string): string[] {
    this.buffer += token;
    const sentences: string[] = [];

    let match: RegExpExecArray | null;
    while ((match = this.boundaryPattern.exec(this.buffer)) !== null) {
      const end = match.index + match[0].length;
      const sentence = this.buffer.slice(0, end).trim();
      if (sentence) sentences.push(sentence);
      this.buffer = this.buffer.slice(end);
    }

    // Prevent unbounded buffering for long text without punctuation
    if (this.buffer.length > 200) {
      const sentence = this.buffer.trim();
      if (sentence) sentences.push(sentence);
      this.buffer = '';
    }

    return sentences;
  }

  /** Flush remaining buffer content, or null if empty. */
  flush(): string | null {
    const remaining = this.buffer.trim();
    this.buffer = '';
    return remaining || null;
  }
}
