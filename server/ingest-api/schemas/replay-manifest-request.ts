/**
 * JSON Schema for ReplayManifestRequest — mirrors
 * `resolvetrace-contract/schemas/replay.json#/definitions/ReplayManifestRequest`.
 */

const schema = {
  $id: "resolvetrace/replay/ReplayManifestRequest",
  type: "object",
  additionalProperties: false,
  title: "ReplayManifestRequest",
  required: [
    "sessionId",
    "sequence",
    "key",
    "bytes",
    "sha256",
    "clientUploadedAt",
    "scrubber",
  ],
  properties: {
    sessionId: {
      type: "string",
      pattern: "^[0-9A-HJKMNP-TV-Z]{26}$",
    },
    sequence: { type: "integer", minimum: 0 },
    key: { type: "string", minLength: 1, maxLength: 512 },
    bytes: { type: "integer", minimum: 1, maximum: 3145728 },
    sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    clientUploadedAt: { type: "string", format: "date-time" },
    scrubber: {
      type: "object",
      additionalProperties: false,
      required: ["version", "rulesDigest", "applied", "budgetExceeded"],
      properties: {
        version: { type: "string", minLength: 1, maxLength: 64 },
        rulesDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
        applied: {
          type: "array",
          maxItems: 64,
          items: { type: "string", minLength: 1, maxLength: 128 },
        },
        budgetExceeded: { type: "boolean" },
        durationMs: { type: "number", minimum: 0 },
      },
    },
  },
} as const;

export default schema;
