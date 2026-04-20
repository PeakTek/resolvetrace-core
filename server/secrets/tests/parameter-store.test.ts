import { GetParameterCommand } from "@aws-sdk/client-ssm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ParameterStoreSecretsProvider,
  SsmClientLike,
} from "../parameter-store.js";
import { SecretDecodeError, SecretNotFoundError } from "../types.js";

function fakeClient(values: Record<string, string | null>): SsmClientLike & {
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn(async (cmd: GetParameterCommand) => {
    const name = cmd.input.Name;
    if (!name || !(name in values)) {
      return { Parameter: undefined };
    }
    const value = values[name];
    if (value === null) return { Parameter: undefined };
    return { Parameter: { Value: value } };
  });
  return { send };
}

describe("ParameterStoreSecretsProvider", () => {
  let nowCounter = 0;
  const clock = () => nowCounter;

  beforeEach(() => {
    nowCounter = 1_000_000;
  });

  it("get returns the decrypted value and sets WithDecryption", async () => {
    const client = fakeClient({ "/rt/DB": "secretval" });
    const p = new ParameterStoreSecretsProvider({
      client,
      prefix: "/rt/",
      now: clock,
    });
    await expect(p.get("DB")).resolves.toBe("secretval");
    const cmd = client.send.mock.calls[0]![0] as GetParameterCommand;
    expect(cmd.input.WithDecryption).toBe(true);
    expect(cmd.input.Name).toBe("/rt/DB");
  });

  it("caches within the TTL and refetches after expiry", async () => {
    const client = fakeClient({ "A": "v1" });
    const p = new ParameterStoreSecretsProvider({
      client,
      cacheTtlMs: 1000,
      now: clock,
    });

    await p.get("A"); // miss
    await p.get("A"); // hit
    expect(client.send).toHaveBeenCalledTimes(1);

    nowCounter += 1001; // past TTL
    await p.get("A"); // miss again
    expect(client.send).toHaveBeenCalledTimes(2);
  });

  it("separate names each get their own cache entry", async () => {
    const client = fakeClient({ A: "va", B: "vb" });
    const p = new ParameterStoreSecretsProvider({
      client,
      now: clock,
    });
    await p.get("A");
    await p.get("B");
    await p.get("A"); // cached
    expect(client.send).toHaveBeenCalledTimes(2);
  });

  it("throws SecretNotFoundError when parameter is absent", async () => {
    const client = fakeClient({});
    const p = new ParameterStoreSecretsProvider({ client, now: clock });
    await expect(p.get("NONE")).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  it("getJson parses JSON values", async () => {
    const client = fakeClient({ CONF: '{"x":42}' });
    const p = new ParameterStoreSecretsProvider({ client, now: clock });
    const v = await p.getJson<{ x: number }>("CONF");
    expect(v.x).toBe(42);
  });

  it("getJson throws SecretDecodeError on non-JSON", async () => {
    const client = fakeClient({ BAD: "not-json" });
    const p = new ParameterStoreSecretsProvider({ client, now: clock });
    await expect(p.getJson("BAD")).rejects.toBeInstanceOf(SecretDecodeError);
  });

  it("invalidateAll clears the cache", async () => {
    const client = fakeClient({ A: "v1" });
    const p = new ParameterStoreSecretsProvider({
      client,
      cacheTtlMs: 60_000,
      now: clock,
    });
    await p.get("A");
    await p.get("A");
    expect(client.send).toHaveBeenCalledTimes(1);
    p.invalidateAll();
    await p.get("A");
    expect(client.send).toHaveBeenCalledTimes(2);
  });
});
