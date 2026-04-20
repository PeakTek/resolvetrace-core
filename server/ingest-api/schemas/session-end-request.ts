/**
 * JSON Schema for SessionEndRequest — mirrors
 * `resolvetrace-contract/schemas/session.json#/definitions/SessionEndRequest`.
 */

const schema = {
  $id: "resolvetrace/session/SessionEndRequest",
  type: "object",
  additionalProperties: false,
  title: "SessionEndRequest",
  required: ["sessionId", "endedAt", "reason"],
  properties: {
    sessionId: {
      type: "string",
      pattern: "^[0-9A-HJKMNP-TV-Z]{26}$",
    },
    endedAt: { type: "string", format: "date-time" },
    reason: {
      type: "string",
      enum: [
        "closed",
        "visibility_hidden",
        "beforeunload",
        "timeout",
        "shutdown",
        "error",
      ],
    },
    eventCount: { type: "integer", minimum: 0 },
    replayChunkCount: { type: "integer", minimum: 0 },
  },
} as const;

export default schema;
