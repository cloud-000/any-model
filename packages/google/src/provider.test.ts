import { describe, expect, test } from "bun:test";
import {
    AuthError,
    ContentFilterError,
    ProviderError,
    RateLimitError,
    UnsupportedFeatureError,
} from "@any-model/core";
import { google, googleOptions, makeRequestBody } from "./index.ts";

describe("request translation", () => {
    test("maps history, tools, settings, structured output, and native options", () => {
        const body = makeRequestBody("gemini-test", {
            messages: [
                { role: "system", content: "Be concise" },
                {
                    role: "user",
                    content: [
                        { type: "text", text: "inspect" },
                        { type: "image", image: "aGVsbG8=", mediaType: "image/png" },
                        { type: "file", data: "gs://bucket/a.pdf", mediaType: "application/pdf" },
                    ],
                },
                {
                    role: "assistant",
                    content: [
                        {
                            type: "reasoning",
                            text: "think",
                            providerMetadata: { google: { signature: "sig" } },
                        },
                        {
                            type: "tool-call",
                            toolCallId: "call-1",
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
                            toolCallId: "call-1",
                            toolName: "lookup",
                            result: { n: 2 },
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
            responseFormat: { type: "json", schema: { type: "object" } },
            providerOptions: googleOptions({
                previousInteractionId: "int-old",
                store: true,
                tools: [{ type: "google_search" }],
                generationConfig: { thinking_level: "high", temperature: 9, tool_choice: "wrong" },
                labels: { app: "test" },
                model: "wrong",
                input: "wrong",
            }),
        });

        expect(body).toMatchObject({
            model: "gemini-test",
            stream: true,
            system_instruction: "Be concise",
            previous_interaction_id: "int-old",
            store: true,
            labels: { app: "test" },
            generation_config: {
                thinking_level: "high",
                temperature: 0.2,
                top_p: 0.9,
                max_output_tokens: 123,
                stop_sequences: ["stop"],
                tool_choice: { allowed_tools: { mode: "any", tools: ["lookup"] } },
            },
            response_format: {
                type: "text",
                mime_type: "application/json",
                schema: { type: "object" },
            },
            tools: [
                { type: "google_search" },
                {
                    type: "function",
                    name: "lookup",
                    description: "Look up",
                    parameters: { type: "object" },
                },
            ],
        });
        expect(body.input).toEqual([
            {
                type: "user_input",
                content: [
                    { type: "text", text: "inspect" },
                    { type: "image", mime_type: "image/png", data: "aGVsbG8=" },
                    { type: "document", mime_type: "application/pdf", uri: "gs://bucket/a.pdf" },
                ],
            },
            { type: "thought", signature: "sig", summary: [{ type: "text", text: "think" }] },
            { type: "function_call", id: "call-1", name: "lookup", arguments: { q: "x" } },
            {
                type: "function_result",
                call_id: "call-1",
                name: "lookup",
                result: [{ type: "text", text: '{"n":2}' }],
            },
        ]);
    });

    test("maps bytes and data URLs and rejects arbitrary remote media", () => {
        const body = makeRequestBody("m", {
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "image",
                            image: new Uint8Array([104, 105]),
                            mediaType: "image/png",
                        },
                        {
                            type: "file",
                            data: "data:application/pdf;base64,eA==",
                            mediaType: "application/pdf",
                        },
                        {
                            type: "file",
                            data: new URL(
                                "https://generativelanguage.googleapis.com/v1beta/files/abc",
                            ),
                            mediaType: "video/mp4",
                        },
                    ],
                },
            ],
        });
        expect(body.input).toEqual([
            {
                type: "user_input",
                content: [
                    { type: "image", mime_type: "image/png", data: "aGk=" },
                    { type: "document", mime_type: "application/pdf", data: "eA==" },
                    {
                        type: "video",
                        mime_type: "video/mp4",
                        uri: "https://generativelanguage.googleapis.com/v1beta/files/abc",
                    },
                ],
            },
        ]);
        expect(() =>
            makeRequestBody("m", {
                messages: [
                    {
                        role: "user",
                        content: [
                            {
                                type: "image",
                                image: "https://example.com/a.png",
                                mediaType: "image/png",
                            },
                        ],
                    },
                ],
            }),
        ).toThrow(UnsupportedFeatureError);
    });

    test("recombines streamed thought text with its signature for stateless replay", () => {
        const body = makeRequestBody("m", {
            messages: [
                {
                    role: "assistant",
                    content: [
                        { type: "reasoning", text: "thought summary" },
                        {
                            type: "reasoning",
                            text: "",
                            providerMetadata: { google: { signature: "sig-1" } },
                        },
                    ],
                },
            ],
        });
        expect(body.input).toEqual([
            {
                type: "thought",
                signature: "sig-1",
                summary: [{ type: "text", text: "thought summary" }],
            },
        ]);
    });
});

describe("streaming", () => {
    test("parses fragmented lifecycle, reasoning, text, tools, signatures, usage, and metadata", async () => {
        const payload = [
            event({
                event_type: "interaction.created",
                interaction: { id: "int-1", status: "in_progress" },
            }),
            event({ event_type: "step.start", index: 0, step: { type: "thought" } }),
            event({
                event_type: "step.delta",
                index: 0,
                delta: { type: "thought", text: "think " },
            }),
            event({
                event_type: "step.stop",
                index: 0,
                step: { type: "thought", signature: "sig-1" },
            }),
            event({ event_type: "step.delta", index: 1, delta: { type: "text", text: "Hi" } }),
            event({
                event_type: "step.start",
                index: 2,
                step: { type: "function_call", id: "call-1", name: "lookup" },
            }),
            event({
                event_type: "step.delta",
                index: 2,
                delta: { type: "arguments", partial_arguments: '{"q":' },
            }),
            event({
                event_type: "step.delta",
                index: 2,
                delta: { type: "arguments", partial_arguments: '"x"}' },
            }),
            event({ event_type: "step.stop", index: 2 }),
            event({
                event_type: "interaction.completed",
                interaction: {
                    id: "int-1",
                    status: "requires_action",
                    steps: [{ type: "thought", signature: "sig-1" }],
                    usage: {
                        total_input_tokens: 3,
                        total_output_tokens: 4,
                        total_tokens: 8,
                        total_thought_tokens: 1,
                        total_cached_tokens: 2,
                    },
                },
            }),
        ].join("");
        const model = google({
            apiKey: "secret",
            fetch: async () => new Response(fragmented(payload, [1, 3, 7, 2])),
        }).languageModel("gemini-test");
        const result = await model.generate({ messages: [{ role: "user", content: "hello" }] });

        expect(result.text).toBe("Hi");
        expect(result.content[0]).toEqual({ type: "reasoning", text: "think " });
        expect(result.content[1]).toEqual({
            type: "reasoning",
            text: "",
            providerMetadata: { google: { signature: "sig-1" } },
        });
        expect(result.toolCalls[0]).toMatchObject({
            toolCallId: "call-1",
            toolName: "lookup",
            args: { q: "x" },
        });
        expect(result.finishReason).toBe("tool-calls");
        expect(result.usage).toEqual({
            inputTokens: 3,
            outputTokens: 4,
            totalTokens: 8,
            reasoningTokens: 1,
            cachedInputTokens: 2,
        });
        expect(result.providerMetadata).toEqual({
            google: { interactionId: "int-1", status: "requires_action" },
        });
        expect(result.raw).toMatchObject({ event_type: "interaction.completed" });
    });

    test("uses endpoint and request header precedence", async () => {
        let captured: { url?: string; init?: RequestInit } = {};
        const model = google({
            apiKey: "secret",
            baseURL: "https://example.test/v1beta/",
            headers: { "x-scope": "config" },
            fetch: async (url, init) => {
                captured = { url: String(url), init };
                return new Response(
                    event({
                        event_type: "interaction.completed",
                        interaction: { id: "i", status: "completed" },
                    }),
                );
            },
        }).languageModel("m");
        await model.generate({ messages: [], headers: { "x-scope": "request" } });
        expect(captured.url).toBe("https://example.test/v1beta/interactions?alt=sse");
        expect(captured.init?.headers).toMatchObject({
            "x-goog-api-key": "secret",
            "x-scope": "request",
        });
    });

    test("rejects malformed SSE JSON", async () => {
        const model = google({
            apiKey: "x",
            fetch: async () => new Response("data: {oops}\n\n"),
        }).languageModel("m");
        await expect(model.generate({ messages: [] })).rejects.toBeInstanceOf(ProviderError);
    });

    test("maps in-stream safety errors", async () => {
        const model = google({
            apiKey: "x",
            fetch: async () =>
                new Response(event({ error: { code: 400, message: "blocked by safety filter" } })),
        }).languageModel("m");
        await expect(model.generate({ messages: [] })).rejects.toBeInstanceOf(ContentFilterError);
    });
});

describe("HTTP errors", () => {
    test("maps authentication failures", async () => {
        const model = modelReturning(
            new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }),
        );
        await expect(model.generate({ messages: [] })).rejects.toBeInstanceOf(AuthError);
    });

    test("maps rate limits and Retry-After", async () => {
        const model = modelReturning(
            new Response("slow", { status: 429, headers: { "retry-after": "2.5" } }),
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
    return google({ apiKey: "x", fetch: async () => response }).languageModel("m");
}

function event(value: unknown): string {
    return `event: ignored\r\ndata: ${JSON.stringify(value)}\r\n\r\n`;
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
