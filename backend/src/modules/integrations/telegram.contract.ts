/** Pure bot command parser with no database dependencies. */
export const BOT_COMMANDS = ["start", "login", "orders", "receipts", "logout", "help"] as const;
export function parseBotAction(text: string): { command: string; argument: string } | null {
  const m = /^\/(start|login|orders|receipts|logout|help)(?:@[A-Za-z0-9_]+)?(?:\s+([^\s]+))?\s*$/i.exec(text.trim());
  return m ? { command: m[1]!.toLowerCase(), argument: m[2] ?? "" } : null;
}

