# Agent 模式下文本、音频与 Avatar 的处理流程

本文档详细说明在 Agent 模式下, Azure Voice Live API 服务端如何处理 Agent 返回的文本, 如何将文本转换为音频和 Avatar 视频, 以及各环节之间的延迟处理机制。

## 1. 核心结论: TTS 和 Avatar 驱动在服务端完成

在 Agent 模式下, 前端不负责将 Agent 返回的文本转换为音频。文本到音频的转换(TTS)和 Avatar 视频驱动全部由 Azure Voice Live API 服务端完成。前端收到的是加工好的并行流: 字幕流、音频流、以及(可选的) Avatar 视频流。

## 2. 服务端内部处理链路

Agent 模式走 cascaded(级联)架构, Azure Voice Live API 内部的处理链路如下:

```
用户音频 (WebSocket 连续推送 PCM chunks)
    |
    v
Azure Voice Live API 服务端
    |
    +-- (1) VAD 检测用户说完
    +-- (2) Azure Fast Transcription 语音转写
    |        |
    |        v
    |   转写文本发送到 Azure AI Agent Service
    |        |
    |        v
    |   Agent 处理 (调用工具/知识库/模型推理)
    |        |
    |        v
    |   Agent 返回文本流 (逐 token 生成)
    |        |
    |        +---------- 分流点 ----------+
    |        |                             |
    |        v                             v
    |   文本 delta 直接推送            每段文本送入 Azure TTS
    |   response.audio_               合成音频后推送
    |   transcript.delta               response.audio.delta
    |                                  (PCM16 音频块)
    |                                      |
    |                                [如启用 Avatar]
    |                                      |
    |                                      v
    |                                音频同时驱动 Avatar
    |                                视频帧通过 WebRTC 推送
    |                                (独立媒体通道)
    |                                      |
    v                                      v
WebSocket 推送到前端                 WebRTC 推送到前端
文本事件 + 音频事件                  Avatar 视频 + 音频轨道
```

服务端在 Agent 每产出一段文本时立即执行以下操作:

1. 通过 WebSocket 推送 `response.audio_transcript.delta`(字幕)
2. 将该段文本送入 TTS, 合成后推送 `response.audio.delta`(音频)
3. 如果 Avatar 启用, TTS 音频同时驱动 Avatar 渲染, 视频帧通过 WebRTC 推送

## 3. 前端收到的两种内容类型

根据 RTClient SDK 的类型定义, 一个 `RTMessageItem` 通过异步迭代产出内容块, 每个块的 `type` 是 `"text"` 或 `"audio"`:

```typescript
// RTMessageItem 的异步迭代器产出 RTTextContent 或 RTAudioContent
[Symbol.asyncIterator](): AsyncGenerator<RTAudioContent | RTTextContent>
```

### 3.1 content.type === "text" -- 纯文本内容

服务端推送 `response.text.delta` 事件, 前端通过 `textChunks()` 消费:

```typescript
if (content.type === "text") {
  for await (const text of content.textChunks()) {
    message.content += text;  // 逐 delta 累积
    setMessages(...);         // 更新 UI 显示
  }
}
```

这里只有文本, 没有音频。服务端判定这段内容不需要语音输出时, 以 text 类型推送。

### 3.2 content.type === "audio" -- 音频内容(附带字幕)

这是 Agent 模式的主要回复形式。服务端把 Agent 的文本响应送入 Azure TTS 合成后, 同时推送音频流和对应的字幕流:

```typescript
else if (content.type === "audio") {
  // 字幕流: response.audio_transcript.delta 事件
  const textTask = async () => {
    for await (const text of content.transcriptChunks()) {
      message.content += text;   // 字幕逐块显示
      setMessages(...);
    }
  };

  // 音频流: response.audio.delta 事件
  const audioTask = async () => {
    audioHandlerRef.current?.stopStreamingPlayback();
    audioHandlerRef.current?.startStreamingPlayback();
    for await (const audio of content.audioChunks()) {
      audioHandlerRef.current?.playChunk(audio, async () => {
        proactiveManagerRef.current?.updateActivity("agent speaking");
      });
    }
  };

  // 关键: 并行消费, 不是串行
  await Promise.all([textTask(), audioTask()]);
}
```

`transcriptChunks()` 和 `audioChunks()` 是两个独立的异步迭代器, 从同一个 WebSocket 连接的不同事件类型中分别读取。它们通过 `Promise.all` 并行执行。

## 4. 延迟处理机制

### 4.1 服务端流式分流 -- 降低首字/首音延迟

Azure Voice Live API 在服务端实现了流式 TTS: Agent 不是等整段文本生成完毕再合成, 而是 Agent 每产出一段文本, 服务端就立即合成音频并推送。

这意味着:

- 字幕先于音频到达(字幕是文本, 不需要合成时间)
- 音频紧跟字幕(TTS 的延迟通常在 100-300ms)
- Agent 生成下一段文本时, 上一段的音频已经在播放

### 4.2 前端 Promise.all 并行消费 -- 字幕和音频同步推进

```typescript
await Promise.all([textTask(), audioTask()]);
```

这确保了:

- `textTask` 不等待 `audioTask`, `audioTask` 也不等待 `textTask`
- 字幕比音频稍微提前(因为文本传输和渲染极快)
- 音频到达时通过 `playChunk` 立即排队播放
- 两个任务只有在各自的流全部结束后才 resolve

### 4.3 AudioHandler 的无缝播放调度 -- 消除音频块之间的间隙

`playChunk` 方法中的关键调度逻辑(位于 `src/lib/audio.ts`):

```typescript
playChunk(chunk: Uint8Array, onChunkPlayed: () => Promise<void>) {
  // ...格式转换...

  const chunkDuration = audioBuffer.length / this.sampleRate;

  // 如果播放时间落后于当前时间, 立即赶上
  if (this.nextPlayTime < this.context.currentTime) {
    this.nextPlayTime = this.context.currentTime;
  }

  // 在下一个可用时间点调度播放
  source.start(this.nextPlayTime);

  // 预计算下一块的开始时间 = 当前块结束时
  this.nextPlayTime += chunkDuration;
}
```

这是一个前瞻调度模型: 每个音频块不是"收到就立刻播放", 而是排入 Web Audio API 的时间线。`nextPlayTime` 确保块与块之间无缝衔接, 消除了网络抖动导致的断续感。

### 4.4 用户打断 -- 立即停止播放

当 VAD 检测到用户开始说话(`input_audio` 事件), 前端立即停止助手音频:

```typescript
const handleInputAudio = async (item: RTInputAudioItem) => {
  isUserSpeaking.current = true;
  audioHandlerRef.current?.stopStreamingPlayback();  // 立即清空播放队列
  // ...
};
```

`stopStreamingPlayback()` 调用所有排队中 `AudioBufferSourceNode` 的 `stop()`, 并清空队列:

```typescript
stopStreamingPlayback() {
  this.isPlaying = false;
  this.playbackQueue.forEach((source) => source.stop());  // 立即停止所有音频
  this.playbackQueue = [];
  // ...清理录音时间线...
}
```

## 5. Avatar 的驱动机制

Avatar 的视频流走完全独立的 WebRTC 通道, 不经过前端中间处理。

### 5.1 两条通道的职责分工

```
                  Azure Voice Live API
                         |
              +----------+----------+
              |                     |
         WebSocket              WebRTC
      (文本+音频事件)       (Avatar视频+音频)
              |                     |
              v                     v
      前端 JS 处理         RTCPeerConnection
      字幕显示+音频播放    浏览器原生媒体渲染
```

- WebSocket / RTClient: 负责实时消息、音频和控制信令
- WebRTC: 负责 Avatar 音视频媒体流

### 5.2 Avatar 连接建立

在 `configure()` 返回 `session.avatar.ice_servers` 后, 前端建立 WebRTC 连接:

```typescript
if (session?.avatar) {
  await getLocalDescription(session.avatar?.ice_servers);
}
```

建立过程如下:

1. 创建 `RTCPeerConnection` 并配置 ICE 服务器
2. 添加 video 和 audio transceiver(`sendrecv`)
3. 创建 SDP offer, 等待 2 秒收集 ICE candidates
4. 通过 `clientRef.current.connectAvatar(localSDP)` 发送 offer 到服务端
5. 服务端返回 SDP answer, 完成协商
6. 注册 `ontrack` 事件, 将视频/音频轨道直接渲染到 DOM:

```typescript
peerConnection.ontrack = function (event) {
  const mediaPlayer = document.createElement(event.track.kind) as HTMLMediaElement;
  mediaPlayer.id = event.track.kind;
  mediaPlayer.srcObject = event.streams[0];
  mediaPlayer.autoplay = true;
  videoRef?.current?.appendChild(mediaPlayer);
};
```

### 5.3 Avatar 视频驱动原理

Avatar 视频由服务端的 TTS 音频同步驱动:

- 服务端 TTS 合成音频的同时, Avatar 服务根据音频的音素信息生成嘴型动画
- 视频帧通过 WebRTC 实时推送到前端
- 服务端还通过 DataChannel 推送 blendshape 动画事件(`response.animation.blendshapes`)
- 前端不参与 Avatar 渲染逻辑, 浏览器的 `<video>` 元素自动播放 WebRTC 媒体流

### 5.4 Avatar 模式下的双路音频

当 Avatar 启用时, 存在两路音频:

| 路径 | 来源 | 用途 |
|------|------|------|
| WebSocket | `audioChunks()` | 前端通过 AudioHandler 播放, 同时用于会话录制 |
| WebRTC | Avatar 媒体流音频轨道 | 与 Avatar 视频同步, 驱动嘴型动画 |

视频配置中的 `codec: "h264"` 和 crop 参数控制 Avatar 的画面裁剪:

```typescript
const videoParams: AvatarConfigVideoParams = {
  codec: "h264",
  crop: { top_left: [560, 0], bottom_right: [1360, 1080] },
};
```

## 6. 完整时序图

```
时间 ───────────────────────────────────────────────────────────────>

用户说话                   Agent 处理            助手回复
|----用户语音--->|     |--Agent思考--|
                VAD    STT         Agent生成第1段     第2段     第3段
                检测   转写            |                |        |
                完毕   完成            v                v        v
                                    TTS合成          TTS合成  TTS合成

WebSocket 事件到达前端:
input_audio __|
(用户转写)
               transcript_delta_1 __|__|
               audio_delta_1 ________|__|
               transcript_delta_2 ______|__|
               audio_delta_2 __________|__|
               transcript_delta_3 ________|_|
               audio_delta_3 ______________|_|

前端 UI:
字幕显示:     [用户消息]  [助手字幕逐字出现................]
音频播放:                  [chunk1][chunk2][chunk3][无缝衔接]
Avatar视频:                [嘴型与音频同步的视频帧.........]
                           (WebRTC 独立通道)
```

从时序上看:

- 字幕先于音频到达, 因为文本不需要 TTS 合成时间
- 音频块紧跟字幕, 延迟约 100-300ms (TTS 合成时间)
- Avatar 视频与音频同步, 由服务端 TTS 音频直接驱动
- 用户打断时, 前端立即停止播放, 服务端取消后续生成

## 7. 各环节延迟处理汇总

| 环节 | 执行位置 | 延迟处理方式 |
|------|----------|------------|
| Agent 文本生成 | Azure AI Agent Service | 流式输出, 逐 token 推送 |
| Text 转 Audio (TTS) | Azure 服务端 | 流式 TTS, Agent 每生成一段文本立即合成, 不等全部生成完 |
| Text 转 Avatar 视频 | Azure 服务端 | TTS 音频直接驱动 Avatar 渲染, 同步推送 |
| 字幕传输 | WebSocket | 文本无合成延迟, 比音频先到达 |
| 音频传输 | WebSocket | TTS 有延迟, 以 delta 块持续推送 |
| Avatar 视频传输 | WebRTC | 独立媒体通道, 由服务端音频同步驱动 |
| 前端字幕+音频消费 | Promise.all | 并行消费, 互不阻塞 |
| 音频块无缝播放 | AudioHandler.playChunk | nextPlayTime 前瞻调度, 消除块间间隙 |
| 用户打断 | stopStreamingPlayback | 立即清空播放队列, 停止所有排队音频 |

## 8. 关键代码位置索引

| 功能 | 文件 | 位置 |
|------|------|------|
| 响应处理主逻辑 | `src/app/chat-interface.tsx` | handleResponse 函数 |
| 纯文本内容处理 | `src/app/chat-interface.tsx` | content.type === "text" 分支 |
| 音频+字幕并行消费 | `src/app/chat-interface.tsx` | content.type === "audio" 分支, Promise.all |
| 用户打断停止播放 | `src/app/chat-interface.tsx` | handleInputAudio 函数 |
| 音频无缝播放调度 | `src/lib/audio.ts` | playChunk 方法 |
| 停止播放清空队列 | `src/lib/audio.ts` | stopStreamingPlayback 方法 |
| Avatar WebRTC 建立 | `src/app/chat-interface.tsx` | getLocalDescription / setupPeerConnection |
| Avatar SDP 交换 | `src/app/chat-interface.tsx` | setRemoteDescription / connectAvatar |
| Avatar 视频挂载 | `src/app/chat-interface.tsx` | peerConnection.ontrack |
| configure 会话配置 | `src/app/chat-interface.tsx` | clientRef.current.configure 调用 |
