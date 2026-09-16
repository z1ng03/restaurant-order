/*
  Демонстрационный модуль оплаты: Arduino Uno/Nano + RFID RC522.

  Протокол обмена с сайтом по Serial (9600 бод):
  сайт -> START_PAYMENT
  Arduino -> PAYMENT_APPROVED или PAYMENT_DECLINED

  ВАЖНО: RC522 не является банковским платёжным терминалом.
  Этот скетч подходит для учебного прототипа с RFID-картами/метками.
*/

#include <SPI.h>
#include <MFRC522.h>

#define SS_PIN 10
#define RST_PIN 9

MFRC522 rfid(SS_PIN, RST_PIN);
bool paymentRequested = false;

// true: для демонстрации принимается любая RFID-карта.
// false: принимаются только UID из списка AUTHORIZED_UIDS.
const bool APPROVE_ANY_CARD = true;

// Замените DE AD BE EF на UID своей тестовой карты.
const byte AUTHORIZED_UIDS[][4] = {
  {0xDE, 0xAD, 0xBE, 0xEF}
};

const byte AUTHORIZED_UID_COUNT = sizeof(AUTHORIZED_UIDS) / sizeof(AUTHORIZED_UIDS[0]);

bool uidIsAuthorized() {
  if (APPROVE_ANY_CARD) return true;
  if (rfid.uid.size != 4) return false;

  for (byte cardIndex = 0; cardIndex < AUTHORIZED_UID_COUNT; cardIndex++) {
    bool matches = true;
    for (byte uidIndex = 0; uidIndex < 4; uidIndex++) {
      if (rfid.uid.uidByte[uidIndex] != AUTHORIZED_UIDS[cardIndex][uidIndex]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

void setup() {
  Serial.begin(9600);
  SPI.begin();
  rfid.PCD_Init();
  Serial.println("READER_READY");
}

void loop() {
  if (Serial.available() > 0) {
    String command = Serial.readStringUntil('\n');
    command.trim();

    if (command == "START_PAYMENT") {
      paymentRequested = true;
      Serial.println("WAITING_FOR_CARD");
    } else if (command == "CANCEL_PAYMENT") {
      paymentRequested = false;
      Serial.println("PAYMENT_CANCELLED");
    }
  }

  if (!paymentRequested) return;
  if (!rfid.PICC_IsNewCardPresent()) return;
  if (!rfid.PICC_ReadCardSerial()) return;

  Serial.print("CARD_UID:");
  for (byte i = 0; i < rfid.uid.size; i++) {
    if (rfid.uid.uidByte[i] < 0x10) Serial.print("0");
    Serial.print(rfid.uid.uidByte[i], HEX);
    if (i + 1 < rfid.uid.size) Serial.print(":");
  }
  Serial.println();

  if (uidIsAuthorized()) {
    Serial.println("PAYMENT_APPROVED");
  } else {
    Serial.println("PAYMENT_DECLINED");
  }

  paymentRequested = false;
  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
  delay(600);
}
