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
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AGENT_DIR = getAgentDir();
const PROVIDERS_FILE = join(AGENT_DIR, "providers.json");
const MODELS_STORE_FILE = join(AGENT_DIR, "models-store.json");
const DEFAULT_CONTEXT_WINDOW = 400_000;
const DEFAULT_MAX_TOKENS = 16_384;
// The first Node fetch can include DNS/TLS/connection setup and be noticeably slower
// than a warm curl request. Keep this below the model-picker's global timeout while
// allowing a cold connection to complete.
const MODEL_FETCH_TIMEOUT_MS = 10_000;
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
		vision?: unknown;
	};
}

interface PiModel {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
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

interface PersistedPiModel extends PiModel {
	api: "openai-completions";
	provider: string;
	baseUrl: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function positiveNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function toCachedModel(value: unknown, providerId: string): PiModel | undefined {
	const model = asRecord(value);
	if (!model || model.provider !== providerId || typeof model.id !== "string" || !model.id.trim()) return undefined;

	const input = Array.isArray(model.input)
		? model.input.filter((value): value is "text" | "image" => value === "text" || value === "image")
		: [];
	const cost = asRecord(model.cost);
	const thinkingLevelMap = asRecord(model.thinkingLevelMap);
	const compat = asRecord(model.compat);

	return {
		id: model.id,
		name: typeof model.name === "string" && model.name.trim() ? model.name : model.id,
		reasoning: model.reasoning === true,
		input: input.length > 0 ? input : ["text"],
		cost: {
			input: typeof cost?.input === "number" ? cost.input : 0,
			output: typeof cost?.output === "number" ? cost.output : 0,
			cacheRead: typeof cost?.cacheRead === "number" ? cost.cacheRead : 0,
			cacheWrite: typeof cost?.cacheWrite === "number" ? cost.cacheWrite : 0,
		},
		contextWindow: positiveNumber(model.contextWindow, DEFAULT_CONTEXT_WINDOW),
		maxTokens: positiveNumber(model.maxTokens, DEFAULT_MAX_TOKENS),
		...(thinkingLevelMap
			? {
					thinkingLevelMap: Object.fromEntries(
						Object.entries(thinkingLevelMap).filter(
							([, value]) => typeof value === "string" || value === null,
						),
					),
				}
			: {}),
		...(compat?.supportsReasoningEffort === true ? { compat: { supportsReasoningEffort: true } } : {}),
	};
}

function modelsFromStored(
	providerId: string,
	stored: RefreshModelsContext["stored"],
): PiModel[] {
	if (!stored) return [];
	return stored.models
		.map((model) => toCachedModel(model, providerId))
		.filter((model): model is PiModel => model !== undefined);
}

async function readCachedModels(providerId: string): Promise<PiModel[]> {
	try {
		const content = await readFile(MODELS_STORE_FILE, "utf8");
		const root = asRecord(JSON.parse(content));
		const entry = asRecord(root?.[providerId]);
		if (!entry || !Array.isArray(entry.models)) return [];

		return entry.models
			.map((model) => toCachedModel(model, providerId))
			.filter((model): model is PiModel => model !== undefined);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			console.error(`[providers] Failed to read cached models for "${providerId}":`, error);
		}
		return [];
	}
}

function toPersistedModels(providerId: string, provider: ProviderEntry, models: PiModel[]): PersistedPiModel[] {
	return models.map((model) => ({
		...model,
		api: "openai-completions",
		provider: providerId,
		baseUrl: provider.url,
	}));
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
	const supportsVision = type === "axonhub" && model.capabilities?.vision === true;

	return {
		id: model.id,
		name,
		reasoning,
		input: supportsVision ? ["text", "image"] : ["text"],
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

function createRefreshModels(providerId: string, provider: ProviderEntry, initialModels: PiModel[]) {
	let knownModels = [...initialModels];

	return async (context: RefreshModelsContext): Promise<PiModel[]> => {
		const restoredModels = modelsFromStored(providerId, context.stored);
		if (restoredModels.length > 0) knownModels = restoredModels;

		// Pi performs a cache-only refresh during startup and after provider registration.
		// Do not turn that phase into another network request.
		if (!context.allowNetwork || context.signal.aborted) return knownModels;

		try {
			const refreshedModels = await fetchModels(provider, context.signal);
			if (context.signal.aborted) return knownModels;

			const published = await context.publish({
				persist: {
					models: toPersistedModels(providerId, provider, refreshedModels),
					checkedAt: Date.now(),
				},
			});
			if (!published) return knownModels;

			knownModels = refreshedModels;
			return refreshedModels;
		} catch (error) {
			if (!context.signal.aborted) {
				console.error(`[providers] Failed to refresh "${providerId}":`, error);
			}
			// A failed refresh must not make a previously visible catalog disappear.
			return knownModels;
		}
	};
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

async function registerConfiguredProvider(
	pi: ExtensionAPI,
	providerId: string,
	provider: ProviderEntry,
): Promise<void> {
	// Registration must not wait for a cold network connection. The model picker
	// (or the session-start refresh below) will discover models asynchronously.
	const models = await readCachedModels(providerId);

	pi.registerProvider(providerId, {
		baseUrl: provider.url,
		apiKey: provider.apiKey,
		api: "openai-completions",
		models,
		refreshModels: createRefreshModels(providerId, provider, models),
	});
}

function isOfflineMode(): boolean {
	return /^(1|true|yes)$/i.test(process.env.PI_OFFLINE ?? "");
}

export default async function (pi: ExtensionAPI) {
	let config: ProvidersFile;
	try {
		config = await readProvidersFile();
	} catch (error) {
		console.error(`[providers] Failed to read ${PROVIDERS_FILE}:`, error);
		return;
	}

	const providerIds: string[] = [];
	await Promise.all(
		Object.entries(config.providers ?? {}).map(async ([providerId, provider]) => {
			try {
				validateProvider(providerId, provider);
				await registerConfiguredProvider(pi, providerId, provider);
				providerIds.push(providerId);
			} catch (error) {
				console.error(`[providers] Failed to register "${providerId}":`, error);
			}
		}),
	);

	if (providerIds.length === 0) return;

	let backgroundRefreshStarted = false;
	pi.on("session_start", (_event, ctx) => {
		if (
			backgroundRefreshStarted ||
			isOfflineMode() ||
			(ctx.mode !== "tui" && ctx.mode !== "rpc")
		) {
			return;
		}
		backgroundRefreshStarted = true;

		// Keep startup responsive. The model picker also performs this refresh when
		// opened, and Pi's provider refresh generations prevent stale publications.
		void ctx.modelRegistry
			.refresh({ providers: providerIds })
			.then((result) => {
				for (const [providerId, error] of result.errors) {
					console.error(`[providers] Background refresh failed for "${providerId}":`, error);
				}
			})
			.catch((error) => {
				console.error("[providers] Background model refresh failed:", error);
			});
	});
}
