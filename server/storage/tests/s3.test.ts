import type { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { PresignerFn, S3Storage } from "../s3.js";
import { ObjectNotFoundError, StorageConfigError } from "../types.js";

/**
 * Lightweight fake of the parts of `S3Client` our code touches. `send()` is
 * the only method actually invoked for head/delete; presign uses the
 * injected presigner so the client itself is treated as opaque.
 */
function makeFakeClient(sendImpl?: (cmd: unknown) => Promise<unknown>) {
  const send = vi.fn(async (cmd: unknown) => {
    if (sendImpl) return sendImpl(cmd);
    return {};
  });
  return { send } as unknown as S3Client & {
    send: ReturnType<typeof vi.fn>;
  };
}

function makeFakePresigner(): PresignerFn & ReturnType<typeof vi.fn> {
  return vi.fn(async (_client: S3Client, command: PutObjectCommand) => {
    const { Bucket, Key } = command.input;
    return `https://s3.example/${Bucket}/${Key}?X-Amz-Expires=300`;
  }) as unknown as PresignerFn & ReturnType<typeof vi.fn>;
}

describe("S3Storage", () => {
  it("throws when region or bucket is missing", () => {
    expect(
      () =>
        new S3Storage({
          region: "",
          bucket: "b",
          client: makeFakeClient(),
        })
    ).toThrow(StorageConfigError);
    expect(
      () =>
        new S3Storage({
          region: "us-east-1",
          bucket: "",
          client: makeFakeClient(),
        })
    ).toThrow(StorageConfigError);
  });

  it("prefixes keys with the configured keyPrefix on delete", async () => {
    const client = makeFakeClient();
    const s = new S3Storage({
      region: "us-east-1",
      bucket: "rt",
      keyPrefix: "replay",
      client,
    });
    await s.deleteObject("abc/def");
    const cmd = client.send.mock.calls[0]![0] as {
      input: { Bucket: string; Key: string };
    };
    expect(cmd.input.Bucket).toBe("rt");
    expect(cmd.input.Key).toBe("replay/abc/def");
  });

  it("createSignedUploadUrl forwards Bucket, Key, ContentType, ContentLength, and expiry", async () => {
    const presigner = makeFakePresigner();
    const s = new S3Storage({
      region: "us-east-1",
      bucket: "rt",
      keyPrefix: "replay/",
      client: makeFakeClient(),
      presigner,
    });
    const result = await s.createSignedUploadUrl({
      key: "sessions/sess-1/chunk-0",
      contentType: "application/octet-stream",
      maxBytes: 2_000_000,
      expiresInSeconds: 300,
    });

    // The presigner received the right PutObjectCommand shape and expiresIn.
    expect(presigner).toHaveBeenCalledTimes(1);
    const [, command, opts] = (
      presigner as unknown as ReturnType<typeof vi.fn>
    ).mock.calls[0] as [S3Client, PutObjectCommand, { expiresIn: number }];
    expect(command.input.Bucket).toBe("rt");
    expect(command.input.Key).toBe("replay/sessions/sess-1/chunk-0");
    expect(command.input.ContentType).toBe("application/octet-stream");
    expect(command.input.ContentLength).toBe(2_000_000);
    expect(opts.expiresIn).toBe(300);

    // The signed URL + required replay headers are plumbed through.
    expect(result.url).toMatch(/^https?:\/\//);
    expect(result.url).toContain("replay/sessions/sess-1/chunk-0");
    expect(result.headers["Content-Type"]).toBe("application/octet-stream");
    expect(result.headers["Content-Length"]).toBe("2000000");
  });

  it("createSignedUploadUrl rejects non-positive maxBytes or expiry", async () => {
    const s = new S3Storage({
      region: "us-east-1",
      bucket: "rt",
      client: makeFakeClient(),
      presigner: makeFakePresigner(),
    });
    await expect(
      s.createSignedUploadUrl({
        key: "k",
        contentType: "application/octet-stream",
        maxBytes: 0,
        expiresInSeconds: 60,
      })
    ).rejects.toBeInstanceOf(StorageConfigError);
    await expect(
      s.createSignedUploadUrl({
        key: "k",
        contentType: "application/octet-stream",
        maxBytes: 1,
        expiresInSeconds: 0,
      })
    ).rejects.toBeInstanceOf(StorageConfigError);
  });

  it("headObject returns size and optional sha256", async () => {
    const client = makeFakeClient(async () => ({
      ContentLength: 1234,
      ChecksumSHA256: "abcdef",
    }));
    const s = new S3Storage({
      region: "us-east-1",
      bucket: "rt",
      client,
    });
    const meta = await s.headObject("foo");
    expect(meta.size).toBe(1234);
    expect(meta.sha256).toBe("abcdef");
  });

  it("headObject returns sha256=null when the backend reports none", async () => {
    const client = makeFakeClient(async () => ({
      ContentLength: 42,
    }));
    const s = new S3Storage({
      region: "us-east-1",
      bucket: "rt",
      client,
    });
    const meta = await s.headObject("foo");
    expect(meta.size).toBe(42);
    expect(meta.sha256).toBeNull();
  });

  it("headObject maps 404 to ObjectNotFoundError", async () => {
    const client = makeFakeClient(async () => {
      const err = Object.assign(new Error("nope"), {
        name: "NotFound",
        $metadata: { httpStatusCode: 404 },
      });
      throw err;
    });
    const s = new S3Storage({
      region: "us-east-1",
      bucket: "rt",
      client,
    });
    await expect(s.headObject("missing")).rejects.toBeInstanceOf(
      ObjectNotFoundError
    );
  });

  it("rejects an empty key", async () => {
    const s = new S3Storage({
      region: "us-east-1",
      bucket: "rt",
      client: makeFakeClient(),
    });
    await expect(s.deleteObject("")).rejects.toBeInstanceOf(StorageConfigError);
  });
});
