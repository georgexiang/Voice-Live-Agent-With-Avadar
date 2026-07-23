# Voice Live Agent 接入 OpenClaw Agent 集成方案

## 1. 项目功能分析

### 1.1 项目概述

Voice-Live-Agent-With-Avatar 是一个基于 Next.js 的实时语音对话应用, 通过 Azure Voice Live API 实现用户与 AI 模型/代理之间的语音交互, 并可选配 3D 数字人(Avatar)视频流。

### 1.2 核心架构

```
用户麦克风 --> AudioWorklet(24kHz PCM) --> RTClient(WebSocket) --> Azure Voice Live API
                                                                        |
                                                             模型/代理处理 + 语音合成
                                                                        |
Azure 返回: 文本流 + 音频流 <-- WebSocket <-- RTClient <-- 浏览器扬声器播放
                              (可选) WebRTC 视频流 <-- Avatar 数字人
```

### 1.3 关键组件

| 组件 | 文件 | 职责 |
|------|------|------|
| ChatInterface | `src/app/chat-interface.tsx` | 主控制器(约2000行), 管理连接/录音/UI/工具调用 |
| AudioHandler | `src/lib/audio.ts` | 音频采集/播放/会话录制/WAV导出 |
| ProactiveEventManager | `src/lib/proactive-event-manager.ts` | 主动问候 + 静默检测 |
| AudioWorklet | `public/audio-processor.js` | 独立线程低延迟音频处理(100ms chunk) |
| RTClient | rt-client 包 | Azure 实时 SDK, 管理 WebSocket + WebRTC |

### 1.4 双模式运行

- **Model 模式**: API Key 认证, 连接 GPT-4o 等模型, 前端处理 function_call(get_time, search, calculator)。
- **Agent 模式**: Entra ID Token 认证, 连接 Azure AI Agent Service, 代理自带工具/知识。

### 1.5 现有 Tool 系统

当前在 Model 模式下, 前端定义并处理 4 个工具:

- `get_time` -- 获取当前时间
- `search` -- Azure AI Search 语义检索
- `calculator` -- 计算器
- `weather` -- 天气查询

工具执行流程: 模型发出 `function_call` --> 前端捕获并执行(`chat-interface.tsx` 第849行附近) --> 结果通过 `sendItem({ type: "function_call_output" })` 返回 --> 模型继续生成。

---

## 2. OpenClaw 简介

OpenClaw 是一个开源个人 AI 助手框架, 核心特点如下:

- 运行在用户本机, 数据私有
- 持久记忆, 上下文跨会话保持
- 通过 Skills 扩展能力(AgentSkills 兼容格式)
- 支持多渠道接入(WhatsApp/Telegram/Discord/Slack/Signal/iMessage)
- 可执行系统操作(文件读写/浏览器控制/Shell 命令)
- Gateway 服务默认监听 `localhost:18789`
- 通过 ClawHub 社区共享和安装 Skills

### 2.1 OpenClaw 架构要素

| 概念 | 说明 |
|------|------|
| Gateway | 常驻后台服务, 管理会话、调度模型和工具 |
| Skills | 以 `SKILL.md` 为入口的能力扩展包, 遵循 AgentSkills 规范 |
| Plugins | 携带 Skills 的插件, 通过 `openclaw.plugin.json` 声明 |
| Channels | 消息通道(Telegram/WhatsApp 等), Gateway 统一接入 |
| Memory | 持久记忆系统, 跨会话保持用户偏好和上下文 |

---

## 3. 集成策略

接入 OpenClaw 有三种策略, 按复杂度递增排列。

### 3.1 策略一: 将 Voice Live Agent 作为 OpenClaw 的语音通道(推荐)

**思路**: 类比 OpenClaw 已有的 WhatsApp/Telegram 通道, 将本语音界面作为 OpenClaw 的一个新交互入口。

**架构**:

```
用户语音 --> Azure Voice Live API (STT + VAD)
                    |
              转写文本 (transcript)
                    |
           OpenClaw Gateway API (localhost:18789)
                    |
           OpenClaw 处理 (记忆/Skills/工具)
                    |
              文本响应
                    |
           Azure Voice Live API (TTS)
                    |
           语音回放给用户
```

**需要改动的模块**:

1. **新增 OpenClaw Gateway 客户端** (`src/lib/openclaw-client.ts`)
   - 封装对 OpenClaw Gateway HTTP API 的调用
   - 管理会话 (session) 生命周期
   - 处理 OpenClaw 的流式响应

2. **修改 ChatInterface** (`src/app/chat-interface.tsx`)
   - 新增 `"openclaw"` 模式(与现有 `model`/`agent` 并列)
   - 在 UI 配置面板新增 OpenClaw 连接参数(Gateway URL, 认证信息)
   - 拦截 Azure 转写结果, 转发给 OpenClaw 而非让模型直接回复
   - 接收 OpenClaw 文本响应, 注入回 Azure Voice Live API 做 TTS

3. **修改连接逻辑** (`handleConnect`)
   - OpenClaw 模式下, Azure Voice Live API 仅用于 STT + TTS(不绑定模型)
   - 或使用 Azure 的 cascaded 模式, 通过 `input_audio_transcription` 获取转写

4. **修改响应处理** (`startResponseListener`)
   - 检测到用户说话结束后, 将转写文本发往 OpenClaw
   - OpenClaw 返回后, 通过 `clientRef.current.sendItem()` + `generateResponse()` 触发 TTS

**优势**: 充分利用 OpenClaw 的全部能力(记忆、Skills、浏览器控制、文件系统), 语音只是交互层。

**挑战**: 需要处理 Azure STT/TTS 与 OpenClaw 文本处理之间的延迟协调。

---

### 3.2 策略二: 将 OpenClaw 的 Skills/Tools 桥接为 Function Call

**思路**: 保持现有 Azure Voice Live API + 模型架构不变, 在工具层接入 OpenClaw, 让语音模型调用 OpenClaw 的能力。

**架构**:

```
用户语音 --> Azure Voice Live API --> GPT-4o 模型
                                        |
                            function_call: openclaw_execute
                                        |
                         前端 --> OpenClaw Gateway API
                                        |
                         OpenClaw 执行 skill/tool
                                        |
                         结果 --> function_call_output --> 模型继续
```

**需要改动的模块**:

1. **新增 OpenClaw 工具定义** (`src/app/chat-interface.tsx`)
   - 在 `predefinedTools` 中添加 OpenClaw 相关工具声明
   - 示例工具: `openclaw_execute`(通用执行)、`openclaw_memory`(记忆查询)、`openclaw_browse`(网页操作)

2. **新增工具处理逻辑**
   - 在 `isFunctionCallItem` 分支中添加 OpenClaw 工具的处理
   - 调用 OpenClaw Gateway API 执行操作并返回结果

3. **新增 OpenClaw 客户端** (`src/lib/openclaw-client.ts`)
   - HTTP 客户端封装
   - 会话管理

4. **UI 配置面板扩展**
   - 新增 OpenClaw Gateway 地址、认证配置项

**优势**: 改动最小, 现有架构不变, 渐进式接入。

**挑战**: 模型需要"知道"何时调用 OpenClaw 工具, Instructions 需要精心编写; OpenClaw 的复杂多轮交互能力受限于 function_call 的单次调用模式。

---

### 3.3 策略三: 深度集成 -- OpenClaw 替代 Azure 模型层

**思路**: 完全用 OpenClaw 替代 Azure AI 模型/Agent Service, Azure 仅提供 STT + TTS + Avatar。

**架构**:

```
用户麦克风 --> AudioWorklet --> 前端直接处理
                                 |
                 浏览器 Web Speech API 或 Azure STT
                                 |
                       OpenClaw Gateway (全功能模式)
                                 |
                       OpenClaw 文本响应
                                 |
                 Azure Speech SDK (TTS) 或 ElevenLabs
                                 |
                       AudioHandler 播放
                       (可选) Avatar WebRTC
```

**需要改动的模块**:

1. **替换 RTClient** -- 不再使用 Azure Voice Live API 的模型连接, 改用:
   - Web Speech API 或 Azure Speech SDK 做 STT
   - OpenClaw Gateway API 做对话处理
   - Azure Speech SDK 做 TTS
   - (可选) 单独的 Avatar WebRTC 连接

2. **重写音频管道** (`src/lib/audio.ts`)
   - 分离 STT 和 TTS 为独立模块
   - STT 输出文本给 OpenClaw
   - TTS 接收 OpenClaw 文本输出合成语音

3. **重构 ChatInterface**
   - 移除 RTClient 依赖(或仅保留 Avatar 部分)
   - 新增 OpenClaw 会话管理
   - 新的响应处理流程

**优势**: 完全的 OpenClaw 体验, 不受 Azure 模型限制。

**挑战**: 改动量大; 失去 Azure Voice Live API 的端到端低延迟优势(STT/模型/TTS 一条 WebSocket 完成); Avatar 集成需要额外处理。

---

## 4. 推荐实施路径

| 阶段 | 内容 | 涉及文件 |
|------|------|----------|
| Phase 1 | 实现策略二 -- 添加 OpenClaw 工具桥接 | 新增 `openclaw-client.ts`, 修改 `chat-interface.tsx` |
| Phase 2 | 实现策略一 -- 添加 OpenClaw 通道模式 | 修改连接/响应逻辑, 新增配置 UI |
| Phase 3 | (可选) 策略三 -- 完全替代模型层 | 重构音频管道和连接逻辑 |

---

## 5. Phase 1 详细工作项

### 5.1 创建 OpenClaw Gateway 客户端

**文件**: `src/lib/openclaw-client.ts`

```typescript
interface OpenClawConfig {
  gatewayUrl: string;   // 默认 http://localhost:18789
  sessionId?: string;
}

interface OpenClawResponse {
  text: string;
  metadata?: Record<string, unknown>;
}

class OpenClawClient {
  private config: OpenClawConfig;
  private sessionId: string;

  constructor(config: OpenClawConfig) { /* ... */ }
  async sendMessage(text: string): Promise<OpenClawResponse> { /* ... */ }
  async streamMessage(text: string): AsyncGenerator<string> { /* ... */ }
  disconnect(): void { /* ... */ }
}
```

### 5.2 添加 OpenClaw 连接配置 UI

在 `chat-interface.tsx` 配置面板中新增:

- OpenClaw Gateway URL 输入框
- OpenClaw 启用开关
- 连接状态指示

### 5.3 新增 OpenClaw 工具定义

在 `predefinedTools` 数组中添加:

```typescript
{
  id: "openclaw",
  label: "OpenClaw Agent",
  enabled: true,
  tool: {
    type: "function",
    name: "openclaw_execute",
    description: "Execute a task through OpenClaw personal AI assistant. Use for tasks requiring memory, web browsing, file operations, or any skill available in the user's OpenClaw setup.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "The task description to send to OpenClaw"
        }
      },
      required: ["task"]
    }
  } as ToolDeclaration
}
```

### 5.4 添加工具处理逻辑

在 `isFunctionCallItem` 分支中新增:

```typescript
else if (item.functionName === "openclaw_execute") {
  const { task } = JSON.parse(item.arguments);
  const openclawClient = new OpenClawClient({ gatewayUrl: openclawUrl });
  const result = await openclawClient.sendMessage(task);
  await clientRef.current?.sendItem({
    type: "function_call_output",
    output: result.text,
    call_id: item.callId,
  });
  await clientRef.current?.generateResponse();
}
```

### 5.5 编写 Instructions 模板

为模型提供 OpenClaw 工具使用指导:

```
You have access to an OpenClaw personal AI assistant via the openclaw_execute tool.
Use it when the user asks about:
- Personal schedule, reminders, or calendar
- Email management
- Web browsing or information lookup beyond your knowledge
- File operations on the user's machine
- Any task that benefits from persistent memory
```

### 5.6 测试验证

- 验证 OpenClaw Gateway 的连通性
- 测试 function_call 触发和响应集成
- 验证端到端语音交互流畅性
- 测试错误处理和超时场景

---

## 6. 技术注意事项

### 6.1 延迟优化

- OpenClaw Gateway 调用增加额外网络延迟, 在 function_call 处理中需设置合理超时
- 考虑 OpenClaw 流式响应, 减少用户等待感

### 6.2 认证和安全

- OpenClaw Gateway 默认只监听 localhost, 生产环境需配置安全认证
- 不在前端暴露 OpenClaw 的系统级操作权限
- 所有用户输入需经过 OpenClaw 自身的安全过滤

### 6.3 会话管理

- Voice Live Agent 的会话 ID 与 OpenClaw 的 session 需建立映射
- 断线重连时需恢复 OpenClaw 的会话上下文

### 6.4 静态导出限制

- 当前项目使用 `output: 'export'` 静态导出, 无 Node.js 后端
- OpenClaw Gateway 调用从浏览器直接发起, 需处理 CORS
- 如果需要服务端代理, 需移除 `output: 'export'` 配置并添加 Next.js API Routes

---

## 7. 文件变更清单

| 操作 | 文件路径 | 说明 |
|------|----------|------|
| 新增 | `src/lib/openclaw-client.ts` | OpenClaw Gateway HTTP 客户端封装 |
| 修改 | `src/app/chat-interface.tsx` | 新增模式/工具定义/处理逻辑/配置UI |
| 修改 | `package.json` | (如需) 添加新依赖 |
| 修改 | `next.config.ts` | (如需 API Routes) 移除 `output: 'export'` |
| 新增 | `src/app/api/openclaw/route.ts` | (可选) 服务端代理, 避免 CORS 问题 |
