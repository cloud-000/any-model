import { describe, expect, test } from "bun:test";
import { mockProvider, streamToolCall } from "@any-model/testing";
import {
    AuthError,
    UnsupportedFeatureError,
    createLanguageModel,
    createRegistry,
    unsupportedListModels,
    type Capabilities,
    type Provider,
    type StreamPart,
} from "./index.ts";

describe("registry", () => {
    test("resolves a model by 'providerId:modelId'", () => {
        const ai = createRegistry().use(mockProvider({ id: "mock" }));
        const model = ai.languageModel("mock:some-model");
        expect(model.provider).toBe("mock");
        expect(model.modelId).toBe("some-model");
    });

    test("model ids may contain ':'", () => {
        const ai = createRegistry().use(mockProvider({ id: "bedrock" }));
        const model = ai.languageModel("bedrock:anthropic:claude");
        expect(model.modelId).toBe("anthropic:claude");
    });

    test("throws for unknown provider", () => {
        const ai = createRegistry();
        expect(() => ai.languageModel("nope:x")).toThrow(/Unknown provider/);
    });

    test.each(["", "mock", "mock:", ":x"])("throws for malformed id %p", (id) => {
        const ai = createRegistry().use(mockProvider());
        expect(() => ai.languageModel(id)).toThrow();
    });

    test("listModels(providerId) returns that provider's models", async () => {
        const ai = createRegistry()
            .use(mockProvider({ id: "a", models: ["one"] }))
            .use(mockProvider({ id: "b", models: ["two"] }));
        expect(await ai.listModels("b")).toEqual([{ provider: "b", id: "two" }]);
    });

    test("listModels() concatenates every registered provider", async () => {
        const ai = createRegistry()
            .use(mockProvider({ id: "a", models: ["one"] }))
            .use(mockProvider({ id: "b", models: ["two", "three"] }));
        expect(await ai.listModels()).toEqual([
            { provider: "a", id: "one" },
            { provider: "b", id: "two" },
            { provider: "b", id: "three" },
        ]);
    });

    test("listModels() skips UnsupportedFeatureError", async () => {
        const ai = createRegistry()
            .use(mockProvider({ id: "ok", models: ["keep"] }))
            .use(stubProvider("none", unsupportedListModels("none")));
        expect(await ai.listModels()).toEqual([{ provider: "ok", id: "keep" }]);
    });

    test("listModels() propagates errors other than UnsupportedFeatureError", async () => {
        const ai = createRegistry()
            .use(mockProvider({ id: "ok", models: ["keep"] }))
            .use(
                stubProvider("auth", async () => {
                    throw new AuthError("nope", { provider: "auth" });
                }),
            );
        await expect(ai.listModels()).rejects.toBeInstanceOf(AuthError);
    });

    test("listModels(providerId) does not skip UnsupportedFeatureError", async () => {
        const ai = createRegistry().use(stubProvider("none", unsupportedListModels("none")));
        await expect(ai.listModels("none")).rejects.toBeInstanceOf(UnsupportedFeatureError);
        await expect(ai.listModels("missing")).rejects.toThrow(/Unknown provider/);
    });

    test("mock listModels defaults to echo and accepts configured ids", async () => {
        expect(await mockProvider().listModels()).toEqual([{ provider: "mock", id: "echo" }]);
        expect(
            await mockProvider({
                id: "local",
                models: ["a", { id: "b", name: "Bee", ownedBy: "me" }],
            }).listModels(),
        ).toEqual([
            { provider: "local", id: "a" },
            { provider: "local", id: "b", name: "Bee", ownedBy: "me" },
        ]);
    });
});

describe("end-to-end generate/stream", () => {
    const ai = createRegistry().use(mockProvider({ id: "mock" }));

    test("stream() yields normalized parts and generate() folds them", async () => {
        const model = ai.languageModel("mock:echo");
        const req = {
            messages: [{ role: "user" as const, content: "hello world" }],
        };

        const streamed: string[] = [];
        for await (const part of model.stream(req)) {
            if (part.type === "text-delta") streamed.push(part.text);
        }
        expect(streamed.join("")).toBe("hello world");

        const result = await model.generate(req);
        expect(result.text).toBe("hello world");
        expect(result.finishReason).toBe("stop");
        expect(result.toolCalls).toHaveLength(0);
    });

    test("folds a streamed tool call into a parsed tool-call part", async () => {
        const ai2 = createRegistry().use(
            mockProvider({
                id: "mock",
                respond: () => streamToolCall("get_weather", { city: "Paris" }),
            }),
        );
        const result = await ai2.languageModel("mock:tools").generate({
            messages: [{ role: "user", content: "weather?" }],
        });

        expect(result.finishReason).toBe("tool-calls");
        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolCalls[0]).toMatchObject({
            toolName: "get_weather",
            args: { city: "Paris" },
        });
        // Tool call also lands in ordered content.
        expect(result.content.at(-1)?.type).toBe("tool-call");
    });
});

const STUB_CAPABILITIES: Capabilities = {
    streaming: true,
    tools: false,
    vision: false,
    jsonSchema: false,
    reasoning: false,
    promptCaching: false,
};

async function* emptyStream(): AsyncIterable<StreamPart> {
    yield { type: "finish", finishReason: "stop", usage: {} };
}

function stubProvider(id: string, listModels: Provider["listModels"]): Provider {
    return {
        id,
        languageModel(modelId) {
            return createLanguageModel({
                provider: id,
                modelId,
                capabilities: STUB_CAPABILITIES,
                doStream: emptyStream,
            });
        },
        listModels,
    };
}
