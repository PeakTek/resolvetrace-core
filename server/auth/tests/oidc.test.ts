import { describe, expect, it, vi } from "vitest";
import {
  OidcAuthProvider,
  OidcClientLike,
  OidcRedirectUriError,
} from "../oidc.js";

function fakeClient(overrides: Partial<OidcClientLike> = {}): OidcClientLike {
  return {
    authorizationUrl: vi.fn(
      (params) =>
        `https://idp.example/authorize?state=${params.state}&cc=${params.code_challenge}`
    ),
    callback: vi.fn(async () => ({
      claims: () => ({
        sub: "user-123",
        email: "user@example.com",
        roles: ["editor"],
      }),
    })),
    ...overrides,
  };
}

describe("OidcAuthProvider", () => {
  it("beginOidcFlow returns a redirect URL with an S256 code challenge", async () => {
    const client = fakeClient();
    const p = new OidcAuthProvider({
      client,
      redirectUrl: "https://rt.example/callback",
    });

    const { redirectUrl, state } = await p.beginOidcFlow();
    expect(state).toMatch(/^[A-Za-z0-9_-]+$/); // base64url
    expect(redirectUrl).toContain("state=");
    expect(redirectUrl).toContain("cc=");
    expect(client.authorizationUrl).toHaveBeenCalledTimes(1);

    const args = (client.authorizationUrl as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as {
      code_challenge_method: string;
      redirect_uri: string;
      scope: string;
    };
    expect(args.code_challenge_method).toBe("S256");
    expect(args.redirect_uri).toBe("https://rt.example/callback");
    expect(args.scope).toContain("openid");
  });

  it("completeOidcFlow exchanges the code and returns a principal", async () => {
    const client = fakeClient();
    const p = new OidcAuthProvider({
      client,
      redirectUrl: "https://rt.example/callback",
    });
    const { state } = await p.beginOidcFlow();

    const principal = await p.completeOidcFlow({
      code: "auth-code",
      state,
    });

    expect(principal.userId).toBe("oidc:user-123");
    expect(principal.email).toBe("user@example.com");
    expect(principal.roles).toEqual(["editor"]);

    // Confirm the code_verifier round-trip happened.
    const callbackCall = (client.callback as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(callbackCall).toBeDefined();
    const [, , checks] = callbackCall as unknown as [
      unknown,
      unknown,
      { state: string; code_verifier: string },
    ];
    expect(checks.state).toBe(state);
    expect(checks.code_verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("completeOidcFlow rejects an unknown state", async () => {
    const p = new OidcAuthProvider({
      client: fakeClient(),
      redirectUrl: "https://rt.example/callback",
    });
    await expect(
      p.completeOidcFlow({ code: "c", state: "bogus" })
    ).rejects.toThrow(/state/i);
  });

  it("verifyCredentials always returns null (OIDC only)", async () => {
    const p = new OidcAuthProvider({
      client: fakeClient(),
      redirectUrl: "https://rt.example/callback",
    });
    const principal = await p.verifyCredentials({
      username: "x",
      password: "y",
    });
    expect(principal).toBeNull();
  });

  it("uses an allowlisted per-request redirect URI for BOTH legs of the flow", async () => {
    const client = fakeClient();
    const p = new OidcAuthProvider({
      client,
      redirectUrl: "https://portal-a.example/callback",
      allowedRedirectUrls: ["https://portal-b.example/callback"],
    });

    const { state } = await p.beginOidcFlow({
      redirectUri: "https://portal-b.example/callback",
    });
    const authorizeArgs = (client.authorizationUrl as ReturnType<typeof vi.fn>)
      .mock.calls[0]![0] as { redirect_uri: string };
    expect(authorizeArgs.redirect_uri).toBe("https://portal-b.example/callback");

    await p.completeOidcFlow({ code: "c", state });
    // Token exchange MUST reuse the flow's redirect URI, not the default.
    const exchangeRedirect = (client.callback as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as string;
    expect(exchangeRedirect).toBe("https://portal-b.example/callback");
  });

  it("rejects a non-allowlisted redirect URI", async () => {
    const p = new OidcAuthProvider({
      client: fakeClient(),
      redirectUrl: "https://portal-a.example/callback",
      allowedRedirectUrls: ["https://portal-b.example/callback"],
    });
    await expect(
      p.beginOidcFlow({ redirectUri: "https://evil.example/callback" })
    ).rejects.toThrow(OidcRedirectUriError);
  });

  it("keeps using the constructor default when no override is given", async () => {
    const client = fakeClient();
    const p = new OidcAuthProvider({
      client,
      redirectUrl: "https://portal-a.example/callback",
      allowedRedirectUrls: ["https://portal-b.example/callback"],
    });
    const { state } = await p.beginOidcFlow();
    await p.completeOidcFlow({ code: "c", state });
    const authorizeArgs = (client.authorizationUrl as ReturnType<typeof vi.fn>)
      .mock.calls[0]![0] as { redirect_uri: string };
    const exchangeRedirect = (client.callback as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as string;
    expect(authorizeArgs.redirect_uri).toBe("https://portal-a.example/callback");
    expect(exchangeRedirect).toBe("https://portal-a.example/callback");
  });

  it("falls back to defaultRoles when the ID token carries none", async () => {
    const client = fakeClient({
      callback: vi.fn(async () => ({
        claims: () => ({ sub: "roleless" }),
      })),
    });
    const p = new OidcAuthProvider({
      client,
      redirectUrl: "https://rt.example/callback",
      defaultRoles: ["viewer"],
    });
    const { state } = await p.beginOidcFlow();
    const principal = await p.completeOidcFlow({ code: "c", state });
    expect(principal.roles).toEqual(["viewer"]);
    expect(principal.email).toBe("roleless");
  });
});
