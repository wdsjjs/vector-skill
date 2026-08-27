# Skill 路由基准

> [简体中文](README.md) | [English](README.en.md)

该基准评估 embedding 检索，不评估端到端智能体任务质量。它包含 80 个 Skill 标签及 description、对应触发 prompt，以及 8 条需要多个 Skill 的复合 prompt。公开 description 语料不重新分发第三方 `SKILL.md` 正文，也不虚构作者维护的路由元数据。

## 语料

公开 description 数据集来自以下仓库，并补充了 8 个通用工程标签作为 baseline 覆盖：

- [openai/skills](https://github.com/openai/skills)
- [anthropics/skills](https://github.com/anthropics/skills)
- [obra/superpowers](https://github.com/obra/superpowers)

数据集位于 `datasets/public-descriptions.json`。每项都有稳定的带来源前缀 ID、description 和 trigger prompt。复合 case 用于验证阈值路由可选中多个相关 Skill。

## 运行

通过环境变量提供兼容 OpenAI 的 embedding endpoint。不要将凭据写进数据集或项目设置。

```bash
PI_SKILL_ROUTING_BENCHMARK_BASE_URL=https://example.com/v1 \
PI_SKILL_ROUTING_BENCHMARK_MODEL=your-embedding-model \
PI_SKILL_ROUTING_BENCHMARK_API_KEY=your-key \
node --experimental-strip-types benchmarks/skill-routing/run.ts
```

`PI_SKILL_ROUTING_BENCHMARK_THRESHOLD` 默认值是 `0.6`。生产路由器默认每批发送 10 条紧凑 Skill 路由文本，以适配 UDA `text-embedding-v4` 的请求限制。

默认语料只有 description。通过以下两次运行，以同一组 query 对比有无作者维护元数据的效果：

```bash
PI_SKILL_ROUTING_BENCHMARK_DATASET=benchmarks/skill-routing/datasets/chinese-metadata.json \
PI_SKILL_ROUTING_BENCHMARK_ROUTING=description \
PI_SKILL_ROUTING_BENCHMARK_BASE_URL=https://example.com/v1 \
PI_SKILL_ROUTING_BENCHMARK_MODEL=your-embedding-model \
PI_SKILL_ROUTING_BENCHMARK_API_KEY=your-key \
node --experimental-strip-types benchmarks/skill-routing/run.ts

PI_SKILL_ROUTING_BENCHMARK_DATASET=benchmarks/skill-routing/datasets/chinese-metadata.json \
PI_SKILL_ROUTING_BENCHMARK_ROUTING=metadata \
PI_SKILL_ROUTING_BENCHMARK_BASE_URL=https://example.com/v1 \
PI_SKILL_ROUTING_BENCHMARK_MODEL=your-embedding-model \
PI_SKILL_ROUTING_BENCHMARK_API_KEY=your-key \
node --experimental-strip-types benchmarks/skill-routing/run.ts
```

`PI_SKILL_ROUTING_BENCHMARK_ROUTING` 默认值是 `metadata`；`description` 会忽略数据集中的路由字段。该对比评估的是作者维护的 catalogue 检索效果，不对全部第三方 Skill 做泛化声明。

设置 `PI_SKILL_ROUTING_BENCHMARK_CHAT_MODEL` 可运行可选的 native-selection baseline。每个 case 会把相同完整 catalogue 交给聊天模型，并要求返回 JSON Skill ID。这只对比选择行为，不覆盖后续工具执行。

`PI_SKILL_ROUTING_BENCHMARK_TIMEOUT_MS` 默认为 `30000`；`PI_SKILL_ROUTING_BENCHMARK_NATIVE_CONCURRENCY` 默认为 `2`；`PI_SKILL_ROUTING_BENCHMARK_NATIVE_CASE_BATCH_SIZE` 默认为 `8`。native evaluator 会把多个独立 case 打包进一次模型请求，完整运行只需 11 次 chat request。进度写到 stderr，stdout 保持机器可读 JSON。

JSON 结果包含：

- `nativeBaseline.catalogueCharacters` 与 `catalogueEstimatedTokens`：相同 80 个 Skill 下 native 完整 catalogue 的固定 prompt 成本。
- `nativeBaseline.selection`：可选的聊天模型选择精度、召回率、平均候选数和零命中 case 数。
- `embeddingRouting.retrievalRecall`：阈值路由保留预期标签的比例。
- `embeddingRouting.retrievalPrecision`：注入标签中属于预期标签的比例。
- 候选数统计和每个 case 的分数，避免低阈值隐藏过度上下文注入。
- 两种策略的 `durationMs`。

native 模式把 Skill 选择交给聊天模型，因此不能从 embedding 检索指标推断其端到端任务准确率。公平的端到端比较需要相同聊天模型、任务执行器和判分器。要评估作者维护 metadata，请使用包含 `metadata.routing` 的自有 `SKILL.md`、中文任务 prompt 和预期 Skill 标签；路由器每个 Skill 只嵌入一条路由文本，随后注入完整匹配 Skill，无需聊天模型调用工具读取它。
