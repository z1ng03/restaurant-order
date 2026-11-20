const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../serial-payment.js'),'utf8');
const tick=()=>new Promise(r=>setTimeout(r,0));
function fixture({open,request,reply=true}={}) {
  let controller,closed=0,opened=0; const commands=[];
  const port={
    readable:new ReadableStream({start(c){controller=c;}}),
    writable:new WritableStream({write(bytes){
      const command=new TextDecoder().decode(bytes); commands.push(command);
      if(reply&&command==='PING\n') controller.enqueue(new TextEncoder().encode('READER_READY\n'));
    }}),
    async open(){opened++;if(open)await open();},
    async close(){closed++;}
  };
  const context=vm.createContext({navigator:{serial:{requestPort:request|| (async()=>port)}},window:{isSecureContext:true},TextEncoder,TextDecoder,queueMicrotask,setTimeout,Date});
  const Class=vm.runInContext(source+'\nSerialPayment',context);
  return {client:new Class(),port,commands,send:text=>controller.enqueue(new TextEncoder().encode(text)),fail:()=>controller.error(new Error('unplugged')),closed:()=>closed,opened:()=>opened};
}
test('handshake, fragmented CRLF messages, and intentional close release the port',async()=>{
  const f=fixture();const lines=[];let disconnected=false;
  f.client.onMessage=line=>lines.push(line);f.client.onDisconnect=()=>disconnected=true;
  await f.client.connect(); assert.equal(f.client.ready,true);
  await f.client.send('START_PAYMENT');
  f.send('CARD_UID:AA:');f.send('BB:CC:DD\r\nPAYMENT_APPRO');f.send('VED\n');await tick();
  assert.deepEqual(lines.slice(-2),['CARD_UID:AA:BB:CC:DD','PAYMENT_APPROVED']);
  await f.client.disconnect(); assert.equal(f.closed(),1);assert.equal(disconnected,false);
  assert.equal(f.port.readable.locked,false);assert.equal(f.port.writable.locked,false);
});
test('cancel while the browser port picker is open never opens the selected port',async()=>{
  let choose; const f=fixture({request:()=>new Promise(resolve=>choose=resolve)});
  const connect=f.client.connect();const rejected=assert.rejects(connect,/отменено/);
  await f.client.disconnect();choose(f.port);await rejected;assert.equal(f.opened(),0);
});
test('cancel during open waits for open then closes exactly once',async()=>{
  let opened;const f=fixture({open:()=>new Promise(resolve=>opened=resolve)});
  const connect=f.client.connect();const rejected=assert.rejects(connect,/отменено/);await tick();
  const closing=f.client.disconnect();opened();await closing;await rejected;assert.equal(f.closed(),1);
});
test('unplug reports disconnect and releases writer lock',async()=>{
  const f=fixture();let disconnected=false;f.client.onDisconnect=()=>disconnected=true;
  await f.client.connect();f.fail();await tick();await tick();
  assert.equal(disconnected,true);assert.equal(f.closed(),1);assert.equal(f.port.writable.locked,false);
});
test('missing RC522 fails the handshake and releases the port',async()=>{
  const f=fixture({reply:false});const connecting=f.client.connect();
  const rejected=assert.rejects(connecting,/RC522/);await tick();f.send('ERROR:RC522_NOT_FOUND\n');
  await rejected;assert.equal(f.closed(),1);
});
