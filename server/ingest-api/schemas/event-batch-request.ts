/**
 * JSON Schema for EventBatchRequest — mirrors
 * `resolvetrace-contract/schemas/events.json#/definitions/EventBatchRequest`.
 */

const schema = {
  $id: "resolvetrace/events/EventBatchRequest",
  type: "object",
  additionalProperties: false,
  title: "EventBatchRequest",
  properties: {
    events: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["eventId", "type", "capturedAt", "scrubber", "sdk"],
        properties: {
          eventId: {
            type: "string",
            pattern: "^[0-9A-HJKMNP-TV-Z]{26}$",
          },
          sessionId: {
            type: "string",
            pattern: "^[0-9A-HJKMNP-TV-Z]{26}$",
          },
          type: {
            type: "string",
            minLength: 1,
            maxLength: 128,
            pattern: "^[a-zA-Z0-9_.\\-:/]+$",
          },
          capturedAt: { type: "string", format: "date-time" },
          attributes: {
            type: "object",
            patternProperties: { "^(.*)$": {} },
          },
          scrubber: {
            type: "object",
            additionalProperties: false,
            required: ["version", "rulesDigest", "applied", "budgetExceeded"],
            properties: {
              version: { type: "string", minLength: 1, maxLength: 64 },
              rulesDigest: {
                type: "string",
                pattern: "^sha256:[a-f0-9]{64}$",
              },
              applied: {
                type: "array",
                maxItems: 64,
                items: { type: "string", minLength: 1, maxLength: 128 },
              },
              budgetExceeded: { type: "boolean" },
              durationMs: { type: "number", minimum: 0 },
            },
          },
          clockSkewDetected: { type: "boolean" },
          sdk: {
            type: "object",
            additionalProperties: false,
            required: ["name", "version"],
            properties: {
              name: { type: "string", minLength: 1, maxLength: 64 },
              version: { type: "string", minLength: 1, maxLength: 32 },
              runtime: { type: "string", minLength: 1, maxLength: 64 },
            },
          },
        },
      },
    },
  },
  required: ["events"],
} as const;

export default schema;
