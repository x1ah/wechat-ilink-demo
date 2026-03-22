# 微信 ClawBot：首个官方个人号 Bot API 协议拆解与实战

> 从 OpenClaw 插件到独立 Bot，完整实现微信官方机器人 API 对接

## 一、十年等待，一朝开放

微信个人号的机器人开发，一直是一部"猫鼠游戏"史：

| 时期 | 方案 | 原理 | 结局 |
|------|------|------|------|
| 2015-2017 | itchat / wxpy | 微信 Web 协议 | 2017 年微信封禁 Web 端登录，新号完全不可用 |
| 2017-2019 | Xposed Hook | Android 端 hook 微信进程 | 2019 年微信大规模封杀 |
| 2019-2025 | iPad 协议 | 模拟 iPad 端微信 | 灰色地带，服务商被腾讯起诉 |
| 2019-至今 | PC Hook（WeChatFerry 等） | 注入 PC 端微信进程 | 逆向注入，随时封号 |

**2026 年，腾讯终于迈出了历史性的一步** — 通过"微信 ClawBot 插件"，首次为个人号提供官方合法的 Bot API。底层协议名为 iLink（智联），以 `@tencent-weixin/openclaw-weixin` npm 包的形式，作为 OpenClaw（AI Gateway 框架）的 Channel Plugin 发布。

> 💡 这意味着：你终于可以合法、稳定地给微信个人号接入 AI 能力了，不用担心封号。

---

## 二、协议全景：五分钟搞懂

### 整体架构

iLink 是一套纯 HTTP/JSON 协议，接入域名 `ilinkai.weixin.qq.com`，不需要 WebSocket，对开发者非常友好。

```
用户微信 ←→ iLink 服务器 (ilinkai.weixin.qq.com)
                   ↕  HTTP/JSON
              你的 Bot 程序
                   ↕
         1. GET  get_bot_qrcode      → 获取二维码
         2. GET  get_qrcode_status   → 轮询扫码（拿到 bot_token）
         3. POST getupdates          → 长轮询收消息（35s hold + 游标）
         4. POST sendmessage         → 回复（必须带 context_token）
```

### 关键设计

**鉴权机制**

- 扫码登录获取 `bot_token`
- 每个请求带 `Authorization: Bearer {token}`
- `X-WECHAT-UIN`：每次请求随机生成 uint32 → base64，防重放攻击

**消息机制**

- 长轮询（35s hold）+ 游标推进，类似 Telegram Bot API
- 回复必须带 `context_token`，关联到正确的对话窗口
- **不能主动推送**，必须由用户先发消息触发

### API 端点总览

| 端点 | 方法 | 用途 | 超时 |
|------|------|------|------|
| `ilink/bot/get_bot_qrcode` | GET | 获取登录二维码 | - |
| `ilink/bot/get_qrcode_status` | GET | 轮询扫码状态 | 35s |
| `ilink/bot/getupdates` | POST | 长轮询收消息 | 35s |
| `ilink/bot/sendmessage` | POST | 发送消息 | 15s |
| `ilink/bot/getconfig` | POST | 获取 bot 配置（含 typing_ticket） | 10s |
| `ilink/bot/sendtyping` | POST | 发送"正在输入"状态 | 10s |
| `ilink/bot/getuploadurl` | POST | 获取 CDN 预签名上传地址 | 15s |

每个请求都需要携带 `base_info: { channel_version: "1.0.2" }`。

---

## 三、与 OpenClaw 的集成架构

### OpenClaw 是什么

OpenClaw 是一个开源的 AI Gateway 框架，采用插件化设计。每个消息渠道（Telegram、Discord、Slack、微信等）都是一个独立的 Channel Plugin，将各渠道的消息规范化为统一格式，再交给 AI Agent 处理。

`@tencent-weixin/openclaw-weixin` 就是微信渠道的官方 Channel Plugin。

### 架构层次

```
用户微信 ←→ ilinkai.weixin.qq.com ←→ @tencent-weixin/openclaw-weixin ←→ OpenClaw Gateway ←→ AI Agent
              (iLink 协议)                  (Channel Plugin)                (统一消息格式)       (Claude/GPT/...)
```

### 插件生命周期

Plugin 通过 OpenClaw 的 7 阶段生命周期管理：

1. **Discovery** — 扫描 `extensions/` 目录，读取 `package.json` 中的 `openclaw.extensions` 字段
2. **Loading** — 动态 import 插件入口文件
3. **Validation** — 校验配置 schema
4. **Runtime Creation** — 创建运行时实例
5. **Registration** — 调用 `api.registerChannel(plugin)` 注册为微信渠道
6. **Activation** — 开始长轮询收取消息
7. **Teardown** — 清理资源

### SDK 的增值能力

通过阅读 `@tencent-weixin/openclaw-weixin` 1.0.2 的源码，发现 SDK 在 iLink 协议之上做了大量增强：

| 能力 | 说明 |
|------|------|
| **Session Guard** | 检测到错误码 `-14`（会话过期）时，自动暂停该账号 60 分钟，防止触发风控 |
| **Config Cache** | `typing_ticket` 按用户缓存 24 小时，失败时指数退避重试（2s → 4s → ... → 1h） |
| **Markdown → 纯文本** | AI 返回的 markdown 自动转为微信友好的纯文本（去代码围栏、去图片、链接只留文字） |
| **SILK 语音转码** | 使用 `silk-wasm` 将微信 SILK 音频解码为 WAV（24kHz 单声道 16-bit） |
| **CDN 媒体加解密** | AES-128-ECB 加密上传、下载解密，自动检测 key 编码格式 |
| **引用消息识别** | 读取 `ref_msg` 字段，格式化为 `[引用: xxx] 回复内容`（只读，发送不支持引用） |
| **Pairing 配对** | 扫码用户自动注册到 allowFrom 授权列表，非授权用户消息直接丢弃 |
| **Debug 全链路追踪** | 发送 `/toggle-debug` 开启，每条回复追加完整耗时分解报告 |

> ⚠️ iLink 提供协议，OpenClaw 提供框架，SDK 在两者之间做桥接和增强。但 iLink 协议本身是独立的 HTTP/JSON API，完全可以脱离 OpenClaw 直接调用。

---

## 四、实战：从零构建独立微信 Bot

接下来我们**完全脱离 OpenClaw**，直接调用 iLink 协议，用 Node.js 构建一个可运行的微信机器人。

### 快速开始

```bash
git clone <this-repo>
cd wechat-ilink-demo
npm install
node bot.mjs
```

运行后终端会显示二维码，微信扫码确认即可。给 Bot 发任意消息，它会先显示"正在输入"，然后原样回复。

### 4.1 扫码登录

```javascript
const ILINK_BASE = "https://ilinkai.weixin.qq.com";

async function login() {
  // 1. 获取二维码
  const qrRes = await fetch(
    `${ILINK_BASE}/ilink/bot/get_bot_qrcode?bot_type=3`,
    { headers: makeHeaders() }
  );
  const qrData = await qrRes.json();

  // ⚠️ 注意：用 qrcode_img_content（微信可识别的 URL）
  //         不是 qrcode（那只是轮询用的 key）
  const qrcodeUrl = qrData.qrcode_img_content;
  const qrcodeKey = qrData.qrcode;

  // 终端显示二维码，手机微信扫描
  qrterm.generate(qrcodeUrl, { small: true });

  // 2. 轮询扫码状态
  while (true) {
    await sleep(2000);
    const statusRes = await fetch(
      `${ILINK_BASE}/ilink/bot/get_qrcode_status?qrcode=${qrcodeKey}`,
      { headers: makeHeaders() }
    );
    const statusData = await statusRes.json();
    if (statusData.bot_token) {
      // 登录成功！保存 token 供后续使用
      return {
        bot_token: statusData.bot_token,
        baseurl: statusData.baseurl || ILINK_BASE,
      };
    }
  }
}
```

### 4.2 长轮询收消息

```javascript
async function pollLoop(tokenData, onMessage) {
  let cursor = "";
  while (true) {
    try {
      const data = await apiPost(
        tokenData.baseurl,
        "ilink/bot/getupdates",
        { get_updates_buf: cursor, base_info: { channel_version: "1.0.2" } },
        tokenData.bot_token,
        40_000 // 客户端超时留余量
      );

      // 更新游标
      if (data.get_updates_buf) cursor = data.get_updates_buf;

      // ⚠️ 注意：消息列表在 msgs 字段
      for (const msg of (data.msgs || [])) {
        if (msg.message_type === 2) continue; // 跳过 bot 自己的消息
        // ⚠️ 文本内容在 item_list[].text_item.text
        const text = msg.item_list
          ?.filter(i => i.type === 1 && i.text_item)
          .map(i => i.text_item.text)
          .join("");
        await onMessage(msg, text);
      }
    } catch (err) {
      if (err.name === "AbortError") continue; // 长轮询超时，正常
      await sleep(3000);
    }
  }
}
```

### 4.3 发送回复 + typing 状态

```javascript
// 发送文本消息
async function sendText(baseUrl, token, to, contextToken, text) {
  // ⚠️ 注意：外层需要 msg 包裹 + client_id + base_info
  //         响应是空对象 {} 即表示成功
  return apiPost(baseUrl, "ilink/bot/sendmessage", {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: `demo-${crypto.randomUUID()}`,
      message_type: 2,    // BOT 发送
      message_state: 2,    // FINISH（完整消息）
      context_token: contextToken,
      item_list: [{ type: 1, text_item: { text } }],
    },
    base_info: { channel_version: "1.0.2" },
  }, token);
}

// typing 状态（需要先获取 typing_ticket）
async function sendTyping(baseUrl, token, userId, contextToken) {
  // ⚠️ 注意：不能直接发 typing，需要先 getConfig 拿 ticket
  const config = await apiPost(baseUrl, "ilink/bot/getconfig", {
    ilink_user_id: userId,
    context_token: contextToken,
    base_info: { channel_version: "1.0.2" },
  }, token);

  if (config.typing_ticket) {
    await apiPost(baseUrl, "ilink/bot/sendtyping", {
      ilink_user_id: userId,
      typing_ticket: config.typing_ticket,
      status: 1, // 1=typing, 2=cancel
      base_info: { channel_version: "1.0.2" },
    }, token);
  }
}
```

完整可运行代码见 [bot.mjs](./bot.mjs)。

---

## 五、能力边界与展望

### 当前能力

- 文本、图片、语音、文件、视频的收发
- "正在输入" typing 状态
- 引用消息识别（只读）
- 语音消息自动转文字

### 当前限制

- **不能主动推送消息** — `context_token` 机制决定了必须用户先发消息，Bot 才能回复
- **不能发送引用消息** — `ref_msg` 是只读字段，发送时服务端忽略
- **媒体需自行加解密** — CDN 文件使用 AES-128-ECB 加密，需要自己处理
- **腾讯保留管控权** — 可随时限速、拦截、终止服务

### 应用场景

- **AI 助手** — 接入 Claude / GPT，在微信里直接和 AI 对话
- **客服机器人** — 自动回复常见问题
- **告警通知** — 当用户主动询问时返回系统状态
- **工作流自动化** — 通过微信发指令触发自动化任务

### 与历史方案的根本区别

这不是又一个"破解微信协议"的项目。iLink 是腾讯**主动设计并开放**的：有专用域名、有正式服务条款、有明确的能力边界。开发者不再需要在"功能"和"安全"之间做取舍。

微信个人号生态的 AI 化，可能才刚刚开始。

---

## License

MIT
