# .github 目录架构

> 一旦我所属的文件夹有所变化，请更新我。

这里存放自动化定义，不承载业务逻辑，只负责把源码变成可验证、可发布的制品。

## 目录结构

```text
.github
├── AGENTS.md
└── workflows/
    ├── AGENTS.md
    └── release-vsix.yml
```

## 文件职责

| 文件 | 职责 |
|------|------|
| `AGENTS.md` | 描述自动化目录边界，防止发布逻辑侵入业务代码。 |
| `workflows/AGENTS.md` | 记录各工作流的职责、触发方式与约束。 |
| `workflows/release-vsix.yml` | 执行构建、打包、上传 `.vsix` 制品，并在 tag 发布时附着到 Release。 |
