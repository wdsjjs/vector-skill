# Victory Skill

> [简体中文](README.md) | [English](README.en.md)

Victory Skill is an experimental Skill router that deterministically selects relevant Skills before the first chat-model request, then injects their complete `SKILL.md` bodies directly.

It replaces the native path where a chat model reads a Skill catalogue, decides which Skill to use, and makes a separate tool call to load the file.

## Routing Design

```text
user query
  -> embed query and one compact routing entry per visible Skill
  -> retain candidates at the embedding threshold
  -> optional local cross-encoder rerank
  -> inject each surviving complete SKILL.md
  -> first chat-model request
```

Each Skill has one short, author-maintained routing entry. It contains its name, required `description`, and optional routing metadata. The complete Markdown body is only used after a match: instructions, code blocks, examples, and procedural branches are not reliable retrieval text.

```yaml
---
name: figma-implement-design
description: Translate supplied Figma designs into production-ready application code.
metadata:
  routing:
    use_cases:
      - Implement a supplied Figma file as a responsive page in an existing project.
      - Match Figma variables and component states in production UI code.
    tags:
      - Figma
      - design file
      - React
      - responsive UI
---
```

`use_cases` are short user-task statements. `tags` identify concrete platforms, artifacts, entities, or output types. Skills without this metadata remain routable through `description` alone.

## Design Decisions

- No generated routing cards: routing text is visible, versioned, and maintained by Skill authors.
- No body-segment max pooling: generic procedural prose produced false positives.
- No automatic Top-K limit: compound requests may legitimately require multiple Skills.
- Complete `SKILL.md` is injected only after matching, so no chat-model-initiated Skill-read tool call is needed.
- Rerank receives compact routing entries, never complete Skill bodies.

## Evaluation

All values are retrieval-label metrics, not end-to-end task-success claims. Precision is expected labels divided by injected labels; recall is expected labels retained by routing. The embedding model was `text-embedding-v4`.

### Description-Only Baseline

An 80-Skill public-description corpus with eight compound prompts established the initial baseline at embedding threshold `0.5`.

| Recall | Precision | Average candidates | Maximum candidates | Zero-match cases |
|---:|---:|---:|---:|---:|
| 61.46% | 18.15% | 3.69 | 42 | 27 |

The low precision showed that generic descriptions plus a low global threshold over-inject Skills.

### Rejected Body Routing

An exploratory set of 12 installed Skills and six Chinese prompts compared description-only routing with maximum scoring Markdown body segments at `0.5`.

| Routing input | Recall | Precision |
|---|---:|---:|
| Description only | 83.33% | 55.56% |
| Markdown body segments | 83.33% | 50.00% |

Body segments did not recover expected Skills and added false positives, so they are not part of the routing input.

### Author-Maintained Metadata

The owned Chinese fixture contains 12 Skills and 14 single or compound prompts. `description` ignores routing metadata; `metadata` includes `use_cases` and `tags`.

| Embedding threshold | Input | Recall | Precision | Average candidates | Zero-match cases |
|---:|---|---:|---:|---:|---:|
| 0.50 | description | 68.75% | 47.83% | 1.64 | 4 |
| 0.50 | metadata | 93.75% | 46.88% | 2.29 | 1 |
| 0.55 | description | 62.50% | 52.63% | 1.36 | 5 |
| 0.55 | metadata | 81.25% | 56.52% | 1.64 | 3 |
| 0.60 | description | 25.00% | 57.14% | 0.50 | 10 |
| 0.60 | metadata | 62.50% | 62.50% | 1.14 | 5 |

### Local Rerank

The local `BAAI/bge-reranker-v2-m3` endpoint reranks embedding candidates with query-routing-entry pairs. At an embedding threshold of `0.45`, it retains every expected label in this fixture while keeping the first-stage candidate pool suitable for local inference.

| Embedding threshold | Rerank cutoff | Recall | Precision | Final average candidates |
|---:|---:|---:|---:|---:|
| 0.45 | none | 100.00% | 27.12% | 4.21 |
| 0.45 | 0.01 | 100.00% | 80.00% | 1.43 |
| 0.45 | 0.05 | 93.75% | 83.33% | 1.29 |
| 0.45 | 0.10 | 87.50% | 93.33% | 1.07 |

The current experimental starting point is `embedding 0.45 -> rerank 0.01`. It is not a universal default and needs validation on a larger, real query corpus. The reranker took `1.19s` on its first request and about `101ms` warm for five candidates on Apple MPS.

### 200-Skill Robustness Benchmark

`mainstream-200.json` expands the public catalogue to 200 Skills with pinned upstream commits. Beyond description-close smoke cases, it adds 50 manually labelled cases for semantic paraphrase, near-neighbour disambiguation, multilingual requests, format perturbation, compositions, and abstention.

The `text-embedding-v4` description-only scan found no acceptable global threshold: `0.45` reached 91.32% recall but injected 29.89 Skills on average at 3.14% precision; `0.60` reduced that average to 5.02 but composition recall fell to 18.75%. The full method, sources, and threshold results are in [`benchmarks/skill-routing`](benchmarks/skill-routing/README.en.md). At this catalogue size, reranking or author-maintained metadata is required follow-up work, not an optional refinement.

## Native Baseline

On the same 12-Skill fixture, a chat-model selection baseline returned 100% precision and recall in `6.35s`. This measures only explicit selection from an unambiguous catalogue; it is not an end-to-end comparison and does not remove the native path's later Skill-read call.

## Reproduce

Datasets, runner, commands, input modes, and result schema are in [`benchmarks/skill-routing`](benchmarks/skill-routing).

Provide endpoints and credentials through environment variables only. Do not add credentials to repository files or fixtures.

## Security Status

A current-tree pattern scan found only Google Vertex-shaped strings in API-key resolution test fixtures. No common OpenAI, GitHub, AWS, Slack, or Hugging Face key pattern was found in tracked files. GitHub Secret Scanning is currently disabled for this repository, so it should be enabled before relying on platform-side alerts.

## Status

The metadata routing path and its benchmark suite are implemented. The local reranker has been benchmarked but is not yet wired into the runtime path.

## License

MIT
