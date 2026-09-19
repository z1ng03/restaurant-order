// Talks to frontend/arduino/rc522_payment.ino over Web Serial at 9600 baud.
// Protocol (see the sketch and README.txt):
//   site -> START_PAYMENT | CANCEL_PAYMENT
//   Arduino -> READER_READY | WAITING_FOR_CARD | CARD_UID:.. |
//              PAYMENT_APPROVED | PAYMENT_DECLINED | PAYMENT_CANCELLED
// Only available in Chromium-based browsers (Chrome/Edge) — README.txt
// already tells the person to use one of those.

class SerialPayment {
  static isSupported() {
    return "serial" in navigator;
  }

  constructor() {
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.readableClosed = null;
    this.writableClosed = null;
    this.onMessage = null; // (line: string) => void
    this.onDisconnect = null; // () => void
  }

  async connect() {
    this.port = await navigator.serial.requestPort();
    await this.port.open({ baudRate: 9600 });

    const textDecoder = new TextDecoderStream();
    this.readableClosed = this.port.readable.pipeTo(textDecoder.writable);
    this.reader = textDecoder.readable.getReader();

    const textEncoder = new TextEncoderStream();
    this.writableClosed = textEncoder.readable.pipeTo(this.port.writable);
    this.writer = textEncoder.writable.getWriter();

    this._readLoop();
  }

  async _readLoop() {
    let buffer = "";
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await this.reader.read();
        if (done) break;
        buffer += value;
        let newlineIndex;
        while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line) this.onMessage?.(line);
        }
      }
    } catch {
      // Port went away mid-read (unplugged, etc.) — treat like a disconnect.
    }
    this.onDisconnect?.();
  }

  async send(command) {
    if (!this.writer) throw new Error("Порт не открыт");
    await this.writer.write(`${command}\n`);
  }

  async disconnect() {
    try {
      await this.reader?.cancel();
    } catch {
      /* already closed */
    }
    try {
      await this.writer?.close();
    } catch {
      /* already closed */
    }
    try {
      await this.readableClosed;
    } catch {
      /* already closed */
    }
    try {
      await this.writableClosed;
    } catch {
      /* already closed */
    }
    try {
      await this.port?.close();
    } catch {
      /* already closed */
    }
    this.port = null;
    this.reader = null;
    this.writer = null;
  }
}
