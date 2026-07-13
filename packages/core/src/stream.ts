/**
 * The single streaming event type every provider normalizes to, plus the
 * fold that derives a {@link GenerateResult} from a stream. Providers implement
 * streaming once; `generate()` is this fold (see `provider.ts`).
 */
import type {
    AssistantContentPart,
    FinishReason,
    GenerateResult,
    ToolCallPart,
    Usage,
    Warning,
    ProviderMetadata,
} from "./types.ts";

export type StreamPart =
    | { type: "text-delta"; text: string; providerMetadata?: ProviderMetadata }
    | { type: "reasoning-delta"; text: string; providerMetadata?: ProviderMetadata }
    | {
          type: "tool-call-start";
          toolCallId: string;
          toolName: string;
          providerMetadata?: ProviderMetadata;
      }
    /** A chunk of the tool arguments as raw JSON text. */
    | { type: "tool-call-delta"; toolCallId: string; argsDelta: string }
    /** End of a tool call. `args` is the parsed arguments, if the provider has them. */
    | {
          type: "tool-call-end";
          toolCallId: string;
          args?: unknown;
          providerMetadata?: ProviderMetadata;
      }
    | {
          type: "finish";
          finishReason: FinishReason;
          usage: Usage;
          providerMetadata?: ProviderMetadata;
      }
    | { type: "error"; error: unknown }
    /** Provider-native passthrough for anything not modeled above. */
    | { type: "raw"; value: unknown };

interface PendingToolCall {
    toolName: string;
    argsText: string;
    args?: unknown;
    hasArgs: boolean;
    providerMetadata?: ProviderMetadata;
}

/**
 * Consume a stream and accumulate it into a final {@link GenerateResult}.
 * Text and reasoning deltas are concatenated in order; tool-call events are
 * merged by id, with streamed `argsDelta` JSON parsed at the end unless the
 * provider supplied parsed `args` on `tool-call-end`.
 */
export async function foldStream(stream: AsyncIterable<StreamPart>): Promise<GenerateResult> {
    const content: AssistantContentPart[] = [];
    const warnings: Warning[] = [];
    let text = "";
    let finishReason: FinishReason = "other";
    let usage: Usage = {};
    let providerMetadata: ProviderMetadata | undefined;
    let raw: unknown;

    // Preserve first-seen order of tool calls.
    const toolOrder: string[] = [];
    const tools = new Map<string, PendingToolCall>();
    // Track the current open text/reasoning part so consecutive deltas merge.
    let openText: { type: "text"; text: string; providerMetadata?: ProviderMetadata } | undefined;
    let openReasoning:
        | { type: "reasoning"; text: string; providerMetadata?: ProviderMetadata }
        | undefined;

    const flushText = () => {
        openText = undefined;
        openReasoning = undefined;
    };

    for await (const part of stream) {
        switch (part.type) {
            case "text-delta": {
                text += part.text;
                openReasoning = undefined;
                if (openText && sameMetadata(openText.providerMetadata, part.providerMetadata)) {
                    openText.text += part.text;
                } else {
                    openText = {
                        type: "text",
                        text: part.text,
                        ...metadataField(part.providerMetadata),
                    };
                    content.push(openText);
                }
                break;
            }
            case "reasoning-delta": {
                openText = undefined;
                if (
                    openReasoning &&
                    sameMetadata(openReasoning.providerMetadata, part.providerMetadata)
                ) {
                    openReasoning.text += part.text;
                } else {
                    openReasoning = {
                        type: "reasoning",
                        text: part.text,
                        ...metadataField(part.providerMetadata),
                    };
                    content.push(openReasoning);
                }
                break;
            }
            case "tool-call-start": {
                flushText();
                if (!tools.has(part.toolCallId)) {
                    toolOrder.push(part.toolCallId);
                    tools.set(part.toolCallId, {
                        toolName: part.toolName,
                        argsText: "",
                        hasArgs: false,
                        providerMetadata: part.providerMetadata,
                    });
                }
                break;
            }
            case "tool-call-delta": {
                const call = tools.get(part.toolCallId);
                if (call) call.argsText += part.argsDelta;
                break;
            }
            case "tool-call-end": {
                const call = tools.get(part.toolCallId);
                if (call && part.args !== undefined) {
                    call.args = part.args;
                    call.hasArgs = true;
                }
                if (call && part.providerMetadata !== undefined)
                    call.providerMetadata = part.providerMetadata;
                break;
            }
            case "finish": {
                finishReason = part.finishReason;
                usage = part.usage;
                providerMetadata = part.providerMetadata;
                break;
            }
            case "error": {
                throw part.error;
            }
            case "raw":
                raw = part.value;
                break;
        }
    }

    // Finalize tool calls and append them after text/reasoning content.
    const toolCalls: ToolCallPart[] = [];
    for (const id of toolOrder) {
        const call = tools.get(id)!;
        const args = call.hasArgs ? call.args : safeParseJson(call.argsText);
        const toolCall: ToolCallPart = {
            type: "tool-call",
            toolCallId: id,
            toolName: call.toolName,
            args,
            ...metadataField(call.providerMetadata),
        };
        toolCalls.push(toolCall);
        content.push(toolCall);
    }

    return {
        content,
        text,
        toolCalls,
        finishReason,
        usage,
        warnings,
        ...metadataField(providerMetadata),
        ...(raw === undefined ? {} : { raw }),
    };
}

function metadataField(metadata: ProviderMetadata | undefined): {
    providerMetadata?: ProviderMetadata;
} {
    return metadata === undefined ? {} : { providerMetadata: metadata };
}

function sameMetadata(a: ProviderMetadata | undefined, b: ProviderMetadata | undefined): boolean {
    if (a === b) return true;
    if (a === undefined || b === undefined) return false;
    return JSON.stringify(a) === JSON.stringify(b);
}

function safeParseJson(text: string): unknown {
    if (text.trim() === "") return {};
    try {
        return JSON.parse(text);
    } catch {
        // Leave raw text for the caller to inspect rather than throwing mid-fold.
        return { __unparsed: text };
    }
}
