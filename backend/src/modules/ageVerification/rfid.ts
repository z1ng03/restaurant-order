import { ValidationError } from "../../lib/errors";

/** RC522 UIDs contain 4, 7 or 10 bytes. Store a single canonical representation. */
export function normalizeRfidUid(value: string): string {
  const uid = value.trim().toUpperCase();
  if (!/^(?:[0-9A-F]{2}:){3}[0-9A-F]{2}$|^(?:[0-9A-F]{2}:){6}[0-9A-F]{2}$|^(?:[0-9A-F]{2}:){9}[0-9A-F]{2}$/.test(uid)) {
    throw new ValidationError("Некорректный UID брелка");
  }
  return uid;
}
