/** Deployment-managed credentials and immutable tenant/identity configuration. */
export interface BsportEnv {
  BSPORT_ACCOUNTS: DurableObjectNamespace<import("./bsport.js").BsportAccount>;
  BSPORT_API_KEY?: string;
  BSPORT_CLIENT_ID: string;
  BSPORT_COMPANY_ID: string;
  BSPORT_FRANCHISOR_ID?: string;
  BSPORT_OWNER_EMAIL: string;
  /** Optional comma-separated emails that may connect besides the owner. */
  BSPORT_ALLOWED_EMAILS?: string;
  CF_ACCESS_ISS: string;
  CF_ACCESS_AUD: string;
  BASE_URL: string;
}

export function companyId(env: BsportEnv): number {
  const id = Number(env.BSPORT_COMPANY_ID);
  if (!/^[1-9]\d*$/.test(env.BSPORT_COMPANY_ID) || !Number.isSafeInteger(id)) {
    throw new Error("Invalid bsport company configuration.");
  }
  return id;
}

export function ensureConfigured(env: BsportEnv): void {
  companyId(env);
  if (!env.BSPORT_API_KEY || !env.BSPORT_CLIENT_ID || !env.BSPORT_OWNER_EMAIL ||
      !env.CF_ACCESS_ISS || !env.CF_ACCESS_AUD || !env.BASE_URL) {
    throw new Error("The bsport Gatekeeper is not configured.");
  }
}

/** The owner plus any allow-listed emails, lowercased. The shared key stays the only bsport identity. */
export function allowedEmails(env: BsportEnv): Set<string> {
  const list = (env.BSPORT_ALLOWED_EMAILS ?? "").split(",").map(e => e.trim().toLowerCase()).filter(Boolean);
  return new Set([env.BSPORT_OWNER_EMAIL.toLowerCase(), ...list]);
}

export function isAllowedEmail(env: BsportEnv, email: string): boolean {
  return allowedEmails(env).has(email.toLowerCase());
}
