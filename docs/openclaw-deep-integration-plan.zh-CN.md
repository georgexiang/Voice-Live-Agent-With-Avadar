# Voice Live Agent 项目 — OpenClaw 集成可行方案 (综合分析 v3)

> 本文档综合全部技术调研结果, 分析 Voice Live API 内部管道机制, 提出两种可行的
> OpenClaw 集成方案, 并给出详细的实现设计与对比推荐。
>
> 前置文档: [Agent 模式文本-音频-Avatar 流程](agent-mode-text-audio-avatar-flow.zh-CN.md)
> · [Avatar 驱动原理](avatar-driving-principle.zh-CN.md)

---

## 目录

1. [背景: Azure Voice Live API 内部管道工作原理](#1-背景)
2. [核心问题: 为什么不能直接替换 Agent](#2-核心问题)
3. [方案 A: Voice Live API + nano relay](#3-方案-a)
4. [方案 B: Speech SDK AvatarSynthesizer 独立管道](#4-方案-b)
5. [方案对比矩阵](#5-方案对比矩阵)
6. [推荐与决策建议](#6-推荐与决策建议)
7. [方案 A 详细实现设计](#7-方案-a-详细实现设计)
8. [方案 B 详细实现设计](#8-方案-b-详细实现设计)
9. [延迟分析](#9-延迟分析)
10. [实施阶段](#10-实施阶段)

---

## 1. 背景

### 1.1 Agent 模式的内部管道 (关键发现)

通过源码追踪 (`rt-client/dist/esm/index.js` L5255-5276), Agent 模式的服务端管道如下:

```
用户语音 → [Azure STT] → text transcript
                              ↓
                      [Azure AI Agent Service]  ← 内部服务端
                              ↓
                         Agent 回复文本
                              ↓
                      [Azure TTS 合成引擎]  ← 内部服务端, 文本直接传入 TTS
                              ↓
                    语音音频 + Viseme/BlendShapes
                              ↓
                      [WebRTC 推送到客户端]
                              ↓
                    音频播放 + Avatar 唇形同步
```

**关键洞察:** Agent 输出的文本 **直接** 传给 TTS 合成引擎, 中间 **没有任何 LLM 处理**。
这是 100% 文本保真度的原因 — 不是因为中转 LLM 精确, 而是根本不存在中转 LLM。

### 1.2 客户端代码证据

`chat-interface.tsx` L805-930: `handleResponse()` 中, Agent 模式的响应以
`content.type === "audio"` 到达 — 已是 TTS 合成后的音频流, 不是原始文本。
客户端只负责播放和显示 transcript, 不参与 TTS 合成。

```typescript
// content.type === "audio" — 已合成的音频, 直接播放
for await (const audio of content.audioChunks()) {
  audioHandlerRef.current?.playChunk(audio, async () => {
    proactiveManagerRef.current?.updateActivity("agent speaking");
  });
}
```

### 1.3 RTClient 连接差异

| 参数 | Agent 模式 | Model 模式 |
|------|-----------|-----------|
| WebSocket 路径 | `voice-agent/realtime` | `openai/realtime` |
| 查询参数 | `agent_id`, `agent-project-name`, `agent_access_token` | `model` |
| 响应触发 | 服务端自动 (Agent 收到 transcript 自动回复) | 客户端调用 `generateResponse()` |
| 响应格式 | `content.type === "audio"` (已合成) | 取决于 modalities 配置 |

### 1.4 Voice Live API 提供的核心能力

| 能力 | 说明 | 依赖该 API |
|------|------|-----------|
| `azure_deep_noise_suppression` | 服务端深度降噪 | 是 |
| `server_echo_cancellation` | 服务端回声消除 (允许扬声器播放时继续拾音) | 是 |
| `azure_semantic_vad` | 基于语义的语音活动检测 (理解说话人是否真正结束) | 是 |
| `remove_filler_words` | 自动去除"嗯、啊"等填充词 | 是 |
| Avatar WebRTC 通道 | 通过 `configure()` + `connectAvatar()` 建立 | 是 |
| STT (azure-fast-transcription) | 服务端语音识别 | 是 |
| TTS (azure 标准/自定义语音) | 服务端语音合成 | 是 |

---

## 2. 核心问题

### 2.1 为什么不能直接替换 Agent

当我们用 OpenClaw 替代 Azure AI Agent Service 时, 面临一个 **架构断裂**:

```
❌ 不存在的 API:

用户语音 → [Azure STT] → transcript
                              ↓
                       [OpenClaw Gateway]  ← 外部服务
                              ↓
                      OpenClaw 回复文本
                              ↓
                 >>> 没有 API 直接注入文本到 Azure 内部 TTS <<<
```

Azure Voice Live API 的 "Agent → TTS" 通道是 **服务端内部管道**, 外部不可访问。
`RTClient` SDK 没有 `speakText(text)` 这样的方法。

### 2.2 两种可行的绕过方式

| | 方案 A | 方案 B |
|---|---|---|
| **思路** | 保留 Voice Live API, 用 gpt-4.1-nano 作为 relay model "朗读" OpenClaw 文本 | 放弃 Voice Live API 的 TTS/Avatar 管道, 用 Speech SDK `AvatarSynthesizer` 直接驱动 |
| **文本保真度** | ~95% (nano 是 LLM, 可能微改) | 100% (直接传文本) |
| **保留 Voice Live 能力** | 全部保留 (降噪/回声消除/语义 VAD/Avatar) | 仅保留 STT (或也替换); 降噪/回声消除/VAD 需自行实现 |
| **代码改动量** | 中等 (~300 行新增/修改) | 较大 (~500+ 行, 需重建 WebRTC + TTS 管道) |

---

## 3. 方案 A: Voice Live API + nano relay

### 3.1 架构

```
用户语音 → [Azure Voice Live API (STT + 降噪 + 回声消除 + 语义 VAD)]
                              ↓
                     STT transcript (input_audio 事件)
                              ↓
              [OpenClaw Gateway (localhost:18789)] SSE 流式
                              ↓
                      OpenClaw 回复 (逐 token 到达)
                              ↓
                     句级缓冲 (遇到句号/问号/感叹号分割)
                              ↓
              [RTClient.sendItem() + generateResponse()]
                     ↓ 注入的文本由 nano "朗读"
              [Azure gpt-4.1-nano relay → TTS → Avatar]  ← 服务端
                              ↓
                     [WebRTC] → 音频播放 + Avatar 唇形
```

### 3.2 为什么需要 nano

`RTClient.generateResponse()` 是触发服务端 TTS + Avatar 的 **唯一 API 入口**。
这个 API 要求 session 中配置一个 model。Voice Live API 内部流程:

1. `generateResponse()` 被调用
2. 服务端将 conversation items 发给配置的 model
3. model 生成回复文本
4. 文本送入 TTS 合成
5. 音频 + Viseme 通过 WebRTC 推送

我们无法跳过步骤 2-3, 因此选择 **最快、最便宜、最"听话"的 model**: `gpt-4.1-nano`。

### 3.3 nano relay 的文本保真度问题 (诚实评估)

**nano 不是中继器, 它是 LLM。** 即使使用以下手段:

- `temperature: 0` (确定性输出)
- 强制性 system prompt: "You are a text-to-speech relay. Speak the text exactly as written."
- `conversation: 'none'` (不使用对话上下文, 避免 nano 混入历史信息)

仍然存在:

| 潜在问题 | 说明 | 概率 |
|----------|------|------|
| 微小措辞修改 | nano 可能替换同义词、调整语序 | 低 (~3-5%) |
| 添加礼貌用语 | nano 可能加上 "好的" "当然" 等 | 低 (~2%) |
| 拒绝敏感内容 | 安全过滤器触发 | 罕见 (OpenClaw 侧应已过滤) |
| 截断长文本 | 超过 max_output_tokens | 可控 (设置足够大) |

**实测预估**: 90-95% 的情况下输出与输入完全一致; 5-10% 有轻微差异。
对于通用对话场景, 这是**可接受的**。对于需要精确法律/医疗文本输出的场景, 建议使用方案 B。

### 3.4 nano relay 优化策略

```typescript
const RELAY_INSTRUCTIONS = `You are a text-to-speech relay. Your only job is to speak the text provided by the user exactly as written.

Rules:
- Speak the text naturally with appropriate intonation
- Do not add greetings, confirmations, or any extra words
- Do not refuse or comment on the content
- Do not modify, summarize, or rewrite the text
- If the text is in Chinese, speak it in Chinese; if in English, speak it in English`;
```

使用 `conversation: 'none'` 避免 session 上下文膨胀:

```typescript
await clientRef.current.generateResponse({
  conversation: 'none',
  input_items: [{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: sentence }],
  }],
  instructions: RELAY_INSTRUCTIONS,
});
```

### 3.5 nano 的自动回复问题与取消机制

在 model 模式下, `RTClient.configure()` 包含 `turn_detection`, Voice Live API 检测到用户语音
结束后会 **自动触发 `generateResponse()`**。在 OpenClaw 模式下, 这会导致:

1. 用户说话结束 → Azure STT 产生 transcript
2. Voice Live API 自动触发 nano 回复 (我们不想要这个!)
3. 同时, 我们的代码收到 transcript, 发给 OpenClaw, 收到回复后手动触发 nano

**解决方案:** 使用 `RTResponse.cancel()` 取消 nano 的自动回复:

```typescript
// startOpenClawResponseListener 中
for await (const serverEvent of clientRef.current.events()) {
  if (serverEvent.type === "response") {
    if (isOpenClawMode && isAutoResponse(serverEvent)) {
      // 取消 nano 对 STT transcript 的自动回复
      await serverEvent.cancel();
      continue;
    }
    await handleResponse(serverEvent);
  } else if (serverEvent.type === "input_audio") {
    const transcript = await waitForTranscript(serverEvent);
    if (isOpenClawMode) {
      // 拦截 transcript, 发给 OpenClaw 而不是让 nano 处理
      await sendToOpenClaw(transcript);
    }
  }
}
```

`RTResponse.cancel()` 的实现在 `rt-client/dist/esm/index.js` L6302-6330, 它发送
`{ type: "response.cancel" }` 到服务端, 终止当前 response 的生成和 TTS 合成。

**更优方案: 关闭 turn_detection 的自动回复**

如果 Voice Live API 支持仅 STT (不自动触发 response), 可在 `configure()` 中设置
`turn_detection` 但不配置 model 的 auto-respond 行为。需要测试此 API 行为。

---

## 4. 方案 B: Speech SDK AvatarSynthesizer 独立管道

### 4.1 架构

```
用户语音 → [麦克风捕获 (浏览器 MediaRecorder/Web Audio API)]
                              ↓
           [Azure STT] (通过 Speech SDK SpeechRecognizer 或保留 Voice Live STT)
                              ↓
                     STT transcript
                              ↓
              [OpenClaw Gateway (localhost:18789)] SSE 流式
                              ↓
                      OpenClaw 回复 (逐 token 到达)
                              ↓
                     句级缓冲 (遇到句号/问号/感叹号分割)
                              ↓
           [Speech SDK AvatarSynthesizer.speakTextAsync(sentence)]
                              ↓
              Azure TTS 合成 → 音频 + Viseme/BlendShapes
                              ↓
                     [WebRTC] → 音频播放 + Avatar 唇形
```

### 4.2 AvatarSynthesizer API (来自官方文档)

```typescript
import * as SpeechSDK from 'microsoft-cognitiveservices-speech-sdk';

// 1. 创建语音配置
const speechConfig = SpeechSDK.SpeechConfig.fromSubscription(subscriptionKey, region);
speechConfig.speechSynthesisVoiceName = "zh-CN-XiaoxiaoMultilingualNeural";

// 2. 创建 Avatar 配置
const avatarConfig = new SpeechSDK.AvatarConfig(
  "lisa",          // character
  "casual-sitting" // style
);
avatarConfig.videoFormat = new SpeechSDK.AvatarVideoFormat();
avatarConfig.videoFormat.setCropRange(
  new SpeechSDK.Coordinate(600, 0),
  new SpeechSDK.Coordinate(1320, 1080)
);

// 3. 创建 AvatarSynthesizer
const avatarSynthesizer = new SpeechSDK.AvatarSynthesizer(speechConfig, avatarConfig);

// 4. 建立 WebRTC 连接
const peerConnection = new RTCPeerConnection();
// ... 设置 ontrack 回调 (与现有 setupPeerConnection 类似)
const result = await avatarSynthesizer.startAvatarAsync(peerConnection);

// 5. 直接传文本驱动 Avatar (100% 保真度!)
await avatarSynthesizer.speakTextAsync("你好, 这是 OpenClaw 的回复");

// 6. 停止说话 (用于用户打断)
await avatarSynthesizer.stopSpeakingAsync();
```

### 4.3 官方 chat.js 示例的关键模式

Azure 官方 `chat.js` 示例展示了 "LLM 流式 → 句级分割 → AvatarSynthesizer" 的完整模式:

```javascript
// 从 Azure OpenAI 流式获取文本
for await (const event of response) {
  const token = event.choices[0]?.delta?.content;
  if (token) {
    assistantReply += token;
    // 句级分割
    if (isSentenceBoundary(assistantReply, spokenSentence)) {
      const sentence = assistantReply.substring(spokenSentence.length).trim();
      spokenSentence = assistantReply;
      // 直接传给 AvatarSynthesizer
      avatarSynthesizer.speakSsmlAsync(buildSsml(sentence));
    }
  }
}
```

这与我们的需求完全匹配 — 只需把 "Azure OpenAI" 替换为 "OpenClaw Gateway"。

### 4.4 方案 B 失去的能力

| 失去的能力 | 影响 | 替代方案 |
|-----------|------|---------|
| `azure_deep_noise_suppression` | 嘈杂环境下语音识别准确率下降 | 浏览器端 `noiseSuppression: true` (效果较弱) |
| `server_echo_cancellation` | 扬声器播放时拾音困难, 可能自听自说 | 浏览器端 `echoCancellation: true` (效果不稳定) |
| `azure_semantic_vad` | 用普通 VAD 替代, 可能误判说话结束 | Speech SDK 提供的 VAD 或自行实现 |
| `remove_filler_words` | 填充词 "嗯" "啊" 会出现在 transcript 中 | 客户端文本处理过滤 |
| Voice Live API 统一 WebSocket | 需要分别管理 STT 连接和 TTS/Avatar 连接 | 两个独立连接 |

### 4.5 方案 B 的 STT 选择

**选项 B-1: 保留 Voice Live API 做 STT (推荐)**

仍然创建 RTClient 连接, 但只用它做 STT (配置 nano model 但不使用其回复):

```typescript
// 连接 Voice Live API, 仅用于 STT + 降噪 + 回声消除
const client = new RTClient(url, auth, { modelOrAgent: "gpt-4.1-nano", ... });
await client.configure({
  input_audio_transcription: {
    model: "azure-fast-transcription",
    language: recognitionLanguage === "auto" ? undefined : recognitionLanguage,
  },
  turn_detection: turnDetectionType,
  input_audio_noise_reduction: useNS
    ? { type: "azure_deep_noise_suppression" } : null,
  input_audio_echo_cancellation: useEC
    ? { type: "server_echo_cancellation" } : null,
  modalities: ["text", "audio"],
  avatar: undefined,     // 不通过 Voice Live 驱动 Avatar
  tools: undefined,
  temperature: 0,
});
```

这样保留了降噪和回声消除, 但 Avatar 由独立的 AvatarSynthesizer 驱动。

**选项 B-2: 完全使用 Speech SDK**

```typescript
// Speech SDK SpeechRecognizer 做 STT
const audioConfig = SpeechSDK.AudioConfig.fromDefaultMicrophoneInput();
const recognizer = new SpeechSDK.SpeechRecognizer(speechConfig, audioConfig);
recognizer.recognized = (s, e) => {
  if (e.result.reason === SpeechSDK.ResultReason.RecognizedSpeech) {
    sendToOpenClaw(e.result.text);
  }
};
recognizer.startContinuousRecognitionAsync();
```

失去全部 Voice Live API 增强能力, 但架构最简单。

---

## 5. 方案对比矩阵

| 维度 | 方案 A (nano relay) | 方案 B-1 (混合: VoiceLive STT + AvatarSynthesizer) | 方案 B-2 (纯 Speech SDK) |
|------|--------------------|----------------------------------------------------|--------------------------|
| **文本保真度** | ~95% | **100%** | **100%** |
| **降噪** | ✅ deep noise suppression | ✅ deep noise suppression | ❌ 浏览器端 |
| **回声消除** | ✅ server echo cancel | ✅ server echo cancel | ❌ 浏览器端 |
| **语义 VAD** | ✅ semantic VAD | ✅ semantic VAD | ❌ 需自行实现 |
| **Avatar** | ✅ Voice Live 内部驱动 | ✅ AvatarSynthesizer 驱动 | ✅ AvatarSynthesizer |
| **STT** | ✅ azure-fast-transcription | ✅ azure-fast-transcription | ✅ SpeechRecognizer |
| **自定义语音 (CNV)** | ✅ 原生支持 | ✅ 通过 SSML | ✅ 通过 SSML |
| **代码改动量** | ~300 行 | ~500+ 行 | ~400+ 行 |
| **新增依赖** | 无 | `speech-sdk` | `speech-sdk` |
| **WebRTC 连接数** | 1 (Voice Live) | 2 (Voice Live + AvatarSynthesizer) | 1 (AvatarSynthesizer) |
| **额外 Azure 成本** | nano token (~$0.001/1K) | 双 session (RTClient + AvatarSynthesizer) | Speech 资源 |
| **首段延迟** | 550-2450ms | 500-2400ms | 500-2400ms |
| **适用场景** | 通用对话, 客服 | 精确文本 + 高质量语音 | 简单场景, 安静环境 |

---

## 6. 推荐与决策建议

### 6.1 场景化推荐

| 如果你的优先级是... | 推荐 | 理由 |
|---|---|---|
| **快速上线 + 最小改动** | 方案 A | 保留全部 Voice Live 管道, 仅新增 OpenClaw 调用层 |
| **100% 文本保真度** | 方案 B-1 | 保留降噪/回声消除 + 直接文本驱动 Avatar |
| **语音质量 (嘈杂环境)** | 方案 A 或 B-1 | 必须保留服务端降噪/回声消除 |
| **最低代码复杂度** | 方案 A | 在现有架构上增量开发 |
| **最低 Azure 成本** | 方案 B-2 | 无 nano token, 无 Voice Live session |
| **最佳综合效果** | 方案 B-1 | 保留 Voice Live STT 四大增强 + 100% 文本保真 Avatar |

### 6.2 建议的实施路径

```
阶段 1: 实现方案 A (nano relay) — 快速验证 OpenClaw 集成可行性
    ↓
阶段 2: 评估 nano 文本保真度是否满足业务需求
    ↓
如果满足 → 完成, 持续优化
如果不满足 → 实施方案 B-1 (保留 Voice Live STT, 替换 TTS/Avatar 为 AvatarSynthesizer)
```

方案 A 的改动完全**不冲突**于后续切换到方案 B-1:
- OpenClaw 客户端代码可复用
- API 代理路由可复用
- 句级分割逻辑可复用
- UI 模式选择器可复用

---

## 7. 方案 A 详细实现设计

### 7.1 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/lib/openclaw-client.ts` | **新建** | OpenClaw Gateway SSE 流式客户端 |
| `src/app/api/openclaw/route.ts` | **新建** | Next.js API Route 代理 (避免 CORS) |
| `src/app/chat-interface.tsx` | **修改** | mode 扩展, OpenClaw 响应逻辑, UI |
| `next.config.ts` | **修改** | 移除 `output: 'export'` |
| `.env.local` | **修改** | 新增 OpenClaw 配置 |

### 7.2 新建: `src/lib/openclaw-client.ts`

```typescript
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
}

/**
 * OpenClaw Gateway SSE 流式客户端
 * 协议: OpenAI 兼容 /v1/chat/completions
 */
export async function* streamOpenClawChat(
  gatewayUrl: string,
  options: OpenClawStreamOptions,
  authToken?: string,
): AsyncGenerator<string, void, unknown> {
  const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
    body: JSON.stringify({
      model: options.model,
      messages: options.messages,
      temperature: options.temperature ?? 0.7,
      stream: true,
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
 * 句级缓冲器: 将 token 流分割为完整句子
 */
export class SentenceBuffer {
  private buffer = '';
  // 中英文句末标点
  private readonly boundaryPattern = /[。！？.!?\n]/;

  /** 追加 token, 返回已完成的句子 (可能为空数组) */
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

    // 防止无标点长文本无限缓冲
    if (this.buffer.length > 200) {
      const sentence = this.buffer.trim();
      if (sentence) sentences.push(sentence);
      this.buffer = '';
    }

    return sentences;
  }

  /** 刷新缓冲区, 返回剩余内容 */
  flush(): string | null {
    const remaining = this.buffer.trim();
    this.buffer = '';
    return remaining || null;
  }
}
```

### 7.3 新建: `src/app/api/openclaw/route.ts`

```typescript
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

  // 透传 SSE 流
  return new NextResponse(response.body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
```

### 7.4 修改: `chat-interface.tsx` 核心逻辑

#### 7.4.1 Mode 类型扩展

```typescript
// 当前:
const [mode, setMode] = useState<"model" | "agent">("model");

// 修改后:
const [mode, setMode] = useState<"model" | "agent" | "openclaw">("model");

// 新增 OpenClaw 配置状态
const [openclawModel, setOpenclawModel] = useState("default");
const [openclawGatewayUrl, setOpenclawGatewayUrl] = useState("http://localhost:18789");
const [openclawAuthToken, setOpenclawAuthToken] = useState("");

// 新增 ref
const openclawAbortRef = useRef<AbortController | null>(null);
const openclawHistoryRef = useRef<OpenClawMessage[]>([]);
```

#### 7.4.2 handleConnect: OpenClaw 分支

```typescript
const handleConnect = async () => {
  if (!isConnected) {
    try {
      setIsConnecting(true);

      if (mode === "openclaw") {
        // 健康检查: 验证 OpenClaw Gateway 可达
        try {
          const healthResp = await fetch(`/api/openclaw`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: openclawModel,
              messages: [{ role: "user", content: "ping" }],
              max_tokens: 1,
            }),
          });
          if (!healthResp.ok) throw new Error(`Gateway returned ${healthResp.status}`);
        } catch (e) {
          setMessages(prev => [...prev, {
            type: "error",
            content: `OpenClaw Gateway 不可达: ${e}`,
          }]);
          return;
        }

        // 使用 nano 作为 relay model 连接 Voice Live API
        clientRef.current = new RTClient(
          new URL(endpoint),
          clientAuth,
          {
            modelOrAgent: "gpt-4.1-nano",
            apiVersion: "2025-05-01-preview",
          }
        );

        // configure: 保留全部音频增强 + Avatar, 但 instructions 设为 relay
        const session = await clientRef.current.configure({
          instructions: RELAY_INSTRUCTIONS,
          input_audio_transcription: {
            model: "azure-fast-transcription",
            language: recognitionLanguage === "auto" ? undefined : recognitionLanguage,
          },
          turn_detection: turnDetectionType,
          voice: voice,
          avatar: getAvatarConfig(),
          tools: undefined,  // OpenClaw 模式不需要 tools
          temperature: 0,    // nano relay 需要确定性输出
          modalities: ["text", "audio"],
          input_audio_noise_reduction: useNS
            ? { type: "azure_deep_noise_suppression" } : null,
          input_audio_echo_cancellation: useEC
            ? { type: "server_echo_cancellation" } : null,
        });

        if (session?.avatar) {
          await getLocalDescription(session.avatar?.ice_servers);
        }

        // 初始化 OpenClaw 对话历史
        openclawHistoryRef.current = [];
        if (instructions?.length > 0) {
          openclawHistoryRef.current.push({
            role: 'system',
            content: instructions,
          });
        }

        startOpenClawResponseListener();  // 使用 OpenClaw 专用事件监听

        setIsConnected(true);
        setMessages(prev => [...prev, {
          type: "status",
          content: `Connected to OpenClaw (model: ${openclawModel}, relay: gpt-4.1-nano)`,
        }]);
        return;
      }

      // ... 原有 model/agent handleConnect 逻辑不变
    } finally {
      setIsConnecting(false);
    }
  }
};
```

#### 7.4.3 OpenClaw 专用事件监听器 (核心!)

```typescript
const startOpenClawResponseListener = async () => {
  if (!clientRef.current) return;

  try {
    for await (const serverEvent of clientRef.current.events()) {
      if (serverEvent.type === "response") {
        // 区分: nano 自动回复 vs 我们手动触发的 relay 回复
        if (isNanoAutoResponse(serverEvent)) {
          // 取消 nano 对 STT transcript 的自动回复
          await serverEvent.cancel();
          continue;
        }
        // 我们通过 injectToAzureTTS 触发的 relay 回复, 正常处理
        await handleResponse(serverEvent);

      } else if (serverEvent.type === "input_audio") {
        // 用户说话结束, 拿到 transcript
        isUserSpeaking.current = true;
        audioHandlerRef.current?.stopStreamingPlayback();
        await serverEvent.waitForCompletion();
        isUserSpeaking.current = false;

        const transcript = serverEvent.transcription || "";
        if (!transcript.trim()) continue;

        // 显示用户消息
        setMessages(prev => [...prev, { type: "user", content: transcript }]);

        // 取消上一次 OpenClaw 请求 (如果还在进行中)
        openclawAbortRef.current?.abort();

        // 发给 OpenClaw
        await sendToOpenClaw(transcript);
      }
    }
  } catch (error) {
    console.error("OpenClaw response listener error:", error);
  }
};

/**
 * 判断是否为 nano 自动回复 (由 turn_detection 触发)
 * vs 我们手动 generateResponse() 触发的 relay 回复
 */
let pendingRelayCount = 0;  // 追踪我们主动触发的 generateResponse 数量

const isNanoAutoResponse = (response: RTResponse): boolean => {
  if (pendingRelayCount > 0) {
    pendingRelayCount--;
    return false;  // 这是我们触发的
  }
  return true;  // 这是 nano 自动回复, 取消
};
```

#### 7.4.4 sendToOpenClaw + sentence-level TTS 注入

```typescript
const sendToOpenClaw = async (userMessage: string) => {
  // 更新对话历史
  openclawHistoryRef.current.push({ role: 'user', content: userMessage });

  const abortController = new AbortController();
  openclawAbortRef.current = abortController;

  const sentenceBuffer = new SentenceBuffer();
  let fullResponse = '';

  // 创建助手消息占位符
  const assistantMessage: Message = { type: "assistant", content: "" };
  setMessages(prev => [...prev, assistantMessage]);

  try {
    for await (const token of streamOpenClawChat(
      '/api/openclaw',  // 通过 API Route 代理
      {
        model: openclawModel,
        messages: [...openclawHistoryRef.current],
        stream: true,
        signal: abortController.signal,
      }
    )) {
      fullResponse += token;

      // 实时更新显示
      assistantMessage.content = fullResponse;
      setMessages(prev => [...prev]);

      // 句级分割并注入 TTS
      const sentences = sentenceBuffer.push(token);
      for (const sentence of sentences) {
        await injectToAzureTTS(sentence);
      }
    }

    // 处理缓冲区中剩余文本
    const remaining = sentenceBuffer.flush();
    if (remaining) {
      await injectToAzureTTS(remaining);
    }

    // 记录助手回复到历史
    openclawHistoryRef.current.push({ role: 'assistant', content: fullResponse });

  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      console.log('OpenClaw request cancelled (user interrupted)');
    } else {
      console.error('OpenClaw streaming error:', error);
      setMessages(prev => [...prev, {
        type: "error",
        content: "OpenClaw error: " + (error instanceof Error ? error.message : String(error)),
      }]);
    }
  }
};

/**
 * 将一句文本注入 Azure Voice Live API, 通过 nano relay → TTS → Avatar
 */
const injectToAzureTTS = async (sentence: string) => {
  if (!clientRef.current || !sentence.trim()) return;

  pendingRelayCount++;
  await clientRef.current.generateResponse({
    conversation: 'none',
    input_items: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: sentence }],
    }],
    instructions: RELAY_INSTRUCTIONS,
  });
};
```

#### 7.4.5 用户打断处理

```typescript
// 在 sendToOpenClaw 中已处理: OpenClaw 请求通过 AbortController 取消
// 在 startOpenClawResponseListener 中已处理: 收到 input_audio 时停止播放

// 额外: 断开连接时清理
const disconnect = () => {
  openclawAbortRef.current?.abort();
  openclawHistoryRef.current = [];
  pendingRelayCount = 0;
  // ... 原有 disconnect 逻辑
};
```

#### 7.4.6 sendMessage (文本输入)

```typescript
const sendMessage = async () => {
  if (currentMessage.trim() && clientRef.current) {
    const msg = currentMessage;
    setCurrentMessage("");
    setMessages(prev => [...prev, { type: "user", content: msg }]);

    if (mode === "openclaw") {
      // OpenClaw 模式: 直接发给 OpenClaw, 不通过 RTClient.sendItem()
      await sendToOpenClaw(msg);
    } else {
      // 原有 model/agent 逻辑
      const item = await clientRef.current.sendItem({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: msg }],
      });
      await clientRef.current.generateResponse();
    }
  }
};
```

### 7.5 修改: `next.config.ts`

```typescript
// 移除 output: 'export' 以支持 API Routes
const nextConfig: NextConfig = {
  // output: 'export', // 已移除
  webpack: (config, { isServer }) => { ... },
};
```

### 7.6 修改: `.env.local`

```bash
# 现有配置 (保持不变)
# AZURE_ENDPOINT=...
# AZURE_API_KEY=...

# OpenClaw 配置 (新增)
OPENCLAW_GATEWAY_URL=http://localhost:18789
OPENCLAW_GATEWAY_TOKEN=                       # 可选
```

---

## 8. 方案 B 详细实现设计

### 8.1 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/lib/openclaw-client.ts` | **新建** | 与方案 A 相同 |
| `src/lib/avatar-synthesizer.ts` | **新建** | AvatarSynthesizer 封装 |
| `src/app/api/openclaw/route.ts` | **新建** | 与方案 A 相同 |
| `src/app/chat-interface.tsx` | **修改** | mode 扩展 + AvatarSynthesizer 集成 |
| `next.config.ts` | **修改** | 移除 `output: 'export'` |
| `.env.local` | **修改** | 新增配置 |
| `package.json` | **修改** | 新增 `microsoft-cognitiveservices-speech-sdk` |

### 8.2 新建: `src/lib/avatar-synthesizer.ts`

```typescript
import * as SpeechSDK from 'microsoft-cognitiveservices-speech-sdk';

export interface AvatarSynthesizerOptions {
  subscriptionKey: string;
  region: string;
  voiceName: string;
  avatarCharacter: string;
  avatarStyle: string;
  videoContainer: HTMLDivElement;
}

export class AvatarTTSManager {
  private synthesizer: SpeechSDK.AvatarSynthesizer | null = null;
  private peerConnection: RTCPeerConnection | null = null;
  private options: AvatarSynthesizerOptions;

  constructor(options: AvatarSynthesizerOptions) {
    this.options = options;
  }

  async connect(): Promise<void> {
    const speechConfig = SpeechSDK.SpeechConfig.fromSubscription(
      this.options.subscriptionKey,
      this.options.region,
    );
    speechConfig.speechSynthesisVoiceName = this.options.voiceName;

    const avatarConfig = new SpeechSDK.AvatarConfig(
      this.options.avatarCharacter,
      this.options.avatarStyle,
    );

    this.synthesizer = new SpeechSDK.AvatarSynthesizer(speechConfig, avatarConfig);

    // 建立 WebRTC 连接
    this.peerConnection = new RTCPeerConnection();
    this.peerConnection.ontrack = (event) => {
      const el = document.createElement(event.track.kind) as HTMLMediaElement;
      el.id = event.track.kind;
      el.srcObject = event.streams[0];
      el.autoplay = true;
      this.options.videoContainer.appendChild(el);
    };
    this.peerConnection.addTransceiver('video', { direction: 'sendrecv' });
    this.peerConnection.addTransceiver('audio', { direction: 'sendrecv' });

    const result = await this.synthesizer.startAvatarAsync(this.peerConnection);
    if (result.reason === SpeechSDK.ResultReason.SynthesizingAudioCompleted) {
      console.log('Avatar connected');
    } else {
      throw new Error(`Avatar connection failed: ${result.errorDetails}`);
    }
  }

  /** 直接传文本驱动 Avatar — 100% 保真 */
  async speakText(text: string): Promise<void> {
    if (!this.synthesizer) throw new Error('Not connected');
    const result = await this.synthesizer.speakTextAsync(text);
    if (result.reason !== SpeechSDK.ResultReason.SynthesizingAudioCompleted) {
      console.warn('TTS warning:', result.errorDetails);
    }
  }

  /** 用户打断: 停止当前语音 */
  async stopSpeaking(): Promise<void> {
    if (this.synthesizer) {
      await this.synthesizer.stopSpeakingAsync();
    }
  }

  async disconnect(): Promise<void> {
    if (this.synthesizer) {
      await this.synthesizer.stopSpeakingAsync();
      this.synthesizer.close();
      this.synthesizer = null;
    }
    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }
  }
}
```

### 8.3 混合 B-1: 保留 Voice Live STT + AvatarSynthesizer TTS

核心差异: `handleConnect` 建立 **两个** 连接:

```typescript
// 1. RTClient — 仅用于 STT + 降噪 + 回声消除 + VAD
clientRef.current = new RTClient(url, auth, { modelOrAgent: "gpt-4.1-nano", ... });
await clientRef.current.configure({
  input_audio_transcription: { model: "azure-fast-transcription", ... },
  turn_detection: turnDetectionType,
  input_audio_noise_reduction: useNS
    ? { type: "azure_deep_noise_suppression" } : null,
  input_audio_echo_cancellation: useEC
    ? { type: "server_echo_cancellation" } : null,
  modalities: ["text", "audio"],
  avatar: undefined,        // Avatar 由 AvatarSynthesizer 管理
  tools: undefined,
  temperature: 0,
});

// 2. AvatarSynthesizer — 用于 TTS + Avatar
avatarManagerRef.current = new AvatarTTSManager({
  subscriptionKey: azureApiKey,
  region: azureRegion,
  voiceName: selectedVoiceName,
  avatarCharacter: avatarName,
  avatarStyle: avatarStyle,
  videoContainer: videoRef.current!,
});
await avatarManagerRef.current.connect();
```

事件监听中, 收到 transcript 后:

```typescript
// startOpenClawResponseListenerB1
for await (const serverEvent of clientRef.current.events()) {
  if (serverEvent.type === "response") {
    // B-1 模式下, 所有 nano 回复都取消 (nano 只用于维持 STT session)
    await serverEvent.cancel();
    continue;
  }
  if (serverEvent.type === "input_audio") {
    isUserSpeaking.current = true;
    audioHandlerRef.current?.stopStreamingPlayback();
    avatarManagerRef.current?.stopSpeaking();  // 也停止 AvatarSynthesizer
    await serverEvent.waitForCompletion();
    isUserSpeaking.current = false;

    const transcript = serverEvent.transcription || "";
    if (!transcript.trim()) continue;

    setMessages(prev => [...prev, { type: "user", content: transcript }]);
    await sendToOpenClawB1(transcript);
  }
}
```

TTS 注入使用 AvatarSynthesizer 而非 nano relay:

```typescript
const injectToAvatarTTS = async (sentence: string) => {
  // 100% 文本保真! 直接传文本驱动 Avatar
  await avatarManagerRef.current?.speakText(sentence);
};
```

---

## 9. 延迟分析

### 9.1 各模式延迟拆解

```
现有 Agent 模式:
[===Azure STT===] → [===Azure Agent Service===] → [===Azure TTS + Avatar===]
   200-500ms             300-1500ms                      200-400ms
首段音频: 700-2400ms
```

```
方案 A (nano relay):
[===Azure STT===] → transcript → [===OpenClaw===] → 首句 → [nano relay → TTS → Avatar]
   200-500ms          ~50ms        100-1500ms                 <100ms + 200-400ms
首段音频: 550-2450ms
```

```
方案 B / B-1 (AvatarSynthesizer):
[===Azure STT===] → transcript → [===OpenClaw===] → 首句 → [speakTextAsync → Avatar]
   200-500ms          ~50ms        100-1500ms                    200-400ms
首段音频: 500-2400ms
```

### 9.2 对比总结

| 模式 | 首段音频延迟 | 说明 |
|------|------------|------|
| Model 模式 (Realtime) | 400-800ms | 端到端一条 WebSocket |
| Agent 模式 (Cascaded) | 700-2400ms | Azure Agent 处理时间不定 |
| **方案 A (nano relay)** | **550-2450ms** | 多 <100ms nano 推理 |
| **方案 B/B-1 (AvatarSynthesizer)** | **500-2400ms** | 无 nano 开销 |

### 9.3 延迟优化手段 (两种方案通用)

| 优化 | 说明 | 效果 |
|------|------|------|
| 句级流式 TTS | 遇到 `。！？.!?\n` 立即触发 TTS | 不等全部回复 |
| SSE 流式 | OpenClaw 每个 token 实时到达 | 不等完整回复 |
| AbortController | 用户打断时立即取消请求 | 快速响应打断 |
| OpenClaw 本地模型 | Llama 3 / Phi-4 等 localhost | 推理延迟 <500ms |
| 短句合并 | 单字/两字句子缓冲后合并 | 减少 TTS 调用次数 |
| 连接预热 | 首次连接发送健康检查 | 首请求减 ~100ms |

---

## 10. 实施阶段

### Phase 1: 基础设施准备 (方案 A & B 共用)

| 步骤 | 内容 |
|------|------|
| 1.1 | 修改 `next.config.ts`, 移除 `output: 'export'` |
| 1.2 | 创建 `src/app/api/openclaw/route.ts` 代理 |
| 1.3 | 创建 `src/lib/openclaw-client.ts` |
| 1.4 | 更新 `.env.local` |
| 1.5 | 验证 `npm run dev` + API Route + OpenClaw Gateway 连通性 |

### Phase 2: 方案 A 核心集成

| 步骤 | 内容 |
|------|------|
| 2.1 | `chat-interface.tsx`: mode 类型扩展 + OpenClaw 状态变量 |
| 2.2 | `handleConnect` OpenClaw 分支 (nano relay + 健康检查) |
| 2.3 | `startOpenClawResponseListener` (transcript 拦截 + nano 自动回复取消) |
| 2.4 | `injectToAzureTTS` (sendItem + generateResponse, conversation:'none') |
| 2.5 | `sendToOpenClaw` (SSE 流式 + 句级分割 + 用户打断) |
| 2.6 | `sendMessage` OpenClaw 分支 (文本输入) |

### Phase 3: UI 集成

| 步骤 | 内容 |
|------|------|
| 3.1 | Mode Select 添加 "OpenClaw" 选项 |
| 3.2 | OpenClaw 配置面板 (Gateway URL, Auth Token, Model) |
| 3.3 | 条件隐藏不适用的 UI (Agent 字段, Tools) |
| 3.4 | disconnect / mode 切换副作用 |

### Phase 4: 端到端验证

| 步骤 | 内容 |
|------|------|
| 4.1 | 全链路: 语音 → STT → OpenClaw → nano relay → TTS → Avatar |
| 4.2 | Avatar 唇形同步测试 |
| 4.3 | 用户打断测试 |
| 4.4 | 文本输入模式测试 (Developer Mode) |
| 4.5 | 现有模式回归 (model + agent 不受影响) |
| 4.6 | nano 文本保真度评估 (sample 100 句, 统计一致率) |

### Phase 5: (可选) 升级到混合 B-1

仅当 Phase 4.6 文本保真度不满足业务需求时执行:

| 步骤 | 内容 |
|------|------|
| 5.1 | `npm install microsoft-cognitiveservices-speech-sdk` |
| 5.2 | 创建 `src/lib/avatar-synthesizer.ts` |
| 5.3 | `handleConnect`: OpenClaw 模式下额外建立 AvatarSynthesizer 连接 |
| 5.4 | 替换 `injectToAzureTTS` 为 `injectToAvatarTTS` (speakTextAsync) |
| 5.5 | RTClient configure: 移除 `avatar` 配置 (Avatar 交给 AvatarSynthesizer) |
| 5.6 | 全链路验证 (关注两个 WebRTC 连接的资源消耗) |

---

## 代码位置索引

| 修改目标 | 当前代码位置 | 行号范围 |
|----------|-------------|----------|
| Mode 类型定义 + 状态声明 | `chat-interface.tsx` | ~409-420 |
| Mode 选择器 UI | `chat-interface.tsx` Connection Settings | ~1340-1360 |
| Agent 配置面板 (参考结构) | `chat-interface.tsx` | ~1375-1445 |
| `handleConnect` 函数 | `chat-interface.tsx` | ~490-700 |
| `configure()` 调用 | `chat-interface.tsx` | ~629-660 |
| `startResponseListener` | `chat-interface.tsx` | ~938-968 |
| `handleResponse` | `chat-interface.tsx` | ~805-930 |
| `handleInputAudio` | `chat-interface.tsx` | ~932-944 |
| `sendMessage` 函数 | `chat-interface.tsx` | ~972-1000 |
| `disconnect` 函数 | `chat-interface.tsx` | ~770-800 |
| `isCascaded` 函数 | `chat-interface.tsx` | ~1261-1272 |
| mode 切换 useEffect | `chat-interface.tsx` | ~486-489 |
| Tools UI | `chat-interface.tsx` | ~1590-1720 |
| Instructions textarea | `chat-interface.tsx` | ~1620-1640 |
| Voice 选择器 | `chat-interface.tsx` | ~1735-1800 |
| Avatar 配置 | `chat-interface.tsx` | ~1800-1860 |
| 静态导出配置 | `next.config.ts` | ~4 |
| RTClient 构造差异 | `node_modules/rt-client/dist/esm/index.js` | ~5255-5276 |
| `RTResponse.cancel()` | `node_modules/rt-client/dist/esm/index.js` | ~6302-6330 |
