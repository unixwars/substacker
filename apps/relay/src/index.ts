import { handle } from "./relay.js";
import type { Env } from "./relay.js";

export default {
  fetch: (request: Request, env: Env): Promise<Response> => handle(request, env),
};
