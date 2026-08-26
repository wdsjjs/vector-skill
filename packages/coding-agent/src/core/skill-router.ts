import { buildSkillRoutingInput, type Skill } from "./skills.ts";

export interface SkillEmbeddingRequest {
	baseUrl: string;
	model: string;
	apiKey?: string;
	headers?: Record<string, string>;
	batchSize?: number;
	timeoutMs?: number;
}

export interface SkillRoute {
	skill: Skill;
	score: number;
}

interface EmbeddingsResponse {
	data: Array<{ index: number; embedding: number[] }>;
}

interface SkillRoutingInputs {
	skill: Skill;
	input: string;
}

/** Routes a query to every visible skill at or above the threshold and caches embeddings by embedding space. */
export class SkillRouter {
	private embeddings = new Map<string, number[]>();

	async route(
		query: string,
		skills: Skill[],
		request: SkillEmbeddingRequest,
		minimumSimilarity: number,
	): Promise<SkillRoute[]> {
		const normalizedQuery = query.trim();
		const candidates = skills.filter((skill) => !skill.disableModelInvocation);
		if (!normalizedQuery || candidates.length === 0) return [];

		const spaceKey = `${request.baseUrl}\u0000${request.model}`;
		const skillInputs = candidates.map((skill) => this.getRoutingInputs(skill));
		const missing = skillInputs.filter(({ input }) => !this.embeddings.has(this.getCacheKey(spaceKey, input)));
		const batchSize = request.batchSize ?? 10;
		if (!Number.isInteger(batchSize) || batchSize < 1) {
			throw new Error(`Embedding batch size must be a positive integer: ${String(batchSize)}`);
		}
		const timeoutMs = request.timeoutMs ?? 30000;
		if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
			throw new Error(`Embedding timeout must be a positive integer: ${String(timeoutMs)}`);
		}
		const [queryVector] = await this.embed([normalizedQuery], request);

		for (let start = 0; start < missing.length; start += batchSize) {
			const batch = missing.slice(start, start + batchSize);
			const vectors = await this.embed(
				batch.map(({ input }) => input),
				request,
			);
			for (let index = 0; index < batch.length; index++) {
				const { input } = batch[index]!;
				this.embeddings.set(this.getCacheKey(spaceKey, input), vectors[index]!);
			}
		}

		const matches: SkillRoute[] = [];
		for (const { skill, input } of skillInputs) {
			const vector = this.embeddings.get(this.getCacheKey(spaceKey, input));
			if (!vector) continue;
			const score = cosineSimilarity(queryVector, vector);
			if (score >= minimumSimilarity) {
				matches.push({ skill, score });
			}
		}

		return matches.sort((left, right) => right.score - left.score);
	}

	private getRoutingInputs(skill: Skill): SkillRoutingInputs {
		return {
			skill,
			input: buildSkillRoutingInput(skill),
		};
	}

	private getCacheKey(spaceKey: string, input: string): string {
		return `${spaceKey}\u0000${input}`;
	}

	private async embed(inputs: string[], request: SkillEmbeddingRequest): Promise<number[][]> {
		const headers: Record<string, string> = { ...request.headers, "Content-Type": "application/json" };
		const hasAuthorization = Object.keys(headers).some((name) => name.toLowerCase() === "authorization");
		if (request.apiKey && !hasAuthorization) {
			headers.Authorization = `Bearer ${request.apiKey}`;
		}

		const response = await fetch(`${request.baseUrl.replace(/\/+$/, "")}/embeddings`, {
			method: "POST",
			headers,
			body: JSON.stringify({ model: request.model, input: inputs }),
			signal: AbortSignal.timeout(request.timeoutMs ?? 30000),
		});
		const responseText = await response.text();
		if (!response.ok) {
			throw new Error(`Embedding request failed (${response.status}): ${responseText}`);
		}

		let payload: unknown;
		try {
			payload = JSON.parse(responseText);
		} catch {
			throw new Error("Embedding request returned invalid JSON");
		}

		return parseEmbeddings(payload, inputs.length);
	}
}

function parseEmbeddings(payload: unknown, expectedCount: number): number[][] {
	if (!isEmbeddingsResponse(payload)) {
		throw new Error("Embedding response does not contain a valid data array");
	}

	const embeddings: Array<number[] | undefined> = Array.from({ length: expectedCount });
	for (const item of payload.data) {
		if (!Number.isInteger(item.index) || item.index < 0 || item.index >= expectedCount) {
			throw new Error("Embedding response contains an invalid index");
		}
		if (item.embedding.length === 0 || item.embedding.some((value) => !Number.isFinite(value))) {
			throw new Error("Embedding response contains an invalid vector");
		}
		embeddings[item.index] = item.embedding;
	}

	if (embeddings.some((embedding) => embedding === undefined)) {
		throw new Error("Embedding response is missing vectors");
	}

	return embeddings as number[][];
}

function isEmbeddingsResponse(value: unknown): value is EmbeddingsResponse {
	if (!value || typeof value !== "object") return false;
	const data = (value as { data?: unknown }).data;
	if (!Array.isArray(data)) return false;
	return data.every((item: unknown) => {
		if (!item || typeof item !== "object") return false;
		const entry = item as { index?: unknown; embedding?: unknown };
		return (
			typeof entry.index === "number" &&
			Array.isArray(entry.embedding) &&
			entry.embedding.every((value: unknown) => typeof value === "number")
		);
	});
}

function cosineSimilarity(left: number[], right: number[]): number {
	if (left.length !== right.length) {
		throw new Error("Embedding vectors have different dimensions");
	}

	let dotProduct = 0;
	let leftMagnitude = 0;
	let rightMagnitude = 0;
	for (let index = 0; index < left.length; index++) {
		const leftValue = left[index]!;
		const rightValue = right[index]!;
		dotProduct += leftValue * rightValue;
		leftMagnitude += leftValue * leftValue;
		rightMagnitude += rightValue * rightValue;
	}

	if (leftMagnitude === 0 || rightMagnitude === 0) {
		throw new Error("Embedding vector has zero magnitude");
	}

	return dotProduct / Math.sqrt(leftMagnitude * rightMagnitude);
}
