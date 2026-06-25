/**
 * JSON Schema for EventBatchRequest — mirrors
 * `resolvetrace-contract/schemas/events.json#/definitions/EventBatchRequest`.
 */

// Reserved-namespace event type. A value is valid iff it is one of the 14
// canonical names OR a custom name that does NOT shadow a reserved namespace
// (view. action. error. perf. ux. support.). Mirrors the contract's
// `EventType` pattern exactly — keep the two byte-for-byte identical.
const EVENT_TYPE_PATTERN =
  "^(?:(?:view\\.start|view\\.end|action\\.click|action\\.submit|action\\.navigation|error\\.js|error\\.api|error\\.resource|perf\\.api_latency|perf\\.long_task|ux\\.dead_click|ux\\.rage_click|ux\\.repeated_submit|support\\.report_submitted)|(?!(?:view|action|error|perf|ux|support)\\.)[a-zA-Z0-9_.\\-:/]+)$";

// EventContext — optional per-event global context. When present,
// releaseVersion/locale/market/diagnosticsLevel are required; everything else
// is optional. `additionalProperties: false` so unknown context keys are
// rejected. Mirrors `events.json#/definitions/EventContext`.
const eventContext = {
  type: "object",
  additionalProperties: false,
  title: "EventContext",
  required: ["releaseVersion", "locale", "market", "diagnosticsLevel"],
  properties: {
    releaseVersion: { type: "string", minLength: 1, maxLength: 256 },
    locale: { type: "string", minLength: 1, maxLength: 64 },
    market: { type: "string", minLength: 1, maxLength: 64 },
    diagnosticsLevel: {
      anyOf: [
        { type: "string", const: "essential" },
        { type: "string", const: "standard" },
        { type: "string", const: "assisted_support" },
      ],
    },
    routeName: { type: "string", maxLength: 256 },
    routeType: { type: "string", maxLength: 64 },
    componentId: { type: "string", maxLength: 256 },
    componentType: { type: "string", maxLength: 128 },
    browserFamily: { type: "string", maxLength: 64 },
    browserVersion: { type: "string", maxLength: 64 },
    osFamily: { type: "string", maxLength: 64 },
    deviceType: { type: "string", maxLength: 64 },
    viewportWidth: { type: "integer", minimum: 0 },
    viewportHeight: { type: "integer", minimum: 0 },
    featureFlags: {
      type: "object",
      patternProperties: { "^(.*)$": {} },
    },
    experimentVariant: { type: "string", maxLength: 128 },
    networkState: { type: "string", maxLength: 64 },
    pageUrl: { type: "string", maxLength: 2048 },
    supportCode: { type: "string", maxLength: 64 },
  },
} as const;

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
        required: ["schemaVersion", "eventId", "type", "capturedAt", "scrubber", "sdk"],
        properties: {
          schemaVersion: {
            type: "integer",
            minimum: 1,
          },
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
            pattern: EVENT_TYPE_PATTERN,
          },
          capturedAt: { type: "string", format: "date-time" },
          context: eventContext,
          severity: {
            anyOf: [
              { type: "string", const: "info" },
              { type: "string", const: "warn" },
              { type: "string", const: "error" },
            ],
          },
          durationMs: { type: "integer", minimum: 0 },
          httpStatus: { type: "integer", minimum: 100, maximum: 599 },
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
