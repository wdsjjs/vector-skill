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
}

const fixturePath = resolve(import.meta.dirname, "../../../benchmarks/skill-routing/datasets/public-descriptions.json");
const benchmark = JSON.parse(readFileSync(fixturePath, "utf-8")) as BenchmarkDataset;
const metadataFixturePath = resolve(
	import.meta.dirname,
	"../../../benchmarks/skill-routing/datasets/chinese-metadata.json",
);
const metadataBenchmark = JSON.parse(readFileSync(metadataFixturePath, "utf-8")) as BenchmarkDataset;

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
});
