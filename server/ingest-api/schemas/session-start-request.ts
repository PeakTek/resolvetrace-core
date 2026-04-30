/**
 * JSON Schema for SessionStartRequest — mirrors
 * `resolvetrace-contract/schemas/session.json#/definitions/SessionStartRequest`.
 */

const schema = {
  $id: "resolvetrace/session/SessionStartRequest",
  type: "object",
  additionalProperties: false,
  title: "SessionStartRequest",
  required: ["sessionId", "startedAt"],
  properties: {
    sessionId: {
      type: "string",
      pattern: "^[0-9A-HJKMNP-TV-Z]{26}$",
    },
    startedAt: { type: "string", format: "date-time" },
    appVersion: { type: "string", minLength: 1, maxLength: 64 },
    releaseChannel: {
      type: "string",
      enum: ["production", "staging", "development", "canary"],
    },
    client: {
      type: "object",
      additionalProperties: false,
      properties: {
        userAgent: { type: "string", minLength: 1, maxLength: 512 },
        locale: { type: "string", minLength: 2, maxLength: 35 },
        timezone: { type: "string", minLength: 1, maxLength: 64 },
        viewport: {
          type: "object",
          additionalProperties: false,
          required: ["width", "height"],
          properties: {
            width: { type: "integer", minimum: 0, maximum: 20000 },
            height: { type: "integer", minimum: 0, maximum: 20000 },
            devicePixelRatio: { type: "number", minimum: 0, maximum: 16 },
          },
        },
      },
    },
    userAnonId: { type: "string", minLength: 1, maxLength: 128 },
    identify: {
      type: "object",
      additionalProperties: false,
      properties: {
        userId: {
          oneOf: [
            { type: "string", minLength: 1, maxLength: 128 },
            { type: "null" },
          ],
        },
        traits: {
          type: "object",
          patternProperties: { "^(.*)$": {} },
        },
      },
    },
  },
} as const;

export default schema;
