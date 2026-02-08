import { getUserSettings } from "../db/user-settings.ts";

export async function isQuietHours(userId: number): Promise<boolean> {
  const settings = await getUserSettings(userId);
  if (settings.quietStart == null || settings.quietEnd == null) return false;

  const now = getCurrentHourInTimezone(settings.timezone);

  // Handle overnight ranges like 22:00-08:00
  if (settings.quietStart > settings.quietEnd) {
    return now >= settings.quietStart || now < settings.quietEnd;
  }
  return now >= settings.quietStart && now < settings.quietEnd;
}

function getCurrentHourInTimezone(timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    hour12: false,
  });
  return Number(formatter.format(new Date()));
}
