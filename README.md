<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
</p>
<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>

> New issues and PRs from new contributors are auto-closed by default. Maintainers review auto-closed issues daily. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

# Pi Agent Harness Mono Repo

This is the home of the pi agent harness project including our self extensible coding agent.

* **[@earendil-works/pi-coding-agent](packages/coding-agent)**: Interactive coding agent CLI
* **[@earendil-works/pi-agent-core](packages/agent)**: Agent runtime with tool calling and state management
* **[@earendil-works/pi-ai](packages/ai)**: Unified multi-provider LLM API (OpenAI, Anthropic, Google, …)

To learn more about pi:

* [Visit pi.dev](https://pi.dev), the project website with demos
* [Read the documentation](https://pi.dev/docs/latest), but you can also ask the agent to explain itself

## Victory Skill Routing

Victory Skill Routing is an experimental progressive-loading path for Pi Skills. Its objective is to inject the complete `SKILL.md` before the first chat-model request without asking that model to select a skill and then call a tool to read it.

### Design

```text
user query
  -> embed query and one compact routing entry per visible Skill
  -> retain every candidate at the embedding threshold
  -> optional local cross-encoder rerank
  -> inject each surviving complete SKILL.md
  -> first chat-model request
```

The embedding entry is deliberately short and authored rather than generated. It consists of a Skill name, its required description, and optional routing metadata. The Markdown body, code blocks, examples, and procedural branches are not embedded; they are instruction content, not reliable task identifiers.

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

`use_cases` should be short task statements. `tags` should identify concrete platforms, artifacts, entities, or output types. Existing Skills without this metadata still route on their description.

The native baseline remains available. It exposes the complete Skill catalogue to the chat model and relies on the model to decide whether to read a matching file. The embedding path trades some selection quality for a predictable pre-chat retrieval path and no model-initiated Skill-read tool call.

### Iteration Evidence

All figures below are retrieval-label metrics, not claims of end-to-end task success. Precision is expected Skill labels divided by injected labels; recall is expected labels retained by routing. The UDA embedding model was `text-embedding-v4`. The reproducible fixtures and runner are under [`packages/coding-agent/test/fixtures`](packages/coding-agent/test/fixtures) and [`packages/coding-agent/scripts/benchmark-skill-routing.ts`](packages/coding-agent/scripts/benchmark-skill-routing.ts).

#### 1. Public description-only corpus

An 80-Skill corpus of public descriptions plus eight compound prompts established the initial threshold baseline. At an embedding threshold of `0.5`, it produced:

| Recall | Precision | Average candidates | Maximum candidates | Zero-match cases |
|---:|---:|---:|---:|---:|
| 61.46% | 18.15% | 3.69 | 42 | 27 |

This showed that a low global threshold over generic descriptions causes excessive injection. The corpus cannot evaluate body routing or author metadata because it intentionally does not redistribute third-party Skill bodies.

#### 2. Rejected body-segment routing

An exploratory corpus of 12 installed Codex Skills and six Chinese prompts compared description-only routing with the maximum score across selected Markdown body segments. At `0.5`, description-only precision/recall was `55.56% / 83.33%`; body-segment routing was `50.00% / 83.33%`.

The body did not improve expected-Skill scores and created additional false positives through generic procedural language. This experiment led to the current rule: full `SKILL.md` is injected after a match, but not embedded for matching.

#### 3. Author-maintained metadata routing

The owned Chinese fixture contains 12 Skills and 14 single/compound prompts. Each Skill provides explicit `use_cases` and `tags`. The same fixture can be run in `description` mode, which ignores its routing metadata, or `metadata` mode.

| Embedding threshold | Input | Recall | Precision | Average candidates | Zero-match cases |
|---:|---|---:|---:|---:|---:|
| 0.50 | description | 68.75% | 47.83% | 1.64 | 4 |
| 0.50 | metadata | 93.75% | 46.88% | 2.29 | 1 |
| 0.55 | description | 62.50% | 52.63% | 1.36 | 5 |
| 0.55 | metadata | 81.25% | 56.52% | 1.64 | 3 |
| 0.60 | description | 25.00% | 57.14% | 0.50 | 10 |
| 0.60 | metadata | 62.50% | 62.50% | 1.14 | 5 |

`0.55` is the best observed balance in this small corpus: the authored metadata raises both recall and precision over description-only input. It is an evaluation point, not a universal default.

The native selection baseline on this exact fixture returned `100%` precision and recall in `6.35s`. It is a selection-only chat-model benchmark with unambiguous prompts, not an end-to-end comparison. It does not remove the native runtime's later model-initiated Skill-read call.

#### 4. Local rerank experiment

The local `BAAI/bge-reranker-v2-m3` endpoint at `127.0.0.1:8088/v1/rerank` reranked the `0.5` metadata candidates using the same compact routing entries. It does not receive full Skill bodies.

| Embedding threshold | Rerank cutoff | Recall | Precision | Average candidates | Zero-match cases |
|---:|---:|---:|---:|---:|---:|
| 0.50 | none | 93.75% | 46.88% | 2.29 | 1 |
| 0.50 | 0.10 | 81.25% | 92.86% | 1.00 | 2 |
| 0.50 | 0.30 | 75.00% | 100.00% | 0.86 | 2 |

The reranker took `1.19s` on the first request and about `101ms` per warm request for five candidates on Apple MPS. The proposed starting configuration is embedding `0.5` followed by rerank `0.1`: it more than doubles measured precision while preserving 81.25% recall. Rerank should remain optional and configurable because the corpus is intentionally small.

### Reproducing The Benchmarks

Set the endpoint and credentials through environment variables; do not add credentials to the repository. The detailed commands and output schema are in [`packages/coding-agent/docs/skill-routing-benchmark.md`](packages/coding-agent/docs/skill-routing-benchmark.md).

## Share your OSS coding agent sessions

If you use pi or other coding agents for open source work, please share your sessions.

Public OSS session data helps improve coding agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `pi-share-hf`.

You can also watch [this video](https://x.com/badlogicgames/status/2041151967695634619), where I show how I publish my `pi-mono` sessions.

I regularly publish my own `pi-mono` work sessions here:

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## All Packages

| Package | Description |
|---------|-------------|
| **[@earendil-works/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@earendil-works/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@earendil-works/pi-tui](packages/tui)** | Terminal UI library with differential rendering |

For Slack/chat automation and workflows see [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).

## Development

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build        # Build all packages
npm run check        # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run pi from sources (can be run from any directory)
```

## Supply-chain hardening

We treat npm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent shrinkwrap.
- The published CLI package includes `packages/coding-agent/npm-shrinkwrap.json`, generated from the root lockfile, to pin transitive deps for npm users.
- Release smoke tests use `npm run release:local` to build, pack, and create isolated npm and Bun installs outside the repo before publishing.
- Local release installs, documented npm installs, and `pi update --self` use `--ignore-scripts` where supported.
- CI installs with `npm ci --ignore-scripts`, and a scheduled GitHub workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.
- Shrinkwrap generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## License

MIT
