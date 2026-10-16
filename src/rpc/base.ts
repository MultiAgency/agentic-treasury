import { CompensationError } from "../compensation-store.js";
import { AgentApiError } from "@near-intents-agent-api/sdk";
import { ORPCError, os as base } from "@orpc/server";
import { refusalDetails } from "../provider-display.js";
import { PublicError } from "../public-error.js";
/**
 * Only explicitly constructed ORPCErrors/PublicErrors are public application messages. Arbitrary exceptions
 * and provider detail/title text may contain credentials or private paths, even for admitted owners.
 * Provider codes and validated refusal metadata remain available for UI recovery guidance.
 */
function toClientError(error: unknown) {
  if (error instanceof CompensationError) return new ORPCError(error.code === "not_found" ? "NOT_FOUND" : "CONFLICT", { message: error.message, data: { code: error.code } });
  if (error instanceof ORPCError) return error;
  if (error instanceof PublicError) return new ORPCError("BAD_REQUEST", { message: error.message });
  if (error instanceof AgentApiError)
    return new ORPCError("BAD_REQUEST", { message: "The provider could not complete this request. Check the recorded outcome before retrying.", data: { code: error.code, availableAt: null, ...refusalDetails(error) } });
  return new ORPCError("INTERNAL_SERVER_ERROR", { message: "The request could not be completed. Check existing records before retrying an action." });
}

export const os = base.$context<{ actor?: string }>().use(async ({ next }) => {
  try {
    const result = await next();
    const output: unknown = result.output;
    if (!output || typeof output !== "object" || !(Symbol.asyncIterator in output)) return result;
    // A stream's errors are thrown after next() resolves, so they are converted where they occur.
    const stream = output as AsyncIterable<unknown>;
    async function* converted() {
      try {
        yield* stream;
      } catch (error) {
        throw toClientError(error);
      }
    }
    return { ...result, output: converted() as typeof result.output };
  } catch (error) {
    throw toClientError(error);
  }
});
