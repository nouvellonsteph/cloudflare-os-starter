import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { BsportEnv } from "./env.js";

export type OwnerIdentity = { email: string; subject: string };
const keys = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** Access's signed email plus subject, never an email header or a caller's RPC argument. */
export function approvedIdentity(payload: JWTPayload, env: BsportEnv): OwnerIdentity | null {
  if (typeof payload.email !== "string" || typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 256 ||
      typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now() || typeof payload.iat !== "number" ||
      payload.email.toLowerCase() !== env.BSPORT_OWNER_EMAIL.toLowerCase()) return null;
  return { email: payload.email.toLowerCase(), subject: payload.sub };
}

export async function verifyOwner(request: Request, env: BsportEnv): Promise<OwnerIdentity | null> {
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token || token.length > 16_384) return null;
  try {
    const issuer = new URL(env.CF_ACCESS_ISS);
    if (issuer.protocol !== "https:" || issuer.origin !== env.CF_ACCESS_ISS || !env.CF_ACCESS_AUD) return null;
    let key = keys.get(issuer.origin);
    if (!key) { key = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", issuer)); keys.set(issuer.origin, key); }
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["RS256"], issuer: issuer.origin, audience: env.CF_ACCESS_AUD,
      requiredClaims: ["exp", "iat", "sub", "email"],
    });
    return approvedIdentity(payload, env);
  } catch { return null; }
}
