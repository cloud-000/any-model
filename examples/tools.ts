import {
    tool,
    ToolInputError,
    toWireTools,
    type Message,
    type ToolResultPart,
} from "@any-model/core";
import { z } from "zod";
import { parseTextToolCalls } from "./parse-text-tool-calls";
import { model } from "./test-model";

// The schema is declared once. `tool()` derives all three things it needs from
// it: the JSON Schema sent to the provider, the runtime validation that guards
// `execute`, and the argument type `{ city: string }` inferred below — nothing
// to keep in sync by hand. Any Standard Schema library works here (Zod, Valibot, ArkType); `SchemaAdapter` remains for raw JSON Schema.
// `execute` closes over whatever the app needs — here, a stand-in for a weather
// API call. Only `toWireTools()`'s output — name/description/inputSchema — ever
// reaches the provider; `execute` cannot leak across that boundary by accident.
const getWeather = tool({
    name: "get_weather",
    description: "Get the current weather for a city.",
    inputSchema: z.object({
        city: z.string().describe("City name, e.g. San Francisco"),
    }),
    execute: ({ city }) => {
        return {
            city,
            tempF: 72,
            conditions: "Sunny",
        };
    },
});

const tools = [getWeather];
const wireTools = toWireTools(tools);
const maxSteps = 5;

const messages: Message[] = [
    { role: "user", content: "What's the weather in San Francisco right now?" },
];

for (let step = 0; step < maxSteps; step++) {
    const result = await model.generate({ messages, tools: wireTools });

    if (result.text) console.log(result.text);

    // Some models emit native tool calls (finishReason === "tool-calls" & result.toolCalls populated),
    // while others output tool call syntax in plain text. Check both.
    let toolCalls = result.toolCalls;
    if (toolCalls.length === 0 && result.text) {
        toolCalls = parseTextToolCalls(result.text);
    }

    if (toolCalls.length === 0) break;

    messages.push({ role: "assistant", content: result.content });
    console.log(result.content);

    const toolResults: ToolResultPart[] = await Promise.all(
        toolCalls.map(async (call): Promise<ToolResultPart> => {
            const matched = tools.find((t) => t.name === call.toolName);
            if (!matched) {
                return {
                    type: "tool-result",
                    toolCallId: call.toolCallId,
                    toolName: call.toolName,
                    result: `Unknown tool: ${call.toolName}`,
                    isError: true,
                };
            }
            try {
                const value = await matched.execute(call.args, {
                    toolCallId: call.toolCallId,
                    messages,
                });
                return {
                    type: "tool-result",
                    toolCallId: call.toolCallId,
                    toolName: call.toolName,
                    result: value,
                };
            } catch (error) {
                // ToolInputError means the model sent bad args — feed the message back as an error result so it can self-correct.
                // Anything else is a genuine tool failure; report it the same way rather than crashing the loop.
                const message = error instanceof ToolInputError ? error.message : String(error);
                return {
                    type: "tool-result",
                    toolCallId: call.toolCallId,
                    toolName: call.toolName,
                    result: message,
                    isError: true,
                };
            }
        }),
    );

    messages.push({ role: "tool", content: toolResults });
}
