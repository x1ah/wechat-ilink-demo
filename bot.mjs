/**
 * 微信 iLink Bot Demo
 *
 * 完整演示：扫码登录 → 长轮询收消息 → typing 状态 → 自动回复
 * 直接调用 iLink 协议，不依赖 OpenClaw。
 * 请求格式参照 @tencent-weixin/openclaw-weixin 1.0.2 源码。
 */

import crypto from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

// ============ 配置 ============

const ILINK_BASE = "https://ilinkai.weixin.qq.com";
const TOKEN_FILE = "./bot_token.json";
const CHANNEL_VERSION = "1.0.2";
const POLL_TIMEOUT_MS = 40_000;
const API_TIMEOUT_MS = 15_000;

// ============ 底层工具 ============

/** base_info：每个请求都要带 */
function baseInfo() {
  return { channel_version: CHANNEL_VERSION };
}

/** X-WECHAT-UIN：random uint32 → 十进制字符串 → base64（防重放） */
function randomUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

/** 构造请求头（与源码 api.ts buildHeaders 对齐） */
function makeHeaders(token, bodyStr) {
  const headers = {
    "Content-Type": "application/json",
    "AuthorizationType": "ilink_bot_token",
    "X-WECHAT-UIN": randomUin(),
  };
  if (bodyStr) {
    headers["Content-Length"] = String(Buffer.byteLength(bodyStr, "utf-8"));
  }
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

/** 通用 POST 请求（与源码 api.ts apiFetch 对齐） */
async function apiPost(baseUrl, endpoint, payload, token, timeoutMs = API_TIMEOUT_MS) {
  const url = new URL(endpoint, baseUrl.endsWith("/") ? baseUrl : baseUrl + "/");
  const bodyStr = JSON.stringify(payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: makeHeaders(token, bodyStr),
      body: bodyStr,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${endpoint} HTTP ${res.status}: ${text}`);
    }
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

function saveToken(data) {
  writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2));
  console.log("[✓] Token 已保存到", TOKEN_FILE);
}

function loadToken() {
  if (!existsSync(TOKEN_FILE)) return null;
  try {
    const data = JSON.parse(readFileSync(TOKEN_FILE, "utf-8"));
    if (data.bot_token) return data;
  } catch {}
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============ API 封装（与源码 api.ts 对齐） ============

/** 长轮询收消息 */
async function getUpdates(baseUrl, token, cursor) {
  return apiPost(
    baseUrl,
    "ilink/bot/getupdates",
    {
      get_updates_buf: cursor || "",
      base_info: baseInfo(),
    },
    token,
    POLL_TIMEOUT_MS
  );
}

/** 发送消息（源码: api.ts sendMessage → 展开 body + base_info） */
async function sendMessageApi(baseUrl, token, msgBody) {
  return apiPost(
    baseUrl,
    "ilink/bot/sendmessage",
    { ...msgBody, base_info: baseInfo() },
    token
  );
}

/** 获取 bot 配置（含 typing_ticket）（源码: api.ts getConfig） */
async function getConfig(baseUrl, token, ilinkUserId, contextToken) {
  return apiPost(
    baseUrl,
    "ilink/bot/getconfig",
    {
      ilink_user_id: ilinkUserId,
      context_token: contextToken,
      base_info: baseInfo(),
    },
    token
  );
}

/** 发送 typing 状态（源码: api.ts sendTyping） */
async function sendTypingApi(baseUrl, token, ilinkUserId, typingTicket, status = 1) {
  return apiPost(
    baseUrl,
    "ilink/bot/sendtyping",
    {
      ilink_user_id: ilinkUserId,
      typing_ticket: typingTicket,
      status, // 1=typing, 2=cancel
      base_info: baseInfo(),
    },
    token
  );
}

// ============ 高级封装 ============

/** 构造发送文本的请求体（源码: send.ts buildTextMessageReq） */
function buildSendTextBody(to, text, contextToken) {
  return {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: `demo-${crypto.randomUUID()}`,
      message_type: 2,   // BOT
      message_state: 2,   // FINISH
      context_token: contextToken,
      item_list: [{ type: 1, text_item: { text } }],
    },
  };
}

/** 发送文本消息 */
async function sendText(baseUrl, token, to, contextToken, text) {
  const body = buildSendTextBody(to, text, contextToken);
  const result = await sendMessageApi(baseUrl, token, body);
  console.log(`[发送] → ${to}: ${text.slice(0, 80)}`);
  return result;
}

/**
 * 发送 typing 状态
 * 需要先 getConfig 拿 typing_ticket（源码: process-message.ts L271-300）
 */
let typingTicketCache = {};

async function startTyping(baseUrl, token, userId, contextToken) {
  try {
    // 缓存 typing_ticket，避免每次都请求
    if (!typingTicketCache[userId]) {
      const config = await getConfig(baseUrl, token, userId, contextToken);
      if (config.typing_ticket) {
        typingTicketCache[userId] = config.typing_ticket;
      }
    }
    const ticket = typingTicketCache[userId];
    if (ticket) {
      await sendTypingApi(baseUrl, token, userId, ticket, 1);
      console.log(`[typing] → ${userId}`);
    }
  } catch (err) {
    // typing 失败不影响主流程
    console.log(`[typing] 失败: ${err.message}`);
  }
}

async function stopTyping(baseUrl, token, userId) {
  try {
    const ticket = typingTicketCache[userId];
    if (ticket) {
      await sendTypingApi(baseUrl, token, userId, ticket, 2);
    }
  } catch {}
}

// ============ 扫码登录 ============

async function login() {
  const saved = loadToken();
  if (saved) {
    console.log("[i] 发现已保存的 token，尝试复用...");
    return saved;
  }

  console.log("\n========== 扫码登录 ==========\n");

  // 1. 获取二维码
  console.log("[1/3] 获取登录二维码...");
  const qrRes = await fetch(
    `${ILINK_BASE}/ilink/bot/get_bot_qrcode?bot_type=3`,
    { headers: makeHeaders() }
  );
  const qrData = await qrRes.json();

  if (!qrData.qrcode_img_content) {
    console.error("[✗] 获取二维码失败:", JSON.stringify(qrData, null, 2));
    process.exit(1);
  }

  const qrcodeUrl = qrData.qrcode_img_content;
  const qrcodeKey = qrData.qrcode;

  // 2. 终端显示二维码
  console.log("[2/3] 请用微信扫描下方二维码:\n");
  try {
    const qrterm = await import("qrcode-terminal");
    qrterm.default.generate(qrcodeUrl, { small: true });
  } catch {
    console.log("    二维码链接:", qrcodeUrl);
  }

  // 3. 轮询扫码状态
  console.log("\n[3/3] 等待扫码确认...");
  while (true) {
    await sleep(2000);
    try {
      const statusRes = await fetch(
        `${ILINK_BASE}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcodeKey)}`,
        { headers: makeHeaders() }
      );
      const statusData = await statusRes.json();

      if (statusData.status === "confirmed" || statusData.bot_token) {
        console.log("\n[✓] 登录成功！");
        const tokenData = {
          bot_token: statusData.bot_token,
          baseurl: statusData.baseurl || ILINK_BASE,
          bot_id: statusData.bot_id || "",
          login_time: new Date().toISOString(),
        };
        saveToken(tokenData);
        return tokenData;
      }

      if (statusData.status === "scanned") {
        process.stdout.write("\r[...] 已扫码，等待确认...");
      } else if (statusData.status === "expired") {
        console.error("\n[✗] 二维码已过期，请重新运行");
        process.exit(1);
      } else {
        process.stdout.write("\r[...] 等待扫码中...");
      }
    } catch {}
  }
}

// ============ 消息处理 ============

const MSG_TYPES = { 1: "文本", 2: "图片", 3: "语音", 4: "文件", 5: "视频" };

function extractText(msg) {
  return (msg.item_list || [])
    .filter((item) => item.type === 1 && item.text_item)
    .map((item) => item.text_item.text)
    .join("");
}

/** 提取引用消息的文本（如果有） */
function extractQuotedText(msg) {
  for (const item of (msg.item_list || [])) {
    if (item.ref_msg?.message_item?.text_item?.text) {
      return item.ref_msg.message_item.text_item.text;
    }
  }
  return null;
}

async function handleMessage(msg, tokenData) {
  const base = tokenData.baseurl || ILINK_BASE;
  const token = tokenData.bot_token;
  const from = msg.from_user_id || "unknown";
  const contextToken = msg.context_token;
  const text = extractText(msg);
  const types = (msg.item_list || []).map((i) => MSG_TYPES[i.type] || `?${i.type}`).join("+");

  // 检测是否有引用消息
  const quoted = extractQuotedText(msg);

  console.log(`[收到 ${types}] ${from}: ${text.slice(0, 100)}`);
  if (quoted) {
    console.log(`  [引用] "${quoted.slice(0, 80)}"`);
  }

  if (!contextToken) {
    console.log("  [!] 无 context_token，跳过回复");
    return;
  }

  // 非文本
  if (!text) {
    await sendText(base, token, from, contextToken, `收到你的${types}消息`);
    return;
  }

  // 命令
  const trimmed = text.trim();

  if (trimmed === "/help") {
    await sendText(base, token, from, contextToken, [
      "iLink Bot Demo 指令：",
      "/help  - 显示帮助",
      "/ping  - 测试连通性",
      "/time  - 当前时间",
      "/info  - 机器人信息",
      "其他消息 - 原样回复",
    ].join("\n"));
    return;
  }
  if (trimmed === "/ping") {
    await sendText(base, token, from, contextToken, "pong!");
    return;
  }
  if (trimmed === "/time") {
    await sendText(base, token, from, contextToken, `当前时间: ${new Date().toLocaleString("zh-CN")}`);
    return;
  }
  if (trimmed === "/info") {
    await sendText(base, token, from, contextToken, [
      `Bot ID: ${tokenData.bot_id || "N/A"}`,
      `登录时间: ${tokenData.login_time || "N/A"}`,
      `服务地址: ${base}`,
    ].join("\n"));
    return;
  }

  // 默认 echo：先 typing 再回复
  await startTyping(base, token, from, contextToken);
  await sleep(500);
  // 如果用户引用了一条消息，回复中体现引用内容
  const reply = quoted
    ? `你引用了「${quoted.slice(0, 50)}」，然后说：${trimmed}`
    : `Echo: ${trimmed}`;
  await sendText(base, token, from, contextToken, reply);
  await stopTyping(base, token, from);
}

// ============ 主循环 ============

async function pollLoop(tokenData, onMessage) {
  const base = tokenData.baseurl || ILINK_BASE;
  const token = tokenData.bot_token;
  let cursor = "";

  console.log("\n========== 开始接收消息 ==========");
  console.log("[i] 长轮询中... 在微信上给机器人发消息试试\n");

  while (true) {
    try {
      const data = await getUpdates(base, token, cursor);

      if (data.ret && data.ret !== 0) {
        console.error(`[!] getupdates 返回错误: ret=${data.ret} errmsg=${data.errmsg || ""}`);
        if (data.errcode === -14) {
          console.error("[✗] Session 超时，请删除 bot_token.json 重新登录");
          process.exit(1);
        }
        await sleep(3000);
        continue;
      }

      if (data.get_updates_buf) {
        cursor = data.get_updates_buf;
      }

      const messages = data.msgs || [];
      for (const msg of messages) {
        // 跳过 bot 自己发的消息（message_type=2）
        if (msg.message_type === 2) continue;
        if (msg.from_user_id?.endsWith("@im.bot")) continue;

        try {
          await onMessage(msg, tokenData);
        } catch (err) {
          console.error("[!] 处理消息异常:", err.message);
        }
      }
    } catch (err) {
      if (err.name === "AbortError") continue; // 长轮询超时，正常
      console.error("[!] 轮询出错:", err.message, "，3秒后重试...");
      await sleep(3000);
    }
  }
}

// ============ 启动 ============

async function main() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║   微信 iLink Bot Demo                ║");
  console.log("║   直接调用 iLink 协议，无需 OpenClaw  ║");
  console.log("╚══════════════════════════════════════╝\n");

  const tokenData = await login();
  await pollLoop(tokenData, handleMessage);
}

main().catch((err) => {
  console.error("启动失败:", err);
  process.exit(1);
});
