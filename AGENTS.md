# cursor-loop 目录架构

> 一旦我所属的文件夹有所变化，请更新我。

一个 VS Code 扩展加一个 MCP 子进程，用文件系统 IPC 把用户输入持续送进 Cursor 对话流。

## 目录结构

```text
.
├── .github/
│   ├── AGENTS.md
│   └── workflows/
│       ├── AGENTS.md
│       └── release-vsix.yml
├── AGENTS.md
├── LICENSE
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
| `LICENSE` | 声明代码分发许可，消除“口头 MIT”这种无效承诺。 |
| `.github/AGENTS.md` | 记录自动化目录的职责边界，避免发布脚本失控蔓延。 |
| `.github/workflows/AGENTS.md` | 记录 CI 工作流的目的与约束，让发布路径可读可改。 |
| `.github/workflows/release-vsix.yml` | 构建并上传 `.vsix` 制品，必要时绑定 GitHub Release。 |
| `.gitignore` | 排除依赖、构建产物与打包文件，避免历史被噪音污染。 |
| `.vscodeignore` | 控制 VS Code 扩展打包时包含哪些文件。 |
| `media/icon.svg` | 扩展侧边栏与面板图标资源。 |
| `mcp-server/index.ts` | MCP 子进程入口，向 Cursor 暴露长轮询、提问、进度三个工具。 |
| `src/extension.ts` | VS Code 扩展入口，负责面板、命令、轮询与用户交互。 |
| `src/ipc.ts` | 文件系统 IPC 层，维护消息队列、提问回答、回复摘要与 MCP 配置。 |
| `package.json` | 扩展清单、命令注册、脚本、依赖与仓库元数据定义。 |
| `package-lock.json` | 依赖解析锁，保证构建结果稳定。 |
| `tsconfig.json` | TypeScript 编译边界与输出约束。 |

## 架构决策

文件系统而不是进程内总线，是因为扩展宿主和 MCP 子进程天然分离；共享 JSON 让边界直白、调试可见、恢复简单。

保留 `src/` 与 `mcp-server/` 两棵最小树，是为了把 VS Code 宿主职责和 Cursor 工具职责硬切开，避免双向污染。

## 开发规范

只提交源码、配置和必要静态资源；不要提交 `node_modules/`、`dist/`、`.vsix` 这类可再生产物。制品应由 CI 生成，而不是由开发机归档。

任何新增、删除、移动根目录文件时，先更新这里，再继续写代码；文档滞后就是架构失忆。

## 变更日志

| 日期 | 变更 |
|------|------|
| 2026-03-30 | 建立根目录架构文档，并补充 `.gitignore` 约束首个提交边界。 |
| 2026-03-30 | 引入 GitHub Actions 制品发布路径，`.vsix` 从仓库历史中移除，改由 CI 产出。 |
| 2026-03-30 | 补齐 `LICENSE`、仓库元数据与打包排除规则，收敛发布产物内容。 |
