import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SkillRouter } from "../../packages/coding-agent/src/core/skill-router.ts";
import { buildSkillRoutingInput, type Skill, formatSkillsForPrompt } from "../../packages/coding-agent/src/core/skills.ts";
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

interface BenchmarkCase {
	id: string;
	prompt: string;
	expected: string[];
	slice: string;
}

interface BenchmarkDataset {
	version: number;
	sources: Record<string, string>;
	skills: BenchmarkSkill[];
	compoundCases: BenchmarkCase[];
	robustCases?: BenchmarkCase[];
}

interface CaseResult {
	id: string;
	slice: string;
	expected: string[];
	matched: Array<{ id: string; score: number }>;
}

interface RetrievalMetrics {
	cases: number;
	retrievalRecall: number;
	retrievalPrecision: number;
	abstentionAccuracy: number | undefined;
	averageCandidates: number;
	maximumCandidates: number;
	zeroMatchCases: number;
}

interface RerankConfig {
	url: string;
	cutoff: number;
	concurrency: number;
}

interface RerankResponse {
	results: Array<{ index: number; relevance_score: number }>;
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

function parseCases(value: unknown, message: string, defaultSlice: string): BenchmarkCase[] {
	if (!Array.isArray(value)) throw new Error(`${message} must be a list`);
	return value.map((value, index) => {
		const testCase = asRecord(value, `${message} case ${index} must be an object`);
		if (!Array.isArray(testCase.expected) || testCase.expected.some((id) => typeof id !== "string" || id.length === 0)) {
			throw new Error(`Invalid expected labels at ${message} case ${index}`);
		}
		return {
			id: asNonEmptyString(testCase.id, `Invalid case id at ${message} case ${index}`),
			prompt: asNonEmptyString(testCase.prompt, `Invalid prompt at ${message} case ${index}`),
			expected: [...testCase.expected],
			slice:
				testCase.slice === undefined
					? defaultSlice
					: asNonEmptyString(testCase.slice, `Invalid slice at ${message} case ${index}`),
		};
	});
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
	const compoundCases = parseCases(dataset.compoundCases, "compoundCases", "compound");
	const robustCases = dataset.robustCases === undefined ? undefined : parseCases(dataset.robustCases, "robustCases", "semantic-paraphrase");
	const skillIds = new Set<string>();
	for (const skill of skills) {
		if (skillIds.has(skill.id)) throw new Error(`Duplicate skill id: ${skill.id}`);
		skillIds.add(skill.id);
	}
	const caseIds = new Set<string>();
	for (const testCase of [...compoundCases, ...(robustCases ?? [])]) {
		if (caseIds.has(testCase.id)) throw new Error(`Duplicate case id: ${testCase.id}`);
		caseIds.add(testCase.id);
		for (const expectedId of testCase.expected) {
			if (!skillIds.has(expectedId)) throw new Error(`Case ${testCase.id} refers to unknown skill: ${expectedId}`);
		}
	}

	return { version: 1, sources, skills, compoundCases, robustCases };
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

function getSelectedSlices(): Set<string> | undefined {
	const value = getOptionalEnvironment("PI_SKILL_ROUTING_BENCHMARK_CASE_SLICES");
	if (!value) return undefined;
	const slices = value
		.split(",")
		.map((slice) => slice.trim())
		.filter((slice) => slice.length > 0);
	if (slices.length === 0) throw new Error("PI_SKILL_ROUTING_BENCHMARK_CASE_SLICES must contain at least one slice");
	return new Set(slices);
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

function getRerankConfig(): RerankConfig | undefined {
	const url = getOptionalEnvironment("PI_SKILL_ROUTING_BENCHMARK_RERANK_URL");
	const cutoffValue = process.env.PI_SKILL_ROUTING_BENCHMARK_RERANK_CUTOFF;
	if (!url) {
		if (cutoffValue !== undefined) throw new Error("PI_SKILL_ROUTING_BENCHMARK_RERANK_URL is required when a rerank cutoff is set");
		return undefined;
	}
	const cutoff = Number(cutoffValue ?? "0.01");
	if (!Number.isFinite(cutoff) || cutoff < 0 || cutoff > 1) {
		throw new Error("PI_SKILL_ROUTING_BENCHMARK_RERANK_CUTOFF must be between 0 and 1");
	}
	return {
		url,
		cutoff,
		concurrency: getPositiveIntegerEnvironment("PI_SKILL_ROUTING_BENCHMARK_RERANK_CONCURRENCY", 1),
	};
}

function parseRerankResponse(payload: unknown, expectedCount: number): number[] {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new Error("Rerank response must be an object");
	}
	const results = (payload as { results?: unknown }).results;
	if (!Array.isArray(results) || results.length !== expectedCount) {
		throw new Error("Rerank response is missing scores");
	}
	const scores: Array<number | undefined> = Array.from({ length: expectedCount });
	for (const result of results) {
		if (!result || typeof result !== "object" || Array.isArray(result)) {
			throw new Error("Rerank response contains an invalid result");
		}
		const { index, relevance_score: relevanceScore } = result as { index?: unknown; relevance_score?: unknown };
		if (
			!Number.isInteger(index) ||
			index < 0 ||
			index >= expectedCount ||
			typeof relevanceScore !== "number" ||
			!Number.isFinite(relevanceScore)
		) {
			throw new Error("Rerank response contains an invalid score");
		}
		scores[index] = relevanceScore;
	}
	if (scores.some((score) => score === undefined)) throw new Error("Rerank response is missing document indices");
	return scores as number[];
}

async function rerankCase(
	benchmarkCase: BenchmarkCase,
	result: CaseResult,
	skillsById: Map<string, Skill>,
	config: RerankConfig,
	timeoutMs: number,
): Promise<CaseResult> {
	if (result.matched.length === 0) return result;
	const candidates = result.matched.map((match) => {
		const skill = skillsById.get(match.id);
		if (!skill) throw new Error(`Rerank candidate is not in the catalogue: ${match.id}`);
		return { id: match.id, input: buildSkillRoutingInput(skill) };
	});
	const response = await fetch(config.url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ query: benchmarkCase.prompt, documents: candidates.map((candidate) => candidate.input) }),
		signal: AbortSignal.timeout(timeoutMs),
	});
	const responseText = await response.text();
	if (!response.ok) throw new Error(`Rerank request failed (${response.status}): ${responseText}`);
	let payload: unknown;
	try {
		payload = JSON.parse(responseText);
	} catch {
		throw new Error("Rerank response returned invalid JSON");
	}
	const scores = parseRerankResponse(payload, candidates.length);
	return {
		...result,
		matched: candidates
			.map((candidate, index) => ({ id: candidate.id, score: scores[index]! }))
			.filter((candidate) => candidate.score >= config.cutoff)
			.sort((left, right) => right.score - left.score),
	};
}

function getMetrics(results: CaseResult[]): RetrievalMetrics {
	let expectedCount = 0;
	let selectedCount = 0;
	let truePositiveCount = 0;
	let zeroMatchCases = 0;
	let maximumCandidates = 0;
	let abstentionCases = 0;
	let correctAbstentions = 0;
	for (const result of results) {
		const matchedIds = new Set(result.matched.map((match) => match.id));
		expectedCount += result.expected.length;
		selectedCount += result.matched.length;
		truePositiveCount += result.expected.filter((id) => matchedIds.has(id)).length;
		maximumCandidates = Math.max(maximumCandidates, result.matched.length);
		if (result.matched.length === 0) zeroMatchCases++;
		if (result.expected.length === 0) {
			abstentionCases++;
			if (result.matched.length === 0) correctAbstentions++;
		}
	}
	return {
		cases: results.length,
		retrievalRecall: expectedCount === 0 ? 0 : truePositiveCount / expectedCount,
		retrievalPrecision: selectedCount === 0 ? 0 : truePositiveCount / selectedCount,
		abstentionAccuracy: abstentionCases === 0 ? undefined : correctAbstentions / abstentionCases,
		averageCandidates: results.length === 0 ? 0 : selectedCount / results.length,
		maximumCandidates,
		zeroMatchCases,
	};
}

function groupMetricsBySlice(results: CaseResult[]): Record<string, RetrievalMetrics> {
	const groups = new Map<string, CaseResult[]>();
	for (const result of results) {
		const group = groups.get(result.slice) ?? [];
		group.push(result);
		groups.set(result.slice, group);
	}
	return Object.fromEntries([...groups.entries()].map(([slice, sliceResults]) => [slice, getMetrics(sliceResults)]));
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
const allBenchmarkCases: BenchmarkCase[] = [
	...dataset.skills.map((skill) => ({ id: skill.id, prompt: skill.triggerPrompt, expected: [skill.id], slice: "catalogue-smoke" })),
	...dataset.compoundCases,
	...(dataset.robustCases ?? []),
];
const selectedSlices = getSelectedSlices();
const benchmarkCases = selectedSlices
	? allBenchmarkCases.filter((benchmarkCase) => selectedSlices.has(benchmarkCase.slice))
	: allBenchmarkCases;
if (benchmarkCases.length === 0) throw new Error("No benchmark cases match PI_SKILL_ROUTING_BENCHMARK_CASE_SLICES");

const router = new SkillRouter();
const baseUrl = getRequiredEnvironment("PI_SKILL_ROUTING_BENCHMARK_BASE_URL");
const model = getRequiredEnvironment("PI_SKILL_ROUTING_BENCHMARK_MODEL");
const apiKey = getRequiredEnvironment("PI_SKILL_ROUTING_BENCHMARK_API_KEY");
const nativeChatModel = getOptionalEnvironment("PI_SKILL_ROUTING_BENCHMARK_CHAT_MODEL");
const requestTimeoutMs = getPositiveIntegerEnvironment("PI_SKILL_ROUTING_BENCHMARK_TIMEOUT_MS", 30000);
const nativeConcurrency = getPositiveIntegerEnvironment("PI_SKILL_ROUTING_BENCHMARK_NATIVE_CONCURRENCY", 2);
const nativeCaseBatchSize = getPositiveIntegerEnvironment("PI_SKILL_ROUTING_BENCHMARK_NATIVE_CASE_BATCH_SIZE", 8);
const embeddingConcurrency = getPositiveIntegerEnvironment("PI_SKILL_ROUTING_BENCHMARK_EMBEDDING_CONCURRENCY", 4);
const rerankConfig = getRerankConfig();
const nativeCatalogue = formatSkillsForPrompt(skills);
const availableIds = new Set(skills.map((skill) => skill.name));
const skillsById = new Map(skills.map((skill) => [skill.name, skill]));
const embeddingStartedAt = performance.now();

const routeCase = async (benchmarkCase: BenchmarkCase): Promise<CaseResult> => {
	const matches = await router.route(benchmarkCase.prompt, skills, { baseUrl, model, apiKey, timeoutMs: requestTimeoutMs }, threshold);
	return {
		id: benchmarkCase.id,
		slice: benchmarkCase.slice,
		expected: benchmarkCase.expected,
		matched: matches.map((match) => ({ id: match.skill.name, score: match.score })),
	};
};
const firstCase = benchmarkCases[0];
if (!firstCase) throw new Error("Benchmark dataset has no cases");
const caseResults = [
	await routeCase(firstCase),
	...(await mapWithConcurrency(benchmarkCases.slice(1), embeddingConcurrency, routeCase)),
];
const embeddingDurationMs = performance.now() - embeddingStartedAt;
const embeddingMetrics = getMetrics(caseResults);

let rerankRouting:
	| {
			cutoff: number;
			overall: RetrievalMetrics;
			bySlice: Record<string, RetrievalMetrics>;
			durationMs: number;
			caseResults: CaseResult[];
	  }
	| undefined;
if (rerankConfig) {
	const rerankStartedAt = performance.now();
	const rerankCaseResults = await mapWithConcurrency(caseResults, rerankConfig.concurrency, async (result, index) =>
		await rerankCase(benchmarkCases[index]!, result, skillsById, rerankConfig, requestTimeoutMs),
	);
	rerankRouting = {
		cutoff: rerankConfig.cutoff,
		overall: getMetrics(rerankCaseResults),
		bySlice: groupMetricsBySlice(rerankCaseResults),
		durationMs: performance.now() - rerankStartedAt,
		caseResults: rerankCaseResults,
	};
}

let nativeSelectionBaseline:
	| {
			overall: RetrievalMetrics;
			bySlice: Record<string, RetrievalMetrics>;
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
	const nativeResults = benchmarkCases.map((benchmarkCase, index) => ({
		id: benchmarkCase.id,
		slice: benchmarkCase.slice,
		expected: benchmarkCase.expected,
		matched: nativeSelections[index]!.map((id) => ({ id, score: 1 })),
	}));
	nativeSelectionBaseline = {
		overall: getMetrics(nativeResults),
		bySlice: groupMetricsBySlice(nativeResults),
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
				...embeddingMetrics,
				bySlice: groupMetricsBySlice(caseResults),
				durationMs: embeddingDurationMs,
			},
			rerankRouting,
			caseResults,
		},
		null,
		2,
	),
);
