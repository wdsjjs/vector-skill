# Victory Skill

> [简体中文](README.md) | [English](README.en.md)

Victory Skill 是一个实验性的 Skill 路由器：在第一次聊天模型请求之前，以确定性方式选出相关 Skill，并直接注入完整 `SKILL.md` 正文。

它替代了原生路径：聊天模型先阅读 Skill catalogue、判断需要哪个 Skill，再额外调用工具读取文件。

## 路由设计

```text
用户 query
  -> 嵌入 query 和每个可见 Skill 的一条紧凑路由文本
  -> 保留达到 embedding 阈值的候选
  -> 可选的本地 cross-encoder rerank
  -> 注入每个保留候选的完整 SKILL.md
  -> 第一次聊天模型请求
```

每个 Skill 只有一条简短、由作者维护的路由文本。它包含名称、必填 `description` 和可选路由元数据。完整 Markdown 正文只在命中后使用：指令、代码块、示例和流程分支不是可靠的检索文本。

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

`use_cases` 是简短的用户任务陈述；`tags` 标识具体平台、工件、实体或输出类型。没有这些元数据的 Skill 仍会仅依赖 `description` 路由。

## 设计决策

- 不生成 routing card：路由文本对作者可见、可版本管理。
- 不使用正文分段 max pooling：通用流程性文本会产生假阳性。
- 不设置自动 Top-K：复合请求可能确实需要多个 Skill。
- 只在匹配后注入完整 `SKILL.md`，不需要聊天模型发起 Skill-read 工具调用。
- rerank 接收紧凑路由文本，绝不接收完整 Skill 正文。

## 测评

所有数据都是检索标签指标，不是端到端任务成功率的声明。精度等于预期标签占注入标签的比例；召回等于被路由保留的预期标签比例。使用的 embedding 模型为 `text-embedding-v4`。

### Description-Only Baseline

80 个公开 Skill description 加 8 条复合 prompt 的语料，在 embedding 阈值 `0.5` 下得到初始 baseline：

| 召回率 | 精度 | 平均候选数 | 最大候选数 | 零命中 case 数 |
|---:|---:|---:|---:|---:|
| 61.46% | 18.15% | 3.69 | 42 | 27 |

这表明通用 description 加较低全局阈值会导致 Skill 过度注入。

### 被否决的正文路由

一组探索性语料使用 12 个已安装 Skill 和 6 条中文 prompt，在 `0.5` 下对比 description-only 与 Markdown 正文分段最高分：

| 路由输入 | 召回率 | 精度 |
|---|---:|---:|
| 仅 description | 83.33% | 55.56% |
| Markdown 正文分段 | 83.33% | 50.00% |

正文分段没有找回更多预期 Skill，反而增加了假阳性，因此不进入路由文本。

### 作者维护的 Metadata

自有中文 fixture 包含 12 个 Skill 和 14 条单/复合 prompt。`description` 忽略路由元数据，`metadata` 则包含 `use_cases` 和 `tags`。

| Embedding 阈值 | 输入 | 召回率 | 精度 | 平均候选数 | 零命中 case 数 |
|---:|---|---:|---:|---:|---:|
| 0.50 | description | 68.75% | 47.83% | 1.64 | 4 |
| 0.50 | metadata | 93.75% | 46.88% | 2.29 | 1 |
| 0.55 | description | 62.50% | 52.63% | 1.36 | 5 |
| 0.55 | metadata | 81.25% | 56.52% | 1.64 | 3 |
| 0.60 | description | 25.00% | 57.14% | 0.50 | 10 |
| 0.60 | metadata | 62.50% | 62.50% | 1.14 | 5 |

### 本地 Rerank

本地 `BAAI/bge-reranker-v2-m3` 端点将 query 与路由文本成对评分，对 embedding 候选进行 rerank。embedding 阈值为 `0.45` 时，它在当前 fixture 中保留了所有预期标签，同时令第一阶段候选池适合本地推理。

| Embedding 阈值 | Rerank cutoff | 召回率 | 精度 | 最终平均候选数 |
|---:|---:|---:|---:|---:|
| 0.45 | 无 | 100.00% | 27.12% | 4.21 |
| 0.45 | 0.01 | 100.00% | 80.00% | 1.43 |
| 0.45 | 0.05 | 93.75% | 83.33% | 1.29 |
| 0.45 | 0.10 | 87.50% | 93.33% | 1.07 |

当前实验性起始配置是 `embedding 0.45 -> rerank 0.01`。它不是通用默认值，仍需在更大的真实 query 语料上验证。reranker 首次请求耗时 `1.19s`，在 Apple MPS 上热态处理 5 个候选约为 `101ms`。

## Native Baseline

同一 12-Skill fixture 上，聊天模型选择 baseline 得到 100% 精度和召回率，耗时 `6.35s`。这只衡量从明确 catalogue 中的显式选择，不是端到端对比，也没有消除原生路径后续的 Skill-read 调用。

## 复跑

数据集、runner、命令、输入模式和结果 schema 均位于 [`benchmarks/skill-routing`](benchmarks/skill-routing)。

仅通过环境变量提供 endpoint 和凭据，不要将凭据加入仓库文件或 fixture。

## 安全状态

当前工作树的模式扫描只在 API key 解析测试 fixture 中发现了 Google Vertex 风格字符串；未在已跟踪文件中发现常见 OpenAI、GitHub、AWS、Slack 或 Hugging Face key 格式。GitHub Secret Scanning 当前未为该仓库启用，因此在依赖平台侧告警前应先启用它。

## 当前状态

metadata 路由路径及其 benchmark suite 已实现。本地 reranker 已完成 benchmark，但尚未接入运行时路径。

## 许可证

MIT
