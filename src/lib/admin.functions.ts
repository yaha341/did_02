import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getAdminSession, isAdminAuthed } from "./admin-session.server";

const LoginInput = z.object({ username: z.string().min(1), password: z.string().min(1) });

export const adminLogin = createServerFn({ method: "POST" })
  .validator((data: unknown) => LoginInput.parse(data))
  .handler(async ({ data }) => {
    const expectedUser = process.env.ADMIN_USERNAME;
    const expectedPass = process.env.ADMIN_PASSWORD;
    if (!expectedUser || !expectedPass) {
      if (process.env.NODE_ENV === "production" || process.env.VERCEL === "1") {
        console.error("[admin] ADMIN_USERNAME / ADMIN_PASSWORD not set");
        return { ok: false as const };
      }
    }
    const user = expectedUser || "admin";
    const pass = expectedPass || "admin";
    if (data.username !== user || data.password !== pass) {
      return { ok: false as const };
    }
    const s = await getAdminSession();
    await s.update({ authed: true });
    return { ok: true as const };
  });

export const adminLogout = createServerFn({ method: "POST" }).handler(async () => {
  const s = await getAdminSession();
  await s.clear();
  return { ok: true as const };
});

export const adminCheck = createServerFn({ method: "GET" }).handler(async () => {
  return { authed: await isAdminAuthed() };
});