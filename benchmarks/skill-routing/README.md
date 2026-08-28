# Skill 路由基准

> [简体中文](README.md) | [English](README.en.md)

该基准评估 embedding 检索，不评估端到端智能体任务质量。`mainstream-200.json` 包含 200 个 Skill 标签及 description、8 条复合 prompt 和 50 条人工标注的鲁棒性 case。公开语料不重新分发第三方 `SKILL.md` 正文，也不虚构作者维护的路由元数据。

## 语料

公开 description 数据集来自以下仓库，并补充了 8 个通用工程标签作为 baseline 覆盖：

- [openai/skills](https://github.com/openai/skills)
- [anthropics/skills](https://github.com/anthropics/skills)
- [obra/superpowers](https://github.com/obra/superpowers)
- [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills)
- [huggingface/skills](https://github.com/huggingface/skills)
- [larksuite/cli](https://github.com/larksuite/cli)
- [google/skills](https://github.com/google/skills)

小基准 `datasets/public-descriptions.json` 保留用于与早期结果对比。主基准为 `datasets/mainstream-200.json`，按固定上游 commit 收集 frontmatter 的 `name` 和 `description`：OpenAI 41、Anthropic 17、Superpowers 14、Vercel 9、Hugging Face 26、Lark 28、Google 57、通用基线 8。

`datasets/mainstream-100.json` 是固定的中间规模子集：先保留复合/鲁棒 case 所需的全部 47 个标签，再按来源补齐为 OpenAI 20、Anthropic 8、Superpowers 7、Vercel 4、Hugging Face 13、Lark 14、Google 27、通用基线 7。它保留与 200-Skill 相同的 58 条复合/鲁棒 case，用于比较 catalogue 大小；不是独立的泛化测试集。

每个 Skill 有一条 description-close smoke prompt，用于检查 catalogue 连接性，不计为鲁棒性结论。额外 50 条人工 case 分成：

- `semantic-paraphrase`：不复述 description 的自然表达。
- `near-neighbor`：相邻能力的排他选择，例如 banner、插屏和激励广告。
- `multilingual`：中文请求命中英文 description，及跨语言产品名。
- `format-perturbation`：YAML、日志和引用文本中的真实任务。
- `composition`：必须同时加载多个 Skill 的请求。
- `abstention`：不属于 catalogue 的通用提问和注入式文本，期望零候选。

每个 case 使用稳定 ID 和人工预期标签。runner 会拒绝重复 ID、未知标签和非法字段；空预期标签只在 `abstention` 中计算拒识准确率。

## 运行

通过环境变量提供兼容 OpenAI 的 embedding endpoint。不要将凭据写进数据集或项目设置。

```bash
PI_SKILL_ROUTING_BENCHMARK_BASE_URL=https://example.com/v1 \
PI_SKILL_ROUTING_BENCHMARK_MODEL=your-embedding-model \
PI_SKILL_ROUTING_BENCHMARK_API_KEY=your-key \
PI_SKILL_ROUTING_BENCHMARK_DATASET=benchmarks/skill-routing/datasets/mainstream-200.json \
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

`PI_SKILL_ROUTING_BENCHMARK_TIMEOUT_MS` 默认为 `30000`；`PI_SKILL_ROUTING_BENCHMARK_EMBEDDING_CONCURRENCY` 默认为 `4`；`PI_SKILL_ROUTING_BENCHMARK_NATIVE_CONCURRENCY` 默认为 `2`；`PI_SKILL_ROUTING_BENCHMARK_NATIVE_CASE_BATCH_SIZE` 默认为 `8`。embedding runner 先预热 catalogue 向量，再并发测 query；native evaluator 会把多个独立 case 打包进模型请求。进度写到 stderr，stdout 保持机器可读 JSON。

本地 cross-encoder 可作为第二阶段 benchmark，默认不启用，也不改变生产路由器：

```bash
PI_SKILL_ROUTING_BENCHMARK_RERANK_URL=http://127.0.0.1:8088/v1/rerank \
PI_SKILL_ROUTING_BENCHMARK_RERANK_CUTOFF=0.01 \
PI_SKILL_ROUTING_BENCHMARK_CASE_SLICES=compound,semantic-paraphrase,near-neighbor,multilingual,format-perturbation,composition,abstention \
node --experimental-strip-types benchmarks/skill-routing/run.ts
```

`PI_SKILL_ROUTING_BENCHMARK_RERANK_CONCURRENCY` 默认 `1`，以匹配本地 MPS 模型的串行锁；`RERANK_CUTOFF` 默认 `0.01`。`CASE_SLICES` 可排除 description-close smoke，只评估同一个 catalogue 上的鲁棒性 query。输出中的 `rerankRouting` 与 `embeddingRouting` 分开记录，避免将两阶段时延混为一谈。

JSON 结果包含：

- `nativeBaseline.catalogueCharacters` 与 `catalogueEstimatedTokens`：相同 80 个 Skill 下 native 完整 catalogue 的固定 prompt 成本。
- `nativeBaseline.selection`：可选的聊天模型选择精度、召回率、平均候选数和零命中 case 数。
- `embeddingRouting.retrievalRecall`：阈值路由保留预期标签的比例。
- `embeddingRouting.retrievalPrecision`：注入标签中属于预期标签的比例。
- `embeddingRouting.abstentionAccuracy`：空标签 case 正确返回零候选的比例。
- `embeddingRouting.bySlice`：按 smoke、近邻、组合、跨语言和拒识分别统计，避免单一总分掩盖风险。
- 候选数统计和每个 case 的分数，避免低阈值隐藏过度上下文注入。
- 两种策略的 `durationMs`。

native 模式把 Skill 选择交给聊天模型，因此不能从 embedding 检索指标推断其端到端任务准确率。公平的端到端比较需要相同聊天模型、任务执行器和判分器。要评估作者维护 metadata，请使用包含 `metadata.routing` 的自有 `SKILL.md`、中文任务 prompt 和预期 Skill 标签；路由器每个 Skill 只嵌入一条路由文本，随后注入完整匹配 Skill，无需聊天模型调用工具读取它。

## 200 Skill Description-Only 结果

以下测试使用 Codex 已配置 UDA endpoint 的 `text-embedding-v4`，仅路由 description，不使用 reranker。200-Skill catalogue 共 258 个 case，其中 50 个为鲁棒性 case；单次约 20-21 秒。结果是 2026-08-28 的本地测量，不能外推为真实任务成功率。

| 阈值 | 召回率 | 精度 | 平均候选数 | 拒识准确率 |
|---:|---:|---:|---:|---:|
| 0.45 | 91.32% | 3.14% | 29.89 | 75.00% |
| 0.50 | 81.13% | 5.12% | 16.28 | 75.00% |
| 0.55 | 70.57% | 8.24% | 8.79 | 75.00% |
| 0.60 | 65.66% | 13.44% | 5.02 | 87.50% |

没有一个阈值同时满足低注入和高召回。`0.45` 在近邻 case 保留 91.67% 预期标签，但近邻精度仅 4.80%；`0.60` 近邻精度升至 31.58%，但组合 case 召回降至 18.75%，语义改写召回降至 41.67%。因此下一阶段应固定一档低阈值作为第一阶段候选池，再以本地 reranker 或作者维护的 routing metadata 做二次筛选；不能把更高全局阈值当作替代方案。

### 200 Skill 本地 Rerank 初测

在同一 200-Skill catalogue 上，仅选择 50 条鲁棒 case 和 8 条复合 case，`embedding 0.45 -> BAAI/bge-reranker-v2-m3 -> cutoff 0.01` 得到：

| 阶段 | 召回率 | 精度 | 平均候选数 | 拒识准确率 | 耗时 |
|---|---:|---:|---:|---:|---:|
| embedding | 86.15% | 6.39% | 15.10 | 75.00% | 12.84s |
| rerank | 69.23% | 23.94% | 3.24 | 100.00% | 170.20s |

rerank 明显减少了错误注入，也正确拒绝了全部 8 条无关请求；但近邻召回从 91.67% 降至 58.33%，说明旧 12-Skill fixture 的 `0.01` cutoff 不能直接迁移。当前结论是“rerank 有效但未校准”，不是将该 cutoff 设为生产默认值。完整无 cutoff 分数的复跑受本地 MPS 单实例约束影响尚未完成，后续需要先加候选池预算，再在保存的原始分数上离线扫 cutoff。

### 100 Skill 同口径复测

使用同一 UDA `text-embedding-v4`、相同 58 条复合/鲁棒 case、`embedding 0.45 -> BAAI/bge-reranker-v2-m3 -> cutoff 0.01`：

| Catalogue | 阶段 | 召回率 | 精度 | 平均候选数 | 拒识准确率 | 耗时 |
|---:|---|---:|---:|---:|---:|---:|
| 100 | embedding | 86.15% | 12.84% | 7.52 | 75.00% | 8.67s |
| 100 | rerank | 69.23% | 38.79% | 2.00 | 100.00% | 39.29s |
| 200 | embedding | 86.15% | 6.39% | 15.10 | 75.00% | 12.84s |
| 200 | rerank | 69.23% | 23.94% | 3.24 | 100.00% | 170.20s |

100 与 200 的 rerank 总召回及近邻召回均相同（69.23% 和 58.33%）。规模变小会降低候选池和 MPS 重排时延，但不能修复 cutoff 对近邻/组合标签的过滤损失；后续仍应保存完整 rerank 分数并离线校准 cutoff。
