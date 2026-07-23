import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

async function getAzureToken(resource: string) {
  const { stdout } = await execFileAsync(
    "az",
    [
      "account",
      "get-access-token",
      "--resource",
      resource,
      "--query",
      "accessToken",
      "-o",
      "tsv",
    ],
    { maxBuffer: 1024 * 1024 }
  );

  return stdout.trim();
}

export async function GET() {
  if (process.env.NODE_ENV !== "development") {
    return new NextResponse(null, { status: 404 });
  }

  let token: string;
  let modelToken: string;
  try {
    [token, modelToken] = await Promise.all([
      getAzureToken("https://ai.azure.com"),
      getAzureToken("https://cognitiveservices.azure.com"),
    ]);
  } catch (error) {
    console.error("Failed to refresh Azure access tokens:", error);
    return NextResponse.json(
      { error: "Unable to refresh Azure access tokens. Check Azure CLI sign-in." },
      { status: 503 }
    );
  }

  return NextResponse.json(
    {
      token,
      endpoint: process.env.VOICE_LIVE_ENDPOINT?.trim(),
      agent: {
        project_name: process.env.VOICE_LIVE_AGENT_PROJECT_NAME?.trim(),
        agents: process.env.VOICE_LIVE_AGENT_ID
          ? [
              {
                id: process.env.VOICE_LIVE_AGENT_ID.trim(),
                name: process.env.VOICE_LIVE_AGENT_ID.trim(),
              },
            ]
          : [],
      },
      model: {
        endpoint: process.env.VOICE_LIVE_MODEL_ENDPOINT?.trim(),
        token: modelToken,
        name: process.env.VOICE_LIVE_MODEL_NAME?.trim(),
      },
    },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0",
        Pragma: "no-cache",
      },
    }
  );
}