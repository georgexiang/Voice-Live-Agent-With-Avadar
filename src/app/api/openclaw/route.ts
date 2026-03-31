import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL || 'http://localhost:18789';
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;

  const body = await request.json();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (gatewayToken) {
    headers['Authorization'] = `Bearer ${gatewayToken}`;
  }

  const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    return NextResponse.json(
      { error: `Gateway error: ${response.status}` },
      { status: response.status }
    );
  }

  return new NextResponse(response.body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
