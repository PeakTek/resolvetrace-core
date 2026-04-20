/**
 * Embedded copies of the public JSON Schemas used to validate request bodies.
 *
 * The canonical definitions live in `resolvetrace-contract/schemas/*.json`
 * (see OpenAPI spec). These copies mirror those exactly and are used by the
 * ajv body-validator plugin. Conformance across the two is enforced by the
 * conformance harness in the contract repo; drift shows up there first.
 *
 * Keeping the schemas inline (rather than reading JSON at runtime from a
 * sibling package) means the server has zero runtime dependency on the
 * contract repo layout and can be vendored/shipped in isolation.
 */

import eventBatchRequestJson from "./event-batch-request.js";
import replaySignedUrlRequestJson from "./replay-signed-url-request.js";
import replayManifestRequestJson from "./replay-manifest-request.js";
import sessionStartRequestJson from "./session-start-request.js";
import sessionEndRequestJson from "./session-end-request.js";

export const EventBatchRequestSchema = eventBatchRequestJson;
export const ReplaySignedUrlRequestSchema = replaySignedUrlRequestJson;
export const ReplayManifestRequestSchema = replayManifestRequestJson;
export const SessionStartRequestSchema = sessionStartRequestJson;
export const SessionEndRequestSchema = sessionEndRequestJson;
