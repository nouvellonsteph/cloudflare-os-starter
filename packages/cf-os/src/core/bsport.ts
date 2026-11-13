/** Required non-secret configuration for the wrapper-owned Gatekeeper. */
export const BSPORT_VARS = ["BSPORT_COMPANY_ID", "BSPORT_CLIENT_ID", "BSPORT_OWNER_EMAIL"] as const;

/** Refuse secrets in vars, tenant ambiguity and overrides of the validated Access realm. */
export function validateBsportVars(vars: Record<string, string> = {}): void {
  if (!vars || typeof vars !== "object" || Array.isArray(vars)) throw new Error("gatekeepers.bsport.vars must be an object.");
  const allowed: readonly string[] = [...BSPORT_VARS, "BSPORT_FRANCHISOR_ID", "BSPORT_ALLOWED_EMAILS"];
  for (const key of Object.keys(vars)) {
    if (key === "BSPORT_API_KEY") throw new Error("gatekeepers.bsport.vars.BSPORT_API_KEY is a secret; install it on the bsport Worker, never in deployment.jsonc.");
    if (!allowed.includes(key)) throw new Error(`gatekeepers.bsport.vars.${key} is not allowed. Access issuer/audience and BASE_URL are deployment-derived.`);
  }
  for (const key of BSPORT_VARS) {
    if (typeof vars[key] !== "string" || !vars[key] || vars[key] !== vars[key].trim()) throw new Error(`Missing or padded deployment value: gatekeepers.bsport.vars.${key}`);
  }
  for (const key of ["BSPORT_COMPANY_ID", "BSPORT_FRANCHISOR_ID"]) {
    const value = vars[key];
    if (value !== undefined && (typeof value !== "string" || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))) throw new Error(`gatekeepers.bsport.vars.${key} must be a positive integer string.`);
  }
  if (!/^[^@\s]+@[^@\s]+$/.test(vars.BSPORT_OWNER_EMAIL)) throw new Error("gatekeepers.bsport.vars.BSPORT_OWNER_EMAIL must name the one approved owner.");
  if (vars.BSPORT_ALLOWED_EMAILS !== undefined) {
    if (typeof vars.BSPORT_ALLOWED_EMAILS !== "string") throw new Error("gatekeepers.bsport.vars.BSPORT_ALLOWED_EMAILS must be a comma-separated string.");
    const emails = vars.BSPORT_ALLOWED_EMAILS.split(",").map(e => e.trim());
    if (emails.some(e => !/^[^@\s,]+@[^@\s,]+$/.test(e))) throw new Error("gatekeepers.bsport.vars.BSPORT_ALLOWED_EMAILS must list valid email addresses separated by commas.");
  }
  // eslint-disable-next-line no-control-regex -- Header values must not contain control characters.
  if (vars.BSPORT_CLIENT_ID.length > 500 || /[\u0000-\u001f\u007f]/.test(vars.BSPORT_CLIENT_ID)) throw new Error("gatekeepers.bsport.vars.BSPORT_CLIENT_ID is invalid.");
}
