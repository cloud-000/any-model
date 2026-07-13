import { describe, expect, test } from "bun:test";
import { createRegistry } from "@any-model/core";
import { openRouter, openRouterOptions } from "./index.ts";

describe("OpenRouter provider", () => {
    test("requires an API key", () => {
        expect(() => openRouter({ apiKey: "" })).toThrow(TypeError);
    });

    test("registers as openrouter and enables reasoning", () => {
        const provider = openRouter({ apiKey: "key", fetch: doneFetch });
        const model = createRegistry()
            .use(provider)
            .languageModel("openrouter:anthropic/claude-test");
        expect(provider.id).toBe("openrouter");
        expect(model.provider).toBe("openrouter");
        expect(model.modelId).toBe("anthropic/claude-test");
        expect(model.capabilities.reasoning).toBe(true);
    });

    test("uses the default endpoint, auth, attribution, and header precedence", async () => {
        let captured: { url?: string; init?: RequestInit } = {};
        const model = openRouter({
            apiKey: "secret",
            appURL: "https://app.test",
            appName: "Any Model",
            appCategories: ["developer-tools", "productivity"],
            headers: { "x-custom": "config", "X-OpenRouter-Title": "Override" },
            fetch: async (url, init) => {
                captured = { url: String(url), init };
                return new Response("data: [DONE]\n\n");
            },
        }).languageModel("model");

        await model.generate({
            messages: [],
            headers: { "x-custom": "request" },
        });

        expect(captured.url).toBe("https://openrouter.ai/api/v1/chat/completions");
        expect(captured.init?.headers).toMatchObject({
            authorization: "Bearer secret",
            "HTTP-Referer": "https://app.test",
            "X-OpenRouter-Title": "Override",
            "X-OpenRouter-Categories": "developer-tools,productivity",
            "x-custom": "request",
        });
    });

    test("serializes routing, fallbacks, plugins, and transforms", async () => {
        let body: Record<string, unknown> = {};
        const model = openRouter({
            apiKey: "key",
            baseURL: "https://proxy.test/v1/",
            fetch: async (_url, init) => {
                body = JSON.parse(String(init?.body));
                return new Response("data: [DONE]\n\n");
            },
        }).languageModel("anthropic/primary");

        await model.generate({
            messages: [{ role: "user", content: "hi" }],
            temperature: 0.3,
            providerOptions: openRouterOptions({
                models: ["openai/fallback"],
                route: "fallback",
                provider: {
                    order: ["anthropic", "openai"],
                    allow_fallbacks: true,
                    require_parameters: true,
                    data_collection: "deny",
                    zdr: true,
                    quantizations: ["fp8"],
                    sort: { by: "latency", partition: "none" },
                    preferred_min_throughput: { p90: 50 },
                    max_price: { prompt: 1, completion: 2 },
                },
                plugins: [{ id: "web", enabled: true, max_results: 3 }],
                transforms: ["middle-out"],
                user: "stable-user",
                model: "wrong",
                messages: [],
                stream: false,
                temperature: 2,
            }),
        });

        expect(body).toMatchObject({
            model: "anthropic/primary",
            messages: [{ role: "user", content: "hi" }],
            stream: true,
            temperature: 0.3,
            models: ["openai/fallback"],
            route: "fallback",
            provider: {
                order: ["anthropic", "openai"],
                data_collection: "deny",
                sort: { by: "latency", partition: "none" },
                preferred_min_throughput: { p90: 50 },
            },
            plugins: [{ id: "web", enabled: true, max_results: 3 }],
            transforms: ["middle-out"],
            user: "stable-user",
        });
    });
});

async function doneFetch() {
    return new Response("data: [DONE]\n\n");
}
