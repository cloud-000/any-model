import {
    createRegistry,
    tool,
    ToolInputError,
    toWireTools,
    type Message,
    type SchemaAdapter,
    type ToolResultPart,
} from "@any-model/core";
import { model } from "./test-model";

// A SchemaAdapter is the one seam that gives `tool()` both a JSON Schema (for
// the wire) and a typed, runtime-validated `parse()` (for `execute`) from a
// single definition — no `<Args>` generic to keep in sync by hand. A real app
// would generate this from Zod or another schema library instead of
// hand-writing `parse`; see `fromZod()` in the tool-calling spec.
const cityArgs: SchemaAdapter<{ city: string }> = {
    jsonSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
        additionalProperties: false,
    },
    parse: (input) => {
        const city = (input as { city?: unknown } | null)?.city;
        if (typeof city !== "string") throw new Error("city must be a string");
        return { city };
    },
};

// A tool with real executable logic (`execute` closes over whatever the app
// needs — here, nothing more than a stand-in for a weather API call). Only
// `toWireTools()`'s output — name/description/inputSchema — ever reaches the
// provider; `execute` cannot leak across that boundary even by accident.
const getWeather = tool({
    name: "get_weather",
    description: "Get the current weather for a city.",
    inputSchema: cityArgs,
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
    if (result.finishReason !== "tool-calls") break;

    messages.push({ role: "assistant", content: result.content });
    console.log(result.content);

    const toolResults: ToolResultPart[] = await Promise.all(
        result.toolCalls.map(async (call): Promise<ToolResultPart> => {
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
