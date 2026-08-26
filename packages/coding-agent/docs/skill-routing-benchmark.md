# Skill Routing Benchmark

This benchmark evaluates embedding retrieval, not an end-to-end agent's final task quality. It uses 80 skill labels with descriptions and trigger prompts, plus eight compound prompts that expect multiple skills. The corpus deliberately includes public descriptions only: it does not redistribute third-party `SKILL.md` instructions or invent author-maintained routing metadata.

## Corpus

The corpus combines metadata from these public repositories with eight common engineering labels authored for baseline coverage:

- [openai/skills](https://github.com/openai/skills)
- [anthropics/skills](https://github.com/anthropics/skills)
- [obra/superpowers](https://github.com/obra/superpowers)

The fixture is at `test/fixtures/skill-routing-benchmark.json`. Each item has a stable source-qualified identifier, description, and trigger prompt. Compound cases verify that threshold routing can select more than one skill.

## Run

Provide an OpenAI-compatible embeddings endpoint through environment variables. Do not place credentials in the corpus or project settings.

```bash
PI_SKILL_ROUTING_BENCHMARK_BASE_URL=https://example.com/v1 \
PI_SKILL_ROUTING_BENCHMARK_MODEL=your-embedding-model \
PI_SKILL_ROUTING_BENCHMARK_API_KEY=your-key \
node --experimental-strip-types scripts/benchmark-skill-routing.ts
```

`PI_SKILL_ROUTING_BENCHMARK_THRESHOLD` defaults to `0.6`.
The production router batches compact skill routing entries in groups of 10 by default, which accommodates the UDA `text-embedding-v4` request limit.

The default corpus has only descriptions. Run the owned Chinese metadata corpus twice to compare the same queries with and without author-maintained fields:

```bash
PI_SKILL_ROUTING_BENCHMARK_DATASET=test/fixtures/skill-routing-metadata-benchmark.json \
PI_SKILL_ROUTING_BENCHMARK_ROUTING=description \
PI_SKILL_ROUTING_BENCHMARK_BASE_URL=https://example.com/v1 \
PI_SKILL_ROUTING_BENCHMARK_MODEL=your-embedding-model \
PI_SKILL_ROUTING_BENCHMARK_API_KEY=your-key \
node --experimental-strip-types scripts/benchmark-skill-routing.ts

PI_SKILL_ROUTING_BENCHMARK_DATASET=test/fixtures/skill-routing-metadata-benchmark.json \
PI_SKILL_ROUTING_BENCHMARK_ROUTING=metadata \
PI_SKILL_ROUTING_BENCHMARK_BASE_URL=https://example.com/v1 \
PI_SKILL_ROUTING_BENCHMARK_MODEL=your-embedding-model \
PI_SKILL_ROUTING_BENCHMARK_API_KEY=your-key \
node --experimental-strip-types scripts/benchmark-skill-routing.ts
```

`PI_SKILL_ROUTING_BENCHMARK_ROUTING` defaults to `metadata`; `description` ignores the fixture's routing fields. This is a retrieval evaluation of the authored catalogue, not a claim about all third-party Skills.

Set `PI_SKILL_ROUTING_BENCHMARK_CHAT_MODEL` to run the optional native-selection baseline. For each case it sends the same full catalogue to that chat model and requires JSON skill IDs. This compares only selection behavior, not downstream tool execution.

`PI_SKILL_ROUTING_BENCHMARK_TIMEOUT_MS` defaults to `30000`; `PI_SKILL_ROUTING_BENCHMARK_NATIVE_CONCURRENCY` defaults to `2`; and `PI_SKILL_ROUTING_BENCHMARK_NATIVE_CASE_BATCH_SIZE` defaults to `8`. The native evaluator packs multiple independent cases into one model request while keeping the catalogue unchanged, reducing a full run to 11 chat requests. Progress is written to stderr so stdout remains machine-readable JSON.

The JSON result reports:

- `nativeBaseline.catalogueCharacters` and `catalogueEstimatedTokens`: the fixed prompt cost of Pi's native full catalogue for the same 80 skills.
- `nativeBaseline.selection`: optional chat-model selection precision, recall, average candidates, and zero-match cases.
- `embeddingRouting.retrievalRecall`: fraction of expected labels retained by threshold routing.
- `embeddingRouting.retrievalPrecision`: fraction of injected labels that are expected labels.
- Candidate-count statistics and every per-case score, so a low threshold cannot hide excessive context injection.
- `durationMs` for both retrieval strategies.

Native mode delegates skill choice to the chat model, so its end-to-end task accuracy cannot be inferred from an embedding retrieval metric. A fair end-to-end comparison requires the same chat model, task runner, and grader for both modes. To measure author-maintained metadata, use owned `SKILL.md` files with `metadata.routing`, Chinese task prompts, and expected skill labels; the router embeds one routing entry per skill and then injects the complete matching skill without a chat-model tool call.
