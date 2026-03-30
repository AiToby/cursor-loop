/**
 * 文件系统 IPC 层
 *
 * extension.ts 和 mcp-server 是两个独立进程，通过共享 JSON 文件通信。
 * 数据目录: ~/.cursor-loop/<workspace-md5-12>/
 *
 * queue.json     用户 → AI 的消息队列
 * question.json  AI → 用户 的提问
 * answer.json    用户 → AI 的回答
 * reply.json     AI 的回复摘要（展示在 Webview）
 * sessions.json  多会话标签管理
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ─── 路径 ─────────────────────────────────────

const ROOT_DIR = path.join(os.homedir(), ".cursor-loop");

let dataDir = ROOT_DIR;
let QUEUE_FILE = path.join(dataDir, "queue.json");
let QUESTION_FILE = path.join(dataDir, "question.json");
let ANSWER_FILE = path.join(dataDir, "answer.json");
let REPLY_FILE = path.join(dataDir, "reply.json");
let SESSIONS_FILE = path.join(dataDir, "sessions.json");

let HISTORY_FILE = path.join(dataDir, "history.json");
let STATUS_FILE = path.join(dataDir, "status.json");

export function setDataDir(dir: string) {
  dataDir = dir;
  QUEUE_FILE = path.join(dir, "queue.json");
  QUESTION_FILE = path.join(dir, "question.json");
  ANSWER_FILE = path.join(dir, "answer.json");
  REPLY_FILE = path.join(dir, "reply.json");
  SESSIONS_FILE = path.join(dir, "sessions.json");
  HISTORY_FILE = path.join(dir, "history.json");
  STATUS_FILE = path.join(dir, "status.json");
}

export function getDataDir() {
  return dataDir;
}

export function getFilePaths() {
  return { QUEUE_FILE, QUESTION_FILE, ANSWER_FILE, REPLY_FILE, SESSIONS_FILE, HISTORY_FILE, STATUS_FILE };
}

function ensureDir() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

// ─── 消息队列 ──────────────────────────────────

export interface QueueItem {
  id: string;
  type: "text" | "image" | "file";
  content?: string;
  path?: string;
  caption?: string;
  tag?: string;
  timestamp: string;
}

function makeId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function readQueue(): QueueItem[] {
  ensureDir();
  if (!fs.existsSync(QUEUE_FILE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(QUEUE_FILE, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function writeQueue(items: QueueItem[]) {
  ensureDir();
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(items, null, 2), "utf-8");
}

export function sendText(text: string, tag?: string) {
  const queue = readQueue();
  const item: QueueItem = {
    id: makeId(),
    type: "text",
    content: text,
    timestamp: new Date().toISOString(),
  };
  if (tag) item.tag = tag;
  queue.push(item);
  writeQueue(queue);
}

export function sendImage(filePath: string, caption?: string) {
  const queue = readQueue();
  queue.push({
    id: makeId(),
    type: "image",
    path: filePath,
    caption,
    timestamp: new Date().toISOString(),
  });
  writeQueue(queue);
}

export function sendFile(filePath: string) {
  const queue = readQueue();
  queue.push({
    id: makeId(),
    type: "file",
    path: filePath,
    timestamp: new Date().toISOString(),
  });
  writeQueue(queue);
}

export function getQueueCount(): number {
  return readQueue().length;
}

export function deleteQueueItem(id: string) {
  writeQueue(readQueue().filter((item) => item.id !== id));
}

export function clearQueue() {
  writeQueue([]);
}

export function updateQueueItem(id: string, content: string) {
  const queue = readQueue();
  const item = queue.find((i) => i.id === id);
  if (item && item.type === "text") {
    item.content = content;
    writeQueue(queue);
  }
}

// ─── AI 提问 / 用户回答 ──────────────────────────

export interface QuestionOption {
  id: string;
  label: string;
}

export interface QuestionItem {
  id: string;
  question: string;
  options: QuestionOption[];
  allow_multiple: boolean;
}

export interface QuestionData {
  id: string;
  questions: QuestionItem[];
  timestamp: string;
}

export interface AnswerItem {
  questionId: string;
  selected: string[];
  other: string;
}

export interface AnswerData {
  id: string;
  answers: AnswerItem[];
}

export function readQuestion(): QuestionData | null {
  if (!fs.existsSync(QUESTION_FILE)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(QUESTION_FILE, "utf-8"));
    return data?.id && data?.questions ? data : null;
  } catch {
    return null;
  }
}

export function writeAnswer(answer: AnswerData) {
  ensureDir();
  fs.writeFileSync(ANSWER_FILE, JSON.stringify(answer, null, 2), "utf-8");
}

export function cancelQuestion() {
  const q = readQuestion();
  if (!q) return;
  const answers = q.questions.map((qi, i) => ({
    questionId: qi.id,
    selected: [] as string[],
    other: i === 0 ? "用户取消了回答" : "",
  }));
  writeAnswer({ id: q.id, answers });
}

// ─── AI 回复摘要 ──────────────────────────────────

export interface ReplyData {
  content: string;
  timestamp: string;
}

export function readReply(): ReplyData | null {
  if (!fs.existsSync(REPLY_FILE)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(REPLY_FILE, "utf-8"));
    return data?.content ? data : null;
  } catch {
    return null;
  }
}

export function clearReply() {
  try {
    fs.unlinkSync(REPLY_FILE);
  } catch {}
}

// ─── 会话管理 ──────────────────────────────────

const SESSION_STALE_MS = 3 * 60 * 1000;

interface SessionsData {
  counter: number;
  tags: string[];
  activity: Record<string, number>;
}

export function getSessionTags(): string[] {
  try {
    const raw = fs.readFileSync(SESSIONS_FILE, "utf-8");
    const data: SessionsData = JSON.parse(raw);
    const tags = Array.isArray(data.tags) ? data.tags : [];
    const activity = data.activity || {};
    const now = Date.now();
    return tags.filter((tag) => {
      const last = activity[tag];
      return last && now - last < SESSION_STALE_MS;
    });
  } catch {
    return [];
  }
}

export function resetSessions() {
  try {
    fs.writeFileSync(
      SESSIONS_FILE,
      JSON.stringify({ counter: 0, tags: [], activity: {} }, null, 2),
      "utf-8"
    );
  } catch {}
}

// ─── MCP 配置 ──────────────────────────────────

const RULES_FILE_NAME = "cursor-loop.mdc";

const RULES_CONTENT = `---
description: "Cursor Loop: 每轮回复后自动调用 check_messages 保持持续对话"
globs: "**/*"
alwaysApply: true
---

# Cursor Loop MCP 工具调用规则

## 核心循环（必须遵守）
1. 每轮对话回复**完整输出后**，最后一步必须调用 \`check_messages\`，适用于 Agent/Plan/Debug/Ask 所有模式
2. \`check_messages\` 会持续等待直到用户发来新消息；收到后处理并回复，然后再次调用 \`check_messages\`，形成永续循环
3. 首次调用不传 session_tag，系统自动分配；收到分配后，后续每次必须传入 session_tag
4. 可通过 reply 参数将本轮回复摘要推送到插件界面

## 提问规则（严格禁止文字提问）
5. **凡是需要用户做选择、确认、投票、选方案、选框架的场景，必须且只能调用 \`ask_question\` 工具**
6. **严禁**在回复文本中以"你想选哪个？""是否确认？""请选择"等方式向用户提问——用户**看不到**这些文字提问
7. **严禁**使用 Cursor 内置的 ask_user_question 或 AskQuestion
8. 只有纯信息性输出（不需要用户回复）才可以用纯文本

## 异常恢复
9. 如果 check_messages/ask_question 因客户端取消、网络抖动或内部异常返回/报错，**禁止输出内部提示**，必须立即重新调用
10. 如果收到"[system] 会话恢复"类消息，说明用户手动触发了恢复，正常处理即可

## 进度推送
11. 执行多步任务时，每完成一个关键步骤后调用 \`send_progress\` 推送进度

---
**回合结束（强制）**: 回复完成后最后一步必须调用 \`check_messages\`。凡需要用户选择/确认的，必须用 \`ask_question\` 工具，严禁文字提问。
`;

export function getMcpServerPath(): string {
  const extDir = path.dirname(path.dirname(__filename));
  return path.join(extDir, "dist", "mcp-server.mjs");
}

export function setupMcpConfig(
  workspaceFolder: string,
  messengerDataDir: string
): boolean {
  const cursorDir = path.join(workspaceFolder, ".cursor");
  if (!fs.existsSync(cursorDir)) {
    fs.mkdirSync(cursorDir, { recursive: true });
  }

  const mcpJsonPath = path.join(cursorDir, "mcp.json");
  const previousContent = fs.existsSync(mcpJsonPath)
    ? fs.readFileSync(mcpJsonPath, "utf-8")
    : "";

  let config: any = {};
  if (fs.existsSync(mcpJsonPath)) {
    try {
      config = JSON.parse(previousContent);
    } catch {}
  }
  if (!config.mcpServers) config.mcpServers = {};

  const mcpServerConfig: any = {
    command: "node",
    args: [getMcpServerPath()],
  };
  if (messengerDataDir) {
    mcpServerConfig.env = { CURSOR_LOOP_DATA_DIR: messengerDataDir };
  }
  config.mcpServers["cursor-loop"] = mcpServerConfig;

  const nextContent = JSON.stringify(config, null, 2);
  let changed = false;
  if (nextContent !== previousContent) {
    fs.writeFileSync(mcpJsonPath, nextContent, "utf-8");
    changed = true;
  }

  if (ensureRulesFile(workspaceFolder)) {
    changed = true;
  }
  return changed;
}

export function removeMcpConfig(workspaceFolder: string): boolean {
  const mcpJsonPath = path.join(workspaceFolder, ".cursor", "mcp.json");
  let removed = false;
  if (fs.existsSync(mcpJsonPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
      if (config.mcpServers?.["cursor-loop"]) {
        delete config.mcpServers["cursor-loop"];
        fs.writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2), "utf-8");
        removed = true;
      }
    } catch {}
  }
  removeRulesFile(workspaceFolder);
  return removed;
}

function ensureRulesFile(workspaceFolder: string): boolean {
  const rulesDir = path.join(workspaceFolder, ".cursor", "rules");
  if (!fs.existsSync(rulesDir)) {
    fs.mkdirSync(rulesDir, { recursive: true });
  }
  const filePath = path.join(rulesDir, RULES_FILE_NAME);
  const existing = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, "utf-8")
    : "";
  if (existing === RULES_CONTENT) return false;
  fs.writeFileSync(filePath, RULES_CONTENT, "utf-8");
  return true;
}

function removeRulesFile(workspaceFolder: string) {
  const filePath = path.join(
    workspaceFolder,
    ".cursor",
    "rules",
    RULES_FILE_NAME
  );
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch {}
  }
}

// ─── 发送历史 ──────────────────────────────────

export interface HistoryItem {
  id: string;
  type: "text" | "image" | "file";
  content?: string;
  path?: string;
  timestamp: string;
}

const MAX_HISTORY = 50;

export function readHistory(): HistoryItem[] {
  ensureDir();
  if (!fs.existsSync(HISTORY_FILE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function addToHistory(item: Omit<HistoryItem, "id">) {
  const history = readHistory();
  history.unshift({
    ...item,
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
  });
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), "utf-8");
}

export function clearHistory() {
  try {
    fs.writeFileSync(HISTORY_FILE, "[]", "utf-8");
  } catch {}
}

// ─── 连接状态 ──────────────────────────────────

export interface StatusData {
  state: "idle" | "waiting" | "processing";
  lastHeartbeat: number;
  sessionTag?: string;
}

export function readStatus(): StatusData {
  if (!fs.existsSync(STATUS_FILE)) return { state: "idle", lastHeartbeat: 0 };
  try {
    return JSON.parse(fs.readFileSync(STATUS_FILE, "utf-8"));
  } catch {
    return { state: "idle", lastHeartbeat: 0 };
  }
}

export function writeStatus(data: Partial<StatusData>) {
  ensureDir();
  const current = readStatus();
  fs.writeFileSync(
    STATUS_FILE,
    JSON.stringify({ ...current, ...data }, null, 2),
    "utf-8"
  );
}
