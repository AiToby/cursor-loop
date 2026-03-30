# workflows 目录架构

> 一旦我所属的文件夹有所变化，请更新我。

这里是发布流水线本体；每个工作流只做一件事，避免 CI 变成无人敢碰的泥团。

## 目录结构

```text
workflows
├── AGENTS.md
└── release-vsix.yml
```

## 文件职责

| 文件 | 职责 |
|------|------|
| `AGENTS.md` | 记录工作流骨架、约束与演进历史。 |
| `release-vsix.yml` | 负责安装依赖、编译扩展、打包 `.vsix`、上传 artifact，并在 tag 上发布。 |
