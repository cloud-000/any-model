import { describe, expect, test } from "bun:test";
import { AuthError, ProviderError, RateLimitError, UnsupportedFeatureError } from "@any-model/core";
import { openAICompatible } from "./index.ts";
import { makeRequestBody } from "./provider.ts";

describe("request translation", () => {
    test("maps normalized options, messages, tools, and protected fields", () => {
        const body = makeRequestBody("local", "gpt-test", {
            messages: [
                { role: "system", content: "Be concise" },
                {
                    role: "user",
                    content: [
                        { type: "text", text: "inspect" },
                        { type: "image", image: "aGVsbG8=", mediaType: "image/png" },
                    ],
                },
                {
                    role: "assistant",
                    content: [
                        {
                            type: "tool-call",
                            toolCallId: "call_1",
                            toolName: "lookup",
                            args: { q: "x" },
                        },
                    ],
                },
                {
                    role: "tool",
                    content: [
                        {
                            type: "tool-result",
                            toolCallId: "call_1",
                            toolName: "lookup",
                            result: { value: 2 },
                        },
                    ],
                },
            ],
            tools: [{ name: "lookup", description: "Look up", inputSchema: { type: "object" } }],
            toolChoice: { type: "tool", toolName: "lookup" },
            temperature: 0.2,
            topP: 0.9,
            maxOutputTokens: 123,
            stopSequences: ["stop"],
            responseFormat: { type: "json", name: "answer", schema: { type: "object" } },
            providerOptions: {
                local: {
                    seed: 7,
                    model: "wrong",
                    stream: false,
                    tools: [{ type: "wrong" }],
                    temperature: 9,
                },
            },
        });

        expect(body).toMatchObject({
            seed: 7,
            model: "gpt-test",
            stream: true,
            temperature: 0.2,
            top_p: 0.9,
            max_tokens: 123,
            stop: ["stop"],
            tool_choice: { type: "function", function: { name: "lookup" } },
            response_format: {
                type: "json_schema",
                json_schema: { name: "answer", schema: { type: "object" }, strict: true },
            },
        });
        expect(body.messages).toEqual([
            { role: "system", content: "Be concise" },
            {
                role: "user",
                content: [
                    { type: "text", text: "inspect" },
                    { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
                ],
            },
            {
                role: "assistant",
                content: null,
                tool_calls: [
                    {
                        id: "call_1",
                        type: "function",
                        function: { name: "lookup", arguments: '{"q":"x"}' },
                    },
                ],
            },
            { role: "tool", tool_call_id: "call_1", content: '{"value":2}' },
        ]);
    });

    test("rejects unsupported file input before fetch", async () => {
        let called = false;
        const model = openAICompatible({
            id: "local",
            baseURL: "http://localhost:8000/v1",
            fetch: async () => {
                called = true;
                return new Response();
            },
        }).languageModel("x");
        await expect(
            model.generate({
                messages: [
                    {
                        role: "user",
                        content: [{ type: "file", data: "x", mediaType: "application/pdf" }],
                    },
                ],
            }),
        ).rejects.toBeInstanceOf(UnsupportedFeatureError);
        expect(called).toBe(false);
    });
});

describe("streaming", () => {
    test("parses fragmented tolerant SSE and folds text, reasoning, tools, and usage", async () => {
        const events = [
            ": keepalive\r\n\r\n",
            event({ choices: [{ delta: { reasoning_content: "think " }, finish_reason: null }] }),
            event({ choices: [{ delta: { content: "Hi" }, finish_reason: null }] }),
            event({
                choices: [
                    {
                        delta: {
                            tool_calls: [
                                {
                                    index: 0,
                                    id: "call_1",
                                    function: { name: "lookup", arguments: '{\"q\":' },
                                },
                            ],
                        },
                        finish_reason: null,
                    },
                ],
            }),
            event({
                choices: [
                    {
                        delta: { tool_calls: [{ index: 0, function: { arguments: '\"x\"}' } }] },
                        finish_reason: "tool_calls",
                    },
                ],
            }),
            event({
                choices: [],
                usage: {
                    prompt_tokens: 3,
                    completion_tokens: 4,
                    total_tokens: 7,
                    completion_tokens_details: { reasoning_tokens: 1 },
                    prompt_tokens_details: { cached_tokens: 2 },
                },
            }),
            "data: [DONE]\r\n\r\n",
        ].join("");
        const fetchMock = async () =>
            new Response(fragmented(events, [1, 2, 7, 3]), {
                status: 200,
                headers: { "content-type": "text/event-stream" },
            });
        const model = openAICompatible({
            id: "local",
            baseURL: "http://host/v1/",
            fetch: fetchMock,
        }).languageModel("m");
        const result = await model.generate({ messages: [{ role: "user", content: "hello" }] });

        expect(result.text).toBe("Hi");
        expect(result.content[0]).toEqual({ type: "reasoning", text: "think " });
        expect(result.toolCalls[0]).toMatchObject({
            toolCallId: "call_1",
            toolName: "lookup",
            args: { q: "x" },
        });
        expect(result.finishReason).toBe("tool-calls");
        expect(result.usage).toEqual({
            inputTokens: 3,
            outputTokens: 4,
            totalTokens: 7,
            reasoningTokens: 1,
            cachedInputTokens: 2,
        });
    });

    test("uses the normalized endpoint and header precedence", async () => {
        let captured: { url?: string; init?: RequestInit } = {};
        const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
            captured = { url: String(url), init };
            return new Response("data: [DONE]\n\n");
        };
        const model = openAICompatible({
            id: "local",
            baseURL: "https://example.test/v1/",
            apiKey: "secret",
            headers: { "x-scope": "config" },
            fetch: fetchMock,
        }).languageModel("m");
        await model.generate({
            messages: [{ role: "user", content: "hi" }],
            headers: { "x-scope": "request" },
        });
        expect(captured.url).toBe("https://example.test/v1/chat/completions");
        expect(captured.init?.headers).toMatchObject({
            authorization: "Bearer secret",
            "x-scope": "request",
        });
    });

    test("rejects malformed SSE JSON", async () => {
        const model = openAICompatible({
            id: "local",
            baseURL: "http://host/v1",
            fetch: async () => new Response("data: {oops}\n\n"),
        }).languageModel("m");
        await expect(model.generate({ messages: [] })).rejects.toBeInstanceOf(ProviderError);
    });

    test("maps in-stream errors delivered through an HTTP 200 response", async () => {
        const model = openAICompatible({
            id: "openrouter",
            baseURL: "http://host/v1",
            fetch: async () =>
                new Response(
                    event({
                        error: {
                            code: 429,
                            message: "upstream limited",
                            metadata: { error_type: "rate_limit_exceeded" },
                        },
                        choices: [{ delta: { content: "" }, finish_reason: "error" }],
                    }),
                ),
        }).languageModel("m");
        await expect(model.generate({ messages: [] })).rejects.toBeInstanceOf(RateLimitError);
    });
});

describe("HTTP errors", () => {
    test("maps authentication failures", async () => {
        const model = modelReturning(
            new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }),
        );
        await expect(model.generate({ messages: [] })).rejects.toBeInstanceOf(AuthError);
    });

    test("maps rate limits and Retry-After seconds", async () => {
        const model = modelReturning(
            new Response("slow down", { status: 429, headers: { "retry-after": "2.5" } }),
        );
        try {
            await model.generate({ messages: [] });
            throw new Error("expected rejection");
        } catch (error) {
            expect(error).toBeInstanceOf(RateLimitError);
            expect((error as RateLimitError).retryAfterMs).toBe(2500);
        }
    });
});

function modelReturning(response: Response) {
    return openAICompatible({
        id: "local",
        baseURL: "http://host/v1",
        fetch: async () => response,
    }).languageModel("m");
}

function event(value: unknown): string {
    return `data: ${JSON.stringify(value)}\r\n\r\n`;
}

function fragmented(text: string, sizes: number[]): ReadableStream<Uint8Array> {
    const bytes = new TextEncoder().encode(text);
    return new ReadableStream({
        start(controller) {
            let offset = 0;
            let index = 0;
            while (offset < bytes.length) {
                const size = sizes[index++ % sizes.length] ?? 1;
                controller.enqueue(bytes.slice(offset, offset + size));
                offset += size;
            }
            controller.close();
        },
    });
}
