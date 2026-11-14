/** The restaurant is in Almaty; every user-visible timestamp is shown in this zone. */
export const RESTAURANT_TIME_ZONE = "Asia/Almaty";

export function formatDateTimeAlmaty(date: Date): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: RESTAURANT_TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}
