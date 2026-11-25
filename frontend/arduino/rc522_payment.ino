/* Restaurant Order: учебный RFID-терминал, реальные деньги не списывает.
   Uno: RC522 SS=D10, RST=D9, MOSI=D11, MISO=D12, SCK=D13, питание 3.3V.
   RGB: R=D5, G=D6, B=D7 через отдельные резисторы 330 Ом. Без пищалки. D4 не используется.
   Полная схема: ../../rfid-setup.html и docs/RFID_SETUP.md.
   Serial 9600, команды/ответы — одна строка. Карты хранятся в EEPROM.
*/
#include <SPI.h>
#include <MFRC522.h>
#include <EEPROM.h>

const byte RED_PIN=5, GREEN_PIN=6, BLUE_PIN=7;
// Модуль с контактом '-' / общий катод: false. Общий анод: true, общий на 5V.
const bool COMMON_ANODE=false;
MFRC522 rfid(10,9);
struct Card { byte size; byte uid[10]; };
Card approvedCard, declinedCard, waiterCard;
enum Mode { IDLE, PAYMENT, AGE_CHECK, LEARN_APPROVED, LEARN_DECLINED, LEARN_WAITER };
Mode mode=IDLE;
bool readerOK=false;
char command[48];
byte commandLength=0;
bool commandOverflow=false;
unsigned long modeStarted=0, signalStarted=0;
byte signalType=0;

void color(bool r,bool g,bool b) {
  digitalWrite(RED_PIN,r != COMMON_ANODE);
  digitalWrite(GREEN_PIN,g != COMMON_ANODE);
  digitalWrite(BLUE_PIN,b != COMMON_ANODE);
}
bool validSize(byte size) { return size==4 || size==7 || size==10; }
bool matches(const Card &card) {
  return validSize(card.size) && card.size==rfid.uid.size &&
    memcmp(card.uid,rfid.uid.uidByte,card.size)==0;
}
void stopActivity() { mode=IDLE; signalType=0; color(false,false,false); }
void signalResult(bool ok) {
  signalType=ok ? 1 : 2; signalStarted=millis();
  color(!ok,ok,false);
}
void updateSignal() {
  if (!signalType) return;
  unsigned long elapsed=millis()-signalStarted;
  if (elapsed>=1800) { signalType=0; color(false,false,false); }
}
void printCard(const Card &card) {
  if (!validSize(card.size)) { Serial.print(F("NONE")); return; }
  for(byte i=0;i<card.size;i++) {
    if(i) Serial.print(':');
    if(card.uid[i]<16) Serial.print('0');
    Serial.print(card.uid[i],HEX);
  }
}
void status() {
  Serial.println(readerOK ? F("READER_READY") : F("ERROR:RC522_NOT_FOUND"));
  Serial.print(F("APPROVED_UID:")); printCard(approvedCard); Serial.println();
  Serial.print(F("DECLINED_UID:")); printCard(declinedCard); Serial.println();
  Serial.print(F("WAITER_UID:")); printCard(waiterCard); Serial.println();
  Serial.println(F("PROTOCOL:3"));
}
void handleCommand() {
  if (!strcmp(command,"PING") || !strcmp(command,"STATUS")) { status(); return; }
  if ((!strcmp(command,"CANCEL_PAYMENT") || !strcmp(command,"CANCEL_AGE"))) { stopActivity(); Serial.println(F("PAYMENT_CANCELLED")); return; }
  if (!strcmp(command,"TEST_GREEN")) { stopActivity(); signalResult(true); return; }
  if (!strcmp(command,"TEST_RED")) { stopActivity(); signalResult(false); return; }
  if (!strcmp(command,"TEST_YELLOW")) { stopActivity(); color(true,true,false); return; }
  if (!strcmp(command,"TEST_BLUE")) { stopActivity(); color(false,false,true); return; }
  if (!readerOK) { Serial.println(F("ERROR:RC522_NOT_FOUND")); return; }
  if (!strcmp(command,"START_PAYMENT")) {
    if (!validSize(approvedCard.size) || !validSize(declinedCard.size)) {
      Serial.println(F("ERROR:CARDS_NOT_CONFIGURED")); return;
    }
    stopActivity(); mode=PAYMENT;
  } else if (!strcmp(command,"START_AGE")) {
    if (!validSize(waiterCard.size)) { Serial.println(F("ERROR:WAITER_NOT_CONFIGURED")); return; }
    stopActivity(); mode=AGE_CHECK;
  } else if (!strcmp(command,"ENROLL_APPROVED")) { stopActivity(); mode=LEARN_APPROVED; }
  else if (!strcmp(command,"ENROLL_DECLINED")) { stopActivity(); mode=LEARN_DECLINED; }
  else if (!strcmp(command,"ENROLL_WAITER")) { stopActivity(); mode=LEARN_WAITER; }
  else { Serial.println(F("ERROR:UNKNOWN_COMMAND")); return; }
  modeStarted=millis(); color(true,true,false); Serial.println(F("WAITING_FOR_CARD"));
}
void setup() {
  pinMode(RED_PIN,OUTPUT); pinMode(GREEN_PIN,OUTPUT); pinMode(BLUE_PIN,OUTPUT);
  stopActivity(); Serial.begin(9600);
  SPI.begin(); rfid.PCD_Init();
  byte version=rfid.PCD_ReadRegister(MFRC522::VersionReg);
  readerOK=version!=0 && version!=0xFF;
  if(EEPROM.read(0)==0x52 && (EEPROM.read(1)==0x02 || EEPROM.read(1)==0x03)) {
    EEPROM.get(2,approvedCard); EEPROM.get(2+sizeof(Card),declinedCard);
    if (EEPROM.read(1)==0x03) EEPROM.get(2+2*sizeof(Card),waiterCard);
  } else { approvedCard.size=0; declinedCard.size=0; }
  status();
}
void loop() {
  updateSignal();
  while(Serial.available()) {
    char c=Serial.read();
    if(c=='\r') continue;
    if(c=='\n') {
      command[commandLength]=0;
      if(commandOverflow) Serial.println(F("ERROR:COMMAND_TOO_LONG"));
      else if(commandLength) handleCommand();
      commandLength=0; commandOverflow=false;
    } else if(commandLength<sizeof(command)-1) command[commandLength++]=c;
    else commandOverflow=true;
  }
  if(mode==IDLE) return;
  if(millis()-modeStarted>=60000UL) { bool age=mode==AGE_CHECK; stopActivity(); signalResult(false); Serial.println(age ? F("AGE_TIMEOUT") : F("PAYMENT_TIMEOUT")); return; }
  if(!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial()) return;
  Card scanned={}; scanned.size=rfid.uid.size;
  if(!validSize(scanned.size)) { Serial.println(F("ERROR:UID_SIZE")); stopActivity(); return; }
  memcpy(scanned.uid,rfid.uid.uidByte,scanned.size);
  Serial.print(F("CARD_UID:")); printCard(scanned); Serial.println();
  if(mode==LEARN_APPROVED || mode==LEARN_DECLINED || mode==LEARN_WAITER) {
    bool duplicate=(mode!=LEARN_APPROVED && matches(approvedCard)) ||
      (mode!=LEARN_DECLINED && matches(declinedCard)) || (mode!=LEARN_WAITER && matches(waiterCard));
    if(duplicate) { Serial.println(F("ERROR:SAME_CARD")); signalResult(false); }
    else {
      if(mode==LEARN_APPROVED) approvedCard=scanned;
      else if(mode==LEARN_DECLINED) declinedCard=scanned;
      else waiterCard=scanned;
      EEPROM.put(2,approvedCard); EEPROM.put(2+sizeof(Card),declinedCard);
      EEPROM.put(2+2*sizeof(Card),waiterCard);
      EEPROM.update(0,0x52); EEPROM.update(1,0x03);
      if(mode==LEARN_WAITER) Serial.println(F("ENROLLED_WAITER"));
      else Serial.println(mode==LEARN_APPROVED ? F("ENROLLED_APPROVED") : F("ENROLLED_DECLINED"));
      signalResult(true);
    }
  } else if(mode==AGE_CHECK) {
    // The server checks this UID against an active staff account before confirming age.
    if(matches(waiterCard)) { Serial.print(F("AGE_CARD:")); printCard(scanned); Serial.println(); }
    else { Serial.println(F("AGE_DECLINED")); signalResult(false); }
  } else {
    bool approve=matches(approvedCard);
    if(!approve && !matches(declinedCard)) Serial.println(F("UNKNOWN_CARD"));
    Serial.println(approve ? F("PAYMENT_APPROVED") : F("PAYMENT_DECLINED"));
    signalResult(approve);
  }
  mode=IDLE; rfid.PICC_HaltA(); rfid.PCD_StopCrypto1();
}
