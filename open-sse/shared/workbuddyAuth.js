function decodeJwtPayload(token) {
  if (typeof token !== "string") return null;
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export function getWorkBuddyIdentity(accessToken, explicit = {}) {
  const claims = decodeJwtPayload(accessToken) || {};
  const issuer = typeof claims.iss === "string" ? claims.iss : "";
  const enterpriseId = issuer.match(/\/sso-([^/]+)\/?$/)?.[1];
  let domain;
  try {
    domain = issuer ? new URL(issuer).hostname : undefined;
  } catch {
    domain = undefined;
  }

  return {
    ...(claims.sub ? { uid: String(claims.sub) } : {}),
    ...(enterpriseId ? { enterpriseId } : {}),
    ...(domain ? { domain } : {}),
    ...Object.fromEntries(Object.entries(explicit).filter(([, value]) => value !== undefined && value !== null && value !== "")),
  };
}
