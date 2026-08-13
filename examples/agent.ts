import { runAgent } from "@any-model/agent";
import { tool } from "@any-model/core";
import { z } from "zod";
import { model } from "./test-model";

const getWeather = tool({
    name: "get_time",
    description: "Get the time",
    inputSchema: z.object({
        location: z.string().describe("City name, e.g. San Francisco"),
    }),
    execute: ({ location }) => ({ location, time: Date.now() }),
});

const getLocation = tool({
    name: "get_location",
    description: "Get the user's location",
    inputSchema: z.object(),
    execute: () => {
        return "San Francisco";
    },
});

const result = await runAgent({
    model,
    instructions: "Use tools when needed, then answer concisely.",
    messages: [
        {
            role: "user",
            content: "What is the time?",
        },
    ],
    tools: [getWeather, getLocation],
    maxSteps: 5,
    extensions: [
        {
            prepareStep({ stepNumber }) {
                return { generateOptions: { temperature: 0.2, maxOutputTokens: 10000 } };
            },
        },
    ],
    onStreamPart({ part }) {
        if (part.type === "text-delta") process.stdout.write(part.text);
    },
});

console.log("\nResult");
console.log(result.messages[2]!.content);
console.log(`\nStopped: ${result.stopReason} after ${result.steps.length} step(s)`);
