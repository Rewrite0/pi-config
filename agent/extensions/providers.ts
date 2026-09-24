/**
 * 从 ~/.pi/agent/providers.json 加载兼容 OpenAI API 的 provider。
 *
 * 配置格式：
 * {
 *   "providers": {
 *     "provider-id": {
 *       "type": "axonhub",
 *       "url": "https://api.example.com/v1",
 *       "apiKey": "your-api-key"
 *     }
 *   }
 * }
 *
 * `url` 会作为兼容 OpenAI API 的基础地址，获取模型时会自动追加 `/models`。
 * `type: "axonhub"` 会额外请求 AxonHub 的模型元数据。
 * 如果 providers.json 不存在，本扩展会自动创建该文件，并写入空 JSON 对象（`{}`）。
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDERS_FILE = join(getAgentDir(), "providers.json");
const DEFAULT_CONTEXT_WINDOW = 400_000;
const DEFAULT_MAX_TOKENS = 16_384;
const MODEL_FETCH_TIMEOUT_MS = 2_000;
const AXONHUB_MODELS_INCLUDE = "name,context_length,max_output_tokens,capabilities";

interface ProviderEntry {
	type?: "axonhub";
	url: string;
	apiKey: string;
}

interface ProvidersFile {
	providers?: Record<string, ProviderEntry>;
}

interface RemoteModel {
	id?: unknown;
	name?: unknown;
	context_length?: unknown;
	max_output_tokens?: unknown;
	capabilities?: {
		reasoning?: unknown;
	};
}

interface PiModel {
	id: string;
	name: string;
	reasoning: boolean;
	input: ["text"];
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: Record<string, string | null>;
	compat?: {
		supportsReasoningEffort?: boolean;
	};
}

async function ensureProvidersFile(): Promise<void> {
	try {
		await readFile(PROVIDERS_FILE);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;

		await writeFile(PROVIDERS_FILE, "{}\n", { mode: 0o600 });
	}
}

async function readProvidersFile(): Promise<ProvidersFile> {
	await ensureProvidersFile();

	const content = await readFile(PROVIDERS_FILE, "utf8");
	if (!content.trim()) return {};

	const parsed: unknown = JSON.parse(content);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("providers.json must contain a JSON object");
	}

	const providers = (parsed as { providers?: unknown }).providers;
	if (providers === undefined) return {};
	if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
		throw new Error('providers.json field "providers" must be an object');
	}

	return { providers: providers as Record<string, ProviderEntry> };
}

function getModelsUrl(url: string, type?: ProviderEntry["type"]): string {
	const modelsUrl = `${url.replace(/\/+$/, "")}/models`;
	if (type !== "axonhub") return modelsUrl;

	const parsed = new URL(modelsUrl);
	parsed.searchParams.set("include", AXONHUB_MODELS_INCLUDE);
	return parsed.toString();
}

function toModel(model: RemoteModel, type?: ProviderEntry["type"]): PiModel | undefined {
	if (typeof model.id !== "string" || !model.id.trim()) return undefined;

	const name = typeof model.name === "string" && model.name.trim() ? model.name : model.id;

	const contextWindow =
		typeof model.context_length === "number" && model.context_length > 0
			? model.context_length
			: DEFAULT_CONTEXT_WINDOW;
	const maxTokens =
		typeof model.max_output_tokens === "number" && model.max_output_tokens > 0
			? model.max_output_tokens
			: DEFAULT_MAX_TOKENS;
	const reasoning = type === "axonhub" && model.capabilities?.reasoning !== false;

	return {
		id: model.id,
		name,
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
		...(reasoning
			? {
					thinkingLevelMap: {
						minimal: "low",
						low: "low",
						medium: "medium",
						high: "high",
						xhigh: "xhigh",
						max: "max",
					},
					compat: { supportsReasoningEffort: true },
				}
			: {}),
	};
}

async function fetchModels(provider: ProviderEntry, signal?: AbortSignal): Promise<PiModel[]> {
	const timeoutController = new AbortController();
	const timeout = setTimeout(() => timeoutController.abort(), MODEL_FETCH_TIMEOUT_MS);
	const abortFromCaller = () => timeoutController.abort();
	signal?.addEventListener("abort", abortFromCaller, { once: true });

	try {
		const response = await fetch(getModelsUrl(provider.url, provider.type), {
			signal: timeoutController.signal,
			headers: {
				Authorization: `Bearer ${provider.apiKey}`,
				Accept: "application/json",
			},
		});

		if (!response.ok) {
			throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
		}

		const payload: unknown = await response.json();
		const data = payload && typeof payload === "object" ? (payload as { data?: unknown }).data : undefined;
		if (!Array.isArray(data)) {
			throw new Error("models response must contain a data array");
		}

		const models = data
			.map((model) =>
				model && typeof model === "object" ? toModel(model as RemoteModel, provider.type) : undefined,
			)
			.filter((model): model is PiModel => model !== undefined);

		if (models.length === 0) {
			throw new Error("models response did not contain any usable model IDs");
		}

		return models;
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", abortFromCaller);
	}
}

function validateProvider(providerId: string, provider: unknown): asserts provider is ProviderEntry {
	if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
		throw new Error(`provider "${providerId}" must be an object`);
	}

	const { url, apiKey } = provider as Partial<ProviderEntry>;
	if (typeof url !== "string" || !url.trim()) {
		throw new Error(`provider "${providerId}" must define a non-empty url`);
	}
	if (typeof apiKey !== "string") {
		throw new Error(`provider "${providerId}" must define an apiKey`);
	}

	try {
		new URL(url);
	} catch {
		throw new Error(`provider "${providerId}" has an invalid url`);
	}
}

export default async function (pi: ExtensionAPI) {
	let config: ProvidersFile;
	try {
		config = await readProvidersFile();
	} catch (error) {
		console.error(`[providers] Failed to read ${PROVIDERS_FILE}:`, error);
		return;
	}

	await Promise.all(
		Object.entries(config.providers ?? {}).map(async ([providerId, provider]) => {
			try {
				validateProvider(providerId, provider);
				const models = await fetchModels(provider);

				pi.registerProvider(providerId, {
					baseUrl: provider.url,
					apiKey: provider.apiKey,
					api: "openai-completions",
					models,
					refreshModels: ({ signal }) => fetchModels(provider, signal),
				});
			} catch (error) {
				console.error(`[providers] Failed to register "${providerId}":`, error);
			}
		}),
	);
}
