import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SkillRouter } from "../../packages/coding-agent/src/core/skill-router.ts";
import { type Skill, formatSkillsForPrompt } from "../../packages/coding-agent/src/core/skills.ts";
import { createSyntheticSourceInfo } from "../../packages/coding-agent/src/core/source-info.ts";

interface BenchmarkSkill {
	id: string;
	source: string;
	description: string;
	routing?: {
		useCases: string[];
		tags: string[];
	};
	triggerPrompt: string;
}

interface CompoundCase {
	id: string;
	prompt: string;
	expected: string[];
}

interface BenchmarkDataset {
	version: number;
	sources: Record<string, string>;
	skills: BenchmarkSkill[];
	compoundCases: CompoundCase[];
}

interface BenchmarkCase {
	id: string;
	prompt: string;
	expected: string[];
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(message);
	}
	return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown, message: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(message);
	}
	return value;
}

function parseRoutingMetadata(value: unknown, message: string): BenchmarkSkill["routing"] {
	if (value === undefined) return undefined;
	const routing = asRecord(value, message);
	const parseList = (field: "useCases" | "tags"): string[] => {
		const list = routing[field];
		if (!Array.isArray(list) || list.some((item) => typeof item !== "string" || item.trim() === "")) {
			throw new Error(`${message}.${field} must be a list of non-empty strings`);
		}
		return list.map((item) => item.trim());
	};
	return { useCases: parseList("useCases"), tags: parseList("tags") };
}

function parseDataset(value: unknown): BenchmarkDataset {
	const dataset = asRecord(value, "Benchmark dataset must be an object");
	if (dataset.version !== 1) throw new Error("Unsupported benchmark dataset version");

	const sourcesRecord = asRecord(dataset.sources, "Benchmark sources must be an object");
	const sources = Object.fromEntries(
		Object.entries(sourcesRecord).map(([name, source]) => [name, asNonEmptyString(source, `Invalid source: ${name}`)]),
	);
	if (!Array.isArray(dataset.skills) || !Array.isArray(dataset.compoundCases)) {
		throw new Error("Benchmark dataset is missing skills or compoundCases");
	}

	const skills = dataset.skills.map((value, index) => {
		const skill = asRecord(value, `Invalid skill at index ${index}`);
		return {
		id: asNonEmptyString(skill.id, `Invalid skill id at index ${index}`),
		source: asNonEmptyString(skill.source, `Invalid skill source at index ${index}`),
		description: asNonEmptyString(skill.description, `Invalid skill description at index ${index}`),
		routing: parseRoutingMetadata(skill.routing, `Invalid routing metadata at skill index ${index}`),
		triggerPrompt: asNonEmptyString(skill.triggerPrompt, `Invalid skill triggerPrompt at index ${index}`),
		};
	});
	const compoundCases = dataset.compoundCases.map((value, index) => {
		const testCase = asRecord(value, `Invalid compound case at index ${index}`);
		if (!Array.isArray(testCase.expected) || testCase.expected.some((id) => typeof id !== "string" || id.length === 0)) {
			throw new Error(`Invalid compound case expected labels at index ${index}`);
		}
		return {
			id: asNonEmptyString(testCase.id, `Invalid compound case id at index ${index}`),
			prompt: asNonEmptyString(testCase.prompt, `Invalid compound case prompt at index ${index}`),
			expected: [...testCase.expected],
		};
	});

	return { version: 1, sources, skills, compoundCases };
}

function getRequiredEnvironment(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`Set ${name} before running this benchmark`);
	return value;
}

function getThreshold(): number {
	const value = Number(process.env.PI_SKILL_ROUTING_BENCHMARK_THRESHOLD ?? "0.6");
	if (!Number.isFinite(value) || value < -1 || value > 1) {
		throw new Error("PI_SKILL_ROUTING_BENCHMARK_THRESHOLD must be between -1 and 1");
	}
	return value;
}

function getOptionalEnvironment(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value || undefined;
}

function getRoutingInputMode(): "description" | "metadata" {
	const mode = process.env.PI_SKILL_ROUTING_BENCHMARK_ROUTING ?? "metadata";
	if (mode !== "description" && mode !== "metadata") {
		throw new Error("PI_SKILL_ROUTING_BENCHMARK_ROUTING must be description or metadata");
	}
	return mode;
}

function getPositiveIntegerEnvironment(name: string, defaultValue: number): number {
	const rawValue = process.env[name];
	if (rawValue === undefined) return defaultValue;
	const value = Number(rawValue);
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`${name} must be a positive integer`);
	}
	return value;
}

function parseNativeSkillSelections(
	value: unknown,
	benchmarkCases: BenchmarkCase[],
	availableIds: Set<string>,
): string[][] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return [];
	const selections = (value as { selections?: unknown }).selections;
	if (!selections || typeof selections !== "object" || Array.isArray(selections)) return [];
	return benchmarkCases.map((benchmarkCase) => {
		const skills = (selections as Record<string, unknown>)[benchmarkCase.id];
		if (!Array.isArray(skills)) return [];
		return skills.filter((skill): skill is string => typeof skill === "string" && availableIds.has(skill));
	});
}

async function selectWithNativeCatalogue(
	benchmarkCases: BenchmarkCase[],
	request: { baseUrl: string; model: string; apiKey: string; timeoutMs: number },
	catalogue: string,
	availableIds: Set<string>,
): Promise<string[][]> {
	const response = await fetch(`${request.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${request.apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: request.model,
			temperature: 0,
			messages: [
				{
					role: "system",
					content:
						"Select every relevant skill from the supplied catalogue for each input case. Return JSON only, with exactly one field: {\"selections\":{\"case-id\":[\"source:skill-name\"]}}. Do not invent IDs.\n\n" +
						catalogue,
				},
				{
					role: "user",
					content: JSON.stringify(benchmarkCases.map(({ id, prompt }) => ({ id, prompt }))),
				},
			],
		}),
		signal: AbortSignal.timeout(request.timeoutMs),
	});
	const responseText = await response.text();
	if (!response.ok) {
		throw new Error(`Native selection request failed (${response.status}): ${responseText}`);
	}

	let payload: unknown;
	try {
		payload = JSON.parse(responseText);
	} catch {
		throw new Error("Native selection request returned invalid JSON");
	}
	const choices = payload && typeof payload === "object" ? (payload as { choices?: unknown }).choices : undefined;
	const firstChoice = Array.isArray(choices) ? choices[0] : undefined;
	const content =
		firstChoice && typeof firstChoice === "object"
			? (firstChoice as { message?: { content?: unknown } }).message?.content
			: undefined;
	if (typeof content !== "string") {
		throw new Error("Native selection response does not contain text content");
	}

	try {
		const selections = parseNativeSkillSelections(JSON.parse(content), benchmarkCases, availableIds);
		if (selections.length !== benchmarkCases.length) {
			throw new Error("Native selection response is missing the selections object");
		}
		return selections;
	} catch {
		throw new Error("Native selection response is not a JSON object");
	}
}

async function mapWithConcurrency<T, Result>(
	values: T[],
	concurrency: number,
	callback: (value: T, index: number) => Promise<Result>,
): Promise<Result[]> {
	const results: Result[] = Array.from({ length: values.length });
	let nextIndex = 0;
	const worker = async (): Promise<void> => {
		while (nextIndex < values.length) {
			const index = nextIndex++;
			results[index] = await callback(values[index]!, index);
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
	return results;
}

function chunkValues<Value>(values: Value[], size: number): Value[][] {
	const chunks: Value[][] = [];
	for (let start = 0; start < values.length; start += size) {
		chunks.push(values.slice(start, start + size));
	}
	return chunks;
}

const datasetPath = resolve(
	process.cwd(),
	process.env.PI_SKILL_ROUTING_BENCHMARK_DATASET ?? "benchmarks/skill-routing/datasets/public-descriptions.json",
);
const dataset = parseDataset(JSON.parse(readFileSync(datasetPath, "utf-8")));
const threshold = getThreshold();
const routingInputMode = getRoutingInputMode();
const skills: Skill[] = dataset.skills.map((skill) => {
	const filePath = `/benchmark-skills/${skill.id}/SKILL.md`;
	return {
		name: skill.id,
		description: skill.description,
		routing: routingInputMode === "metadata" ? skill.routing : undefined,
		filePath,
		baseDir: `/benchmark-skills/${skill.id}`,
		sourceInfo: createSyntheticSourceInfo(filePath, { source: "benchmark" }),
		disableModelInvocation: false,
	};
});
const benchmarkCases: BenchmarkCase[] = [
	...dataset.skills.map((skill) => ({ id: skill.id, prompt: skill.triggerPrompt, expected: [skill.id] })),
	...dataset.compoundCases,
];

const router = new SkillRouter();
const baseUrl = getRequiredEnvironment("PI_SKILL_ROUTING_BENCHMARK_BASE_URL");
const model = getRequiredEnvironment("PI_SKILL_ROUTING_BENCHMARK_MODEL");
const apiKey = getRequiredEnvironment("PI_SKILL_ROUTING_BENCHMARK_API_KEY");
const nativeChatModel = getOptionalEnvironment("PI_SKILL_ROUTING_BENCHMARK_CHAT_MODEL");
const requestTimeoutMs = getPositiveIntegerEnvironment("PI_SKILL_ROUTING_BENCHMARK_TIMEOUT_MS", 30000);
const nativeConcurrency = getPositiveIntegerEnvironment("PI_SKILL_ROUTING_BENCHMARK_NATIVE_CONCURRENCY", 2);
const nativeCaseBatchSize = getPositiveIntegerEnvironment("PI_SKILL_ROUTING_BENCHMARK_NATIVE_CASE_BATCH_SIZE", 8);
const nativeCatalogue = formatSkillsForPrompt(skills);
const availableIds = new Set(skills.map((skill) => skill.name));
let selectedCount = 0;
let expectedCount = 0;
let truePositiveCount = 0;
let zeroMatchCases = 0;
let maximumCandidates = 0;
const caseResults: Array<{
	id: string;
	expected: string[];
	matched: Array<{ id: string; score: number }>;
}> = [];
const embeddingStartedAt = performance.now();

for (const benchmarkCase of benchmarkCases) {
	const matches = await router.route(benchmarkCase.prompt, skills, { baseUrl, model, apiKey }, threshold);
	const matched = matches.map((match) => ({ id: match.skill.name, score: match.score }));
	const matchedIds = new Set(matched.map((match) => match.id));
	const truePositives = benchmarkCase.expected.filter((id) => matchedIds.has(id)).length;
	selectedCount += matched.length;
	expectedCount += benchmarkCase.expected.length;
	truePositiveCount += truePositives;
	maximumCandidates = Math.max(maximumCandidates, matched.length);
	if (matched.length === 0) zeroMatchCases++;
	caseResults.push({ id: benchmarkCase.id, expected: benchmarkCase.expected, matched });
}
const embeddingDurationMs = performance.now() - embeddingStartedAt;

let nativeSelectionBaseline:
	| {
			retrievalRecall: number;
			retrievalPrecision: number;
			averageCandidates: number;
			zeroMatchCases: number;
			durationMs: number;
	  }
	| undefined;
if (nativeChatModel) {
	const nativeStartedAt = performance.now();
	const nativeCaseBatches = chunkValues(benchmarkCases, nativeCaseBatchSize);
	const nativeSelections = (
		await mapWithConcurrency(nativeCaseBatches, nativeConcurrency, async (caseBatch, index) => {
			console.error(`native selection batch ${index + 1}/${nativeCaseBatches.length}`);
			return await selectWithNativeCatalogue(
				caseBatch,
				{ baseUrl, model: nativeChatModel, apiKey, timeoutMs: requestTimeoutMs },
				nativeCatalogue,
				availableIds,
			);
		})
	).flat();
	let nativeSelectedCount = 0;
	let nativeTruePositiveCount = 0;
	let nativeZeroMatchCases = 0;
	for (const [index, benchmarkCase] of benchmarkCases.entries()) {
		const selected = nativeSelections[index]!;
		const selectedIds = new Set(selected);
		nativeSelectedCount += selected.length;
		nativeTruePositiveCount += benchmarkCase.expected.filter((id) => selectedIds.has(id)).length;
		if (selected.length === 0) nativeZeroMatchCases++;
	}
	nativeSelectionBaseline = {
		retrievalRecall: expectedCount === 0 ? 0 : nativeTruePositiveCount / expectedCount,
		retrievalPrecision: nativeSelectedCount === 0 ? 0 : nativeTruePositiveCount / nativeSelectedCount,
		averageCandidates: nativeSelectedCount / benchmarkCases.length,
		zeroMatchCases: nativeZeroMatchCases,
		durationMs: performance.now() - nativeStartedAt,
	};
}

console.log(
	JSON.stringify(
		{
			dataset: {
				path: datasetPath,
				version: dataset.version,
				skills: skills.length,
				cases: benchmarkCases.length,
				sources: dataset.sources,
			},
			threshold,
			routingInputMode,
			nativeBaseline: {
				catalogueCharacters: nativeCatalogue.length,
				catalogueEstimatedTokens: Math.ceil(nativeCatalogue.length / 4),
				selection: nativeSelectionBaseline,
			},
			embeddingRouting: {
				retrievalRecall: expectedCount === 0 ? 0 : truePositiveCount / expectedCount,
				retrievalPrecision: selectedCount === 0 ? 0 : truePositiveCount / selectedCount,
				averageCandidates: selectedCount / benchmarkCases.length,
				maximumCandidates,
				zeroMatchCases,
				durationMs: embeddingDurationMs,
			},
			caseResults,
		},
		null,
		2,
	),
);
