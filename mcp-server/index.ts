/**
 * Cursor Loop MCP Server
 *
 * 独立 Node.js 进程，由 Cursor 通过 .cursor/mcp.json 启动。
 * 通过 stdin/stdout (JSON-RPC 2.0) 与 Cursor AI 通信。
 *
 * 提供 3 个工具:
 *   check_messages  — 阻塞式长轮询，等待用户消息
 *   ask_question    — 向用户提问并等待回答
 *   send_progress   — 推送进度摘要（立即返回）
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// ─── 配置 ───────────────────────────────────────

const DATA_DIR =
  process.env.CURSOR_LOOP_DATA_DIR ||
  path.join(os.homedir(), ".cursor-loop");

const QUEUE_FILE = path.join(DATA_DIR, "queue.json");
const QUESTION_FILE = path.join(DATA_DIR, "question.json");
const ANSWER_FILE = path.join(DATA_DIR, "answer.json");
const REPLY_FILE = path.join(DATA_DIR, "reply.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const STATUS_FILE = path.join(DATA_DIR, "status.json");

const POLL_INTERVAL = 100; // ms, 轮询 queue.json 的间隔
const HEARTBEAT_INTERVAL = 8_000; // ms, 防止 Cursor 判定工具超时
const MAX_WAIT_MS = 120_000; // ms, check_messages 最长阻塞时间
const SESSION_STALE_MS = 3 * 60 * 1_000; // 3 分钟无活动的会话视为过期

const SYSTEM_SUFFIX =
  "\n\n---\n[system] 以上是用户通过 Cursor Loop 插件发送的消息。回复完成后请调用 check_messages 继续监听。如需用户做选择/确认，必须调用 ask_question 工具，严禁文字提问。";

// ─── 工具函数 ────────────────────────────────────

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function writeStatus(state: string, tag?: string) {
  try {
    const data: any = { state, lastHeartbeat: Date.now() };
    if (tag) data.sessionTag = tag;
    await fs.writeFile(STATUS_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch {}
}

async function readQueue(): Promise<any[]> {
  try {
    const raw = await fs.readFile(QUEUE_FILE, "utf-8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

// ─── 会话标签管理 ─────────────────────────────────

interface SessionsData {
  counter: number;
  tags: string[];
  activity: Record<string, number>;
}

async function readSessions(): Promise<SessionsData> {
  try {
    const raw = await fs.readFile(SESSIONS_FILE, "utf-8");
    const data = JSON.parse(raw);
    return {
      counter: data.counter || 0,
      tags: data.tags || [],
      activity: data.activity || {},
    };
  } catch {
    return { counter: 0, tags: [], activity: {} };
  }
}

async function writeSessions(data: SessionsData) {
  await fs.writeFile(SESSIONS_FILE, JSON.stringify(data, null, 2), "utf-8");
}

async function allocateSessionTag(): Promise<string> {
  const sessions = await readSessions();
  const now = Date.now();
  const activeNumbers = new Set<number>();

  for (const tag of sessions.tags) {
    const lastActivity = sessions.activity[tag];
    if (lastActivity && now - lastActivity < SESSION_STALE_MS) {
      const match = tag.match(/^对话(\d+)$/);
      if (match) activeNumbers.add(parseInt(match[1], 10));
    }
  }

  let num = 1;
  while (activeNumbers.has(num)) num++;
  const tag = `对话${num}`;

  if (!sessions.tags.includes(tag)) sessions.tags.push(tag);
  sessions.activity[tag] = now;
  sessions.counter = Math.max(sessions.counter, num);
  await writeSessions(sessions);
  return tag;
}

async function touchSessionActivity(tag: string) {
  const sessions = await readSessions();
  sessions.activity[tag] = Date.now();
  await writeSessions(sessions);
}

// ─── 消息处理 ─────────────────────────────────────

const MIME_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
};

const TEXT_EXTS = new Set([
  ".txt", ".md", ".json", ".js", ".ts", ".jsx", ".tsx", ".py",
  ".java", ".c", ".cpp", ".h", ".css", ".html", ".xml", ".yaml",
  ".yml", ".toml", ".ini", ".cfg", ".sh", ".bat", ".ps1", ".log",
  ".csv", ".sql", ".rs", ".go", ".rb", ".php", ".vue", ".svelte",
]);

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

async function processMessage(msg: any): Promise<any | any[]> {
  switch (msg.type) {
    case "text":
      return { type: "text", text: msg.content || "" };

    case "image": {
      if (!msg.path) return { type: "text", text: "[图片消息：路径为空]" };
      try {
        const buf = await fs.readFile(msg.path);
        const ext = path.extname(msg.path).toLowerCase();
        const mime = MIME_MAP[ext] || "application/octet-stream";
        const base64 = buf.toString("base64");
        const result: any[] = [];
        if (msg.caption) result.push({ type: "text", text: msg.caption });
        result.push({ type: "image", data: base64, mimeType: mime });
        return result.length === 1 ? result[0] : result;
      } catch {
        return { type: "text", text: `[图片读取失败: ${msg.path}]` };
      }
    }

    case "file": {
      if (!msg.path) return { type: "text", text: "[文件消息：路径为空]" };
      try {
        const stat = await fs.stat(msg.path);
        const ext = path.extname(msg.path).toLowerCase();
        let text = `[文件: ${path.basename(msg.path)}] (${formatSize(stat.size)})\n路径: ${msg.path}\n`;
        if (TEXT_EXTS.has(ext) && stat.size < 512 * 1024) {
          const content = await fs.readFile(msg.path, "utf-8");
          text += "```\n" + content + "\n```";
        } else {
          text += "(二进制文件，已跳过内容)";
        }
        return { type: "text", text };
      } catch {
        return { type: "text", text: `[文件读取失败: ${msg.path}]` };
      }
    }

    default:
      return { type: "text", text: `[未知消息类型: ${msg.type}]` };
  }
}

// ─── 辅助 ────────────────────────────────────────

function sleepWithAbort(signal: AbortSignal, ms: number): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timeout = setTimeout(finish, ms, true);
    const onAbort = () => finish(false);
    function finish(result: boolean) {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function emitHeartbeat(extra: any, message: string) {
  if (extra.signal.aborted) return;
  const progressToken = extra._meta?.progressToken;
  if (progressToken !== undefined) {
    try {
      await extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress: Date.now(), message },
      });
      return;
    } catch {}
  }
  try {
    await server.sendLoggingMessage(
      { level: "info", logger: "cursor-loop", data: message },
      extra.sessionId
    );
  } catch {}
}

// ─── MCP Server 定义 ─────────────────────────────

const server = new McpServer(
  { name: "cursor-loop", version: "1.0.0" },
  { capabilities: { logging: {} } }
);

// ── Tool 1: check_messages ───────────────────────

server.tool(
  "check_messages",
  `检查并返回待处理的用户消息。

【强制规则】
1. 每轮对话回复完整输出后，最后一步必须调用此工具
2. 收到消息后处理并回复，然后再次调用此工具，形成永续循环
3. 首次调用不传 session_tag，系统自动分配；后续每次必须传入
4. 可通过 reply 参数将本轮回复摘要推送到插件界面
5. 如果此工具因超时或中断返回，不要输出内部提示，直接重新调用`,
  {
    reply: z
      .string()
      .optional()
      .describe("本轮回复摘要（Markdown），推送到插件界面展示"),
    session_tag: z
      .string()
      .optional()
      .describe("会话标识。首次不传，系统自动分配；后续每次必须传入"),
  },
  async ({ reply, session_tag }, extra) => {
    await ensureDataDir();

    // ① 会话标签分配
    let myTag = session_tag;
    let isNewSession = false;
    if (!myTag) {
      myTag = await allocateSessionTag();
      isNewSession = true;
    } else {
      await touchSessionActivity(myTag);
    }

    // ② 写入 reply（供 Webview 展示）
    if (reply) {
      await fs.writeFile(
        REPLY_FILE,
        JSON.stringify({ content: reply, timestamp: new Date().toISOString() }, null, 2),
        "utf-8"
      );
    }

    // ③ 首次调用：返回 tag 分配通知
    if (isNewSession) {
      return {
        content: [
          {
            type: "text",
            text: `[system] 你的对话标识是「${myTag}」。后续每次调用 check_messages 时必须传入 session_tag="${myTag}"。只有标记为「${myTag}」或无标签的消息会被发送给你。`,
          },
        ],
      };
    }

    // ④ 阻塞等待消息（核心循环）
    await writeStatus("waiting", myTag);
    const waitStart = Date.now();
    let nextHeartbeatAt = Date.now() + HEARTBEAT_INTERVAL;

    while (!extra.signal.aborted) {
      const queue = await readQueue();
      const myMessages = queue.filter(
        (msg) => !msg.tag || msg.tag === myTag
      );

      if (myMessages.length > 0) {
        const remaining = queue.filter(
          (msg) => msg.tag && msg.tag !== myTag
        );
        await fs.writeFile(
          QUEUE_FILE,
          JSON.stringify(remaining, null, 2),
          "utf-8"
        );

        const results: any[] = [];
        for (const msg of myMessages) {
          if (msg.tag) {
            results.push({ type: "text", text: `[来自标签: ${msg.tag}]` });
          }
          const processed = await processMessage(msg);
          if (Array.isArray(processed)) {
            results.push(...processed);
          } else {
            results.push(processed);
          }
        }

        if (results.length > 0 && results[results.length - 1].type === "text") {
          results[results.length - 1].text += SYSTEM_SUFFIX;
        } else {
          results.push({ type: "text", text: SYSTEM_SUFFIX });
        }

        await writeStatus("processing", myTag);
        return { content: results };
      }

      // 超时
      if (Date.now() - waitStart >= MAX_WAIT_MS) {
        return {
          content: [
            {
              type: "text",
              text: "[system] 暂无新消息。请勿向用户输出此提示，立即再次调用 check_messages 继续监听。",
            },
          ],
        };
      }

      if (Date.now() >= nextHeartbeatAt) {
        await emitHeartbeat(extra, "Cursor Loop is waiting for messages...");
        if (myTag) await touchSessionActivity(myTag);
        await writeStatus("waiting", myTag);
        nextHeartbeatAt = Date.now() + HEARTBEAT_INTERVAL;
      }

      const keepWaiting = await sleepWithAbort(extra.signal, POLL_INTERVAL);
      if (!keepWaiting) break;
    }

    await writeStatus("idle", myTag);
    return {
      content: [
        {
          type: "text",
          text: "[system] check_messages 被中断。若会话需继续，请直接再次调用 check_messages。",
        },
      ],
      isError: true,
    };
  }
);

// ── Tool 2: send_progress ─────────────────────────

server.tool(
  "send_progress",
  "推送当前工作进度到插件界面。执行多步任务时，每完成一个关键步骤后调用。此工具立即返回，不会等待消息。",
  {
    progress: z
      .string()
      .describe("进度摘要（支持 Markdown），推送到插件界面"),
  },
  async ({ progress }) => {
    await ensureDataDir();
    await fs.writeFile(
      REPLY_FILE,
      JSON.stringify(
        { content: progress, timestamp: new Date().toISOString() },
        null,
        2
      ),
      "utf-8"
    );
    return {
      content: [
        {
          type: "text",
          text: "[system] 进度已推送。请继续执行任务，无需等待用户回复。",
        },
      ],
    };
  }
);

// ── Tool 3: ask_question ──────────────────────────

server.tool(
  "ask_question",
  `向用户提出问题并等待回答。仅在任务中确实需要用户做选择时使用。
支持单选(allow_multiple:false)/多选(allow_multiple:true)，用户可额外输入补充文本。
回答后仍需调用 check_messages 继续监听。`,
  {
    questions: z.array(
      z.object({
        question: z.string().describe("问题文本"),
        options: z.array(
          z.object({
            id: z.string().describe("选项ID"),
            label: z.string().describe("选项显示文本"),
          })
        ).describe("选项列表"),
        allow_multiple: z.boolean().default(false).describe("是否允许多选"),
      })
    ).describe("问题列表"),
  },
  async ({ questions }, extra) => {
    await ensureDataDir();

    const questionItems = questions.map((q, i) => ({
      id: "q" + i,
      question: q.question,
      options: q.options || [],
      allow_multiple: !!q.allow_multiple,
    }));

    const questionData = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      questions: questionItems,
      timestamp: new Date().toISOString(),
    };

    await fs.writeFile(QUESTION_FILE, JSON.stringify(questionData, null, 2), "utf-8");
    try { await fs.unlink(ANSWER_FILE); } catch {}

    // 等待用户回答
    const waitStart = Date.now();
    let nextHeartbeatAt = Date.now() + HEARTBEAT_INTERVAL;

    while (!extra.signal.aborted) {
      try {
        const raw = await fs.readFile(ANSWER_FILE, "utf-8");
        const answerData = JSON.parse(raw);
        try { await fs.unlink(QUESTION_FILE); } catch {}
        try { await fs.unlink(ANSWER_FILE); } catch {}

        const answers = answerData.answers || [];
        const parts: string[] = [];

        for (const qItem of questionItems) {
          const ans = answers.find((a: any) => a.questionId === qItem.id);
          if (!ans) continue;
          const selected: string[] = ans.selected || [];
          const other: string = ans.other || "";
          let text = "";
          if (selected.length > 0) {
            const labels = selected.map(
              (sid: string) =>
                qItem.options.find((o) => o.id === sid)?.label || sid
            );
            text = "选择: " + labels.join(", ");
          }
          if (other) {
            text += text ? "\n用户补充: " + other : "用户回答: " + other;
          }
          if (text) {
            parts.push(
              questionItems.length > 1
                ? "【" + qItem.question + "】\n" + text
                : text
            );
          }
        }

        const finalText = parts.length > 0 ? parts.join("\n\n") : "(用户未作答)";
        return { content: [{ type: "text", text: finalText }] };
      } catch {}

      if (Date.now() - waitStart >= MAX_WAIT_MS) {
        return {
          content: [
            {
              type: "text",
              text: "[system] 等待回答超时。请勿输出此提示，直接重新调用 ask_question。",
            },
          ],
        };
      }

      if (Date.now() >= nextHeartbeatAt) {
        await emitHeartbeat(extra, "Cursor Loop is waiting for the user's answer.");
        nextHeartbeatAt = Date.now() + HEARTBEAT_INTERVAL;
      }

      const keepWaiting = await sleepWithAbort(extra.signal, POLL_INTERVAL);
      if (!keepWaiting) break;
    }

    return {
      content: [
        {
          type: "text",
          text: "[system] ask_question 被中断。请勿输出此提示，若仍需提问请重新调用。",
        },
      ],
      isError: true,
    };
  }
);

// ─── 启动 ────────────────────────────────────────

async function main() {
  await ensureDataDir();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Cursor Loop MCP Server fatal: ${err}\n`);
  process.exit(1);
});
