import { daoRequests, ownerActions, prepare, status, submit } from "../owner-intents.js";
import { os, owner } from "./base.js";
import { readOutput } from "./read-output.js";

export const ownerRoutes = {
  owner: {
    prepare: owner.owner.prepare.handler(({ input }) => prepare(input.action, input.signer)),
    status: owner.owner.status.use(readOutput("owner/status")).handler(({ input }) => status(input.correlationId)),
    /** What this server waits for the DAO to sign, for members to check each proposal before voting. */
    pending: os.use(readOutput("owner/pending")).handler(() => daoRequests()),
    actions: os.use(readOutput("owner/actions")).handler(() => ownerActions()),
    submit: owner.owner.submit.handler(({ input }) => submit(input.correlationId, input.signedData)),
  },
};
