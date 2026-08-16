# The agent loop (`@any-model/agent`)

A small extensible model/tool loop. Deliberately outside core — core stays the provider
contract. Source: `packages/agent/src/`.

## Input

```ts
interface AgentRunInput<AppContext = unknown> {
    model: LanguageModel;
    messages: readonly Message[];
    instructions?: string;              // prepended as a system message, `messages` untouched
    tools?: readonly ToolDefinition[];  // pass tool() results directly — no toWireTools()
    context?: AppContext;               // reaches tools (ctx.context) and every hook
    abortSignal?: AbortSignal;
    maxSteps?: number;                  // default 8; must be a positive integer
    toolExecution?: "parallel" | "sequential";  // default parallel
    generateOptions?: AgentGenerateOptions;     // GenerateRequest minus messages/tools/abortSignal
    onStreamPart?: (part: AgentStreamPart) => void | Promise<void>;
    extensions?: readonly AgentExtension<AppContext>[];
    formatToolError?: (error: unknown, ctx: AgentToolCallContext<AppContext>) => unknown;
}
```

`AgentStreamPart` is `{ stepNumber, model, part }` — the normalized `StreamPart` annotated
with which step produced it. Each step streams to this callback while being folded into its
`GenerateResult`, so you get live tokens and a final result from one model call.

## Result

```ts
interface AgentRunResult {
    text: string;                      // final (or latest, if stopped early) response text
    messages: readonly Message[];      // full transcript incl. instructions + final response
    steps: readonly AgentStep[];
    usage: Usage;                      // summed across steps, field by field
    stopReason: "completed" | "max-steps" | "custom" | "aborted";
}

interface AgentStep {
    stepNumber: number;                 // one-based
    model: LanguageModel;               // the model actually used (prepareStep may swap it)
    inputMessages: readonly Message[];  // transcript snapshot fed to this invocation
    response: GenerateResult;
    toolResults: readonly ToolResultPart[];
}
```

Loop order per step: abort check → `prepareStep` → `step-start` → generate → append assistant
message → `model-finish` → execute tool calls → append tool message → `step-finish` →
`shouldStop` → stop if no tool calls. `finish` is emitted once at the end, even on abort.

`stopReason: "completed"` means the model returned no tool calls. An abort mid-flight is
swallowed and reported as `"aborted"`; any other thrown error propagates.

Only **native normalized tool calls** are executed. Models that emit tool syntax as plain text
are a caller concern (see `examples/parse-text-tool-calls.ts` for one approach).

## Extensions

An extension is either a bag of stateless hooks, or a factory with `createRun` that returns
fresh hooks per invocation.

```ts
interface AgentRunHooks<AppContext> {
    prepareStep?(ctx: AgentHookContext<AppContext>):
        AgentStepPreparation | void | Promise<AgentStepPreparation | void>;   // { model?, generateOptions? }
    beforeToolCall?(ctx: AgentToolCallContext<AppContext>):
        AgentToolDecision | void | Promise<AgentToolDecision | void>;         // { action: "allow" } | { action: "deny", reason? }
    afterToolCall?(ctx: AgentToolResultContext<AppContext>): void | Promise<void>;
    stopWhen?(ctx: AgentHookContext<AppContext>): boolean | Promise<boolean>;
    onEvent?(event: AgentEvent): void | Promise<void>;
}

interface AgentExtensionFactory<AppContext> {
    createRun(ctx: AgentRunStartContext<AppContext>): AgentRunHooks<AppContext> | Promise<…>;
}
```

Hook contexts carry `model`, `messages`, `context`, `abortSignal`, `stepNumber`, `steps`, plus
`toolCall` (before) and `toolResult` (after). `AgentEvent` is
`step-start | model-finish | tool-start | tool-finish | step-finish | finish`.

**Stateless hooks may be shared across runs. Anything with per-run state must use
`createRun`** — otherwise concurrent runs share the counter.

```ts
// stateless: policy + logging
const auditAndPolicy: AgentExtension<RequestContext> = {
    prepareStep: () => ({ generateOptions: { temperature: 0.2, maxOutputTokens: 10_000 } }),
    beforeToolCall({ toolCall, context }) {
        if (toolCall.toolName === "get_weather" && !context?.allowWeather) {
            return { action: "deny", reason: "Weather access is disabled for this request." };
        }
        return { action: "allow" };
    },
    onEvent(event) {
        if (event.type === "finish") console.log(event.result.stopReason, event.result.usage);
    },
};

// stateful: one counter per invocation
function toolCallLimit(maxCalls: number): AgentExtension {
    return {
        createRun() {
            let calls = 0;
            return {
                beforeToolCall() {
                    if (++calls > maxCalls) {
                        return { action: "deny", reason: `Tool-call limit of ${maxCalls} reached.` };
                    }
                },
            };
        },
    };
}

await runAgent({ model, messages, tools, extensions: [auditAndPolicy, toolCallLimit(2)] });
```

A `deny` decision is fed back to the model as a tool result with `isError: true` — the run
continues, the model sees the reason. `prepareStep` returning a `model` swaps the model for
that step only, which is how fallback/escalation is expressed today (no retry middleware yet).

## Errors inside the loop

Tool failures never crash the run: they are converted to `ToolResultPart { isError: true }`.
The default error value is `error.message` (or `String(error)`), so stack traces never reach
the model; `formatToolError` overrides it. `ToolInputError` (bad model args), an unknown tool
name, and a denied call all arrive the same way, so the model can correct itself on the next
step. The one exception is abort: if `abortSignal` fired, the error rethrows and the run ends
as `"aborted"`.

`runAgent` throws `Error("Duplicate tool name: …")` up front if two tools share a name, and
`RangeError` if `maxSteps` isn't a positive integer.

## Hand-rolled alternative

`runAgent` is one loop, not the only one — the contract is designed so callers can write their
own (`examples/tools.ts` shows a minimal version: `toWireTools`, `generate`, match tool by
name, execute, push `{ role: "tool", content: toolResults }`, repeat).
