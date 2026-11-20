// Web Serial, newline protocol at 9600 baud. Waits for the Uno boot handshake.
class SerialPayment {
  static isSupported() { return 'serial' in navigator && window.isSecureContext; }
  constructor() {
    this.port=null; this.reader=null; this.writer=null;
    this.onMessage=null; this.onDisconnect=null;
    this.closing=false; this.ready=false; this.readTask=null;
  }
  async connect() {
    try {
      const selected=await navigator.serial.requestPort();
      if(this.closing) throw new Error('Подключение отменено');
      this.port=selected;
      this.openTask=this.port.open({baudRate:9600});
      await this.openTask;
      if(this.closing) throw new Error('Подключение отменено');
      this.writer=this.port.writable.getWriter();
      this.reader=this.port.readable.getReader();
      this.readTask=this._readLoop();
      const deadline=Date.now()+8000;
      while(!this.ready) {
        if(this.failure) throw this.failure;
        if(this.closing) throw new Error('Подключение отменено');
        if(Date.now()>deadline) throw new Error('Arduino не отвечает. Загрузите прошивку rc522_payment.');
        await this.send('PING');
        await new Promise(resolve=>setTimeout(resolve,300));
      }
    } catch(error) { await this.disconnect(); throw error; }
  }
  async _readLoop() {
    const decoder=new TextDecoder(); let buffer='';
    try {
      while(!this.closing) {
        const {value,done}=await this.reader.read();
        if(done) break;
        buffer+=decoder.decode(value,{stream:true});
        if(buffer.length>4096) throw new Error('Некорректные данные Arduino');
        let index;
        while((index=buffer.indexOf('\n'))>=0) {
          const line=buffer.slice(0,index).trim(); buffer=buffer.slice(index+1);
          if(line==='READER_READY') this.ready=true;
          if(line==='ERROR:RC522_NOT_FOUND') this.failure=new Error('RC522 не найден: проверьте питание 3.3V и провода SPI.');
          // Defer callbacks: a callback may disconnect and await this read loop.
          if(line) queueMicrotask(()=>this.onMessage?.(line));
        }
      }
    } catch(error) { this.failure=error; }
    finally {
      this.reader?.releaseLock(); this.reader=null;
      if(!this.closing) {
        this.failure ||= new Error('Связь с Arduino потеряна');
        queueMicrotask(async()=> { await this.disconnect(); this.onDisconnect?.(); });
      }
    }
  }
  async send(command) {
    if(!this.writer || this.closing) throw new Error('Порт не открыт');
    await this.writer.write(new TextEncoder().encode(command+'\n'));
  }
  async disconnect() {
    if(this.closeTask) return this.closeTask;
    this.closing=true;
    this.closeTask=(async()=> {
      try { await this.openTask; } catch {}
      try { await this.reader?.cancel(); } catch {}
      try { await this.readTask; } catch {}
      try { this.writer?.releaseLock(); } catch {}
      this.writer=null;
      try { await this.port?.close(); } catch {}
      this.port=null; this.ready=false;
    })();
    return this.closeTask;
  }
}
