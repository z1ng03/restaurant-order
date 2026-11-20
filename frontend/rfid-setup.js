let device=null;
const $=id=>document.getElementById(id);
const messages={
  READER_READY:'Arduino готова.', WAITING_FOR_CARD:'Приложите карту к антенне (ожидание до 60 секунд).',
  ENROLLED_APPROVED:'Карта «Успех» сохранена. Уберите её от антенны.',
  ENROLLED_DECLINED:'Карта «Отказ» сохранена. Уберите её от антенны.',
  PAYMENT_APPROVED:'Оплата одобрена (учебная проверка).', PAYMENT_DECLINED:'Оплата отклонена (учебная проверка).',
  PAYMENT_CANCELLED:'Ожидание отменено.', PAYMENT_TIMEOUT:'Время ожидания истекло. Повторите проверку.',
  'ERROR:SAME_CARD':'Эта карта уже назначена другому результату. Возьмите вторую карту.',
  'ERROR:CARDS_NOT_CONFIGURED':'Сначала назначьте обе карты.',
  'ERROR:RC522_NOT_FOUND':'RC522 не найден. Отключите USB и проверьте схему подключения.'
};
function controls(connected) {
  $('connect').disabled=connected; $('disconnect').disabled=!connected;
  document.querySelectorAll('[data-command]').forEach(b=>b.disabled=!connected);
}
function log(line) { $('log').textContent=($('log').textContent+line+'\n').split('\n').slice(-80).join('\n'); }
$('connect').onclick=async()=> {
  if(!SerialPayment.isSupported()) { $('status').textContent='Нужен Chrome или Edge и адрес http://localhost:8000.'; return; }
  $('connect').disabled=true;
  const current=new SerialPayment(); device=current;
  current.onMessage=line=> {
    if(device!==current) return;
    log(line);
    if(messages[line] && (line!=='READER_READY' || document.getElementById("disconnect").disabled)) $('status').textContent=messages[line];
    if(line.startsWith('APPROVED_UID:')) $('approved').textContent=line.slice(13);
    if(line.startsWith('DECLINED_UID:')) $('declined').textContent=line.slice(13);
    if(line.startsWith('ENROLLED_')) void current.send('STATUS').catch(error=>{$('status').textContent=error.message;});
  };
  current.onDisconnect=()=> { if(device===current) { device=null; controls(false); $('status').textContent='Соединение потеряно. Подключите Arduino снова.'; } };
  try { await current.connect(); controls(true); }
  catch(error) { device=null; controls(false); $('status').textContent=error.message; }
};
$('disconnect').onclick=async()=> {
  const current=device; device=null; controls(false);
  if(current) { try { await current.send('CANCEL_PAYMENT'); } catch {} await current.disconnect(); }
  $('status').textContent='Отключено. Можно открыть корзину.';
};
document.querySelectorAll('[data-command]').forEach(button=>button.onclick=async()=> {
  try { await device.send(button.dataset.command); }
  catch(error) { $('status').textContent=error.message; }
});
