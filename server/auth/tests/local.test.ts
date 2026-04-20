import bcrypt from "bcrypt";
import { beforeAll, describe, expect, it } from "vitest";
import { LocalAuthProvider } from "../local.js";
import { AuthConfigError } from "../types.js";

describe("LocalAuthProvider", () => {
  let hash: string;

  beforeAll(async () => {
    hash = await bcrypt.hash("correct-horse-battery-staple", 4);
  });

  it("accepts a correct username + password", async () => {
    const p = new LocalAuthProvider({
      users: [
        {
          username: "admin",
          passwordHash: hash,
          email: "admin@example.com",
          roles: ["admin"],
        },
      ],
    });
    const principal = await p.verifyCredentials({
      username: "admin",
      password: "correct-horse-battery-staple",
    });
    expect(principal).not.toBeNull();
    expect(principal!.userId).toBe("local:admin");
    expect(principal!.email).toBe("admin@example.com");
    expect(principal!.roles).toEqual(["admin"]);
  });

  it("rejects a wrong password with null", async () => {
    const p = new LocalAuthProvider({
      users: [{ username: "admin", passwordHash: hash }],
    });
    const principal = await p.verifyCredentials({
      username: "admin",
      password: "not-the-password",
    });
    expect(principal).toBeNull();
  });

  it("rejects an unknown user with null", async () => {
    const p = new LocalAuthProvider({
      users: [{ username: "admin", passwordHash: hash }],
    });
    const principal = await p.verifyCredentials({
      username: "nobody",
      password: "anything",
    });
    expect(principal).toBeNull();
  });

  it("defaults email to the username and roles to ['admin']", async () => {
    const p = new LocalAuthProvider({
      users: [{ username: "admin", passwordHash: hash }],
    });
    const principal = await p.verifyCredentials({
      username: "admin",
      password: "correct-horse-battery-staple",
    });
    expect(principal?.email).toBe("admin");
    expect(principal?.roles).toEqual(["admin"]);
  });

  it("throws when constructed with no users", () => {
    expect(() => new LocalAuthProvider({ users: [] })).toThrow(AuthConfigError);
  });
});
