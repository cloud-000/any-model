export function jwt(payload: Record<string, unknown>): string {
    return `header.${base64url(JSON.stringify(payload))}.signature`;
}

function base64url(value: string): string {
    return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
