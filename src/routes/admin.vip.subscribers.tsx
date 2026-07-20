import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { getVipSubscriptions, getVipMemberProfiles, addVipSubscriptionManual, extendVipSubscription, deleteVipSubscription, confirmVipSubscription, rejectVipSubscription, excludeVipFromCommunity } from "@/lib/vip-subscriptions.functions";
import { getVipTariffs } from "@/lib/vip-tariffs.functions";
import { paymentProofKind } from "@/lib/file-mime";
import { Button } from "@/components-ui/button";
import { Input } from "@/components-ui/input";
import { Label } from "@/components-ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components-ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components-ui/dialog";

export const Route = createFileRoute("/admin/vip/subscribers")({
  component: AdminVipSubscribers,
});

function AdminVipSubscribers() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("pending_payment");
  
  const subs = useQuery({
    queryKey: ["vip_subs", statusFilter],
    queryFn: () => getVipSubscriptions({ data: { status: statusFilter } }),
  });
  const profiles = useQuery({ queryKey: ["vip_profiles"], queryFn: () => getVipMemberProfiles() });
  const tariffs = useQuery({ queryKey: ["vip_tariffs"], queryFn: () => getVipTariffs() });

  const profileByTelegram = new Map(
    (profiles.data ?? []).map((p: any) => [String(p.telegram_id), p]),
  );

  const filteredSubs = (subs.data ?? []).filter((s: any) =>
    statusFilter === "all" ? true : s.status === statusFilter,
  );

  const [addingManual, setAddingManual] = useState(false);
  const [manualData, setManualData] = useState({ telegram_id: "", tariff_id: "", days: 30, status: "active" });
  const [proofModal, setProofModal] = useState<{ path: string } | null>(null);

  const handleAddManual = async () => {
    if (!manualData.telegram_id || !manualData.tariff_id) return alert("Заполните ID и выберите тариф");
    await addVipSubscriptionManual({ data: manualData });
    setAddingManual(false);
    qc.invalidateQueries({ queryKey: ["vip_subs"] });
  };

  const handleConfirm = async (id: string) => {
    if (!confirm("Подтвердить оплату и выдать доступ?")) return;
    try {
      await confirmVipSubscription({ data: { id } });
      qc.invalidateQueries({ queryKey: ["vip_subs"] });
    } catch (e: any) {
      alert("Ошибка: " + e.message);
    }
  };

  const handleReject = async (id: string) => {
    if (!confirm("Отклонить оплату? Пользователь получит уведомление в VIP-боте.")) return;
    try {
      await rejectVipSubscription({ data: { id } });
      qc.invalidateQueries({ queryKey: ["vip_subs"] });
    } catch (e: any) {
      alert("Ошибка: " + e.message);
    }
  };

  const handleExtend = async (id: string) => {
    const days = prompt("На сколько дней продлить?", "30");
    if (!days) return;
    const n = parseInt(days, 10);
    if (!Number.isFinite(n) || n < 1) return alert("Укажите целое число дней ≥ 1");
    try {
      await extendVipSubscription({ data: { id, days: n } });
      qc.invalidateQueries({ queryKey: ["vip_subs"] });
    } catch (e: any) {
      alert("Ошибка: " + e.message);
    }
  };

  const handleExclude = async (id: string) => {
    if (
      !confirm(
        "Исключить из VIP-сообщества?\n\nЧеловека кикнут из группы, активные подписки станут «Истёкшие», он получит сообщение в боте.",
      )
    )
      return;
    try {
      await excludeVipFromCommunity({ data: { id } });
      qc.invalidateQueries({ queryKey: ["vip_subs"] });
    } catch (e: any) {
      alert("Ошибка: " + e.message);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Удалить подписку?\n\nЕсли у человека больше не останется записей — бот забудет его (личный тариф и «уже был в VIP»), и снова покажет «Первый вход».\n\nДля кика из группы лучше «Исключить».")) return;
    await deleteVipSubscription({ data: { id } });
    qc.invalidateQueries({ queryKey: ["vip_subs"] });
    qc.invalidateQueries({ queryKey: ["vip_profiles"] });
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-semibold">Подписчики VIP</h2>
        <Button onClick={() => setAddingManual(!addingManual)}>{addingManual ? "Отмена" : "+ Добавить вручную (Импорт)"}</Button>
      </div>

      {addingManual && (
        <div className="bg-card border rounded-lg p-4 space-y-4 max-w-xl">
          <h3 className="font-medium">Добавление участника вручную</h3>
          <p className="text-xs text-muted-foreground">
            При ручном добавлении бот не пишет пользователю — только отсчёт до напоминания/кика.
            ID можно узнать: человек пишет VIP-боту <code>/id</code>.
          </p>
          <div className="space-y-2">
            <Label>Telegram ID участника</Label>
            <Input value={manualData.telegram_id} onChange={(e) => setManualData({...manualData, telegram_id: e.target.value})} placeholder="Например: 123456789" />
          </div>
          <div className="space-y-2">
            <Label>Тариф</Label>
            <Select value={manualData.tariff_id} onValueChange={(v) => setManualData({...manualData, tariff_id: v})}>
              <SelectTrigger><SelectValue placeholder="Выберите тариф" /></SelectTrigger>
              <SelectContent>
                {tariffs.data?.map((t: any) => (
                  <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Дней до истечения (остаток)</Label>
            <Input type="number" value={manualData.days} onChange={(e) => setManualData({...manualData, days: parseInt(e.target.value)})} />
          </div>
          <Button onClick={handleAddManual}>Сохранить</Button>
        </div>
      )}

      <div className="flex gap-2">
        <Button variant={statusFilter === "all" ? "default" : "outline"} size="sm" onClick={() => setStatusFilter("all")}>Все</Button>
        <Button variant={statusFilter === "active" ? "default" : "outline"} size="sm" onClick={() => setStatusFilter("active")}>Активные</Button>
        <Button variant={statusFilter === "pending_payment" ? "default" : "outline"} size="sm" onClick={() => setStatusFilter("pending_payment")}>Ожидают проверки</Button>
        <Button variant={statusFilter === "expired" ? "default" : "outline"} size="sm" onClick={() => setStatusFilter("expired")}>Истёкшие</Button>
        <Button variant={statusFilter === "cancelled" ? "default" : "outline"} size="sm" onClick={() => setStatusFilter("cancelled")}>Отклонённые</Button>
      </div>

      <div className="border rounded-md overflow-hidden bg-card">
        <table className="w-full text-sm text-left">
          <thead className="bg-muted">
            <tr>
              <th className="p-2 font-medium">Пользователь</th>
              <th className="p-2 font-medium">Тариф</th>
              <th className="p-2 font-medium">Статус</th>
              <th className="p-2 font-medium">Истекает</th>
              <th className="p-2 font-medium text-right">Действия</th>
            </tr>
          </thead>
          <tbody>
            {filteredSubs.map((s: any) => {
              const profile = profileByTelegram.get(String(s.telegram_id));
              const personalTariff = profile?.vip_tariffs;
              return (
              <tr key={s.id} className="border-t">
                <td className="p-2">
                  <div>{s.first_name} {s.last_name}</div>
                  <div className="text-xs text-muted-foreground">{s.username ? `@${s.username}` : `ID: ${s.telegram_id}`}</div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {s.imported && <span className="text-[10px] bg-secondary px-1 rounded">импорт</span>}
                    {personalTariff && (
                      <span className="text-[10px] bg-orange-100 text-orange-800 px-1 rounded border border-orange-200">
                        личный тариф: {personalTariff.price} {personalTariff.currency}
                      </span>
                    )}
                  </div>
                </td>
                <td className="p-2">{s.vip_tariffs?.name || "Удалён"}</td>
                <td className="p-2">
                  {(() => {
                    const pastDue =
                      s.status === "active" && new Date(s.expires_at).getTime() <= Date.now();
                    if (s.status === "active" && !pastDue)
                      return <span className="text-green-600 font-medium">Активен</span>;
                    if (pastDue)
                      return (
                        <span className="text-amber-600 font-medium">Истёк (ожидает кик)</span>
                      );
                    if (s.status === "pending_payment")
                      return <span className="text-orange-600 font-medium">Ожидает</span>;
                    if (s.status === "expired")
                      return <span className="text-red-600 font-medium">Истёк</span>;
                    if (s.status === "cancelled")
                      return <span className="text-muted-foreground">Отклонён</span>;
                    return <span className="text-muted-foreground">{s.status}</span>;
                  })()}
                </td>
                <td className="p-2">
                  {s.status === 'pending_payment' ? '-' : new Date(s.expires_at).toLocaleString("ru-RU")}
                </td>
                <td className="p-2">
                  <div className="flex flex-wrap items-center justify-end gap-1.5">
                    {s.payment_proof_path && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setProofModal({ path: s.payment_proof_path })}
                      >
                        Чек
                      </Button>
                    )}
                    {s.status === "pending_payment" && (
                      <>
                        <Button variant="default" size="sm" onClick={() => handleConfirm(s.id)}>
                          Подтвердить
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => handleReject(s.id)}>
                          Отклонить
                        </Button>
                      </>
                    )}
                    {s.status !== "pending_payment" && (
                      <Button variant="outline" size="sm" onClick={() => handleExtend(s.id)}>
                        Продлить
                      </Button>
                    )}
                    {s.status === "active" && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-destructive border-destructive/40 hover:bg-destructive/10"
                        onClick={() => handleExclude(s.id)}
                      >
                        Исключить
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-destructive border-destructive/40 hover:bg-destructive/10"
                      onClick={() => handleDelete(s.id)}
                    >
                      Удалить
                    </Button>
                  </div>
                </td>
              </tr>
            );
            })}
            {filteredSubs.length === 0 && (
              <tr>
                <td colSpan={5} className="p-4 text-center text-muted-foreground">Ничего не найдено.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={!!proofModal} onOpenChange={(open) => !open && setProofModal(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Чек оплаты VIP</DialogTitle>
          </DialogHeader>
          {proofModal && (() => {
            const kind = paymentProofKind(proofModal.path);
            const src = `/api/admin/file/${proofModal.path}?bucket=payment-proofs`;
            if (kind === "image") {
              return <img src={src} alt="Чек оплаты" className="max-h-[80vh] mx-auto rounded" />;
            }
            if (kind === "pdf") {
              return <iframe src={src} className="w-full h-[80vh] rounded border" title="Чек оплаты" />;
            }
            return (
              <div className="text-center py-6 space-y-3">
                <p className="text-muted-foreground">Формат не поддерживается для предпросмотра.</p>
                <Button asChild>
                  <a href={src} target="_blank" rel="noreferrer">
                    Скачать чек
                  </a>
                </Button>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>
    </div>
  );
}
