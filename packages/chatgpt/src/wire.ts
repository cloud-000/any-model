/**
 * Experimental ChatGPT/Codex wire constants and payloads.
 *
 * These endpoints are intentionally isolated: unlike the OpenAI Platform API,
 * they are client implementation details and may change without notice.
 */
export const CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CHATGPT_AUTH_BASE_URL = "https://auth.openai.com";
export const CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

export const AUTHORIZE_URL = `${CHATGPT_AUTH_BASE_URL}/oauth/authorize`;
export const TOKEN_URL = `${CHATGPT_AUTH_BASE_URL}/oauth/token`;
export const DEVICE_USER_CODE_URL = `${CHATGPT_AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
export const DEVICE_TOKEN_URL = `${CHATGPT_AUTH_BASE_URL}/api/accounts/deviceauth/token`;
export const DEVICE_CALLBACK_URL = `${CHATGPT_AUTH_BASE_URL}/deviceauth/callback`;

export interface OAuthTokenResponse {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    id_token?: string;
    error?: string;
    error_description?: string;
    [key: string]: unknown;
}

export interface DeviceUserCodeResponse {
    device_auth_id?: string;
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_url?: string;
    verification_uri_complete?: string;
    interval?: number;
    expires_in?: number;
    error?: string;
    error_description?: string;
    [key: string]: unknown;
}

export interface DeviceTokenResponse extends OAuthTokenResponse {
    authorization_code?: string;
    code?: string;
    code_verifier?: string;
    [key: string]: unknown;
}

export interface ChatGPTResponsesRequest {
    [key: string]: unknown;
    model: string;
    input: unknown[];
    stream: true;
    store: false;
}

export interface ChatGPTResponseEvent {
    type?: string;
    delta?: string;
    item_id?: string;
    output_index?: number;
    call_id?: string;
    name?: string;
    arguments?: string;
    item?: Record<string, unknown>;
    response?: Record<string, unknown>;
    error?: Record<string, unknown>;
    [key: string]: unknown;
}
