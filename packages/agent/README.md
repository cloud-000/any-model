# @any-model/agent

A small, provider-independent model/tool loop for `@any-model/core`.

```bash
bun add @any-model/agent @any-model/core
```

```ts
import { runAgent } from "@any-model/agent";
import { tool } from "@any-model/core";

const weather = tool({
    name: "weather",
    inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
    },
    execute: (args) => ({ city: (args as { city: string }).city, conditions: "sunny" }),
});

const result = await runAgent({
    model,
    messages: [{ role: "user", content: "What is the weather in Paris?" }],
    tools: [weather],
    maxSteps: 8,
});

console.log(result.text);
```

To render output as it is generated, handle normalized stream parts. The callback runs for
every model step, including steps that produce tool calls, and `runAgent()` still resolves to
the complete folded result:

```ts
const result = await runAgent({
    model,
    messages: [{ role: "user", content: "Research this and summarize it." }],
    tools,
    onStreamPart({ stepNumber, part }) {
        if (part.type === "text-delta") process.stdout.write(part.text);
    },
});
```

`runAgent()` owns only one invocation. It does not retain conversation state between calls.
It returns the complete transcript, each model/tool step, accumulated usage, and a normalized
stop reason.

Extensions may provide stateless hooks directly. Stateful extensions should create isolated
hooks for every run:

```ts
const extension = {
    createRun() {
        let toolCalls = 0;
        return {
            beforeToolCall() {
                toolCalls++;
                return toolCalls > 10
                    ? { action: "deny" as const, reason: "Tool-call limit reached" }
                    : { action: "allow" as const };
            },
        };
    },
};
```
