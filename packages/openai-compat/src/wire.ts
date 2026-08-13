export interface OpenAIChatCompletionRequest {
    [key: string]: unknown;
    model: string;
    messages: unknown[];
    stream: true;
}

export interface OpenAIToolCallDelta {
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
}

export interface OpenAIChatCompletionChunk {
    error?: {
        code?: number | string;
        message?: string;
        metadata?: {
            error_type?: string;
            provider_code?: string;
            [key: string]: unknown;
        };
        [key: string]: unknown;
    };
    choices?: Array<{
        delta?: {
            content?: string | null;
            reasoning_content?: string | null;
            reasoning?: string | null;
            tool_calls?: OpenAIToolCallDelta[];
        };
        finish_reason?: string | null;
    }>;
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        completion_tokens_details?: { reasoning_tokens?: number };
        prompt_tokens_details?: { cached_tokens?: number };
    } | null;
}
