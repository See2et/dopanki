import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

export type AccessBindings = { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string };
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

// Partial configuration also enables Access mode, so it cannot fall back to a password.
export const accessEnabled = (env: AccessBindings) => !!(env.ACCESS_TEAM_DOMAIN || env.ACCESS_AUD);

export async function verifyAccess(request: Request, env: AccessBindings): Promise<JWTPayload | null> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return null;
  try {
    let keys = keySets.get(env.ACCESS_TEAM_DOMAIN);
    if (!keys) {
      keys = createRemoteJWKSet(new URL(`${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`));
      keySets.set(env.ACCESS_TEAM_DOMAIN, keys);
    }
    const { payload } = await jwtVerify(token, keys, {
      issuer: env.ACCESS_TEAM_DOMAIN,
      audience: env.ACCESS_AUD,
      algorithms: ['RS256'],
      requiredClaims: ['exp', 'iat', 'sub'],
    });
    return payload;
  } catch {
    return null;
  }
}
