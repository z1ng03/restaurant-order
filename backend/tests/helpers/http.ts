import request from "supertest";
import { app } from "../../src/app";

export const api = () => request(app);

export interface Kiosk {
  sessionId: string;
  tableId: string;
  token: string;
  /** headers every guest request must carry */
  h: Record<string, string>;
}

export async function openKiosk(monitorNumber: number, deviceHeaders: Record<string, string> = {}): Promise<Kiosk> {
  const res = await api().post("/api/sessions/open").set(deviceHeaders).send({ monitorNumber });
  if (res.status !== 200 && res.status !== 201) throw new Error(`open session failed: ${res.status} ${JSON.stringify(res.body)}`);
  const token: string = res.body.kioskSessionToken;
  return {
    sessionId: String(res.body.session.sessionId),
    tableId: String(res.body.table.tableId),
    token,
    h: { "X-Kiosk-Session-Token": token },
  };
}

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

export async function addToCart(k: Kiosk, body: Record<string, unknown>, extraHeaders: Record<string, string> = {}) {
  return api().post(`/api/cart/${k.sessionId}/items`).set({ ...k.h, ...extraHeaders }).send(body);
}

export async function checkout(k: Kiosk, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return api().post(`/api/checkout/${k.sessionId}/confirm`).set({ ...k.h, ...headers }).send(body);
}

export async function registerClient(email = "guest@example.com", password = "password-123", kiosk?: Kiosk) {
  const res = await api()
    .post("/api/client-auth/register")
    .set(kiosk?.h ?? {})
    .send({ name: "Гость", email, password, ...(kiosk ? { kioskSessionId: kiosk.sessionId } : {}) });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { token: res.body.token as string, clientUserId: String(res.body.client.clientUserId), email, password };
}
