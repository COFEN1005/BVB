#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include "USB.h"
#include "USBHIDKeyboard.h"

#if !defined(CONFIG_IDF_TARGET_ESP32S3)
#error This sketch requires an ESP32-S3.
#endif

#ifndef ARDUINO_USB_MODE
#error Select an ESP32-S3 board with native USB support.
#elif ARDUINO_USB_MODE == 1
#error Tools > USB Mode must be set to USB-OTG (TinyUSB), not Hardware CDC and JTAG.
#endif

// These UUIDs must match dist/index.html.
static constexpr char DEVICE_NAME[] = "ESP-BVB Bridge";
static constexpr char SERVICE_UUID[] = "7f510001-6f3b-4f37-9d9a-6c7f5f11b001";
static constexpr char WRITE_UUID[]   = "7f510002-6f3b-4f37-9d9a-6c7f5f11b001";
static constexpr char STATUS_UUID[]  = "7f510003-6f3b-4f37-9d9a-6c7f5f11b001";

static constexpr size_t MAX_TEXT_BYTES = 4096;
static constexpr uint8_t PACKET_START = 0xA1;
static constexpr uint8_t PACKET_DATA  = 0xA2;
static constexpr uint8_t PACKET_END   = 0xA3;
static constexpr uint8_t FLAG_APPEND_ENTER = 0x01;
static constexpr uint8_t FLAG_ALT_X = 0x02;
static constexpr uint8_t UNICODE_MARKER = 0x1e;

USBHIDKeyboard Keyboard;
BLECharacteristic *statusCharacteristic = nullptr;

struct IncomingMessage {
  bool active = false;
  uint16_t id = 0;
  uint32_t expectedLength = 0;
  uint32_t receivedLength = 0;
  uint8_t flags = 0;
  uint8_t data[MAX_TEXT_BYTES + 1] = {};
};

IncomingMessage incoming;
portMUX_TYPE readyMux = portMUX_INITIALIZER_UNLOCKED;
volatile bool messageReady = false;
uint32_t readyLength = 0;
uint8_t readyFlags = 0;
uint8_t readyData[MAX_TEXT_BYTES + 1] = {};

uint16_t readU16LE(const uint8_t *data) {
  return static_cast<uint16_t>(data[0]) |
         (static_cast<uint16_t>(data[1]) << 8);
}

uint32_t readU32LE(const uint8_t *data) {
  return static_cast<uint32_t>(data[0]) |
         (static_cast<uint32_t>(data[1]) << 8) |
         (static_cast<uint32_t>(data[2]) << 16) |
         (static_cast<uint32_t>(data[3]) << 24);
}

void notifyStatus(const String &status) {
  if (statusCharacteristic == nullptr) return;
  statusCharacteristic->setValue(status.c_str());
  statusCharacteristic->notify();
}

void failMessage(uint16_t id, const char *reason) {
  incoming.active = false;
  notifyStatus("ERR:" + String(id) + ":" + reason);
}

bool containsUnsupportedUnicode(const uint8_t *data, size_t length) {
  for (size_t i = 0; i < length; ++i) {
    if (data[i] >= 0x80) return true;
  }
  return false;
}

int hexValue(uint8_t c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

bool validAltXPayload(const uint8_t *data, size_t length) {
  for (size_t i = 0; i < length;) {
    if (data[i] != UNICODE_MARKER) {
      if (data[i] >= 0x80) return false;
      ++i;
      continue;
    }
    ++i;
    uint32_t codepoint = 0;
    size_t digits = 0;
    while (i < length && data[i] != ';') {
      const int digit = hexValue(data[i++]);
      if (digit < 0 || ++digits > 6) return false;
      codepoint = (codepoint << 4) | digit;
    }
    if (i == length || digits < 4 || codepoint > 0x10ffff ||
        (codepoint >= 0xd800 && codepoint <= 0xdfff)) return false;
    ++i;
  }
  return true;
}

class TextWriteCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *characteristic) override {
    String value = characteristic->getValue();
    const size_t length = value.length();
    if (length == 0) return;

    const uint8_t *packet = reinterpret_cast<const uint8_t *>(value.c_str());
    const uint8_t type = packet[0];

    if (type == PACKET_START) {
      if (length != 8) return;
      const uint16_t id = readU16LE(packet + 1);
      const uint32_t expected = readU32LE(packet + 3);
      if (expected == 0 || expected > MAX_TEXT_BYTES) {
        failMessage(id, "SIZE");
        return;
      }

      incoming.active = true;
      incoming.id = id;
      incoming.expectedLength = expected;
      incoming.receivedLength = 0;
      incoming.flags = packet[7];
      return;
    }

    if (type == PACKET_DATA) {
      if (length < 6 || !incoming.active) return;
      const uint16_t id = readU16LE(packet + 1);
      const uint16_t offset = readU16LE(packet + 3);
      const size_t payloadLength = length - 5;

      if (id != incoming.id || offset != incoming.receivedLength ||
          incoming.receivedLength + payloadLength > incoming.expectedLength) {
        failMessage(id, "SEQUENCE");
        return;
      }

      memcpy(incoming.data + incoming.receivedLength, packet + 5, payloadLength);
      incoming.receivedLength += payloadLength;
      return;
    }

    if (type == PACKET_END) {
      if (length != 3 || !incoming.active) return;
      const uint16_t id = readU16LE(packet + 1);
      if (id != incoming.id || incoming.receivedLength != incoming.expectedLength) {
        failMessage(id, "INCOMPLETE");
        return;
      }

      if (incoming.flags & FLAG_ALT_X) {
        if (!validAltXPayload(incoming.data, incoming.receivedLength)) {
          failMessage(id, "ENCODING");
          return;
        }
      } else if (containsUnsupportedUnicode(incoming.data, incoming.receivedLength)) {
        failMessage(id, "UNICODE");
        return;
      }

      bool accepted = false;
      portENTER_CRITICAL(&readyMux);
      if (!messageReady) {
        memcpy(readyData, incoming.data, incoming.receivedLength);
        readyData[incoming.receivedLength] = 0;
        readyLength = incoming.receivedLength;
        readyFlags = incoming.flags;
        messageReady = true;
        accepted = true;
      }
      portEXIT_CRITICAL(&readyMux);

      incoming.active = false;
      if (accepted) {
        notifyStatus("OK:" + String(id));
      } else {
        notifyStatus("ERR:" + String(id) + ":BUSY");
      }
    }
  }
};

void setupBLE() {
  BLEDevice::init(DEVICE_NAME);
  Serial.print("BLE address: ");
  Serial.println(BLEDevice::getAddress().toString());

  BLEServer *server = BLEDevice::createServer();
  server->advertiseOnDisconnect(true);

  BLEService *service = server->createService(SERVICE_UUID);
  BLECharacteristic *writeCharacteristic = service->createCharacteristic(
    WRITE_UUID,
    BLECharacteristic::PROPERTY_WRITE
  );
  statusCharacteristic = service->createCharacteristic(
    STATUS_UUID,
    BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY
  );

  writeCharacteristic->setCallbacks(new TextWriteCallbacks());
  statusCharacteristic->setValue("READY:ALT_X_V1");
  service->start();

  BLEAdvertising *advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(SERVICE_UUID);
  advertising->setScanResponse(true);
  advertising->setMinPreferred(0x06);
  advertising->setMaxPreferred(0x12);
  BLEDevice::startAdvertising();
  Serial.println("BLE advertising: ESP-BVB Bridge");
}

void typeReadyMessage() {
  static uint8_t localData[MAX_TEXT_BYTES + 1];
  uint32_t localLength = 0;
  uint8_t localFlags = 0;

  portENTER_CRITICAL(&readyMux);
  if (messageReady) {
    localLength = readyLength;
    localFlags = readyFlags;
    memcpy(localData, readyData, localLength + 1);
    messageReady = false;
  }
  portEXIT_CRITICAL(&readyMux);

  if (localLength == 0) return;

  for (uint32_t i = 0; i < localLength;) {
    const uint8_t c = localData[i++];
    if ((localFlags & FLAG_ALT_X) && c == UNICODE_MARKER) {
      Keyboard.write('U');
      Keyboard.write('+');
      while (i < localLength && localData[i] != ';') {
        Keyboard.write(localData[i++]);
        delay(8);
      }
      ++i;  // Skip the validated terminator.
      delay(25);
      Keyboard.press(KEY_LEFT_ALT);
      delay(12);
      Keyboard.press('x');
      delay(12);
      Keyboard.releaseAll();
      delay(45);
    } else if (c != '\r') {
      Keyboard.write(c);
      delay(8);
    }
  }

  if (localFlags & FLAG_APPEND_ENTER) {
    Keyboard.write('\n');
  }
}

void setup() {
  Serial.begin(115200);
  Serial.println("BVB PC keyboard starting");
  USB.productName("BVB PC Keyboard");
  Keyboard.begin(KeyboardLayout_ja_JP);
  USB.begin();
  delay(800);
  setupBLE();
}

void loop() {
  if (messageReady) typeReadyMessage();
  delay(2);
}
