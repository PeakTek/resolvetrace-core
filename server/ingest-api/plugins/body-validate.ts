/**
 * Body-validation plugin. Compiles the public JSON Schemas once with ajv and
 * exposes a `request.validateBody(schemaId)` helper that routes call on entry.
 *
 * Route handlers call `request.validateBody("EventBatchRequest")` at the top
 * of the handler. On validation failure, a 400 `ErrorResponse` is returned
 * via a thrown `ValidationError` caught by the global error handler.
 *
 * We intentionally do not wire ajv into Fastify's schema compiler: the
 * public schemas live in the contract repo and are emitted from TypeBox.
 * Using ajv directly keeps us aligned with the contract's validator.
 */

import { FastifyPluginAsync } from "fastify";
import AjvImport, { AnySchema, ValidateFunction } from "ajv";
import addFormatsImport from "ajv-formats";
import {
  EventBatchRequestSchema,
  ReplaySignedUrlRequestSchema,
  ReplayManifestRequestSchema,
  SessionStartRequestSchema,
  SessionEndRequestSchema,
} from "../schemas/index.js";

// Under NodeNext, `import X from "ajv"` resolves to the CJS module namespace
// whose `.default` property is the actual class. Cast through the namespace
// type so tsc sees the constructor / callable signature.
const Ajv = AjvImport as unknown as typeof AjvImport.default;
const addFormats =
  addFormatsImport as unknown as typeof addFormatsImport.default;

export type ValidatorId =
  | "EventBatchRequest"
  | "ReplaySignedUrlRequest"
  | "ReplayManifestRequest"
  | "SessionStartRequest"
  | "SessionEndRequest";

/** Thrown when the request body fails schema validation. */
export class ValidationError extends Error {
  readonly errors: unknown;
  constructor(message: string, errors: unknown) {
    super(message);
    this.name = "ValidationError";
    this.errors = errors;
  }
}

declare module "fastify" {
  interface FastifyRequest {
    validateBody(id: ValidatorId): unknown;
  }
}

export const bodyValidatePlugin: FastifyPluginAsync = async (fastify) => {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    validateFormats: true,
  });
  addFormats(ajv);

  const validators: Record<ValidatorId, ValidateFunction> = {
    EventBatchRequest: ajv.compile(EventBatchRequestSchema as AnySchema),
    ReplaySignedUrlRequest: ajv.compile(
      ReplaySignedUrlRequestSchema as AnySchema
    ),
    ReplayManifestRequest: ajv.compile(
      ReplayManifestRequestSchema as AnySchema
    ),
    SessionStartRequest: ajv.compile(SessionStartRequestSchema as AnySchema),
    SessionEndRequest: ajv.compile(SessionEndRequestSchema as AnySchema),
  };

  // Decorate the request prototype with a method that captures the
  // pre-compiled validators via closure. The arrow function here is bound
  // to the request via Fastify's decorator semantics.
  fastify.decorateRequest("validateBody", function validateBody(
    this: import("fastify").FastifyRequest,
    id: ValidatorId
  ) {
    const validate = validators[id];
    if (!validate(this.body)) {
      throw new ValidationError(
        "Request body failed schema validation",
        validate.errors
      );
    }
    return this.body;
  });
};
