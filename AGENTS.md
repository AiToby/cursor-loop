# cursor-loop 目录架构

> 一旦我所属的文件夹有所变化，请更新我。

一个 VS Code 扩展加一个 MCP 子进程，用文件系统 IPC 把用户输入持续送进 Cursor 对话流。

## 目录结构

```text
.
├── AGENTS.md
├── .gitignore
├── .vscodeignore
├── media/
│   └── icon.svg
├── mcp-server/
│   └── index.ts
├── src/
│   ├── extension.ts
│   └── ipc.ts
├── package.json
├── package-lock.json
└── tsconfig.json
```

## 文件职责

| 文件 | 职责 |
|------|------|
| `AGENTS.md` | 记录根目录骨架、职责边界、开发约束与变更记忆。 |
| `.gitignore` | 排除依赖、构建产物与打包文件，避免历史被噪音污染。 |
| `.vscodeignore` | 控制 VS Code 扩展打包时包含哪些文件。 |
| `media/icon.svg` | 扩展侧边栏与面板图标资源。 |
| `mcp-server/index.ts` | MCP 子进程入口，向 Cursor 暴露长轮询、提问、进度三个工具。 |
| `src/extension.ts` | VS Code 扩展入口，负责面板、命令、轮询与用户交互。 |
| `src/ipc.ts` | 文件系统 IPC 层，维护消息队列、提问回答、回复摘要与 MCP 配置。 |
| `package.json` | 扩展清单、命令注册、脚本与依赖定义。 |
| `package-lock.json` | 依赖解析锁，保证构建结果稳定。 |
| `tsconfig.json` | TypeScript 编译边界与输出约束。 |

## 架构决策

文件系统而不是进程内总线，是因为扩展宿主和 MCP 子进程天然分离；共享 JSON 让边界直白、调试可见、恢复简单。

保留 `src/` 与 `mcp-server/` 两棵最小树，是为了把 VS Code 宿主职责和 Cursor 工具职责硬切开，避免双向污染。

## 开发规范

只提交源码、配置和必要静态资源；不要提交 `node_modules/`、`dist/` 这类可再生产物。`.vsix` 是否提交取决于发布策略；当前仓库将其视为交付物。

任何新增、删除、移动根目录文件时，先更新这里，再继续写代码；文档滞后就是架构失忆。

## 变更日志

| 日期 | 变更 |
|------|------|
| 2026-03-30 | 建立根目录架构文档，并补充 `.gitignore` 约束首个提交边界；`.vsix` 作为交付物保留提交。 |
