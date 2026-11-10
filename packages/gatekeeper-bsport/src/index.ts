import { htmlResponse } from "@gadgets/gatekeeper-kit/connect-pages";
import type { BsportEnv } from "./env.js";

export { BsportAccount, BsportGatekeeper, BsportUser, BsportVerifier, GatekeeperVendor } from "./bsport.js";

export default {
  async fetch(request: Request, env: BsportEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== new URL(env.BASE_URL).origin || url.pathname !== `${new URL(env.BASE_URL).pathname}/connect`) return htmlResponse("Not found.", 404);
    const id = url.searchParams.get("account") ?? "";
    if (!/^[0-9a-f]{64}$/.test(id)) return htmlResponse("Invalid connection.", 400);
    try { return await env.BSPORT_ACCOUNTS.get(env.BSPORT_ACCOUNTS.idFromString(id)).fetch(request); }
    catch { return htmlResponse("Connection unavailable. Start again from the Workshop.", 503); }
  },
} satisfies ExportedHandler<BsportEnv>;
