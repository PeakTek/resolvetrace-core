/**
 * JSON Schema for ReplaySignedUrlRequest — mirrors
 * `resolvetrace-contract/schemas/replay.json#/definitions/ReplaySignedUrlRequest`.
 */

const schema = {
  $id: "resolvetrace/replay/ReplaySignedUrlRequest",
  type: "object",
  additionalProperties: false,
  title: "ReplaySignedUrlRequest",
  required: ["sessionId", "sequence", "approxBytes", "contentType"],
  properties: {
    sessionId: {
      type: "string",
      pattern: "^[0-9A-HJKMNP-TV-Z]{26}$",
    },
    sequence: { type: "integer", minimum: 0 },
    approxBytes: { type: "integer", minimum: 1, maximum: 3145728 },
    contentType: {
      type: "string",
      const: "application/vnd.resolvetrace.replay+rrweb",
    },
  },
} as const;

export default schema;
