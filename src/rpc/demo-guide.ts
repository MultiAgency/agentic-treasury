import { ORPCError } from "@orpc/server";
import { GuideInput } from "../payables-guide.js";
import { generateGuide } from "../payables-guide-model.js";
import { os } from "./base.js";

// Bounded inference per agent process; this is not a distributed quota.
let busy = false;
let nextRequest = 0;
export const demoGuideRoutes = {
  demoGuide: {
    compose: os.input(GuideInput).handler(async ({ input }) => {
      const key = process.env.NEARAI_API_KEY;
      if (!key) throw new ORPCError("PRECONDITION_FAILED", { message: "AI guidance is not configured on this agent. The scripted rehearsal and real review controls remain available." });
      if (busy || Date.now() < nextRequest) throw new ORPCError("TOO_MANY_REQUESTS", { message: "The guide is busy. Wait a moment and ask again." });
      busy = true;
      nextRequest = Date.now() + 10_000;
      try { return await generateGuide(input, key); }
      catch { throw new ORPCError("BAD_GATEWAY", { message: "The AI scene could not be verified. Continue with the scripted guide or try your question again." }); }
      finally { busy = false; }
    }),
  },
};
