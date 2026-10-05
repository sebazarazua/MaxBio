import { parseCookie, stringifySetCookie } from 'cookie';
import type { Request, Response } from 'express';

export const sessionCookieName = (production: boolean) =>
  production ? '__Host-maxbio-session' : 'maxbio-session';
export function readSessionToken(request: Request, production: boolean) {
  const token = parseCookie(request.headers.cookie ?? '')[sessionCookieName(production)];
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
}
export function setSessionCookie(
  response: Response,
  token: string,
  expiresAt: Date,
  production: boolean,
) {
  response.append(
    'Set-Cookie',
    stringifySetCookie({
      name: sessionCookieName(production),
      value: token,
      httpOnly: true,
      secure: production,
      sameSite: 'lax',
      path: '/',
      expires: expiresAt,
      maxAge: Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
    }),
  );
}
export function clearSessionCookie(response: Response, production: boolean) {
  setSessionCookie(response, '', new Date(0), production);
}
