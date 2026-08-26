<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>

> [English](README.md) | [简体中文](README.zh-CN.md)

<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
</p>
<p align="center">
  <a href="https://pi.dev">pi.dev</a> 域名由
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
  慷慨提供。
</p>

> 新贡献者提交的新 Issue 和 PR 默认会被自动关闭。维护者会每日审核被自动关闭的内容。参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

# Pi Agent Harness 单体仓库

这是 pi agent harness 项目的仓库，包含一个可自我扩展的编程智能体。

* **[@earendil-works/pi-coding-agent](packages/coding-agent)**：交互式编程智能体 CLI
* **[@earendil-works/pi-agent-core](packages/agent)**：支持工具调用和状态管理的智能体运行时
* **[@earendil-works/pi-ai](packages/ai)**：统一的多提供商 LLM API（OpenAI、Anthropic、Google 等）

更多 pi 信息：

* [访问 pi.dev](https://pi.dev)，查看演示
* [阅读文档](https://pi.dev/docs/latest)，也可以直接让智能体解释自身能力

## Victory Skill Routing

Victory Skill Routing 是 Pi Skill 的实验性渐进加载路径。它的目标是在第一次聊天模型请求之前注入完整 `SKILL.md`，避免让聊天模型先选择 Skill、再调用工具读取该文件。

### 设计

```text
用户 query
  -> 嵌入 query 和每个可见 Skill 的一条紧凑路由文本
  -> 保留所有达到 embedding 阈值的候选
  -> 可选的本地 cross-encoder rerank
  -> 注入每个保留候选的完整 SKILL.md
  -> 第一次聊天模型请求
```

路由嵌入文本刻意保持简短，并由作者维护而不是模型生成。它由 Skill 名称、必填 description 和可选路由元数据组成。Markdown 正文、代码块、示例和流程分支不参与嵌入，因为它们是指令内容，不是可靠的任务标识。

```yaml
---
name: figma-implement-design
description: Translate supplied Figma designs into production-ready application code.
metadata:
  routing:
    use_cases:
      - 把提供的 Figma 设计稿实现为现有项目中的响应式页面。
      - 读取 Figma 变量和组件状态，完成像素级 UI 还原。
    tags:
      - Figma
      - design file
      - React
      - responsive UI
---
```

`use_cases` 应是简短的用户任务陈述；`tags` 应标识具体平台、工件、实体或输出类型。未提供这些元数据的既有 Skill 仍会仅依赖 description 路由。

原生 baseline 仍可用：它将完整 Skill catalogue 暴露给聊天模型，并依赖模型决定是否读取匹配文件。embedding 路径以部分选择质量为代价，换取确定的 pre-chat 检索路径，以及无需模型发起 Skill-read 工具调用。

### 迭代证据

以下所有数字都是检索标签指标，不是端到端任务成功率的声明。精度等于预期 Skill 标签占注入标签的比例；召回等于被路由保留的预期标签比例。UDA embedding 模型为 `text-embedding-v4`。可复跑 fixture 和 runner 位于 [`packages/coding-agent/test/fixtures`](packages/coding-agent/test/fixtures) 与 [`packages/coding-agent/scripts/benchmark-skill-routing.ts`](packages/coding-agent/scripts/benchmark-skill-routing.ts)。

#### 1. 公开 description-only 语料

由 80 个公开 Skill description 和 8 个复合 prompt 构成的语料建立了初始阈值 baseline。embedding 阈值为 `0.5` 时结果如下：

| 召回率 | 精度 | 平均候选数 | 最大候选数 | 零命中 case 数 |
|---:|---:|---:|---:|---:|
| 61.46% | 18.15% | 3.69 | 42 | 27 |

这表明，对通用 description 使用过低的全局阈值会导致过度注入。该语料刻意不重新分发第三方 Skill 正文，因此不能评估正文路由或作者元数据。

#### 2. 被否决的正文分段路由

一组探索性语料使用 12 个已安装 Codex Skill 和 6 条中文 prompt，对比 description-only 与多个 Markdown 正文片段最高分的做法。阈值 `0.5` 时，description-only 的精度/召回率为 `55.56% / 83.33%`，正文分段路由为 `50.00% / 83.33%`。

正文没有提升预期 Skill 分数，且通用流程性语言制造了更多假阳性。因此当前规则是：命中后注入完整 `SKILL.md`，但不嵌入它以进行匹配。

#### 3. 作者维护的 metadata 路由

自有中文 fixture 包含 12 个 Skill 和 14 条单/复合 prompt。每个 Skill 提供显式 `use_cases` 和 `tags`。同一个 fixture 可以在忽略路由元数据的 `description` 模式，或使用元数据的 `metadata` 模式运行。

| Embedding 阈值 | 输入 | 召回率 | 精度 | 平均候选数 | 零命中 case 数 |
|---:|---|---:|---:|---:|---:|
| 0.50 | description | 68.75% | 47.83% | 1.64 | 4 |
| 0.50 | metadata | 93.75% | 46.88% | 2.29 | 1 |
| 0.55 | description | 62.50% | 52.63% | 1.36 | 5 |
| 0.55 | metadata | 81.25% | 56.52% | 1.64 | 3 |
| 0.60 | description | 25.00% | 57.14% | 0.50 | 10 |
| 0.60 | metadata | 62.50% | 62.50% | 1.14 | 5 |

在这个小语料中，`0.55` 是观察到的较佳平衡点：作者维护的元数据相较 description-only 同时提高了召回和精度。这只是一个评估点，不是通用默认值。

同一 fixture 上的原生选择 baseline 得到 `100%` 精度和召回率，耗时 `6.35s`。这是 prompt 清晰的、仅评估聊天模型选择的基准，不是端到端对比；它也没有消除原生运行时后续由模型发起的 Skill-read 调用。

#### 4. 本地 rerank 实验

本地 `BAAI/bge-reranker-v2-m3` 端点 `127.0.0.1:8088/v1/rerank` 使用同一份紧凑路由文本，对 `0.5` metadata 候选进行 rerank。完整 Skill 正文不会传给该服务。

| Embedding 阈值 | Rerank cutoff | 召回率 | 精度 | 平均候选数 | 零命中 case 数 |
|---:|---:|---:|---:|---:|---:|
| 0.50 | 无 | 93.75% | 46.88% | 2.29 | 1 |
| 0.50 | 0.10 | 81.25% | 92.86% | 1.00 | 2 |
| 0.50 | 0.30 | 75.00% | 100.00% | 0.86 | 2 |

reranker 首次请求耗时 `1.19s`，在 Apple MPS 上热态处理 5 个候选约为 `101ms`。建议的起始配置是 embedding `0.5` 后接 rerank `0.1`：在保留 81.25% 召回率的同时，测得精度超过两倍。由于语料刻意较小，rerank 应保持可选和可配置。

### 复跑基准

通过环境变量提供 endpoint 和凭据，不要把凭据加入仓库。详细命令和输出 schema 见 [`packages/coding-agent/docs/skill-routing-benchmark.md`](packages/coding-agent/docs/skill-routing-benchmark.md)。

## 分享你的开源编程智能体会话

如果你使用 pi 或其他编程智能体进行开源工作，请分享会话数据。

公开的开源会话数据能以真实任务、工具使用、失败和修复来帮助改进编程智能体，而不是只依赖玩具基准。

完整说明见 [这条 X 帖子](https://x.com/badlogicgames/status/2037811643774652911)。

使用 [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf) 发布会话。请阅读其 README 获取配置说明；只需一个 Hugging Face 账号、Hugging Face CLI 和 `pi-share-hf`。

你也可以观看[这个视频](https://x.com/badlogicgames/status/2041151967695634619)，其中演示了如何发布 `pi-mono` 工作会话。

我定期在这里发布自己的 `pi-mono` 工作会话：

- [Hugging Face 上的 badlogicgames/pi-mono](https://huggingface.co/datasets/badlogicgames/pi-mono)

## 所有包

| 包 | 说明 |
|---|---|
| **[@earendil-works/pi-ai](packages/ai)** | 统一的多提供商 LLM API（OpenAI、Anthropic、Google 等） |
| **[@earendil-works/pi-agent-core](packages/agent)** | 支持工具调用和状态管理的智能体运行时 |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | 交互式编程智能体 CLI |
| **[@earendil-works/pi-tui](packages/tui)** | 采用差分渲染的终端 UI 库 |

Slack/chat 自动化与工作流见 [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat)。

## 贡献

贡献指南见 [CONTRIBUTING.md](CONTRIBUTING.md)，人类和智能体均应遵循 [AGENTS.md](AGENTS.md) 中的项目规则。

## 开发

```bash
npm install --ignore-scripts  # 安装全部依赖，但不运行生命周期脚本
npm run build                 # 构建全部包
npm run check                 # lint、格式化和类型检查
./test.sh                     # 运行测试；没有 API key 时跳过依赖 LLM 的测试
./pi-test.sh                  # 从源码运行 pi，可从任意目录执行
```

## 供应链加固

依赖变更被视为需要审查的代码。

- 直接外部依赖固定精确版本；内部 workspace 依赖保持版本范围。
- `.npmrc` 设置 `save-exact=true` 与 `min-release-age=2`，避免 npm 解析时使用当天发布的依赖。
- `package-lock.json` 是依赖事实来源。pre-commit 会阻止意外提交 lockfile，除非设置 `PI_ALLOW_LOCKFILE_CHANGE=1`。
- `npm run check` 会校验直接依赖版本固定、原生 TypeScript import 兼容性和生成的 coding-agent shrinkwrap。
- 发布的 CLI 包包含由根 lockfile 生成的 `packages/coding-agent/npm-shrinkwrap.json`，用于固定 npm 用户的传递依赖。
- 发布冒烟测试使用 `npm run release:local` 在仓库外构建、打包并创建隔离的 npm 与 Bun 安装。
- 本地发布安装、文档中的 npm 安装和 `pi update --self` 在支持时使用 `--ignore-scripts`。
- CI 使用 `npm ci --ignore-scripts` 安装；计划任务会运行 `npm audit --omit=dev` 和 `npm audit signatures --omit=dev`。
- shrinkwrap 生成有依赖生命周期脚本的显式 allowlist；新的生命周期脚本依赖在审核前会使检查失败。

## 许可证

MIT
