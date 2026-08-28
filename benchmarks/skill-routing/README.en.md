# Skill Routing Benchmark

> [简体中文](README.md) | [English](README.en.md)

This benchmark evaluates embedding retrieval, not an end-to-end agent's final task quality. `mainstream-200.json` contains 200 skill labels with descriptions, eight compound prompts, and 50 manually labelled robustness cases. The corpus deliberately includes public descriptions only: it does not redistribute third-party `SKILL.md` instructions or invent author-maintained routing metadata.

## Corpus

The corpus combines metadata from these public repositories with eight common engineering labels authored for baseline coverage:

- [openai/skills](https://github.com/openai/skills)
- [anthropics/skills](https://github.com/anthropics/skills)
- [obra/superpowers](https://github.com/obra/superpowers)
- [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills)
- [huggingface/skills](https://github.com/huggingface/skills)
- [larksuite/cli](https://github.com/larksuite/cli)
- [google/skills](https://github.com/google/skills)

`datasets/public-descriptions.json` remains the small comparison corpus. The main corpus is `datasets/mainstream-200.json`, pinned to upstream commits: OpenAI 41, Anthropic 17, Superpowers 14, Vercel 9, Hugging Face 26, Lark 28, Google 57, and eight general engineering baselines.

`datasets/mainstream-100.json` is a fixed intermediate-scale subset. It first retains all 47 labels needed by the compound and robustness cases, then fills by source to OpenAI 20, Anthropic 8, Superpowers 7, Vercel 4, Hugging Face 13, Lark 14, Google 27, and seven general baselines. It retains the same 58 compound and robustness cases as the 200-Skill corpus to compare catalogue size; it is not an independent generalization set.

Every Skill has a description-close smoke prompt for catalogue connectivity only. The 50 manually labelled cases measure semantic paraphrase, near-neighbour disambiguation, multilingual requests, YAML/log/quoted-format perturbation, compositions, and out-of-catalogue abstention. The runner rejects duplicate IDs, unknown labels, and invalid fields; `abstentionAccuracy` is computed only from cases with no expected labels.

## Run

Provide an OpenAI-compatible embeddings endpoint through environment variables. Do not place credentials in the corpus or project settings.

```bash
PI_SKILL_ROUTING_BENCHMARK_BASE_URL=https://example.com/v1 \
PI_SKILL_ROUTING_BENCHMARK_MODEL=your-embedding-model \
PI_SKILL_ROUTING_BENCHMARK_API_KEY=your-key \
PI_SKILL_ROUTING_BENCHMARK_DATASET=benchmarks/skill-routing/datasets/mainstream-200.json \
node --experimental-strip-types benchmarks/skill-routing/run.ts
```

`PI_SKILL_ROUTING_BENCHMARK_THRESHOLD` defaults to `0.6`.
The production router batches compact skill routing entries in groups of 10 by default, which accommodates the UDA `text-embedding-v4` request limit.

The default corpus has only descriptions. Run the owned Chinese metadata corpus twice to compare the same queries with and without author-maintained fields:

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

`PI_SKILL_ROUTING_BENCHMARK_ROUTING` defaults to `metadata`; `description` ignores the fixture's routing fields. This is a retrieval evaluation of the authored catalogue, not a claim about all third-party Skills.

Set `PI_SKILL_ROUTING_BENCHMARK_CHAT_MODEL` to run the optional native-selection baseline. For each case it sends the same full catalogue to that chat model and requires JSON skill IDs. This compares only selection behavior, not downstream tool execution.

`PI_SKILL_ROUTING_BENCHMARK_TIMEOUT_MS` defaults to `30000`; `PI_SKILL_ROUTING_BENCHMARK_EMBEDDING_CONCURRENCY` defaults to `4`; `PI_SKILL_ROUTING_BENCHMARK_NATIVE_CONCURRENCY` defaults to `2`; and `PI_SKILL_ROUTING_BENCHMARK_NATIVE_CASE_BATCH_SIZE` defaults to `8`. The embedding runner prewarms catalogue vectors before concurrent queries. Progress is written to stderr so stdout remains machine-readable JSON.

An optional local cross-encoder is available for the benchmark only; it does not change the production router:

```bash
PI_SKILL_ROUTING_BENCHMARK_RERANK_URL=http://127.0.0.1:8088/v1/rerank \
PI_SKILL_ROUTING_BENCHMARK_RERANK_CUTOFF=0.01 \
PI_SKILL_ROUTING_BENCHMARK_CASE_SLICES=compound,semantic-paraphrase,near-neighbor,multilingual,format-perturbation,composition,abstention \
node --experimental-strip-types benchmarks/skill-routing/run.ts
```

`PI_SKILL_ROUTING_BENCHMARK_RERANK_CONCURRENCY` defaults to `1` for the local MPS model lock, and `RERANK_CUTOFF` defaults to `0.01`. `CASE_SLICES` excludes description-close smoke cases while retaining the same catalogue. `rerankRouting` is reported separately from `embeddingRouting` so the two-stage latency is explicit.

The JSON result reports:

- `nativeBaseline.catalogueCharacters` and `catalogueEstimatedTokens`: the fixed prompt cost of Pi's native full catalogue for the same 80 skills.
- `nativeBaseline.selection`: optional chat-model selection precision, recall, average candidates, and zero-match cases.
- `embeddingRouting.retrievalRecall`: fraction of expected labels retained by threshold routing.
- `embeddingRouting.retrievalPrecision`: fraction of injected labels that are expected labels.
- `embeddingRouting.abstentionAccuracy`: fraction of out-of-catalogue cases that correctly select no Skill.
- `embeddingRouting.bySlice`: metrics split by smoke, near-neighbour, composition, multilingual, and abstention risks.
- Candidate-count statistics and every per-case score, so a low threshold cannot hide excessive context injection.
- `durationMs` for both retrieval strategies.

Native mode delegates skill choice to the chat model, so its end-to-end task accuracy cannot be inferred from an embedding retrieval metric. A fair end-to-end comparison requires the same chat model, task runner, and grader for both modes. To measure author-maintained metadata, use owned `SKILL.md` files with `metadata.routing`, Chinese task prompts, and expected skill labels; the router embeds one routing entry per skill and then injects the complete matching skill without a chat-model tool call.

## 200-Skill Description-Only Results

The following local measurements used the Codex-configured UDA endpoint and `text-embedding-v4`, with description-only routing and no reranker. The 200-Skill catalogue has 258 cases, including 50 robustness cases; each run took about 20-21 seconds. These are retrieval measurements from 2026-08-28, not task-success claims.

| Threshold | Recall | Precision | Average candidates | Abstention accuracy |
|---:|---:|---:|---:|---:|
| 0.45 | 91.32% | 3.14% | 29.89 | 75.00% |
| 0.50 | 81.13% | 5.12% | 16.28 | 75.00% |
| 0.55 | 70.57% | 8.24% | 8.79 | 75.00% |
| 0.60 | 65.66% | 13.44% | 5.02 | 87.50% |

No global threshold is an acceptable trade-off. At `0.45`, near-neighbour recall is 91.67% but precision is only 4.80%; at `0.60`, near-neighbour precision reaches 31.58%, while composition recall drops to 18.75% and semantic-paraphrase recall to 41.67%. The next experiment should keep a lower first-stage threshold and apply a local reranker or author-maintained routing metadata. Raising a global threshold is not a substitute.

### 200-Skill Local Rerank Initial Result

On the same 200-Skill catalogue, the 50 robustness and eight compound cases measured `embedding 0.45 -> BAAI/bge-reranker-v2-m3 -> cutoff 0.01`:

| Stage | Recall | Precision | Average candidates | Abstention accuracy | Duration |
|---|---:|---:|---:|---:|---:|
| embedding | 86.15% | 6.39% | 15.10 | 75.00% | 12.84s |
| rerank | 69.23% | 23.94% | 3.24 | 100.00% | 170.20s |

Reranking removes many incorrect injections and rejects all eight out-of-catalogue cases, but near-neighbour recall falls from 91.67% to 58.33%. The prior `0.01` cutoff from the 12-Skill fixture does not transfer. The verified conclusion is that reranking works but is not calibrated; it is not a production-default recommendation.

### 100-Skill Like-for-Like Repeat

Using the same UDA `text-embedding-v4`, the same 58 compound and robustness cases, and `embedding 0.45 -> BAAI/bge-reranker-v2-m3 -> cutoff 0.01`:

| Catalogue | Stage | Recall | Precision | Average candidates | Abstention accuracy | Duration |
|---:|---|---:|---:|---:|---:|---:|
| 100 | embedding | 86.15% | 12.84% | 7.52 | 75.00% | 8.67s |
| 100 | rerank | 69.23% | 38.79% | 2.00 | 100.00% | 39.29s |
| 200 | embedding | 86.15% | 6.39% | 15.10 | 75.00% | 12.84s |
| 200 | rerank | 69.23% | 23.94% | 3.24 | 100.00% | 170.20s |

The 100- and 200-Skill runs have identical rerank overall and near-neighbour recall (69.23% and 58.33%). A smaller catalogue reduces the candidate pool and MPS rerank latency, but cannot repair cutoff losses on near-neighbour or composition labels. The next step remains retaining all rerank scores and calibrating the cutoff offline.
