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
  session_key?: string;
}

/**
 * OpenClaw Gateway streaming client.
 * Sends a message via the Next.js API bridge (/api/openclaw) which
 * connects to the Gateway over WebSocket and proxies back SSE events.
 *
 * SSE events:
 *   event: delta  → { delta: "token text" }
 *   event: done   → {}
 *   event: error  → { error: "..." }
 */
export async function* streamOpenClawChat(
  url: string,
  options: OpenClawStreamOptions,
): AsyncGenerator<string, void, unknown> {
  // Build the last user message (the Gateway processes conversation
  // history internally via session state, so we only send the latest message).
  const lastUserMessage =
    options.messages.filter((m) => m.role === 'user').pop()?.content ?? '';

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: lastUserMessage,
      session_key: options.session_key,
      gateway_url: options.gateway_url,
      auth_token: options.auth_token,
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `OpenClaw error: ${response.status} ${response.statusText}${text ? ` – ${text}` : ''}`,
    );
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

    let currentEvent = '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        currentEvent = '';
        continue;
      }
      if (trimmed.startsWith('event: ')) {
        currentEvent = trimmed.slice(7);
        continue;
      }
      if (trimmed.startsWith('data: ')) {
        const data = trimmed.slice(6);
        if (currentEvent === 'delta') {
          try {
            const parsed = JSON.parse(data);
            if (parsed.delta) yield parsed.delta as string;
          } catch {
            /* skip malformed */
          }
        } else if (currentEvent === 'done') {
          return;
        } else if (currentEvent === 'error') {
          try {
            const parsed = JSON.parse(data);
            throw new Error(parsed.error || 'OpenClaw Gateway error');
          } catch (e) {
            if (e instanceof Error && e.message !== 'OpenClaw Gateway error')
              throw e;
            throw new Error('OpenClaw Gateway error');
          }
        }
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
