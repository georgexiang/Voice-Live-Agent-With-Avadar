import { NextRequest, NextResponse } from 'next/server';
import WebSocket from 'ws';
import {
  randomUUID,
  generateKeyPairSync,
  createHash,
  createPrivateKey,
  sign,
} from 'crypto';

// --- Ed25519 device identity (generated once per process) ---
const ED25519_SPKI_PREFIX = Buffer.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

const { publicKey: _pubKey, privateKey: _privKey } =
  generateKeyPairSync('ed25519');
const PUBLIC_KEY_PEM = _pubKey
  .export({ type: 'spki', format: 'pem' })
  .toString();
const PRIVATE_KEY_PEM = _privKey
  .export({ type: 'pkcs8', format: 'pem' })
  .toString();
const SPKI_DER = _pubKey.export({ type: 'spki', format: 'der' });
const RAW_PUB_KEY = SPKI_DER.subarray(ED25519_SPKI_PREFIX.length);
const DEVICE_ID = createHash('sha256').update(RAW_PUB_KEY).digest('hex');

function b64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/g, '');
}

function signPayload(payload: string): string {
  return b64url(
    sign(null, Buffer.from(payload, 'utf8'), createPrivateKey(PRIVATE_KEY_PEM)),
  );
}

const RAW_PUB_KEY_B64 = b64url(RAW_PUB_KEY);

// -------------------------------------------------------------------

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/openclaw — WS-to-SSE bridge for OpenClaw Gateway */
export async function POST(request: NextRequest) {
  const body = await request.json();

  const gatewayUrl = (
    body.gateway_url ||
    process.env.OPENCLAW_GATEWAY_URL ||
    'ws://localhost:18789'
  ).replace(/^http/, 'ws'); // ensure ws:// scheme

  const gatewayToken =
    process.env.OPENCLAW_GATEWAY_TOKEN || body.auth_token || '';

  const userMessage: string = body.message || '';
  const isHealthCheck: boolean = body.health_check === true;
  // Use a unique session key per request to avoid Gateway lane contention.
  // The Gateway serialises all chat.send calls for the same sessionKey;
  // reusing 'agent:main:main' caused lane starvation under rapid requests.
  const sessionKey: string =
    body.session_key || `agent:main:web-${randomUUID().slice(0, 8)}`;

  const WS_TIMEOUT_MS = 120_000; // hard timeout per request (model can take 60s+)

  // Health check: only verify WS connection + auth, no chat message needed
  if (isHealthCheck) {
    return new Promise<Response>((resolve) => {
      const ws = new WebSocket(gatewayUrl);
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        resolve(NextResponse.json({ error: 'Gateway timeout' }, { status: 504 }));
      }, 10_000);

      ws.on('error', () => {
        clearTimeout(timer);
        resolve(NextResponse.json({ error: 'Gateway unreachable' }, { status: 502 }));
      });

      ws.on('message', (raw: Buffer | string) => {
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        // Challenge → authenticate
        if (msg.type === 'event' && (msg as { event?: string }).event === 'connect.challenge') {
          const nonce = (msg as { payload?: { nonce?: string } }).payload?.nonce;
          if (!nonce) {
            clearTimeout(timer);
            try { ws.close(); } catch { /* ignore */ }
            resolve(NextResponse.json({ error: 'missing nonce' }, { status: 502 }));
            return;
          }
          const signedAtMs = Date.now();
          const payloadStr = ['v3', DEVICE_ID, 'gateway-client', 'backend', 'operator',
            'operator.admin,operator.read,operator.write,operator.approvals',
            String(signedAtMs), gatewayToken, nonce, process.platform, ''].join('|');
          ws.send(JSON.stringify({
            type: 'req', id: randomUUID(), method: 'connect',
            params: {
              minProtocol: 3, maxProtocol: 3,
              client: { id: 'gateway-client', displayName: 'Health Check', version: '1.0.0',
                platform: process.platform, mode: 'backend', instanceId: randomUUID() },
              caps: [], auth: { token: gatewayToken }, role: 'operator',
              scopes: ['operator.admin', 'operator.read', 'operator.write', 'operator.approvals'],
              device: { id: DEVICE_ID, publicKey: RAW_PUB_KEY_B64,
                signature: signPayload(payloadStr), signedAt: signedAtMs, nonce },
            },
          }));
          return;
        }

        // Auth success → healthy
        if (msg.type === 'res' && msg.ok === true) {
          clearTimeout(timer);
          try { ws.close(1000, 'health check done'); } catch { /* ignore */ }
          resolve(NextResponse.json({ status: 'ok' }));
          return;
        }

        // Auth failure
        if (msg.type === 'res' && msg.ok === false) {
          clearTimeout(timer);
          try { ws.close(); } catch { /* ignore */ }
          const errObj = msg.error as { message?: string } | undefined;
          resolve(NextResponse.json({ error: errObj?.message || 'auth failed' }, { status: 401 }));
        }
      });
    });
  }

  if (!userMessage.trim()) {
    return NextResponse.json(
      { error: 'message is required' },
      { status: 400 },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let connected = false;
      let done = false;

      const ws = new WebSocket(gatewayUrl);

      // Hard timeout – prevents zombie WS connections from blocking the lane
      const wsTimer = setTimeout(() => {
        if (!done) {
          sendSSE(
            'error',
            JSON.stringify({ error: 'Gateway response timeout' }),
          );
          cleanup();
        }
      }, WS_TIMEOUT_MS);

      // SSE keepalive – send a comment every 15s so proxies/browsers don't drop the connection
      const keepaliveTimer = setInterval(() => {
        if (done) return;
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch { /* stream closed */ }
      }, 15_000);

      const sendSSE = (event: string, data: string) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${data}\n\n`),
        );
      };

      const cleanup = () => {
        if (done) return;
        done = true;
        clearTimeout(wsTimer);
        clearInterval(keepaliveTimer);
        try {
          ws.close(1000, 'bridge done');
        } catch {
          /* ignore */
        }
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      };

      // Abort if client disconnects
      request.signal.addEventListener('abort', () => {
        cleanup();
      });

      ws.on('open', () => {
        /* wait for challenge */
      });

      ws.on('error', (err: Error) => {
        sendSSE('error', JSON.stringify({ error: err.message }));
        cleanup();
      });

      ws.on('close', () => {
        cleanup();
      });

      ws.on('message', (raw: Buffer | string) => {
        if (done) return;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }

        // 1) Challenge → respond with device-identity connect
        if (
          msg.type === 'event' &&
          (msg as { event?: string }).event === 'connect.challenge'
        ) {
          const nonce = (msg as { payload?: { nonce?: string } }).payload
            ?.nonce;
          if (!nonce) {
            sendSSE('error', JSON.stringify({ error: 'missing nonce' }));
            cleanup();
            return;
          }

          const signedAtMs = Date.now();
          const role = 'operator';
          const scopes = [
            'operator.admin',
            'operator.read',
            'operator.write',
            'operator.approvals',
          ];
          const clientId = 'gateway-client';
          const clientMode = 'backend';
          const platform = process.platform;

          const payloadStr = [
            'v3',
            DEVICE_ID,
            clientId,
            clientMode,
            role,
            scopes.join(','),
            String(signedAtMs),
            gatewayToken,
            nonce,
            platform,
            '',
          ].join('|');

          ws.send(
            JSON.stringify({
              type: 'req',
              id: randomUUID(),
              method: 'connect',
              params: {
                minProtocol: 3,
                maxProtocol: 3,
                client: {
                  id: clientId,
                  displayName: 'Voice Live Agent Bridge',
                  version: '1.0.0',
                  platform,
                  mode: clientMode,
                  instanceId: randomUUID(),
                },
                caps: [],
                auth: { token: gatewayToken },
                role,
                scopes,
                device: {
                  id: DEVICE_ID,
                  publicKey: RAW_PUB_KEY_B64,
                  signature: signPayload(payloadStr),
                  signedAt: signedAtMs,
                  nonce,
                },
              },
            }),
          );
          return;
        }

        // 2) Connect response → send chat.send
        if (msg.type === 'res' && msg.ok === true && !connected) {
          connected = true;
          ws.send(
            JSON.stringify({
              type: 'req',
              id: randomUUID(),
              method: 'chat.send',
              params: {
                sessionKey,
                idempotencyKey: randomUUID(),
                message: userMessage,
              },
            }),
          );
          return;
        }

        // 3) chat.send error
        if (msg.type === 'res' && msg.ok === false) {
          const errObj = msg.error as { message?: string } | undefined;
          sendSSE(
            'error',
            JSON.stringify({
              error: errObj?.message || 'gateway request failed',
            }),
          );
          cleanup();
          return;
        }

        // 4) Agent streaming tokens
        if (msg.type === 'event') {
          const evt = msg as {
            event?: string;
            payload?: Record<string, unknown>;
          };

          // assistant text delta
          if (evt.event === 'agent') {
            const payload = evt.payload as {
              stream?: string;
              data?: { delta?: string; text?: string; phase?: string };
            } | undefined;

            // lifecycle events → forward as status so UI can show "thinking..."
            if (payload?.stream === 'lifecycle') {
              const phase = payload.data?.phase;
              if (phase === 'start') {
                sendSSE('status', JSON.stringify({ status: 'thinking' }));
              } else if (phase === 'end') {
                sendSSE('done', '{}');
                cleanup();
              }
              return;
            }

            if (payload?.stream === 'assistant' && payload.data?.delta) {
              sendSSE(
                'delta',
                JSON.stringify({ delta: payload.data.delta }),
              );
            }
          }

          // chat final message (backup end signal)
          if (evt.event === 'chat') {
            const payload = evt.payload as {
              state?: string;
              message?: { content?: Array<{ text?: string }> };
            } | undefined;
            if (payload?.state === 'final') {
              sendSSE('done', '{}');
              cleanup();
            }
          }
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
