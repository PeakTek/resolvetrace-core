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

import { FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
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

const bodyValidatePluginImpl: FastifyPluginAsync = async (fastify) => {
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

  // Reserve the request prototype slot. v5 rejects `null` for a
  // function-typed decorator (the declared FastifyRequest augmentation
  // below types `validateBody` as a callable), so the initial value is
  // a placeholder function. The onRequest hook below overrides per-request
  // with a closure that captures the current request's body — the
  // placeholder would only fire if the hook somehow didn't run, which
  // means "loud bug", not "silent wrong result".
  fastify.decorateRequest("validateBody", function validateBodyPlaceholder(
    this: FastifyRequest,
    _id: ValidatorId
  ): unknown {
    throw new Error(
      "validateBody called before onRequest hook initialised per-request closure"
    );
  });

  fastify.addHook("onRequest", async (request) => {
    request.validateBody = (id: ValidatorId) => {
      const validate = validators[id];
      if (!validate(request.body)) {
        throw new ValidationError(
          "Request body failed schema validation",
          validate.errors
        );
      }
      return request.body;
    };
  });
};

// Wrap with fastify-plugin so the decorator + onRequest hook propagate to
// the parent scope; otherwise routes registered in app.ts don't see
// `request.validateBody` and handlers get a TypeError at call time.
export const bodyValidatePlugin = fp(bodyValidatePluginImpl, {
  name: "body-validate",
  fastify: "5.x",
});
