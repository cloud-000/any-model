import { describe, expect, test } from "bun:test";
import { ChatGPTAuthManager } from "./auth-manager.ts";
import { memoryCredentialStore } from "./credentials.ts";
import { TOKEN_URL } from "./wire.ts";
import { jwt } from "./test-utils.ts";

describe("ChatGPT auth manager", () => {
    test("deduplicates refresh and persists rotated credentials", async () => {
        let calls = 0;
        const store = memoryCredentialStore({
            accessToken: jwt({ chatgpt_account_id: "acct", exp: 1 }),
            refreshToken: "old-refresh",
            expiresAt: 1,
            accountId: "acct",
        });
        const manager = new ChatGPTAuthManager(
            store,
            async (url, init) => {
                calls++;
                expect(String(url)).toBe(TOKEN_URL);
                expect(String(init?.body)).toContain("grant_type=refresh_token");
                await Promise.resolve();
                return Response.json({
                    access_token: jwt({ chatgpt_account_id: "acct", exp: 999 }),
                    refresh_token: "rotated",
                    expires_in: 600,
                });
            },
            () => 100_000,
        );

        const [first, second, third] = await Promise.all([
            manager.getCredentials(),
            manager.getCredentials(),
            manager.getCredentials(),
        ]);
        expect(calls).toBe(1);
        expect(first.refreshToken).toBe("rotated");
        expect(second.accessToken).toBe(first.accessToken);
        expect(third.accessToken).toBe(first.accessToken);
        expect((await store.load())?.refreshToken).toBe("rotated");
    });

    test("does not refresh again when another request already replaced a stale token", async () => {
        let calls = 0;
        const oldToken = jwt({ chatgpt_account_id: "acct", exp: 999 });
        const store = memoryCredentialStore({
            accessToken: oldToken,
            refreshToken: "refresh",
            expiresAt: 999_000,
            accountId: "acct",
        });
        const manager = new ChatGPTAuthManager(store, async () => {
            calls++;
            return Response.json({
                access_token: jwt({ chatgpt_account_id: "acct", exp: 2_000 }),
                expires_in: 1_000,
            });
        }, () => 0);

        const [a, b] = await Promise.all([
            manager.refreshAfterUnauthorized(oldToken),
            manager.refreshAfterUnauthorized(oldToken),
        ]);
        expect(calls).toBe(1);
        expect(a.accessToken).toBe(b.accessToken);
    });
});
