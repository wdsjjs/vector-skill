import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

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
	skills: BenchmarkSkill[];
	compoundCases: CompoundCase[];
	robustCases?: CompoundCase[];
}

const fixturePath = resolve(import.meta.dirname, "../../../benchmarks/skill-routing/datasets/public-descriptions.json");
const benchmark = JSON.parse(readFileSync(fixturePath, "utf-8")) as BenchmarkDataset;
const metadataFixturePath = resolve(
	import.meta.dirname,
	"../../../benchmarks/skill-routing/datasets/chinese-metadata.json",
);
const metadataBenchmark = JSON.parse(readFileSync(metadataFixturePath, "utf-8")) as BenchmarkDataset;
const mainstream200FixturePath = resolve(
	import.meta.dirname,
	"../../../benchmarks/skill-routing/datasets/mainstream-200.json",
);
const mainstream200Benchmark = JSON.parse(readFileSync(mainstream200FixturePath, "utf-8")) as BenchmarkDataset;
const mainstream100FixturePath = resolve(
	import.meta.dirname,
	"../../../benchmarks/skill-routing/datasets/mainstream-100.json",
);
const mainstream100Benchmark = JSON.parse(readFileSync(mainstream100FixturePath, "utf-8")) as BenchmarkDataset;

describe("skill routing benchmark corpus", () => {
	it("contains 80 uniquely-labelled skills and valid trigger prompts", () => {
		expect(benchmark.skills).toHaveLength(80);
		const ids = new Set(benchmark.skills.map((skill) => skill.id));
		expect(ids).toHaveLength(80);
		for (const skill of benchmark.skills) {
			expect(skill.source).not.toBe("");
			expect(skill.description).not.toBe("");
			expect(skill.triggerPrompt).not.toBe("");
		}
	});

	it("keeps metadata benchmark routing fields author-maintained and well-formed", () => {
		expect(metadataBenchmark.skills).toHaveLength(12);
		for (const skill of metadataBenchmark.skills) {
			expect(skill.routing?.useCases.length).toBeGreaterThan(0);
			expect(skill.routing?.tags.length).toBeGreaterThan(0);
			for (const value of [...(skill.routing?.useCases ?? []), ...(skill.routing?.tags ?? [])]) {
				expect(value.trim()).not.toBe("");
			}
		}
	});

	it("keeps every compound case grounded in corpus labels", () => {
		const ids = new Set(benchmark.skills.map((skill) => skill.id));
		expect(benchmark.compoundCases.length).toBeGreaterThan(0);
		for (const testCase of benchmark.compoundCases) {
			expect(testCase.prompt).not.toBe("");
			expect(testCase.expected.length).toBeGreaterThan(1);
			for (const expected of testCase.expected) {
				expect(ids.has(expected)).toBe(true);
			}
		}
	});

	it("keeps the 100-Skill subset stratified and preserves all robust labels", () => {
		expect(mainstream100Benchmark.skills).toHaveLength(100);
		const sourceCounts = Object.fromEntries(
			["openai", "anthropic", "superpowers", "baseline", "vercel", "huggingface", "lark", "google"].map((source) => [
				source,
				mainstream100Benchmark.skills.filter((skill) => skill.source === source).length,
			]),
		);
		expect(sourceCounts).toEqual({
			openai: 20,
			anthropic: 8,
			superpowers: 7,
			baseline: 7,
			vercel: 4,
			huggingface: 13,
			lark: 14,
			google: 27,
		});

		const ids = new Set(mainstream100Benchmark.skills.map((skill) => skill.id));
		const sourceIds = new Set(mainstream200Benchmark.skills.map((skill) => skill.id));
		for (const skill of mainstream100Benchmark.skills) expect(sourceIds.has(skill.id)).toBe(true);
		for (const testCase of [...mainstream100Benchmark.compoundCases, ...(mainstream100Benchmark.robustCases ?? [])]) {
			for (const expected of testCase.expected) expect(ids.has(expected)).toBe(true);
		}
	});
});
