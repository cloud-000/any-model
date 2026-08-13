import type {
    GenerateRequest,
    GenerateResult,
    LanguageModel,
    Message,
    ToolCallPart,
    ToolDefinition,
    ToolResultPart,
    StreamPart,
    Usage,
} from "@any-model/core";

/** Model request fields that an agent may apply to every step. */
export type AgentGenerateOptions = Omit<GenerateRequest, "messages" | "tools" | "abortSignal">;

export type ToolExecutionMode = "parallel" | "sequential";
export type AgentStopReason = "completed" | "max-steps" | "custom" | "aborted";

export interface AgentRunInput<AppContext = unknown> {
    model: LanguageModel;
    messages: readonly Message[];
    /** Prepended as a system message without mutating `messages`. */
    instructions?: string;
    tools?: readonly ToolDefinition[];
    /** Application-owned request context passed to tools and hooks. */
    context?: AppContext;
    abortSignal?: AbortSignal;
    /** Maximum model invocations in this run. Defaults to 8. */
    maxSteps?: number;
    /** Multiple calls from one response run in parallel by default. */
    toolExecution?: ToolExecutionMode;
    generateOptions?: AgentGenerateOptions;
    /** Receives normalized model stream parts as each step generates them. */
    onStreamPart?: (part: AgentStreamPart) => void | Promise<void>;
    extensions?: readonly AgentExtension<AppContext>[];
    /** Controls the error value shown to the model; stack traces are omitted by default. */
    formatToolError?: (error: unknown, context: AgentToolCallContext<AppContext>) => unknown;
}

/** A normalized provider stream part annotated with its agent step. */
export interface AgentStreamPart {
    readonly stepNumber: number;
    readonly model: LanguageModel;
    readonly part: StreamPart;
}

export interface AgentStep {
    /** One-based model invocation number. */
    stepNumber: number;
    model: LanguageModel;
    /** Transcript snapshot supplied to this model invocation. */
    inputMessages: readonly Message[];
    response: GenerateResult;
    toolResults: readonly ToolResultPart[];
}

export interface AgentRunResult {
    /** Text from the final model response (or the latest response when stopped early). */
    text: string;
    /** Complete transcript, including the final assistant response. */
    messages: readonly Message[];
    steps: readonly AgentStep[];
    usage: Usage;
    stopReason: AgentStopReason;
}

export interface AgentRunStartContext<AppContext = unknown> {
    readonly model: LanguageModel;
    readonly messages: readonly Message[];
    readonly context: AppContext | undefined;
    readonly abortSignal: AbortSignal | undefined;
}

export interface AgentHookContext<AppContext = unknown> extends AgentRunStartContext<AppContext> {
    readonly stepNumber: number;
    readonly steps: readonly AgentStep[];
}

export interface AgentToolCallContext<AppContext = unknown> extends AgentHookContext<AppContext> {
    readonly toolCall: ToolCallPart;
}

export interface AgentToolResultContext<
    AppContext = unknown,
> extends AgentToolCallContext<AppContext> {
    readonly toolResult: ToolResultPart;
}

export interface AgentStepPreparation {
    model?: LanguageModel;
    generateOptions?: Partial<AgentGenerateOptions>;
}

export type AgentToolDecision = { action: "allow" } | { action: "deny"; reason?: unknown };

export type AgentEvent =
    | { type: "step-start"; stepNumber: number; model: LanguageModel }
    | { type: "model-finish"; stepNumber: number; response: GenerateResult }
    | { type: "tool-start"; stepNumber: number; toolCall: ToolCallPart }
    | { type: "tool-finish"; stepNumber: number; toolResult: ToolResultPart }
    | { type: "step-finish"; step: AgentStep }
    | { type: "finish"; result: AgentRunResult };

/** Hooks scoped to one invocation. Return these from `createRun` when they hold state. */
export interface AgentRunHooks<AppContext = unknown> {
    prepareStep?(
        context: AgentHookContext<AppContext>,
    ): AgentStepPreparation | void | Promise<AgentStepPreparation | void>;
    beforeToolCall?(
        context: AgentToolCallContext<AppContext>,
    ): AgentToolDecision | void | Promise<AgentToolDecision | void>;
    afterToolCall?(context: AgentToolResultContext<AppContext>): void | Promise<void>;
    stopWhen?(context: AgentHookContext<AppContext>): boolean | Promise<boolean>;
    onEvent?(event: AgentEvent): void | Promise<void>;
}

export interface AgentExtensionFactory<AppContext = unknown> {
    createRun(
        context: AgentRunStartContext<AppContext>,
    ): AgentRunHooks<AppContext> | Promise<AgentRunHooks<AppContext>>;
}

/** Stateless hooks may be supplied directly; stateful extensions should use `createRun`. */
export type AgentExtension<AppContext = unknown> =
    | AgentRunHooks<AppContext>
    | AgentExtensionFactory<AppContext>;
