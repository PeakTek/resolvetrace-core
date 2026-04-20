import { describe, expect, it } from "vitest";
import { EnvSecretsProvider } from "../env.js";
import { SecretDecodeError, SecretNotFoundError } from "../types.js";

describe("EnvSecretsProvider", () => {
  it("get returns the env var value", async () => {
    const p = new EnvSecretsProvider({
      env: { FOO: "bar" } as NodeJS.ProcessEnv,
    });
    await expect(p.get("FOO")).resolves.toBe("bar");
  });

  it("get throws SecretNotFoundError when missing", async () => {
    const p = new EnvSecretsProvider({ env: {} as NodeJS.ProcessEnv });
    await expect(p.get("MISSING")).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  it("get treats empty-string as missing", async () => {
    const p = new EnvSecretsProvider({
      env: { EMPTY: "" } as NodeJS.ProcessEnv,
    });
    await expect(p.get("EMPTY")).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  it("getJson parses JSON values", async () => {
    const p = new EnvSecretsProvider({
      env: { JSON_CONFIG: '{"a":1,"b":"two"}' } as NodeJS.ProcessEnv,
    });
    const v = await p.getJson<{ a: number; b: string }>("JSON_CONFIG");
    expect(v.a).toBe(1);
    expect(v.b).toBe("two");
  });

  it("getJson throws SecretDecodeError on non-JSON", async () => {
    const p = new EnvSecretsProvider({
      env: { JUNK: "not json at all" } as NodeJS.ProcessEnv,
    });
    await expect(p.getJson("JUNK")).rejects.toBeInstanceOf(SecretDecodeError);
  });

  it("getJson propagates SecretNotFoundError on missing", async () => {
    const p = new EnvSecretsProvider({ env: {} as NodeJS.ProcessEnv });
    await expect(p.getJson("NONE")).rejects.toBeInstanceOf(SecretNotFoundError);
  });
});
