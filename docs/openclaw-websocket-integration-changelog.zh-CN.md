# OpenClaw Gateway WebSocket 集成 — 变更总结

> 日期: 2026-03-31  
> 范围: OpenClaw Gateway 通信协议从 HTTP REST 迁移到 WebSocket RPC

---

## 一、变更背景

在 Phase 1–3 完成后（API Route 骨架、客户端库、UI 模式集成），Phase 4（端到端联调）发现 **OpenClaw Gateway 不是 HTTP REST 服务**，而是一个 **WebSocket RPC 服务器**。

原有代码假设 Gateway 提供 OpenAI 兼容的 `POST /v1/chat/completions` 接口，但实际返回 404。根本原因：

| 假设 | 实际 |
|------|------|
| HTTP REST (`/v1/chat/completions`) | WebSocket RPC (`ws://localhost:18789`) |
| Bearer Token 认证 | Ed25519 设备身份 + Challenge-Response 握手 |
| OpenAI SSE 格式 (`data: {"choices":[...]}`) | 自定义事件帧 (`type:"event"`, `event:"agent"`) |
| 无状态请求 | 有状态会话 (`sessionKey`, `idempotencyKey`) |

因此需要**完全重写通信层**，将 WebSocket RPC 协议桥接为浏览器可消费的 SSE 流。

---

## 二、变更文件清单

共修改 **6 个文件**，新增 **350 行**，删除 **53 行**：

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `src/app/api/openclaw/route.ts` | **重写** | HTTP 代理 → WebSocket-to-SSE 桥接器 |
| `src/lib/openclaw-client.ts` | **重写** | OpenAI SSE 解析 → 自定义命名事件解析 |
| `next.config.ts` | 修改 | webpack fallback → `serverExternalPackages` |
| `package.json` | 修改 | 添加 `@types/ws` 开发依赖 |
| `.env.local` | 修改 | 填入 `OPENCLAW_GATEWAY_TOKEN` |
| `.gitignore` | 修改 | 忽略 GSD 工作流本地文件 |

---

## 三、各文件变更详情

### 3.1 `src/app/api/openclaw/route.ts` — 核心重写

**变更前**: 简单的 HTTP 反向代理，将请求转发到 `${gatewayUrl}/v1/chat/completions`，透传 SSE 响应。

**变更后**: 完整的 WebSocket-to-SSE 桥接器，实现了：

#### (a) Ed25519 设备身份模块（模块级，进程启动时生成一次）
```
generateKeyPairSync('ed25519') → 派生 deviceId (SHA256 of raw public key)
```
- 生成 Ed25519 密钥对
- 从 SPKI DER 格式提取原始公钥
- 计算 `deviceId = SHA256(rawPublicKey).hex()`
- 提供 `signPayload()` 函数用于 v3 认证载荷签名

#### (b) WebSocket 连接与认证握手
```
浏览器 POST → API Route 创建 ReadableStream → 打开 WS 连接 → 收到 challenge → 签名回复 connect
```
认证流程：
1. 连接 Gateway WebSocket
2. 收到 `connect.challenge` 事件（含 `nonce`）
3. 构造 v3 认证载荷：`v3|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce|platform|deviceFamily`
4. 用 Ed25519 私钥签名
5. 发送 `connect` 请求（含设备身份信息）
6. 收到 `hello-ok` 响应

#### (c) 聊天消息发送与流式接收
```
认证成功 → 发送 chat.send(sessionKey, idempotencyKey, message) → 监听 agent 事件 → 输出 SSE
```
- 认证成功后发送 `chat.send` RPC 请求
- 监听 `event:"agent"` + `stream:"assistant"` 事件，提取 `data.delta` 文本
- 监听 `stream:"lifecycle"` + `phase:"end"` 作为完成信号
- 监听 `event:"chat"` + `state:"final"` 作为备用完成信号

#### (d) SSE 输出格式
```
event: delta\ndata: {"delta":"token text"}\n\n   — 流式文本片段
event: done\ndata: {}\n\n                         — 完成信号
event: error\ndata: {"error":"..."}\n\n            — 错误信息  
```

#### (e) 连接生命周期管理
- 客户端断开（`request.signal abort`）→ 关闭 WS
- WS 错误/关闭 → 通知 SSE 并清理
- 防止重复清理（`done` 标志位）

---

### 3.2 `src/lib/openclaw-client.ts` — SSE 解析重写

**变更前**: 解析 OpenAI 兼容 SSE 格式：
```
data: {"choices":[{"delta":{"content":"token"}}]}
data: [DONE]
```

**变更后**: 解析自定义命名事件 SSE 格式：
```
event: delta
data: {"delta":"token text"}

event: done
data: {}

event: error
data: {"error":"..."}
```

具体改动：
- **请求体简化**: 不再转发完整的 `messages` 数组和 `model`/`temperature` 参数，改为只发送 `message`（最后一条用户消息），因为 Gateway 内部维护会话历史
- **新增 `session_key`**: 支持指定 OpenClaw 会话标识（默认 `agent:main:main`）
- **SSE 解析器重写**: 新增 `currentEvent` 状态跟踪，按 `event:` 行识别事件类型，然后对应处理 `data:` 行
- **错误处理增强**: 读取响应体文本用于错误诊断

---

### 3.3 `next.config.ts` — WebSocket 运行时修复

**变更前**:
```ts
webpack: (config, { isServer }) => {
  if (isServer) {
    config.resolve.fallback = {
      bufferutil: false,
      'utf-8-validate': false,
    };
  }
  return config;
}
```

**变更后**:
```ts
serverExternalPackages: ['ws'],
```

**原因**: 原来的 webpack fallback 将 `bufferutil` 替换为空模块，导致 `ws` 包在运行时调用 `bufferutil.mask()` 报错 `TypeError: bufferutil.mask is not a function`。改用 `serverExternalPackages` 让 Next.js 将 `ws` 包作为外部依赖通过 Node.js 原生 `require` 加载，避免 webpack 打包干预。

---

### 3.4 `package.json` — 类型声明依赖

新增 `@types/ws` (^8.18.1) 作为开发依赖，为 `route.ts` 中的 `import WebSocket from 'ws'` 提供 TypeScript 类型定义。

---

### 3.5 `.env.local` — 配置补全

将空的 `OPENCLAW_GATEWAY_TOKEN=` 填入实际 Gateway Token，使服务端桥接器能自动认证，UI 无需手动传入 Token。

---

### 3.6 `.gitignore` — GSD 文件排除

添加 GSD（get-shit-done）工作流产生的本地文件到 `.gitignore`，不影响功能。

---

## 四、架构变化示意

### 变更前（HTTP 直通代理）
```
浏览器 ──POST──▶ /api/openclaw ──fetch──▶ Gateway /v1/chat/completions ❌ 404
                                    (HTTP REST, Bearer Token)
```

### 变更后（WS→SSE 桥接器）
```
浏览器 ──POST──▶ /api/openclaw ──WebSocket──▶ Gateway ws://localhost:18789
         ◀─SSE──┘                   │
  event: delta                      ├─ connect.challenge (nonce)
  event: delta                      ├─ connect (Ed25519 device identity)
  event: done                       ├─ hello-ok
                                    ├─ chat.send (sessionKey, message)
                                    ├─ agent events (stream: assistant, delta)
                                    └─ lifecycle end / chat final
```

---

## 五、验证结果

| 测试项 | 结果 |
|--------|------|
| TypeScript 编译 (`next build`) | ✅ 通过 |
| API 端点 curl 测试 | ✅ 收到完整 SSE 流（delta tokens + done） |
| Gateway 认证（Ed25519 设备身份） | ✅ 获得 operator.write 等 scope |
| 流式响应内容 | ✅ "Hi, I'm Nexus—here to assist you!" |
| 生产构建 | ✅ 所有路由正常生成 |

---

## 六、未修改的文件

- **`src/app/chat-interface.tsx`**: 主 UI 控制器**未修改**。`sendToOpenClaw()` 函数调用 `streamOpenClawChat('/api/openclaw', {...})` 的接口与重写后的客户端库保持兼容。
- **`src/lib/openclaw-client.ts` 中的 `SentenceBuffer` 类**: 句子分割逻辑**未修改**，仍在标点处切分流式文本供 TTS 使用。

---

## 七、已知遗留

1. **测试文件清理**: 项目根目录存在 `test_gateway.py` 和 `test_ws_gateway.mjs`（协议逆向工程阶段产生），可删除
2. **会话管理**: 当前默认使用 `agent:main:main` 作为 `sessionKey`，未在 UI 中暴露会话切换功能
3. **连接复用**: 每次请求新建 WS 连接，高频场景下可考虑连接池化
4. **`src/lib/audio.ts:455`**: 预存在的 Uint8Array 类型错误，与本次变更无关
