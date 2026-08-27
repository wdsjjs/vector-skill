> pi can create skills. Ask it to build one for your use case.

# Skills

Skills are self-contained capability packages that the agent loads on-demand. A skill provides specialized workflows, setup instructions, helper scripts, and reference documentation for specific tasks.

Pi implements the [Agent Skills standard](https://agentskills.io/specification), warning about most violations but remaining lenient. Pi allows skill names to differ from their parent directory even though the standard disallows it; that rule is suboptimal for shared skill directories used across multiple agent harnesses.

## Table of Contents

- [Locations](#locations)
- [How Skills Work](#how-skills-work)
- [Semantic Skill Routing](#semantic-skill-routing)
- [Skill Commands](#skill-commands)
- [Skill Structure](#skill-structure)
- [Frontmatter](#frontmatter)
- [Validation](#validation)
- [Example](#example)
- [Skill Repositories](#skill-repositories)

## Locations

> **Security:** Skills can instruct the model to perform any action and may include executable code the model invokes. Review skill content before use.

Pi loads skills from:

- Global:
  - `~/.pi/agent/skills/`
  - `~/.agents/skills/`
- Project:
  - `.pi/skills/`
  - `.agents/skills/` in `cwd` and ancestor directories (up to git repo root, or filesystem root when not in a repo)
- Packages: `skills/` directories or `pi.skills` entries in `package.json`
- Settings: `skills` array with files or directories
- CLI: `--skill <path>` (repeatable, additive even with `--no-skills`)

Discovery rules:
- In `~/.pi/agent/skills/` and `.pi/skills/`, direct root `.md` files are discovered as individual skills
- In all skill locations, directories containing `SKILL.md` are discovered recursively
- In `~/.agents/skills/` and project `.agents/skills/`, root `.md` files are ignored

Disable discovery with `--no-skills` (explicit `--skill` paths still load).

### Using Skills from Other Harnesses

To use skills from Claude Code or OpenAI Codex, add their directories to settings:

```json
{
  "skills": [
    "~/.claude/skills",
    "~/.codex/skills"
  ]
}
```

For project-level Claude Code skills, add to `.pi/settings.json`:

```json
{
  "skills": ["../.claude/skills"]
}
```

## How Skills Work

1. At startup, pi scans skill locations and extracts names and descriptions
2. The system prompt includes available skills in XML format per the [specification](https://agentskills.io/integrate-skills)
3. When a task matches, the agent uses `read` to load the full SKILL.md (models don't always do this; use prompting or `/skill:name` to force it)
4. The agent follows the instructions, using relative paths to reference scripts and assets

This is progressive disclosure: only descriptions are always in context, full instructions load on-demand.

## Semantic Skill Routing

Pi has two routing modes that use the same discovered skills. `native` keeps the full skill catalogue in the system prompt, where the chat model can read a matching `SKILL.md`. `embedding` embeds one compact routing entry for each visible skill: its description plus optional author-maintained `metadata.routing.use_cases` and `metadata.routing.tags`. Every skill whose score meets `minimumSimilarity` is injected with its complete body before the chat model starts. There is no Top-K limit, so one compound request can load every relevant skill. In embedding mode, Pi omits the full skill catalogue from the system prompt; queries below the threshold proceed without an automatically loaded skill.

The endpoint and credentials come from the selected provider in `models.json`. Set `skillRouting.provider` to keep routing on one provider when switching chat models; otherwise Pi uses the active model's provider. Routing entries are requested in batches of 10 by default; set `skillRouting.embeddingBatchSize` for a stricter provider limit. Each embedding request times out after 30 seconds. `disable-model-invocation: true` skills remain manual-only. `/skill:name` always forces a skill to load.

```json
{
  "skillRouting": {
    "mode": "embedding",
    "provider": "my-openai-provider",
    "embeddingModel": "your-embedding-model",
    "embeddingBatchSize": 10,
    "minimumSimilarity": 0.6
  }
}
```

For the native baseline, keep the same skills and chat model but set `"mode": "native"`. The embedding fields may remain in the file so switching back only changes this one value.

For an 80-skill public-metadata corpus and a threshold-routing benchmark, see [the benchmark directory](../../../benchmarks/skill-routing/).

## Skill Commands

Skills register as `/skill:name` commands:

```bash
/skill:brave-search           # Load and execute the skill
/skill:pdf-tools extract      # Load skill with arguments
```

Arguments after the command are appended to the skill content as `User: <args>`.

Toggle skill commands via `/settings` in interactive mode or in `settings.json`:

```json
{
  "enableSkillCommands": true
}
```

## Skill Structure

A skill is a directory with a `SKILL.md` file. Everything else is freeform.

```
my-skill/
├── SKILL.md              # Required: frontmatter + instructions
├── scripts/              # Helper scripts
│   └── process.sh
├── references/           # Detailed docs loaded on-demand
│   └── api-reference.md
└── assets/
    └── template.json
```

### SKILL.md Format

````markdown
---
name: my-skill
description: What this skill does and when to use it. Be specific.
---

# My Skill

## Setup

Run once before first use:
```bash
cd /path/to/skill && npm install
```

## Usage

```bash
./scripts/process.sh <input>
```
````

Use relative paths from the skill directory:

```markdown
See [the reference guide](references/REFERENCE.md) for details.
```

## Frontmatter

Per the [Agent Skills specification](https://agentskills.io/specification#frontmatter-required):

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Max 64 chars. Lowercase a-z, 0-9, hyphens. Unlike the standard, Pi does not require this to match the parent directory because that standard requirement is suboptimal for shared skill directories. |
| `description` | Yes | Max 1024 chars. What the skill does and when to use it. |
| `license` | No | License name or reference to bundled file. |
| `compatibility` | No | Max 500 chars. Environment requirements. |
| `metadata` | No | Arbitrary key-value mapping. |
| `allowed-tools` | No | Space-delimited list of pre-approved tools (experimental). |
| `disable-model-invocation` | No | When `true`, skill is hidden from system prompt. Users must use `/skill:name`. |

#### Embedding Routing Metadata

Embedding routing has one input per skill. It always includes `name` and `description`; authors can add a few discriminative use cases and concrete tags under `metadata.routing`. This metadata is not generated and does not change a skill's instructions. The router does not embed Markdown body sections, code blocks, examples, or procedural branches, because they created false positives in threshold routing.

```yaml
---
name: figma-implement-design
description: Translate supplied Figma designs into production UI code.
metadata:
  routing:
    use_cases:
      - Implement a supplied Figma file as a responsive React page.
      - Match Figma variables, spacing, and component states in existing code.
    tags:
      - Figma
      - design file
      - React
      - responsive UI
---
```

Use cases should be short user-task statements. Tags should name concrete platforms, artifacts, entities, or output types. Do not add negated natural-language exclusions: vector similarity does not implement logical negation reliably. A match injects the complete `SKILL.md`, including its code blocks and references, before the first chat-model request.

### Name Rules

- 1-64 characters
- Lowercase letters, numbers, hyphens only
- No leading/trailing hyphens
- No consecutive hyphens
Pi does not require the name to match the parent directory. The Agent Skills standard does, but that requirement is suboptimal for shared skill directories used by multiple tools.

Valid: `pdf-processing`, `data-analysis`, `code-review`
Invalid: `PDF-Processing`, `-pdf`, `pdf--processing`

### Description Best Practices

The description determines when the agent loads the skill. Be specific.

Good:
```yaml
description: Extracts text and tables from PDF files, fills PDF forms, and merges multiple PDFs. Use when working with PDF documents.
```

Poor:
```yaml
description: Helps with PDFs.
```

## Validation

Pi validates skills against the Agent Skills standard. Most issues produce warnings but still load the skill:

- Name exceeds 64 characters or contains invalid characters
- Name starts/ends with hyphen or has consecutive hyphens
- Description exceeds 1024 characters

Unknown frontmatter fields are ignored.

**Exception:** Skills with missing description are not loaded.

Name collisions (same name from different locations) warn and keep the first skill found.

## Example

```
brave-search/
├── SKILL.md
├── search.js
└── content.js
```

**SKILL.md:**
````markdown
---
name: brave-search
description: Web search and content extraction via Brave Search API. Use for searching documentation, facts, or any web content.
---

# Brave Search

## Setup

```bash
cd /path/to/brave-search && npm install
```

## Search

```bash
./search.js "query"              # Basic search
./search.js "query" --content    # Include page content
```

## Extract Page Content

```bash
./content.js https://example.com
```
````

## Skill Repositories

- [Anthropic Skills](https://github.com/anthropics/skills) - Document processing (docx, pdf, pptx, xlsx), web development
- [Pi Skills](https://github.com/badlogic/pi-skills) - Web search, browser automation, Google APIs, transcription
