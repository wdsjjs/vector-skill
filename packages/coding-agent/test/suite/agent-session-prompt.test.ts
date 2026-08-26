import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { PromptTemplate } from "../../src/core/prompt-templates.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("AgentSession prompt characterization", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		while (tempDirs.length > 0) {
			const tempDir = tempDirs.pop();
			if (tempDir) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
	});

	it("prompts while idle and records a single text response", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("hello")]);

		await harness.session.prompt("hi");

		expect(harness.session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(getMessageText(harness.session.messages[0]!)).toBe("hi");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("handles a tool call turn and waits for the follow-up LLM response", async () => {
		const toolRuns: string[] = [];
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				toolRuns.push(text);
				return {
					content: [{ type: "text", text: `echo:${text}` }],
					details: { text },
				};
			},
		};
		const harness = await createHarness({ tools: [echoTool] });
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("start");

		expect(toolRuns).toEqual(["hello"]);
		expect(harness.session.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
		expect(harness.session.messages[2]?.role).toBe("toolResult");
		expect(harness.session.messages[3]?.role).toBe("assistant");
	});

	it("executes multiple tool calls from one response and continues with a single follow-up response", async () => {
		const toolRuns: string[] = [];
		const makeTool = (name: string, delayMs: number): AgentTool => ({
			name,
			label: name,
			description: `${name} tool`,
			parameters: Type.Object({ value: Type.String() }),
			execute: async (_toolCallId, params) => {
				const value =
					typeof params === "object" && params !== null && "value" in params ? String(params.value) : "";
				await new Promise((resolve) => setTimeout(resolve, delayMs));
				toolRuns.push(`${name}:${value}`);
				return {
					content: [{ type: "text", text: `${name}:${value}` }],
					details: { value },
				};
			},
		});
		const harness = await createHarness({ tools: [makeTool("slow", 25), makeTool("fast", 0)] });
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("slow", { value: "a" }), fauxToolCall("fast", { value: "b" })], {
				stopReason: "toolUse",
			}),
			(context) => {
				const toolResults = context.messages.filter((message) => message.role === "toolResult");
				return fauxAssistantMessage(`tool results: ${toolResults.length}`);
			},
		]);

		await harness.session.prompt("run tools");

		expect(toolRuns.sort()).toEqual(["fast:b", "slow:a"]);
		expect(harness.session.messages.filter((message) => message.role === "toolResult")).toHaveLength(2);
		expect(harness.session.messages[harness.session.messages.length - 1]?.role).toBe("assistant");
	});

	it("preserves image attachments in the provider context", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let sawImage = false;

		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				sawImage =
					user?.role === "user" &&
					typeof user.content !== "string" &&
					user.content.some((part) => part.type === "image");
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("describe", {
			images: [
				{
					type: "image",
					mimeType: "image/png",
					data: "ZmFrZQ==",
				},
			],
		});

		expect(sawImage).toBe(true);
	});

	it("expands skill commands before sending the prompt", async () => {
		const tempDir = join(tmpdir(), `pi-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		tempDirs.push(tempDir);
		const skillPath = join(tempDir, "test-skill.md");
		writeFileSync(skillPath, "# Test Skill\n\nUse the skill body.");

		const resourceLoader = {
			...createTestResourceLoader(),
			getSkills: () => ({
				skills: [
					{
						name: "test",
						description: "Test skill",
						filePath: skillPath,
						disableModelInvocation: false,
						baseDir: tempDir,
						sourceInfo: createSyntheticSourceInfo(skillPath, {
							source: "local",
							scope: "project",
							origin: "top-level",
							baseDir: tempDir,
						}),
					},
				],
				diagnostics: [],
			}),
		};
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		let expandedPrompt = "";

		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				expandedPrompt = user ? getMessageText(user) : "";
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("/skill:test explain this");

		expect(expandedPrompt).toContain('<skill name="test" location="');
		expect(expandedPrompt).toContain("Use the skill body.");
		expect(expandedPrompt).toContain("explain this");
	});

	it("keeps the native skill catalogue as an embedding-free baseline", async () => {
		const tempDir = join(tmpdir(), `pi-skill-native-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		tempDirs.push(tempDir);
		const skillPath = join(tempDir, "review", "SKILL.md");
		mkdirSync(join(tempDir, "review"), { recursive: true });
		writeFileSync(skillPath, "# Review\n\nInspect the change carefully.");

		const resourceLoader = {
			...createTestResourceLoader(),
			getSkills: () => ({
				skills: [
					{
						name: "review",
						description: "Review a code change for correctness.",
						filePath: skillPath,
						disableModelInvocation: false,
						baseDir: join(tempDir, "review"),
						sourceInfo: createSyntheticSourceInfo(skillPath, { source: "local" }),
					},
				],
				diagnostics: [],
			}),
		};
		const harness = await createHarness({
			resourceLoader,
			settings: { skillRouting: { mode: "native", embeddingModel: "text-embedding-test" } },
		});
		harnesses.push(harness);
		const originalFetch = globalThis.fetch;
		let fetchCalls = 0;
		globalThis.fetch = async () => {
			fetchCalls++;
			throw new Error("Native mode must not call the embedding endpoint");
		};

		try {
			harness.setResponses([fauxAssistantMessage("ok")]);
			await harness.session.prompt("Please review this change");

			expect(harness.session.systemPrompt).toContain("<available_skills>");
			expect(harness.session.systemPrompt).toContain("Review a code change for correctness.");
			expect(getMessageText(harness.session.messages[0]!)).toBe("Please review this change");
			expect(fetchCalls).toBe(0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("auto-loads the closest skill when its embedding score meets the configured threshold", async () => {
		const tempDir = join(tmpdir(), `pi-skill-routing-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		tempDirs.push(tempDir);
		const matchingSkillPath = join(tempDir, "review", "SKILL.md");
		const otherSkillPath = join(tempDir, "release", "SKILL.md");
		mkdirSync(join(tempDir, "review"), { recursive: true });
		mkdirSync(join(tempDir, "release"), { recursive: true });
		writeFileSync(matchingSkillPath, "# Review\n\nInspect the change carefully.");
		writeFileSync(otherSkillPath, "# Release\n\nPublish the package.");

		const resourceLoader = {
			...createTestResourceLoader(),
			getSkills: () => ({
				skills: [
					{
						name: "review",
						description: "Review a code change for correctness.",
						routing: { useCases: ["Inspect code changes for defects."], tags: ["code review"] },
						filePath: matchingSkillPath,
						disableModelInvocation: false,
						baseDir: join(tempDir, "review"),
						sourceInfo: createSyntheticSourceInfo(matchingSkillPath, { source: "local" }),
					},
					{
						name: "release",
						description: "Publish a package release.",
						routing: { useCases: ["Publish a package release."], tags: ["release"] },
						filePath: otherSkillPath,
						disableModelInvocation: false,
						baseDir: join(tempDir, "release"),
						sourceInfo: createSyntheticSourceInfo(otherSkillPath, { source: "local" }),
					},
				],
				diagnostics: [],
			}),
		};
		const harness = await createHarness({
			resourceLoader,
			settings: {
				skillRouting: { mode: "embedding", embeddingModel: "text-embedding-test", minimumSimilarity: 0.8 },
			},
		});
		harnesses.push(harness);
		const requestSizes: number[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as { input: string[] };
			requestSizes.push(body.input.length);
			return new Response(
				JSON.stringify({
					data: body.input.map((entry, index) => ({
						index,
						embedding: entry.includes("release") ? [0, 1] : [1, 0],
					})),
				}),
			);
		};

		try {
			let firstPrompt = "";
			harness.setResponses([
				(context) => {
					const user = context.messages.find((message) => message.role === "user");
					firstPrompt = user ? getMessageText(user) : "";
					return fauxAssistantMessage("ok");
				},
			]);

			await harness.session.prompt("Please review this change");
			await harness.session.prompt("Review the next change");

			expect(firstPrompt).toContain('<skill name="review" location="');
			expect(firstPrompt).toContain("Inspect the change carefully.");
			expect(firstPrompt).toContain("Please review this change");
			expect(requestSizes).toEqual([1, 2, 1]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("does not auto-load a skill below the configured similarity threshold", async () => {
		const tempDir = join(tmpdir(), `pi-skill-routing-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		tempDirs.push(tempDir);
		const skillPath = join(tempDir, "release", "SKILL.md");
		mkdirSync(join(tempDir, "release"), { recursive: true });
		writeFileSync(skillPath, "# Release\n\nPublish the package.");

		const resourceLoader = {
			...createTestResourceLoader(),
			getSkills: () => ({
				skills: [
					{
						name: "release",
						description: "Publish a package release.",
						filePath: skillPath,
						disableModelInvocation: false,
						baseDir: join(tempDir, "release"),
						sourceInfo: createSyntheticSourceInfo(skillPath, { source: "local" }),
					},
				],
				diagnostics: [],
			}),
		};
		const harness = await createHarness({
			resourceLoader,
			settings: {
				skillRouting: { mode: "embedding", embeddingModel: "text-embedding-test", minimumSimilarity: 0.9 },
			},
		});
		harnesses.push(harness);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as { input: string[] };
			return new Response(
				JSON.stringify({
					data: body.input.map((entry, index) => ({
						index,
						embedding: entry.includes("release") ? [0.8, 0.6] : [1, 0],
					})),
				}),
			);
		};

		try {
			let prompt = "";
			harness.setResponses([
				(context) => {
					const user = context.messages.find((message) => message.role === "user");
					prompt = user ? getMessageText(user) : "";
					return fauxAssistantMessage("ok");
				},
			]);

			await harness.session.prompt("Review this change");

			expect(prompt).toBe("Review this change");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("expands prompt templates before sending the prompt", async () => {
		const template: PromptTemplate = {
			name: "review",
			description: "Review template",
			content: "Review this code: $1",
			filePath: "/virtual/review.md",
			sourceInfo: createSyntheticSourceInfo("/virtual/review.md", {
				source: "local",
				scope: "temporary",
				origin: "top-level",
			}),
		};
		const resourceLoader = {
			...createTestResourceLoader(),
			getPrompts: () => ({ prompts: [template], diagnostics: [] }),
		};
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		let expandedPrompt = "";

		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				expandedPrompt = user ? getMessageText(user) : "";
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("/review src/index.ts");

		expect(expandedPrompt).toBe("Review this code: src/index.ts");
	});

	it("dispatches extension commands without consuming a provider response", async () => {
		const commandRuns: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("testcmd", {
						description: "Test command",
						handler: async (args) => {
							commandRuns.push(args);
						},
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("should stay queued")]);

		await harness.session.prompt("/testcmd hello world");

		expect(commandRuns).toEqual(["hello world"]);
		expect(harness.session.messages).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("sendUserMessage while idle triggers a turn", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("response")]);

		await harness.session.sendUserMessage("from extension");

		expect(harness.session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(getMessageText(harness.session.messages[0]!)).toBe("from extension");
	});

	it("throws when prompted during streaming without a streamingBehavior", async () => {
		let releaseToolExecution: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return {
					content: [{ type: "text", text: "released" }],
					details: {},
				};
			},
		};
		const harness = await createHarness({ tools: [waitTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const sawToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("start");
		await sawToolStart;

		await expect(harness.session.prompt("second")).rejects.toThrow(
			"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
		);

		releaseToolExecution?.();
		await promptPromise;
	});

	it("throws when prompting without a model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.agent.state.model = undefined as unknown as Model<any>;

		await expect(harness.session.prompt("hi")).rejects.toThrow("No model selected.");
	});

	it("throws when prompting without configured auth", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);

		await expect(harness.session.prompt("hi")).rejects.toThrow(
			`No API key found for ${harness.getModel().provider}.`,
		);
	});
});
