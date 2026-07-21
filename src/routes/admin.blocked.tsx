import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { blockTelegramUserFn, listBlockedUsersFn, unblockTelegramUserFn } from "@/lib/blocked-users.functions";
import { Button } from "@/components-ui/button";
import { Input } from "@/components-ui/input";
import { Label } from "@/components-ui/label";
import { Textarea } from "@/components-ui/textarea";

export const Route = createFileRoute("/admin/blocked")({
  component: BlockedUsersPage,
});

function BlockedUsersPage() {
  const qc = useQueryClient();
  const blocked = useQuery({ queryKey: ["blocked_users"], queryFn: () => listBlockedUsersFn() });
  const [telegramId, setTelegramId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function onBlock() {
    const id = telegramId.trim();
    if (!id) return alert("Укажите Telegram ID");
    if (
      !confirm(
        `Заблокировать пользователя ${id}?\n\nБот перестанет отвечать, доступ к VIP-каналу будет закрыт, активные подписки и незавершённые заказы отменятся.`,
      )
    )
      return;
    setBusy(true);
    try {
      await blockTelegramUserFn({ data: { telegram_id: id, reason: reason.trim() || undefined } });
      setTelegramId("");
      setReason("");
      await qc.invalidateQueries({ queryKey: ["blocked_users"] });
    } catch (e: any) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function onUnblock(id: number) {
    if (!confirm(`Разблокировать пользователя ${id}?`)) return;
    setBusy(true);
    try {
      await unblockTelegramUserFn({ data: { telegram_id: id } });
      await qc.invalidateQueries({ queryKey: ["blocked_users"] });
    } catch (e: any) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  }

  const list = (blocked.data ?? []) as any[];

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold">Чёрный список</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Заблокированные пользователи не могут пользоваться магазином и VIP-ботом. Доступ к каналу закрывается автоматически.
        </p>
      </div>

      <div className="bg-card border rounded-lg p-4 space-y-4">
        <h2 className="font-medium">Заблокировать по Telegram ID</h2>
        <div className="space-y-2">
          <Label>Telegram ID</Label>
          <Input
            value={telegramId}
            onChange={(e) => setTelegramId(e.target.value)}
            placeholder="1580128256"
          />
          <p className="text-xs text-muted-foreground">
            ID можно узнать в VIP-боте командой /id или в таблице подписчиков/заказов.
          </p>
        </div>
        <div className="space-y-2">
          <Label>Причина (необязательно)</Label>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="Перепродажа материалов, пиратство…"
          />
        </div>
        <Button onClick={onBlock} disabled={busy}>
          Заблокировать
        </Button>
      </div>

      <div className="space-y-3">
        <h2 className="font-medium">Заблокированные ({list.length})</h2>
        {list.length === 0 && (
          <p className="text-sm text-muted-foreground">Список пуст.</p>
        )}
        {list.map((u) => (
          <div key={u.telegram_id} className="bg-card border rounded-lg p-3 text-sm flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="font-medium">
                {u.first_name || "—"}{" "}
                {u.username ? `@${u.username}` : `ID: ${u.telegram_id}`}
              </div>
              <div className="text-muted-foreground">ID: {u.telegram_id}</div>
              {u.reason && <div className="mt-1">Причина: {u.reason}</div>}
              <div className="text-xs text-muted-foreground mt-1">
                {new Date(u.blocked_at).toLocaleString("ru-RU")}
              </div>
            </div>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onUnblock(u.telegram_id)}>
              Разблокировать
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
