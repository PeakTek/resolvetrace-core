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
    // Optional 0-based clip index (multi-clip replay). Absent / 0 ⇒ the first
    // (only) clip. A clipIndex > 0 is accepted at the schema level but may be
    // authorization-rejected by the replay route unless multi-clip is granted.
    clipIndex: { type: "integer", minimum: 0 },
  },
} as const;

export default schema;
