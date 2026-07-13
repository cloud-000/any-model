import type { ProviderOptions } from "@any-model/core";
import {
    openAICompatible,
    type FetchFunction,
    type OpenAICompatibleConfig,
} from "@any-model/openai-compat";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface OpenRouterConfig {
    apiKey: string;
    baseURL?: string;
    headers?: Record<string, string>;
    appURL?: string;
    appName?: string;
    appCategories?: string[];
    fetch?: FetchFunction;
}

type ExtensibleString<T extends string> = T | (string & {});

export type OpenRouterQuantization = ExtensibleString<
    "int4" | "int8" | "fp4" | "fp6" | "fp8" | "fp16" | "bf16" | "unknown"
>;

export type OpenRouterThresholds = number | Partial<Record<"p50" | "p75" | "p90" | "p99", number>>;

export type OpenRouterSort =
    | "price"
    | "throughput"
    | "latency"
    | {
          by: "price" | "throughput" | "latency";
          partition?: "model" | "none";
      };

export interface OpenRouterPriceLimit {
    prompt?: number;
    completion?: number;
    image?: number;
    audio?: number;
    request?: number;
    [key: string]: number | undefined;
}

export interface OpenRouterProviderPreferences {
    order?: string[];
    allow_fallbacks?: boolean;
    require_parameters?: boolean;
    data_collection?: "allow" | "deny";
    zdr?: boolean;
    enforce_distillable_text?: boolean;
    only?: string[];
    ignore?: string[];
    quantizations?: OpenRouterQuantization[];
    sort?: OpenRouterSort;
    preferred_min_throughput?: OpenRouterThresholds;
    preferred_max_latency?: OpenRouterThresholds;
    max_price?: OpenRouterPriceLimit;
    [key: string]: unknown;
}

export interface OpenRouterPlugin {
    id: ExtensibleString<"web" | "file-parser" | "response-healing">;
    enabled?: boolean;
    [key: string]: unknown;
}

export interface OpenRouterOptions {
    models?: string[];
    route?: "fallback";
    provider?: OpenRouterProviderPreferences;
    plugins?: OpenRouterPlugin[];
    transforms?: string[];
    user?: string;
    [key: string]: unknown;
}

export function openRouter(config: OpenRouterConfig) {
    if (!config?.apiKey) throw new TypeError("OpenRouter apiKey is required.");

    const attributionHeaders: Record<string, string> = {};
    if (config.appURL) attributionHeaders["HTTP-Referer"] = config.appURL;
    if (config.appName) attributionHeaders["X-OpenRouter-Title"] = config.appName;
    if (config.appCategories?.length) {
        attributionHeaders["X-OpenRouter-Categories"] = config.appCategories.join(",");
    }

    const compatibleConfig: OpenAICompatibleConfig = {
        id: "openrouter",
        baseURL: config.baseURL ?? OPENROUTER_BASE_URL,
        apiKey: config.apiKey,
        headers: { ...attributionHeaders, ...config.headers },
        capabilities: { reasoning: true },
        fetch: config.fetch,
    };
    return openAICompatible(compatibleConfig);
}

export function openRouterOptions(options: OpenRouterOptions): ProviderOptions {
    return { openrouter: options };
}
