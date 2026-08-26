import { afterEach, describe, expect, it } from "vitest";
import { SkillRouter } from "../src/core/skill-router.ts";
import type { Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function skill(name: string, description: string, routing?: { useCases: string[]; tags: string[] }): Skill {
	const filePath = `/skills/${name}/SKILL.md`;
	return {
		name,
		description,
		routing,
		filePath,
		baseDir: `/skills/${name}`,
		sourceInfo: createSyntheticSourceInfo(filePath, { source: "test" }),
		disableModelInvocation: false,
	};
}

describe("SkillRouter", () => {
	it("caches skill vectors and returns every match at or above the threshold", async () => {
		const router = new SkillRouter();
		const requests: Array<{ model: string; input: string[] }> = [];
		globalThis.fetch = async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as { model: string; input: string[] };
			requests.push(body);
			return new Response(
				JSON.stringify({
					data: body.input.map((entry, index) => ({
						index,
						embedding: entry.includes("release") ? [0, 1] : [1, 0],
					})),
				}),
			);
		};

		const skills = [skill("review", "Review a code change."), skill("release", "Publish a package.")];
		const request = {
			baseUrl: "https://new-api.example/v1",
			model: "text-embedding-test",
			apiKey: "test-key",
		};

		const firstMatches = await router.route("Review this pull request", skills, request, 0.8);
		const secondMatches = await router.route("Review the next pull request", skills, request, 0.8);
		const rejectedMatches = await router.route("Review another pull request", skills, request, 1.01);

		expect(firstMatches).toMatchObject([{ skill: { name: "review" }, score: 1 }]);
		expect(secondMatches).toMatchObject([{ skill: { name: "review" }, score: 1 }]);
		expect(rejectedMatches).toEqual([]);
		expect(requests.map((request) => request.input.length)).toEqual([1, 2, 1, 1]);
		expect(requests.every((request) => request.input.length <= 10)).toBe(true);
		expect(requests[0]).toMatchObject({ model: "text-embedding-test" });
	});

	it("does not apply a Top-K limit to skills above the threshold", async () => {
		const router = new SkillRouter();
		globalThis.fetch = async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as { input: string[] };
			return new Response(
				JSON.stringify({
					data: body.input.map((entry, index) => ({
						index,
						embedding: entry.includes("migration") ? [0.8, 0.6] : entry.includes("release") ? [0, 1] : [1, 0],
					})),
				}),
			);
		};

		const matches = await router.route(
			"Review and migrate this service",
			[
				skill("review", "Review a code change."),
				skill("migration", "Migrate a service database."),
				skill("release", "Publish a package."),
			],
			{ baseUrl: "https://new-api.example/v1", model: "text-embedding-test" },
			0.6,
		);

		expect(matches.map((match) => match.skill.name)).toEqual(["review", "migration"]);
		expect(matches.map((match) => match.score)).toEqual([1, 0.8]);
	});

	it("routes with one author-maintained metadata input per skill", async () => {
		const router = new SkillRouter();
		const embeddedInputs: string[] = [];
		globalThis.fetch = async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as { input: string[] };
			embeddedInputs.push(...body.input);
			return new Response(
				JSON.stringify({
					data: body.input.map((entry, index) => ({
						index,
						embedding:
							entry.startsWith("Investigate") || entry.includes("GitHub Actions workflows") ? [1, 0] : [0, 1],
					})),
				}),
			);
		};

		const matches = await router.route(
			"Investigate a failed CI workflow",
			[
				skill("ci-repair", "General repository maintenance.", {
					useCases: ["Diagnose and repair failed GitHub Actions workflows."],
					tags: ["CI", "GitHub Actions"],
				}),
			],
			{ baseUrl: "https://new-api.example/v1", model: "text-embedding-test" },
			0.8,
		);

		expect(matches).toMatchObject([{ skill: { name: "ci-repair" }, score: 1 }]);
		expect(embeddedInputs).toEqual([
			"Investigate a failed CI workflow",
			"Skill: ci-repair\nDescription: General repository maintenance.\nUse cases:\n- Diagnose and repair failed GitHub Actions workflows.\nTags: CI, GitHub Actions",
		]);
	});
});
