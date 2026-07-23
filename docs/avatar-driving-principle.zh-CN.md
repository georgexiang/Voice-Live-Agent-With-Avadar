# Azure TTS Avatar 驱动原理与流程

## 1. 整体架构

Avatar 是 Azure TTS 的视觉扩展层。Azure 在服务端维护一个 Avatar 渲染引擎，当 TTS 合成音频时，同步生成对应的面部动画视频帧，通过 WebRTC 推送给客户端。

```
┌─────────────────── Azure 服务端 ───────────────────┐
│                                                      │
│  generateResponse()                                  │
│       ↓                                              │
│  LLM 推理 → 生成文本                                │
│       ↓                                              │
│  Azure TTS 引擎                                      │
│   ├─→ 合成音频 PCM ─→ WebSocket 返回 audio delta    │
│   ├─→ 音素分析 (phoneme → viseme)                    │
│   └─→ Avatar 渲染引擎                                │
│        ├─→ viseme → 唇形 blendshapes                 │
│        ├─→ 自然眨眼/微动                              │
│        └─→ H.264 视频帧 + 音频 ─→ WebRTC 推送        │
│                                                      │
└──────────────────────────────────────────────────────┘
          ↓ WebSocket            ↓ WebRTC
     audio/text 事件        video + audio 媒体流
          ↓                      ↓
┌─────────────── 客户端 (浏览器) ──────────────────────┐
│                                                      │
│  handleResponse()           ontrack 回调              │
│   └─→ 文本显示              ├─→ <video> 元素         │
│   └─→ AudioHandler          └─→ <audio> 元素         │
│        (可选本地播放)          (Avatar 音视频同步)      │
│                                                      │
└──────────────────────────────────────────────────────┘
```

Avatar 的核心设计是**服务端渲染**：客户端不需要做任何 3D 渲染，只需接收 WebRTC 推送的视频流并在 `<video>` 元素中播放。

---

## 2. 连接建立过程

Avatar WebRTC 连接的建立分为六个步骤。

### 2.1 步骤 1: Session 配置 — 声明 Avatar 参数

客户端在 `session.update` 中传入 Avatar 配置，声明要使用的角色、风格和视频编码参数。

对应代码位置: `src/app/chat-interface.tsx` `configure()` 调用 (~行 638-640)

```typescript
const session = await clientRef.current.configure({
  // ...其他参数 (instructions, voice, turn_detection, etc.)
  avatar: getAvatarConfig(),
});
```

`getAvatarConfig()` 函数 (~行 738-770) 生成的配置结构:

```json
{
  "avatar": {
    "character": "lisa",
    "style": "casual-sitting",
    "customized": false,
    "video": {
      "codec": "h264",
      "crop": {
        "top_left": [560, 0],
        "bottom_right": [1360, 1080]
      }
    }
  }
}
```

**AvatarConfig 类型定义** (来自 `rt-client` SDK):

```typescript
interface AvatarConfig {
  ice_servers?: RTCIceServer[];  // 可选，不提供则服务端返回
  character: string;             // 角色名, 如 "lisa"
  style?: string;                // 风格, 如 "casual-sitting"
  customized?: boolean;          // 是否为自定义 Avatar
  video?: AvatarConfigVideoParams;
}

interface AvatarConfigVideoParams {
  bitrate?: number;
  codec: "h264";
  crop?: {
    bottom_right: [number, number];
    top_left: [number, number];
  };
  resolution?: { width: number; height: number };
  background?: {
    color?: string;
    image_url?: URL;
  };
}
```

### 2.2 步骤 2: 服务端返回 ICE Servers

`session.updated` 响应中 `session.avatar.ice_servers` 包含 Avatar 专用的 ICE (Interactive Connectivity Establishment) 服务器信息。

ICE 是 WebRTC 的 NAT 穿透机制，使用 TURN relay 服务器中转音视频流:

```
TURN Server: relay.communication.microsoft.com
├─ UDP 端口 3478
└─ TCP 端口 443
```

如果客户端在 `avatar` 配置中未提供 `ice_servers`，服务端会在 `session.updated` 响应中返回。

### 2.3 步骤 3: 创建 RTCPeerConnection

客户端使用 ICE 服务器信息创建 WebRTC 对等连接。

对应代码位置: `src/app/chat-interface.tsx` (~行 1037-1057)

```typescript
const getLocalDescription = (ice_servers?: RTCIceServer[]) => {
  console.log("Received ICE servers" + JSON.stringify(ice_servers));
  peerConnection = new RTCPeerConnection({ iceServers: ice_servers });
  setupPeerConnection();    // 设置 ontrack, transceiver, datachannel
  // ICE候选收集回调
  peerConnection.onicegatheringstatechange = (): void => { ... };
  peerConnection.onicecandidate = (event): void => { ... };
  setRemoteDescription();   // 发起 SDP 协商
};
```

调用时机: `configure()` 返回 session 后立即调用 (~行 654-656):

```typescript
if (session?.avatar) {
  await getLocalDescription(session.avatar?.ice_servers);
}
```

### 2.4 步骤 4: 设置媒体接收 — ontrack 回调

`setupPeerConnection()` 注册了关键的 `ontrack` 回调，当服务端推送媒体轨道时触发。

对应代码位置: `src/app/chat-interface.tsx` (~行 1086-1113)

```typescript
const setupPeerConnection = () => {
  clearVideo();

  // 当服务端推送 video/audio track 时触发
  peerConnection.ontrack = function (event) {
    // 动态创建 <video> 或 <audio> 元素
    const mediaPlayer = document.createElement(
      event.track.kind     // "video" 或 "audio"
    ) as HTMLMediaElement;
    mediaPlayer.id = event.track.kind;
    mediaPlayer.srcObject = event.streams[0];  // 绑定媒体流
    mediaPlayer.autoplay = true;
    videoRef?.current?.appendChild(mediaPlayer);
  };

  // 声明要接收 video 和 audio (sendrecv 双向)
  peerConnection.addTransceiver("video", { direction: "sendrecv" });
  peerConnection.addTransceiver("audio", { direction: "sendrecv" });

  // 可选: DataChannel 接收服务端事件
  peerConnection.addEventListener("datachannel", (event) => {
    const dataChannel = event.channel;
    dataChannel.onmessage = (e) => {
      console.log("[" + new Date().toISOString() + "] WebRTC event: " + e.data);
    };
  });
  peerConnection.createDataChannel("eventChannel");
};
```

`ontrack` 回调会触发两次:
1. 第一次: `event.track.kind === "video"` → 创建 `<video>` 元素
2. 第二次: `event.track.kind === "audio"` → 创建 `<audio>` 元素

### 2.5 步骤 5: SDP Offer/Answer 协商

WebRTC 标准的信令交换流程。

对应代码位置: `src/app/chat-interface.tsx` (~行 1059-1082)

```
客户端                              Azure 服务端
  │                                      │
  │── createOffer() ──→ SDP Offer        │
  │── setLocalDescription(offer)         │
  │                                      │
  │  (等待 2s, 收集 ICE candidates)       │
  │                                      │
  │── session.avatar.connect ────────────→│  (携带 client_sdp)
  │                                      │
  │←──── session.avatar.connecting ──────│  (携带 server_sdp)
  │                                      │
  │── setRemoteDescription(answer)       │
  │                                      │
  │◄═══════════ WebRTC 连接建立 ═════════►│
  │       video track (H.264)            │
  │       audio track (Opus)             │
```

代码实现:

```typescript
const setRemoteDescription = async () => {
  try {
    // 1. 客户端创建 SDP offer
    const sdp = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(sdp);

    // 2. 等待 ICE candidates 收集
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // 3. 发送 client SDP 给 Azure, 获取 server SDP
    const remoteDescription = await clientRef.current?.connectAvatar(
      peerConnection.localDescription as RTCSessionDescription
    );

    // 4. 设置 server SDP, 完成协商
    await peerConnection.setRemoteDescription(
      remoteDescription as RTCSessionDescriptionInit
    );
  } catch (error) {
    console.error("Connection failed:", error);
  }
};
```

对应的协议消息:

```json
// 客户端发送 (由 connectAvatar 内部封装)
{ "type": "session.avatar.connect", "client_sdp": "v=0\r\n..." }

// 服务端响应
{ "type": "session.avatar.connecting", "server_sdp": "v=0\r\n..." }
```

### 2.6 步骤 6: WebRTC 连接就绪

连接建立后，Avatar 进入 **idle 状态**(自然眨眼、轻微身体晃动)。只有当 TTS 合成音频时，才会产生说话动画。

---

## 3. 运行时 — TTS 如何驱动 Avatar

每次 `generateResponse()` 调用后，服务端内部执行以下流程:

```
1. LLM 推理 → 生成回复文本 (流式, 逐 token)

2. Azure TTS 引擎接收文本块, 开始合成:
   ├─ 文本分析 → 音素序列 (phoneme sequence)
   ├─ 声学模型 → PCM 音频波形 (24kHz, 16-bit)
   └─ 音素 → 视素映射 (phoneme → viseme)

3. Avatar 渲染引擎 (服务端):
   ├─ 输入: viseme 序列 + 时间戳
   ├─ 生成: 面部 blendshapes (52 个 ARKit 面部参数)
   │   ├─ jawOpen       (张嘴幅度)
   │   ├─ mouthSmile    (微笑)
   │   ├─ eyeBlink      (眨眼)
   │   ├─ browInnerUp   (眉毛)
   │   └─ ... 其他面部肌肉参数
   ├─ 渲染: 3D Avatar 模型 + blendshapes → H.264 视频帧 (25fps)
   └─ 音频: TTS PCM → Opus 编码

4. 通过 WebRTC 推送:
   ├─ video track: H.264 视频帧 → 客户端 <video> 元素
   └─ audio track: Opus 音频 → 客户端 <audio> 元素 (音视频同步)

5. 同时通过 WebSocket 推送:
   ├─ response.audio.delta            → 音频 PCM 数据
   ├─ response.audio_transcript.delta → 文本
   └─ response.animation.blendshapes  → 面部动画数据 (可选)
```

关键点: **Avatar 驱动完全发生在服务端**。客户端不需要做任何渲染计算，只需播放 WebRTC 推送的视频流。

---

## 4. Viseme (视素)

### 4.1 什么是 Viseme

Viseme 是声素 (phoneme) 的视觉表示——说话时嘴型和面部的姿态。Azure TTS 在合成音频的同时，计算每个音素对应的嘴型，然后驱动 Avatar 的面部动画。

### 4.2 Viseme 类型

Azure TTS 支持两种 viseme 输出:

| 类型 | 说明 | 参数量 | 用途 |
|------|------|--------|------|
| **viseme_id** | 22 个标准口型 ID (0-21) | 1 个整数 | 简单 2D 口型动画 |
| **blendshapes** | 52 个 ARKit 面部参数 (0.0-1.0) | 52 个浮点数 | 精细 3D Avatar 渲染 |

### 4.3 Viseme 配置

Voice Live API 通过 `animation.outputs` 配置 viseme 输出:

```json
{
  "type": "session.update",
  "session": {
    "animation": {
      "outputs": ["viseme_id"]
    }
  }
}
```

服务端返回 viseme 事件:

```json
{
  "type": "response.animation_viseme.delta",
  "response_id": "<response_id>",
  "item_id": "<item_id>",
  "audio_offset_ms": 455,
  "viseme_id": 20
}
```

### 4.4 Blendshapes 事件

rt-client SDK 中定义了 `ResponseBlendShapeMessage` 类型:

```typescript
interface ResponseBlendShapeMessage extends ServerMessageBase {
  type: "response.animation.blendshapes";
  response_id: string;
  item_id: string;
  output_index: number;
  content_index: number;
  blendshapes: string;  // JSON 字符串, 包含 52 个面部参数
}
```

### 4.5 本项目中的 Viseme 使用

本项目使用**服务端渲染 + WebRTC 推送**模式。Avatar 渲染在 Azure 服务端完成，客户端直接接收视频帧。因此不需要客户端处理 viseme/blendshapes 数据。

如果需要在客户端自行渲染 3D 模型（如使用 Three.js），可以订阅 blendshapes 事件并手动驱动面部动画，但这不是本项目的方案。

---

## 5. 双通道音频

Avatar 模式下存在两条并行的音频通道:

| 通道 | 协议 | 数据格式 | 用途 |
|------|------|----------|------|
| `response.audio.delta` | WebSocket | PCM 16-bit, 24kHz | 客户端本地播放 (`AudioHandler.playChunk()`) |
| WebRTC audio track | WebRTC | Opus 编码 | 与 Avatar 视频同步播放 |

在 Avatar 模式下，WebRTC 的 audio track 负责实际音频播放（因为它和视频是天然同步的）。WebSocket 通道的 audio delta 可用于:
- 本地录音/会话保存
- 音频波形分析/可视化
- 非 Avatar 模式的音频播放回退

---

## 6. Avatar 空闲/说话状态

| 状态 | 触发条件 | 行为 |
|------|----------|------|
| **Idle** | 无 TTS 输出 | 自然眨眼、轻微身体晃动 |
| **Speaking** | TTS 正在合成 | 唇形同步 + 自然手势/表情 |
| **断开** | 空闲 5 分钟 / 会话 30 分钟 | WebRTC 连接自动关闭 |

---

## 7. 网络要求

WebRTC 需要通过 TURN relay 服务器中转流量。防火墙规则:

| 方向 | 目标 | IP 范围 | 端口 | 协议 |
|------|------|---------|------|------|
| 出站 | relay.communication.microsoft.com | 20.202.0.0/16 | 3478 | UDP |
| 出站 | relay.communication.microsoft.com | 20.202.0.0/16 | 443 | TCP |

### 浏览器兼容性

| 平台 | Chrome | Edge | Safari | Firefox | Opera |
|------|--------|------|--------|---------|-------|
| Windows | 支持 | 支持 | N/A | 支持* | 支持 |
| macOS | 支持 | 支持 | 支持 | 支持* | 支持 |
| iOS | 支持 | 支持 | 支持 | 支持 | 支持 |
| Android | 支持 | 支持 | N/A | 支持* | 不支持 |

*Firefox 在使用 Communication Service ICE 服务器时存在兼容性问题，但使用 Coturn 可正常工作。

---

## 8. 为什么 OpenClaw 方案下 Avatar 不需要改动

```
当前 Agent 模式:
  Agent Service 自动回复 → TTS 合成 → Avatar 渲染 → WebRTC 推送 ✓

OpenClaw 模式:
  sendItem() + generateResponse()
    → nano relay 朗读 → TTS 合成 → Avatar 渲染 → WebRTC 推送 ✓
```

Azure 服务端不关心 `generateResponse()` 是由 VAD 自动触发还是客户端手动调用。只要产生 response → 模型输出文本 → TTS 合成音频，Avatar 渲染引擎就自动生成对应视频帧。整个 WebRTC 连接建立、`ontrack` 回调、视频播放逻辑完全不需要修改。

涉及 Avatar 且不需要改动的代码:

| 函数/逻辑 | 位置 | 说明 |
|-----------|------|------|
| `getAvatarConfig()` | ~行 738-770 | Avatar 配置生成 |
| `getLocalDescription()` | ~行 1037-1057 | WebRTC 连接建立 |
| `setupPeerConnection()` | ~行 1086-1113 | 媒体轨道设置 |
| `setRemoteDescription()` | ~行 1059-1082 | SDP 协商 |
| Avatar UI 控件 | ~行 1800-1860 | 开关/角色选择/自定义 |
| `handleResponse()` | ~行 805-930 | 处理 audio/text 事件 |

---

## 9. 官方文档链接

| 文档 | 链接 |
|------|------|
| Voice Live API 概述 | https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live |
| Voice Live API 使用指南 (含 Avatar 章节) | https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-how-to |
| Voice Live API Reference | https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-api-reference-2025-10-01 |
| TTS Avatar 概述 | https://learn.microsoft.com/en-us/azure/ai-services/speech-service/text-to-speech-avatar/what-is-text-to-speech-avatar |
| TTS Avatar 实时合成指南 (WebRTC 设置) | https://learn.microsoft.com/en-us/azure/ai-services/speech-service/text-to-speech-avatar/real-time-synthesis-avatar |
| 标准 Avatar 角色列表 | https://learn.microsoft.com/en-us/azure/ai-services/speech-service/text-to-speech-avatar/standard-avatars |
| GPT Realtime API 指南 | https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio |
| Realtime API 事件参考 | https://learn.microsoft.com/en-us/azure/foundry/openai/realtime-audio-reference |
| Viseme 文档 (SSML) | https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-synthesis-markup-voice#viseme-element |
| Voice Live Avatar 示例代码 (Node.js) | https://github.com/azure-ai-foundry/voicelive-samples/tree/main/javascript/voice-live-avatar |
| TTS Avatar 示例代码 (JS Browser) | https://github.com/Azure-Samples/cognitive-services-speech-sdk/tree/master/samples/js/browser/avatar |
