import { runAgent, type AgentExtension } from "@any-model/agent";
import { tool } from "@any-model/core";
import { z } from "zod";
import { model } from "./test-model";

interface RequestContext {
    userId: string;
    allowWeather: boolean;
}

const getWeather = tool({
    name: "get_weather",
    description: "Get the current weather for a city.",
    inputSchema: z.object({ city: z.string() }),
    execute: ({ city }) => ({
        city,
        tempF: 72,
        conditions: "Sunny",
    }),
});

// Hooks supplied directly are stateless and may safely be reused by many runs.
const auditAndPolicy: AgentExtension<RequestContext> = {
    prepareStep({ stepNumber }) {
        console.log(`[step ${stepNumber}] preparing model request`);
        return { generateOptions: { temperature: 0.2, maxOutputTokens: 10000 } };
    },
    beforeToolCall({ toolCall, context }) {
        console.log(`[tool] ${toolCall.toolName}`, toolCall.args);
        if (toolCall.toolName === "get_weather" && !context?.allowWeather) {
            return { action: "deny", reason: "Weather access is disabled for this request." };
        }
        return { action: "allow" };
    },
    afterToolCall({ toolResult }) {
        console.log(`[tool] ${toolResult.toolName} finished (error=${!!toolResult.isError})`);
        console.log(toolResult.result);
    },
    onEvent(event) {
        if (event.type === "finish") {
            console.log(`[run] ${event.result.stopReason}; usage=`, event.result.usage);
        }
    },
};

// Stateful extensions create fresh hooks for each run, so concurrent requests
// never share counters or other invocation-local state.
function toolCallLimit(maxCalls: number): AgentExtension<RequestContext> {
    return {
        createRun({ context }) {
            let calls = 0;
            return {
                beforeToolCall() {
                    calls++;
                    if (calls > maxCalls) {
                        return {
                            action: "deny",
                            reason: `Tool-call limit of ${maxCalls} reached.`,
                        };
                    }
                },
                onEvent(event) {
                    if (event.type === "finish") {
                        console.log(`[audit] user=${context?.userId}; toolCalls=${calls}`);
                    }
                },
            };
        },
    };
}

const result = await runAgent<RequestContext>({
    model,
    instructions: "Use tools when needed, then answer concisely.",
    messages: [
        {
            role: "user",
            content: "Tell me about the weather in San Francisco, Tokyo, and New York",
        },
    ],
    tools: [getWeather],
    context: { userId: "user-123", allowWeather: true },
    extensions: [auditAndPolicy, toolCallLimit(2)],
    maxSteps: 5,
});

console.log(result.text);
