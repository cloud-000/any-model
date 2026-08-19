import { describe, expect, test } from "bun:test";
import { AuthError, UnsupportedFeatureError, createRegistry } from "@any-model/core";
import { memoryCredentialStore } from "./credentials.ts";
import { chatGPT, chatGPTOptions, makeRequestBody } from "./provider.ts";
import { TOKEN_URL } from "./wire.ts";
import { jwt } from "./test-utils.ts";

describe("ChatGPT provider", () => {
    test("registers with the agentic v1 capabilities", () => {
        const provider = chatGPT({
            credentialStore: validStore(),
            fetch: async () => new Response("data: [DONE]\n\n"),
        });
        const model = createRegistry().use(provider).languageModel("chatgpt:gpt-test");
        expect(provider.id).toBe("chatgpt");
        expect(model.capabilities).toEqual({
            streaming: true,
            tools: true,
            vision: true,
            jsonSchema: false,
            reasoning: true,
            promptCaching: false,
        });
    });

    test("listModels throws UnsupportedFeatureError", async () => {
        const provider = chatGPT({
            credentialStore: validStore(),
            fetch: async () => new Response("data: [DONE]\n\n"),
        });
        try {
            await provider.listModels();
            throw new Error("expected rejection");
        } catch (error) {
            expect(error).toBeInstanceOf(UnsupportedFeatureError);
            expect((error as UnsupportedFeatureError).feature).toBe("listModels");
            expect((error as UnsupportedFeatureError).provider).toBe("chatgpt");
        }
    });

    test("translates messages, images, reasoning replay, tools, and protected fields", () => {
        const body = makeRequestBody("gpt-test", {
            messages: [
                { role: "system", content: "Be concise." },
                {
                    role: "user",
                    content: [
                        { type: "text", text: "Look" },
                        { type: "image", image: "abc", mediaType: "image/png" },
                    ],
                },
                {
                    role: "assistant",
                    content: [
                        {
                            type: "reasoning",
                            text: "summary",
                            providerMetadata: {
                                chatgpt: { itemId: "reason-1", encryptedContent: "encrypted" },
                            },
                        },
                        {
                            type: "tool-call",
                            toolCallId: "call-1",
                            toolName: "weather",
                            args: { city: "LA" },
                        },
                    ],
                },
                {
                    role: "tool",
                    content: [
                        {
                            type: "tool-result",
                            toolCallId: "call-1",
                            toolName: "weather",
                            result: { temp: 72 },
                        },
                    ],
                },
            ],
            tools: [{ name: "weather", inputSchema: { type: "object" } }],
            toolChoice: { type: "tool", toolName: "weather" },
            maxOutputTokens: 123,
            providerOptions: chatGPTOptions({
                reasoning: { effort: "high" },
                include: ["custom.field"],
                model: "wrong",
                input: [],
                stream: false,
                store: true,
            }),
        });
        expect(body).toMatchObject({
            model: "gpt-test",
            instructions: "Be concise.",
            stream: true,
            store: false,
            max_output_tokens: 123,
            reasoning: { effort: "high" },
            include: ["custom.field", "reasoning.encrypted_content"],
            tools: [{ type: "function", name: "weather" }],
            tool_choice: { type: "function", name: "weather" },
        });
        expect(body.input).toEqual([
            {
                type: "message",
                role: "user",
                content: [
                    { type: "input_text", text: "Look" },
                    { type: "input_image", image_url: "data:image/png;base64,abc" },
                ],
            },
            {
                type: "reasoning",
                id: "reason-1",
                encrypted_content: "encrypted",
                summary: [{ type: "summary_text", text: "summary" }],
            },
            {
                type: "function_call",
                call_id: "call-1",
                name: "weather",
                arguments: '{"city":"LA"}',
            },
            {
                type: "function_call_output",
                call_id: "call-1",
                output: '{"temp":72}',
            },
        ]);
    });

    test("omits strict by default, honors request-level default and per-tool override", () => {
        const tools = [
            { name: "weather", inputSchema: { type: "object" } },
            {
                name: "search",
                inputSchema: { type: "object" },
                providerOptions: { chatgpt: { strict: false } },
            },
        ];

        const defaultBody = makeRequestBody("model", { messages: [], tools });
        expect(defaultBody.tools).toEqual([
            { type: "function", name: "weather", parameters: { type: "object" } },
            { type: "function", name: "search", parameters: { type: "object" }, strict: false },
        ]);

        const requestLevelBody = makeRequestBody("model", {
            messages: [],
            tools,
            providerOptions: chatGPTOptions({ strict: true }),
        });
        expect(requestLevelBody.tools).toEqual([
            { type: "function", name: "weather", parameters: { type: "object" }, strict: true },
            { type: "function", name: "search", parameters: { type: "object" }, strict: false },
        ]);
    });

    test("rejects unsupported normalized settings and files before fetching", () => {
        expect(() => makeRequestBody("model", { messages: [], temperature: 0.5 })).toThrow(
            UnsupportedFeatureError,
        );
        expect(() =>
            makeRequestBody("model", {
                messages: [
                    {
                        role: "user",
                        content: [{ type: "file", data: "abc", mediaType: "text/plain" }],
                    },
                ],
            }),
        ).toThrow(UnsupportedFeatureError);
    });

    test("protects auth headers and normalizes fragmented Responses SSE", async () => {
        let captured: { url?: string; headers?: RequestInit["headers"]; body?: string } = {};
        const model = chatGPT({
            credentialStore: validStore(),
            headers: { Authorization: "Bearer wrong", "ChatGPT-Account-Id": "wrong" },
            fetch: async (url, init) => {
                captured = {
                    url: String(url),
                    headers: init?.headers,
                    body: String(init?.body),
                };
                return fragmentedSSE([
                    event({
                        type: "response.reasoning_summary_text.delta",
                        item_id: "reason-1",
                        delta: "thinking",
                    }),
                    event({
                        type: "response.output_item.done",
                        item_id: "reason-1",
                        item: {
                            type: "reasoning",
                            id: "reason-1",
                            encrypted_content: "encrypted",
                        },
                    }),
                    event({
                        type: "response.output_text.delta",
                        item_id: "message-1",
                        delta: "hello",
                    }),
                    event({
                        type: "response.output_item.added",
                        item: { type: "function_call", id: "item-1", call_id: "call-1", name: "go" },
                    }),
                    event({
                        type: "response.function_call_arguments.delta",
                        item_id: "item-1",
                        delta: '{"x":',
                    }),
                    event({
                        type: "response.function_call_arguments.done",
                        item_id: "item-1",
                        arguments: '{"x":1}',
                    }),
                    event({
                        type: "response.completed",
                        response: {
                            id: "response-1",
                            usage: {
                                input_tokens: 10,
                                output_tokens: 5,
                                total_tokens: 15,
                                input_tokens_details: { cached_tokens: 2 },
                                output_tokens_details: { reasoning_tokens: 3 },
                            },
                        },
                    }),
                ]);
            },
        }).languageModel("gpt-test");

        const result = await model.generate({
            messages: [{ role: "user", content: "hi" }],
            headers: { authorization: "still-wrong", "chatgpt-account-id": "still-wrong" },
        });
        expect(captured.url).toBe("https://chatgpt.com/backend-api/codex/responses");
        expect(captured.headers).toMatchObject({
            authorization: expect.stringContaining("Bearer header."),
            "chatgpt-account-id": "acct",
        });
        expect(JSON.parse(captured.body!)).toMatchObject({ model: "gpt-test", stream: true });
        expect(result.text).toBe("hello");
        expect(result.content[0]).toEqual({
            type: "reasoning",
            text: "thinking",
            providerMetadata: {
                chatgpt: { itemId: "reason-1", encryptedContent: "encrypted" },
            },
        });
        expect(result.toolCalls).toEqual([
            {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "go",
                args: { x: 1 },
                providerMetadata: { chatgpt: { itemId: "item-1" } },
            },
        ]);
        expect(result.finishReason).toBe("tool-calls");
        expect(result.usage).toEqual({
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
            reasoningTokens: 3,
            cachedInputTokens: 2,
        });
        expect(result.providerMetadata).toEqual({ chatgpt: { responseId: "response-1" } });
    });

    test("refreshes once after 401, replays, and persists the rotation", async () => {
        const store = validStore();
        let inferenceCalls = 0;
        let refreshCalls = 0;
        const model = chatGPT({
            credentialStore: store,
            fetch: async (url) => {
                if (String(url) === TOKEN_URL) {
                    refreshCalls++;
                    return Response.json({
                        access_token: jwt({ chatgpt_account_id: "acct", exp: 9999999999 }),
                        refresh_token: "rotated",
                        expires_in: 3600,
                    });
                }
                inferenceCalls++;
                if (inferenceCalls === 1) return new Response("", { status: 401 });
                return new Response(
                    event({ type: "response.completed", response: { usage: {} } }),
                    { headers: { "content-type": "text/event-stream" } },
                );
            },
        }).languageModel("model");
        await model.generate({ messages: [] });
        expect(inferenceCalls).toBe(2);
        expect(refreshCalls).toBe(1);
        expect((await store.load())?.refreshToken).toBe("rotated");
    });

    test("clears credentials after a second 401", async () => {
        const store = validStore();
        const model = chatGPT({
            credentialStore: store,
            fetch: async (url) => {
                if (String(url) === TOKEN_URL) {
                    return Response.json({
                        access_token: jwt({ chatgpt_account_id: "acct", exp: 9999999999 }),
                        expires_in: 3600,
                    });
                }
                return new Response("", { status: 401 });
            },
        }).languageModel("model");
        await expect(model.generate({ messages: [] })).rejects.toBeInstanceOf(AuthError);
        expect(await store.load()).toBeUndefined();
    });
});

function validStore() {
    return memoryCredentialStore({
        accessToken: jwt({ chatgpt_account_id: "acct", exp: 9999999999 }),
        refreshToken: "refresh",
        expiresAt: 9_999_999_999_000,
        accountId: "acct",
    });
}

function event(value: Record<string, unknown>): string {
    return `data: ${JSON.stringify(value)}\n\n`;
}

function fragmentedSSE(events: string[]): Response {
    const bytes = new TextEncoder().encode(events.join(""));
    const chunks = [bytes.slice(0, 13), bytes.slice(13, 47), bytes.slice(47)];
    return new Response(
        new ReadableStream<Uint8Array>({
            start(controller) {
                for (const chunk of chunks) controller.enqueue(chunk);
                controller.close();
            },
        }),
        { headers: { "content-type": "text/event-stream" } },
    );
}
