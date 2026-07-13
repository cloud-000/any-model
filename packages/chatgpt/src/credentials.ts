import { AuthError } from "@any-model/core";
import type { OAuthTokenResponse } from "./wire.ts";

export interface ChatGPTCredentials {
    accessToken: string;
    refreshToken: string;
    /** Absolute Unix time in milliseconds. */
    expiresAt: number;
    accountId: string;
}

export interface ChatGPTCredentialStore {
    load(): Promise<ChatGPTCredentials | undefined>;
    save(credentials: ChatGPTCredentials): Promise<void>;
    clear(): Promise<void>;
}

export function memoryCredentialStore(
    initial?: ChatGPTCredentials,
): ChatGPTCredentialStore {
    let current = initial === undefined ? undefined : { ...initial };
    return {
        async load() {
            return current === undefined ? undefined : { ...current };
        },
        async save(credentials) {
            current = { ...credentials };
        },
        async clear() {
            current = undefined;
        },
    };
}

export function credentialsFromTokenResponse(
    response: OAuthTokenResponse,
    previousRefreshToken?: string,
    now = Date.now(),
): ChatGPTCredentials {
    if (typeof response.access_token !== "string" || response.access_token === "") {
        throw new AuthError("ChatGPT token response did not include an access token.", {
            provider: "chatgpt",
        });
    }
    const payload = decodeJWTPayload(response.access_token);
    const accountId = findAccountId(payload);
    if (!accountId) {
        throw new AuthError("ChatGPT access token did not include a chatgpt_account_id claim.", {
            provider: "chatgpt",
        });
    }
    const refreshToken = response.refresh_token ?? previousRefreshToken;
    if (!refreshToken) {
        throw new AuthError("ChatGPT token response did not include a refresh token.", {
            provider: "chatgpt",
        });
    }
    const expiresAt = tokenExpiry(response, payload, now);
    return {
        accessToken: response.access_token,
        refreshToken,
        expiresAt,
        accountId,
    };
}

export function decodeJWTPayload(token: string): Record<string, unknown> {
    const parts = token.split(".");
    const encoded = parts[1];
    if (!encoded) {
        throw new AuthError("ChatGPT access token was not a valid JWT.", {
            provider: "chatgpt",
        });
    }
    try {
        const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
        const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
        const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
        const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (!isRecord(value)) throw new Error("JWT payload was not an object");
        return value;
    } catch (cause) {
        throw new AuthError("ChatGPT access token contained an invalid JWT payload.", {
            provider: "chatgpt",
            cause,
        });
    }
}

function findAccountId(payload: Record<string, unknown>): string | undefined {
    if (typeof payload.chatgpt_account_id === "string") return payload.chatgpt_account_id;
    const auth = payload["https://api.openai.com/auth"];
    if (isRecord(auth) && typeof auth.chatgpt_account_id === "string") {
        return auth.chatgpt_account_id;
    }
    return undefined;
}

function tokenExpiry(
    response: OAuthTokenResponse,
    payload: Record<string, unknown>,
    now: number,
): number {
    if (typeof response.expires_in === "number" && Number.isFinite(response.expires_in)) {
        return now + Math.max(0, response.expires_in) * 1_000;
    }
    if (typeof payload.exp === "number" && Number.isFinite(payload.exp)) {
        return payload.exp * 1_000;
    }
    throw new AuthError("ChatGPT token response did not include an expiration.", {
        provider: "chatgpt",
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
