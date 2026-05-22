import { request, BrowserContext } from "@playwright/test";
import { APP_URLS } from "../../constants";
import { extractPenpotTransitField } from "./penpot-transit";

export type IdentityProbe = (
  ctx: BrowserContext,
  extraHeaders: Record<string, string>,
) => Promise<string>;

async function cookieHeaderFor(ctx: BrowserContext, baseUrl: string): Promise<string> {
  const cookies = await ctx.cookies(baseUrl);
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

export const IDENTITY_PROBES: Record<string, IdentityProbe> = {
  PM: async (ctx, extra) => {
    const cookie = await cookieHeaderFor(ctx, APP_URLS.PM);
    const c = await request.newContext({ extraHTTPHeaders: { cookie, ...extra } });
    try {
      const r = await c.get(`${APP_URLS.PM}/api/users/me/`);
      const j = (await r.json()) as { email: string };
      return j.email;
    } finally {
      await c.dispose();
    }
  },
  Outline: async (ctx, extra) => {
    const cookie = await cookieHeaderFor(ctx, APP_URLS.Outline);
    const c = await request.newContext({
      extraHTTPHeaders: { cookie, "content-type": "application/json", ...extra },
    });
    try {
      const r = await c.post(`${APP_URLS.Outline}/api/auth.info`, { data: {} });
      const j = (await r.json()) as { data: { user: { email: string } } };
      return j.data.user.email;
    } finally {
      await c.dispose();
    }
  },
  SurfSense: async (ctx, extra) => {
    const cookie = await cookieHeaderFor(ctx, APP_URLS.SurfSense);
    const c = await request.newContext({ extraHTTPHeaders: { cookie, ...extra } });
    try {
      const r = await c.get(`${APP_URLS.SurfSense}/users/me`);
      const j = (await r.json()) as { email: string };
      return j.email;
    } finally {
      await c.dispose();
    }
  },
  Penpot: async (ctx, extra) => {
    const cookie = await cookieHeaderFor(ctx, APP_URLS.Penpot);
    const c = await request.newContext({ extraHTTPHeaders: { cookie, ...extra } });
    try {
      const r = await c.get(`${APP_URLS.Penpot}/api/rpc/command/get-profile`);
      return extractPenpotTransitField(await r.json(), "~:email");
    } finally {
      await c.dispose();
    }
  },
};
