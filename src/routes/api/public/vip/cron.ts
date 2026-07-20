import { createFileRoute } from "@tanstack/react-router";
import { isVipCronAuthorized, runVipCronJob } from "@/lib/vip-cron.server";

export const Route = createFileRoute("/api/public/vip/cron")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isVipCronAuthorized(request)) {
          return new Response("Unauthorized", { status: 401 });
        }

        try {
          const result = await runVipCronJob();
          return Response.json({ ok: true, ...result });
        } catch (e) {
          return Response.json({ ok: false, error: (e as Error).message }, { status: 500 });
        }
      },
    },
  },
});
