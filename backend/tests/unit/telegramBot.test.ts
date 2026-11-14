import { describe, expect, it } from "vitest";
import { BOT_COMMANDS, parseBotAction } from "../../src/modules/integrations/telegram.contract";

describe("Telegram bot command contract", () => {
  it("supports the six mandatory commands", () => {
    expect(BOT_COMMANDS).toEqual(["start", "login", "orders", "receipts", "logout", "help"]);
    for (const command of BOT_COMMANDS) expect(parseBotAction(`/${command}`)).toEqual({ command, argument: "" });
  });
  it("understands start payloads and bot mentions but rejects arbitrary text", () => {
    expect(parseBotAction("/start@RestaurantDemoBot g_dummy")).toEqual({ command: "start", argument: "g_dummy" });
    expect(parseBotAction("/orders additional text")).toEqual({ command: "orders", argument: "additional" });
    expect(parseBotAction("password=secret")).toBeNull();
    expect(parseBotAction("/unknown")).toBeNull();
  });
});
