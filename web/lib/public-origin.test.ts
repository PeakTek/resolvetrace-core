import { afterEach, describe, expect, it } from "vitest";
import { publicOrigin } from "./public-origin";

// The reverse-proxy shape this guards: the standalone server sees its internal
// listen address in request.url, while the proxy carries the public host in
// X-Forwarded-* headers.
const INTERNAL = "http://0.0.0.0:3000/api/auth/callback?code=x&state=y";

function req(headers: Record<string, string> = {}, url = INTERNAL): Request {
  return new Request(url, { headers });
}

const ORIGINAL_ENV = process.env.PORTAL_PUBLIC_URL;
afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.PORTAL_PUBLIC_URL;
  else process.env.PORTAL_PUBLIC_URL = ORIGINAL_ENV;
});

describe("publicOrigin", () => {
  it("PORTAL_PUBLIC_URL wins over everything (trailing slash trimmed)", () => {
    process.env.PORTAL_PUBLIC_URL = "https://portal.example.com/";
    expect(
      publicOrigin(req({ "x-forwarded-host": "other.example.com" }))
    ).toBe("https://portal.example.com");
  });

  it("uses X-Forwarded-Host + X-Forwarded-Proto behind a proxy", () => {
    delete process.env.PORTAL_PUBLIC_URL;
    expect(
      publicOrigin(
        req({
          "x-forwarded-host": "portal.example.com",
          "x-forwarded-proto": "https",
          host: "0.0.0.0:3000",
        })
      )
    ).toBe("https://portal.example.com");
  });

  it("defaults the forwarded proto to https", () => {
    delete process.env.PORTAL_PUBLIC_URL;
    expect(publicOrigin(req({ "x-forwarded-host": "portal.example.com" }))).toBe(
      "https://portal.example.com"
    );
  });

  it("takes the first value of comma-separated forwarded headers", () => {
    delete process.env.PORTAL_PUBLIC_URL;
    expect(
      publicOrigin(
        req({
          "x-forwarded-host": "portal.example.com, inner.proxy",
          "x-forwarded-proto": "https, http",
        })
      )
    ).toBe("https://portal.example.com");
  });

  it("falls back to the Host header with the request's own protocol (direct access)", () => {
    delete process.env.PORTAL_PUBLIC_URL;
    expect(
      publicOrigin(req({ host: "localhost:3000" }, "http://localhost:3000/login"))
    ).toBe("http://localhost:3000");
  });

  it("falls back to the request URL origin when no headers are present", () => {
    delete process.env.PORTAL_PUBLIC_URL;
    expect(publicOrigin(new Request(INTERNAL))).toBe("http://0.0.0.0:3000");
  });
});
