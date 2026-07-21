const APP_TIMEZONE = process.env.APP_TIMEZONE || "Asia/Almaty";

export function formatDateTimeRu(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleString("ru-RU", { timeZone: APP_TIMEZONE });
}
