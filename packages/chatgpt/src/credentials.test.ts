import { describe, expect, test } from "bun:test";
import { AuthError } from "@any-model/core";
import {
    credentialsFromTokenResponse,
    decodeJWTPayload,
    memoryCredentialStore,
} from "./credentials.ts";
import { jwt } from "./test-utils.ts";

describe("ChatGPT credentials", () => {
    test("extracts nested account id and computes expiration", () => {
        const accessToken = jwt({
            exp: 99,
            "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
        });
        expect(
            credentialsFromTokenResponse(
                { access_token: accessToken, refresh_token: "refresh", expires_in: 120 },
                undefined,
                1_000,
            ),
        ).toEqual({
            accessToken,
            refreshToken: "refresh",
            expiresAt: 121_000,
            accountId: "acct-1",
        });
    });

    test("preserves a previous refresh token and falls back to JWT exp", () => {
        const accessToken = jwt({ chatgpt_account_id: "acct", exp: 42 });
        expect(
            credentialsFromTokenResponse({ access_token: accessToken }, "old-refresh"),
        ).toMatchObject({ refreshToken: "old-refresh", expiresAt: 42_000 });
    });

    test("rejects malformed tokens and missing account claims without exposing tokens", () => {
        for (const accessToken of ["secret", jwt({ exp: 42 })]) {
            try {
                credentialsFromTokenResponse({
                    access_token: accessToken,
                    refresh_token: "very-secret-refresh",
                    expires_in: 10,
                });
                throw new Error("expected rejection");
            } catch (error) {
                expect(error).toBeInstanceOf(AuthError);
                expect(String(error)).not.toContain(accessToken);
                expect(String(error)).not.toContain("very-secret-refresh");
            }
        }
        expect(() => decodeJWTPayload("a.%%%%.c")).toThrow(AuthError);
    });

    test("memory store clones values and clears them", async () => {
        const original = {
            accessToken: "access",
            refreshToken: "refresh",
            expiresAt: 123,
            accountId: "acct",
        };
        const store = memoryCredentialStore(original);
        const loaded = await store.load();
        loaded!.accessToken = "changed";
        expect((await store.load())?.accessToken).toBe("access");
        await store.clear();
        expect(await store.load()).toBeUndefined();
    });
});
