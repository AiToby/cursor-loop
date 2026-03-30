/**
 * Cursor Loop — 扩展入口
 *
 * 职责：
 *   1. 注册 Webview 侧边栏面板（消息输入、提问回答、进度展示）
 *   2. 轮询文件状态，将 AI 的提问/回复推送到 Webview
 *   3. 自动安装 MCP 配置到工作区
 *   4. 注册命令：安装/卸载 MCP、发送文件
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as crypto from "crypto";
import {
  setDataDir,
  sendText,
  sendImage,
  sendFile,
  readQueue,
  getQueueCount,
  deleteQueueItem,
  clearQueue,
  updateQueueItem,
  readQuestion,
  writeAnswer,
  cancelQuestion,
  readReply,
  clearReply,
  getSessionTags,
  resetSessions,
  setupMcpConfig,
  removeMcpConfig,
} from "./ipc";

let mainPanel: vscode.WebviewView | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let lastQuestionId: string | undefined;
let lastReplyTimestamp: string | undefined;
let lastQueueCount: number | undefined;
let chatTriggered = false;
let currentDataDir = "";

function computeDataDir(workspaceFolders: readonly vscode.WorkspaceFolder[]): string {
  const rootDir = path.join(os.homedir(), ".cursor-loop");
  if (workspaceFolders.length === 0) return rootDir;
  const primary = workspaceFolders[0].uri.fsPath;
  const hash = crypto.createHash("md5").update(primary).digest("hex").slice(0, 12);
  return path.join(rootDir, hash);
}

// ─── 激活 ────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  const workspaceFolders = vscode.workspace.workspaceFolders || [];
  currentDataDir = computeDataDir(workspaceFolders);
  setDataDir(currentDataDir);

  const provider = new LoopViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("cursorLoop.mainView", provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorLoop.setupMcp", () => {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders?.length) {
        vscode.window.showErrorMessage("请先打开一个工作区");
        return;
      }
      const count = setupMcpForFolders(folders);
      vscode.window.showInformationMessage(
        count > 0
          ? `MCP 配置已安装到 ${count} 个工作区，请重启 Cursor 生效`
          : "MCP 配置已存在，无需重复安装"
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorLoop.removeMcp", () => {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders?.length) return;
      let count = 0;
      for (const f of folders) {
        if (removeMcpConfig(f.uri.fsPath)) count++;
      }
      vscode.window.showInformationMessage(
        count > 0
          ? `MCP 配置已从 ${count} 个工作区卸载`
          : "未发现可卸载的 MCP 配置"
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorLoop.sendFile", (uri: vscode.Uri) => {
      if (uri) {
        sendFile(uri.fsPath);
        vscode.window.showInformationMessage("文件已添加到消息队列");
      }
    })
  );

  startPolling();
  autoSetupMcp();

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      if (e.added.length > 0) autoSetupMcp(e.added);
    })
  );

  context.subscriptions.push({
    dispose: () => {
      if (pollTimer) clearInterval(pollTimer);
    },
  });
}

export function deactivate() {
  if (pollTimer) clearInterval(pollTimer);
}

// ─── 轮询状态 ────────────────────────────────────

function startPolling() {
  const poll = () => {
    if (!mainPanel) return;

    const question = readQuestion();
    if (question) {
      if (question.id !== lastQuestionId) {
        mainPanel.webview.postMessage({ type: "showQuestion", data: question });
        lastQuestionId = question.id;
      }
    } else if (lastQuestionId) {
      mainPanel.webview.postMessage({ type: "clearQuestion" });
      lastQuestionId = undefined;
    }

    const reply = readReply();
    if (reply && reply.timestamp !== lastReplyTimestamp) {
      mainPanel.webview.postMessage({ type: "showReply", data: reply });
      lastReplyTimestamp = reply.timestamp;
    } else if (!reply) {
      lastReplyTimestamp = undefined;
    }

    const count = getQueueCount();
    if (count !== lastQueueCount) {
      mainPanel.webview.postMessage({ type: "queueCount", count });
      mainPanel.webview.postMessage({ type: "queueData", data: readQueue() });
      lastQueueCount = count;
    }
  };

  poll();
  pollTimer = setInterval(poll, 500);
}

// ─── 自动安装 MCP ─────────────────────────────────

function autoSetupMcp(
  folders: readonly vscode.WorkspaceFolder[] = vscode.workspace.workspaceFolders || []
) {
  if (folders.length === 0) return;
  const count = setupMcpForFolders(folders);
  if (count > 0) {
    vscode.window.showInformationMessage(
      `Cursor Loop 已自动安装 MCP 配置到 ${count} 个工作区，请重启 Cursor 生效`
    );
  }
}

function setupMcpForFolders(folders: readonly vscode.WorkspaceFolder[]): number {
  let changed = 0;
  for (const folder of folders) {
    try {
      if (setupMcpConfig(folder.uri.fsPath, currentDataDir)) changed++;
    } catch (e: any) {
      vscode.window.showErrorMessage(`安装 MCP 配置失败: ${folder.name} - ${e.message}`);
    }
  }
  return changed;
}

// ─── 触发 Cursor Chat ─────────────────────────────

function handleOutgoingText(text: string, tag?: string) {
  const trimmed = text.trim();
  if (!trimmed) return;
  sendText(trimmed, tag);
  if (!chatTriggered) {
    void triggerCursorChat();
  }
}

async function triggerCursorChat() {
  if (chatTriggered) return;
  chatTriggered = true;
  try {
    const wsName = vscode.workspace.workspaceFolders?.[0]?.name || "default";
    await vscode.commands.executeCommand("workbench.action.chat.open", {
      query: `[${wsName}] 你好，请处理我的消息`,
      isPartialQuery: true,
    });
    await new Promise((r) => setTimeout(r, 800));
    for (const cmd of [
      "workbench.action.chat.acceptInput",
      "workbench.action.chat.submit",
    ]) {
      try {
        await vscode.commands.executeCommand(cmd);
        return;
      } catch {}
    }
  } catch {
    try {
      await vscode.commands.executeCommand("workbench.action.chat.open");
    } catch {}
  }
}

// ─── Webview Provider ─────────────────────────────

class LoopViewProvider implements vscode.WebviewViewProvider {
  constructor(private extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    mainPanel = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "ready":
          this.pushCurrentState();
          mainPanel?.webview.postMessage({
            type: "sessionTags",
            tags: getSessionTags(),
          });
          break;
        case "sendText":
          handleOutgoingText(msg.text, msg.tag);
          break;
        case "sendImage":
          await this.handleSendImage();
          break;
        case "sendPastedImage":
          this.handlePastedImage(msg.dataUrl);
          break;
        case "sendFile":
          await this.handleSendFile();
          break;
        case "submitAnswer":
          writeAnswer(msg.data);
          break;
        case "cancelQuestion":
          cancelQuestion();
          break;
        case "ackReply":
          clearReply();
          lastReplyTimestamp = undefined;
          break;
        case "deleteQueueItem":
          deleteQueueItem(msg.id);
          this.pushQueueData();
          break;
        case "clearQueue":
          clearQueue();
          this.pushQueueData();
          break;
        case "updateQueueItem":
          updateQueueItem(msg.id, msg.content);
          this.pushQueueData();
          break;
        case "getSessionTags":
          mainPanel?.webview.postMessage({
            type: "sessionTags",
            tags: getSessionTags(),
          });
          break;
        case "resetSessions":
          resetSessions();
          mainPanel?.webview.postMessage({ type: "sessionTags", tags: [] });
          break;
        case "interruptChat":
          await this.handleInterrupt(msg.text);
          break;
      }
    });

    webviewView.onDidDispose(() => {
      if (mainPanel === webviewView) {
        mainPanel = undefined;
        lastQuestionId = undefined;
        lastReplyTimestamp = undefined;
        lastQueueCount = undefined;
      }
    });
  }

  private pushCurrentState() {
    if (!mainPanel) return;
    const question = readQuestion();
    if (question) {
      mainPanel.webview.postMessage({ type: "showQuestion", data: question });
      lastQuestionId = question.id;
    } else {
      mainPanel.webview.postMessage({ type: "clearQuestion" });
    }
    const reply = readReply();
    if (reply) {
      mainPanel.webview.postMessage({ type: "showReply", data: reply });
      lastReplyTimestamp = reply.timestamp;
    }
    const count = getQueueCount();
    mainPanel.webview.postMessage({ type: "queueCount", count });
    mainPanel.webview.postMessage({ type: "queueData", data: readQueue() });
    lastQueueCount = count;
  }

  private pushQueueData() {
    if (!mainPanel) return;
    mainPanel.webview.postMessage({ type: "queueData", data: readQueue() });
    mainPanel.webview.postMessage({ type: "queueCount", count: getQueueCount() });
  }

  private handlePastedImage(dataUrl: string) {
    try {
      const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
      if (!match) return;
      const ext = match[1] === "jpeg" ? "jpg" : match[1];
      const buf = Buffer.from(match[2], "base64");
      const tmpPath = path.join(os.tmpdir(), "cursor_loop_" + Date.now() + "." + ext);
      fs.writeFileSync(tmpPath, buf);
      sendImage(tmpPath);
    } catch {}
  }

  private async handleSendImage() {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { Images: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"] },
    });
    if (uris?.[0]) sendImage(uris[0].fsPath);
  }

  private async handleSendFile() {
    const uris = await vscode.window.showOpenDialog({ canSelectMany: false });
    if (uris?.[0]) sendFile(uris[0].fsPath);
  }

  private async handleInterrupt(newText?: string) {
    try {
      await vscode.commands.executeCommand("workbench.action.chat.stop");
    } catch {}
    if (newText?.trim()) {
      await new Promise((r) => setTimeout(r, 500));
      handleOutgoingText(newText.trim());
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
<style nonce="${nonce}">
:root{--bg:var(--vscode-sideBar-background);--fg:var(--vscode-foreground);--fg2:var(--vscode-descriptionForeground);--input-bg:var(--vscode-input-background);--input-border:var(--vscode-input-border,transparent);--btn-bg:var(--vscode-button-background);--btn-fg:var(--vscode-button-foreground);--btn-hover:var(--vscode-button-hoverBackground);--border:var(--vscode-widget-border,rgba(128,128,128,0.2));--badge-bg:var(--vscode-badge-background);--badge-fg:var(--vscode-badge-foreground);--error:var(--vscode-errorForeground,#f44);--success:#22c55e;--radius:6px}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:var(--vscode-font-family);font-size:13px;color:var(--fg);background:var(--bg);padding:8px}
.section{margin-bottom:12px}
.section-title{font-size:11px;font-weight:600;color:var(--fg2);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;display:flex;align-items:center;gap:6px}
.badge{background:var(--badge-bg);color:var(--badge-fg);font-size:10px;padding:1px 6px;border-radius:10px;font-weight:600}
textarea{width:100%;min-height:72px;max-height:200px;padding:8px;background:var(--input-bg);border:1px solid var(--input-border);border-radius:var(--radius);color:var(--fg);font-family:inherit;font-size:13px;resize:vertical;outline:none;line-height:1.5}
textarea:focus{border-color:var(--btn-bg)}
textarea::placeholder{color:var(--fg2)}
.btn-row{display:flex;gap:6px;margin-top:6px;align-items:center;flex-wrap:wrap}
.btn{padding:5px 12px;border:none;border-radius:var(--radius);font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;transition:background .1s}
.btn-primary{background:var(--btn-bg);color:var(--btn-fg)}
.btn-primary:hover{background:var(--btn-hover)}
.btn-primary:disabled{opacity:.4;cursor:not-allowed}
.btn-secondary{background:transparent;border:1px solid var(--border);color:var(--fg2)}
.btn-secondary:hover{background:rgba(128,128,128,0.1)}
.btn-danger{background:rgba(255,68,68,0.1);color:var(--error);border:1px solid rgba(255,68,68,0.15)}
.hint{font-size:11px;color:var(--fg2);flex:1}
.card{border:1px solid var(--border);border-radius:var(--radius);margin-bottom:8px;overflow:hidden}
.card-head{padding:8px 10px;font-size:12px;font-weight:600;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center}
.card-body{padding:10px}
.q-text{font-size:13px;font-weight:600;margin-bottom:8px;line-height:1.4}
.q-opt{display:flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid var(--border);border-radius:var(--radius);margin-bottom:4px;cursor:pointer;font-size:12px;transition:all .1s}
.q-opt:hover{background:rgba(128,128,128,0.08)}
.q-opt.selected{border-color:var(--btn-bg);background:rgba(var(--vscode-button-background),0.1)}
.q-opt .dot{width:14px;height:14px;border:2px solid var(--border);border-radius:50%;flex-shrink:0}
.q-opt.multi .dot{border-radius:3px}
.q-opt.selected .dot{border-color:var(--btn-bg);background:var(--btn-bg)}
.q-other{width:100%;padding:6px 8px;background:var(--input-bg);border:1px solid var(--input-border);border-radius:var(--radius);color:var(--fg);font-size:12px;margin-top:6px;outline:none}
.reply-content{font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:200px;overflow-y:auto;padding:4px 0;color:var(--fg)}
.queue-item{padding:6px 8px;font-size:11px;color:var(--fg2);border-bottom:1px solid rgba(128,128,128,0.1);display:flex;align-items:flex-start;gap:6px}
.queue-item:last-child{border-bottom:none}
.qi-badge{font-size:9px;font-weight:700;padding:1px 5px;border-radius:4px;flex-shrink:0}
.qi-badge.text{background:rgba(96,165,250,0.15);color:#60a5fa}
.qi-badge.image{background:rgba(52,211,153,0.15);color:#34d399}
.qi-badge.file{background:rgba(251,191,36,0.15);color:#fbbf24}
.qi-content{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.empty{text-align:center;padding:16px;color:var(--fg2);font-size:12px}
.hidden{display:none!important}
.drag-over{outline:2px dashed var(--btn-bg);outline-offset:-2px;background:rgba(var(--vscode-button-background),0.05)}
</style>
</head>
<body>
<!-- 发送消息 -->
<div class="section">
  <div class="section-title">发送消息</div>
  <div class="input-area">
    <textarea id="msgInput" placeholder="输入消息发送给 AI...&#10;Enter 发送，Shift+Enter 换行" rows="3"></textarea>
    <div class="btn-row">
      <span class="hint">支持拖拽图片/文件</span>
      <button class="btn btn-secondary" id="btnImg">图片</button>
      <button class="btn btn-secondary" id="btnFile">文件</button>
      <button class="btn btn-primary" id="btnSend" disabled>发送</button>
    </div>
  </div>
</div>

<!-- AI 提问 -->
<div id="questionSection" class="section hidden">
  <div class="section-title">AI 提问 <span class="badge">等待回答</span></div>
  <div class="card">
    <div id="questionBody" class="card-body"></div>
  </div>
</div>

<!-- AI 回复摘要 -->
<div id="replySection" class="section hidden">
  <div class="section-title">AI 回复摘要</div>
  <div class="card">
    <div class="card-body">
      <div id="replyContent" class="reply-content"></div>
      <div class="btn-row" style="justify-content:flex-end;margin-top:8px">
        <button class="btn btn-secondary" id="btnAckReply">已阅</button>
      </div>
    </div>
  </div>
</div>

<!-- 控制 -->
<div class="section">
  <div class="section-title">控制</div>
  <div class="btn-row">
    <button class="btn btn-danger" id="btnInterrupt">中断当前对话</button>
    <span class="hint">停止 AI 回复，可输入新指令后重发</span>
  </div>
</div>

<!-- 消息队列 -->
<div class="section">
  <div class="section-title">消息队列 <span id="queueBadge" class="badge">0</span></div>
  <div class="card">
    <div id="queueList"><div class="empty">队列为空</div></div>
  </div>
  <div class="btn-row">
    <button class="btn btn-danger btn-sm" id="btnClearQueue" style="display:none">清空队列</button>
  </div>
</div>

<!-- 使用提示 -->
<div class="section">
  <div class="section-title">使用说明</div>
  <div style="font-size:11px;color:var(--fg2);line-height:1.5">
    <p>1. 确认 Settings → Tools & MCP 中 <b>cursor-loop</b> 已启用（绿色）</p>
    <p>2. 开一个<b>新的 Chat 对话</b>，从侧边栏发送第一条消息</p>
    <p>3. AI 会在 Chat 窗口中回复，并自动等待你的下一条消息</p>
    <p style="margin-top:4px;opacity:0.7">如首次安装，需重启 Cursor 让 MCP 生效</p>
  </div>
</div>

<script nonce="${nonce}">
(function(){
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  // ── 发送消息 ──
  const input = $('msgInput'), sendBtn = $('btnSend');
  function updateBtn(){ sendBtn.disabled = !input.value.trim(); }
  input.addEventListener('input', updateBtn);
  input.addEventListener('keydown', (e) => {
    if(e.isComposing) return;
    if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); doSend(); }
  });
  sendBtn.addEventListener('click', doSend);
  $('btnImg').addEventListener('click', () => vscode.postMessage({type:'sendImage'}));
  $('btnFile').addEventListener('click', () => vscode.postMessage({type:'sendFile'}));

  function doSend(){
    const txt = input.value.trim();
    if(!txt) return;
    vscode.postMessage({type:'sendText', text: txt});
    input.value = '';
    updateBtn();
    input.focus();
  }

  // ── 拖拽 ──
  const area = document.querySelector('.input-area');
  if(area){
    let dc = 0;
    area.addEventListener('dragenter', (e)=>{ e.preventDefault(); dc++; area.classList.add('drag-over'); });
    area.addEventListener('dragleave', (e)=>{ e.preventDefault(); dc--; if(dc<=0){dc=0;area.classList.remove('drag-over');} });
    area.addEventListener('dragover', (e)=>{ e.preventDefault(); });
    area.addEventListener('drop', (e)=>{
      e.preventDefault(); dc=0; area.classList.remove('drag-over');
      const files = e.dataTransfer && e.dataTransfer.files;
      if(!files||!files.length) return;
      Array.from(files).forEach((file)=>{
        if(file.type && file.type.startsWith('image/')){
          const r = new FileReader();
          r.onload = (ev) => vscode.postMessage({type:'sendPastedImage', dataUrl: ev.target.result});
          r.readAsDataURL(file);
        } else {
          const r2 = new FileReader();
          r2.onload = (ev) => {
            const c = ev.target.result;
            const p = c.length > 500 ? c.slice(0,500)+'...' : c;
            vscode.postMessage({type:'sendText', text:'[File: '+file.name+']\\n'+p});
          };
          r2.readAsText(file);
        }
      });
    });
  }

  // ── AI 提问 ──
  let curQuestion = null, selectedAnswers = {};

  function renderQuestion(q){
    curQuestion = q; selectedAnswers = {};
    const sec = $('questionSection'), body = $('questionBody');
    if(!q||!q.questions||!q.questions.length){ sec.classList.add('hidden'); return; }
    sec.classList.remove('hidden');
    let h = '';
    for(let i=0;i<q.questions.length;i++){
      const qi = q.questions[i];
      selectedAnswers[qi.id] = [];
      h += '<div class="q-text">'+esc(qi.question)+'</div><div>';
      for(let j=0;j<qi.options.length;j++){
        const o = qi.options[j];
        h += '<div class="q-opt'+(qi.allow_multiple?' multi':'')+'" data-qid="'+esc(qi.id)+'" data-oid="'+esc(o.id)+'"><span class="dot"></span><span>'+esc(o.label)+'</span></div>';
      }
      h += '</div><input class="q-other" data-qid="'+esc(qi.id)+'" placeholder="补充说明（可选）">';
      if(i<q.questions.length-1) h += '<hr style="border:none;border-top:1px solid var(--border);margin:10px 0">';
    }
    h += '<div class="btn-row" style="justify-content:flex-end;margin-top:10px"><button class="btn btn-danger" onclick="cancelQ()">取消</button><button class="btn btn-primary" onclick="submitQ()">提交</button></div>';
    body.innerHTML = h;
    body.querySelectorAll('.q-opt').forEach((el)=>{
      el.addEventListener('click', ()=> toggleOpt(el));
    });
  }

  function toggleOpt(el){
    const qid = el.dataset.qid, oid = el.dataset.oid;
    if(!curQuestion) return;
    const qi = curQuestion.questions.find(q=>q.id===qid);
    if(!qi) return;
    let arr = selectedAnswers[qid]||[];
    const idx = arr.indexOf(oid);
    if(qi.allow_multiple){
      if(idx>-1) arr.splice(idx,1); else arr.push(oid);
    } else {
      arr = idx>-1 ? [] : [oid];
      el.parentNode.querySelectorAll('.q-opt').forEach(e=>e.classList.remove('selected'));
    }
    selectedAnswers[qid] = arr;
    el.classList.toggle('selected', arr.indexOf(oid)>-1);
  }

  window.submitQ = function(){
    if(!curQuestion) return;
    const answers = [];
    for(const qi of curQuestion.questions){
      const otherInput = document.querySelector('.q-other[data-qid="'+qi.id+'"]');
      answers.push({questionId:qi.id, selected:selectedAnswers[qi.id]||[], other:otherInput?otherInput.value.trim():''});
    }
    vscode.postMessage({type:'submitAnswer', data:{id:curQuestion.id, answers}});
    $('questionSection').classList.add('hidden');
    curQuestion = null;
  };
  window.cancelQ = function(){
    vscode.postMessage({type:'cancelQuestion'});
    $('questionSection').classList.add('hidden');
    curQuestion = null;
  };

  // ── AI 回复 ──
  $('btnAckReply').addEventListener('click', ()=>{
    vscode.postMessage({type:'ackReply'});
    $('replySection').classList.add('hidden');
  });

  // ── 队列 ──
  function renderQueue(items){
    const L = $('queueList'), btn = $('btnClearQueue');
    if(!items||!items.length){
      L.innerHTML = '<div class="empty">队列为空</div>';
      btn.style.display = 'none';
      return;
    }
    btn.style.display = '';
    let h = '';
    for(const it of items){
      const tp = it.type||'text';
      const preview = tp==='text' ? (it.content||'') : (tp==='image'?'[图片]':'[文件] '+(it.path||'').split(/[\\/\\\\]/).pop());
      h += '<div class="queue-item"><span class="qi-badge '+tp+'">'+ ({text:'文本',image:'图片',file:'文件'}[tp]||tp) +'</span><span class="qi-content">'+esc(preview.substring(0,100))+'</span></div>';
    }
    L.innerHTML = h;
  }
  $('btnClearQueue').addEventListener('click', ()=> vscode.postMessage({type:'clearQueue'}));

  // ── 中断 ──
  $('btnInterrupt').addEventListener('click', ()=>{
    vscode.postMessage({type:'interruptChat'});
  });

  // ── 消息处理 ──
  window.addEventListener('message', (e)=>{
    const m = e.data;
    switch(m.type){
      case 'showQuestion': renderQuestion(m.data); break;
      case 'clearQuestion': $('questionSection').classList.add('hidden'); curQuestion=null; break;
      case 'showReply':
        $('replySection').classList.remove('hidden');
        $('replyContent').textContent = m.data.content;
        break;
      case 'queueCount': $('queueBadge').textContent = m.count||0; break;
      case 'queueData': renderQueue(m.data); break;
    }
  });

  vscode.postMessage({type:'ready'});
})();
</script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
