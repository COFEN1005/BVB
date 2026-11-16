#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <atomic>
#include "USB.h"
#include "USBHIDKeyboard.h"
#include "tusb.h"
#include "BridgeProtocol.h"
#include "HidSequence.h"
#include "AsciiKeys.h"

#if !defined(CONFIG_IDF_TARGET_ESP32S3)
#error This sketch requires an ESP32-S3.
#endif
#if !defined(ARDUINO_USB_MODE) || ARDUINO_USB_MODE == 1
#error Select USB-OTG (TinyUSB), not Hardware CDC and JTAG.
#endif

static constexpr char DEVICE_NAME[] = "ESP-BVB Bridge";
static constexpr char SERVICE_UUID[] = "7f510001-6f3b-4f37-9d9a-6c7f5f11b001";
static constexpr char WRITE_UUID[] = "7f510002-6f3b-4f37-9d9a-6c7f5f11b001";
static constexpr char STATUS_UUID[] = "7f510003-6f3b-4f37-9d9a-6c7f5f11b001";
static constexpr char CAPS_UUID[] = "7f510004-6f3b-4f37-9d9a-6c7f5f11b001";

USBHIDKeyboard Keyboard;
BLECharacteristic *statusCharacteristic = nullptr;
std::atomic<uint32_t> generation{0};
std::atomic<bool> connected{false}, overflowed{false}, usbInterrupted{false}, executing{false};
struct Packet { uint32_t generation; bool duringExecution; uint8_t length; uint8_t data[20]; };
QueueHandle_t packetQueue;
uint32_t bootId, observedGeneration = 0, requestGeneration = 0;
uint8_t capsSnapshot[16] = {};
portMUX_TYPE capsMux = portMUX_INITIALIZER_UNLOCKED;

void notifyStatus(uint8_t event, uint32_t id, uint8_t reason) {
  uint8_t status[7] = {0xc2, event, 0, 0, 0, 0, reason};
  bvb::put32(status+2, id);
  if (statusCharacteristic && connected.load()) {
    statusCharacteristic->setValue(status, sizeof(status));
    statusCharacteristic->notify();
  }
}
bvb::Protocol protocol(notifyStatus);

void publishCaps() {
  uint8_t value[16] = {'B', 'V', 'B', '2', 7, uint8_t(protocol.state), 0, 16};
  bvb::put32(value+8, bootId); bvb::put32(value+12, protocol.highWater);
  portENTER_CRITICAL(&capsMux);
  memcpy(capsSnapshot, value, sizeof(value));
  portEXIT_CRITICAL(&capsMux);
}

class CapabilityCallbacks : public BLECharacteristicCallbacks {
  void onRead(BLECharacteristic *characteristic) override {
    uint8_t value[16];
    portENTER_CRITICAL(&capsMux);
    memcpy(value, capsSnapshot, sizeof(value));
    portEXIT_CRITICAL(&capsMux);
    characteristic->setValue(value, sizeof(value));
  }
};
class WriteCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *characteristic) override {
    const String value = characteristic->getValue();
    if (!connected.load() || value.length() == 0 || value.length() > 20) return;
    Packet packet{}; packet.generation = generation.load(); packet.length = value.length();
    packet.duringExecution = executing.load();
    memcpy(packet.data, value.c_str(), packet.length);
    if (xQueueSend(packetQueue, &packet, 0) != pdTRUE) overflowed.store(true);
  }
};
class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *) override { connected.store(true); }
  void onDisconnect(BLEServer *) override { connected.store(false); generation.fetch_add(1); }
};

// Called during every wait as well as while idle; a second START is rejected
// while Executing. No pending operation can run after the current operation.
void serviceTransport() {
  const uint32_t current = generation.load();
  if (current != observedGeneration) {
    observedGeneration = current; protocol.disconnected(); Keyboard.releaseAll();
  }
  if (overflowed.exchange(false)) {
    usbInterrupted.store(true); protocol.disconnected();
    xQueueReset(packetQueue); Keyboard.releaseAll();
  }
  Packet packet;
  // Bounded work prevents a flooding peer from starving cancellation checks.
  for (int i = 0; i < 16 && xQueueReceive(packetQueue, &packet, 0) == pdTRUE; ++i) {
    if (!connected.load() || packet.generation != generation.load()) continue;
    if (packet.duringExecution) {
      const bool start = packet.data[0] == 0xb1 && packet.length == 20;
      if (start || ((packet.data[0] == 0xb2 || packet.data[0] == 0xb3) && packet.length >= 5)) {
        const uint32_t id = bvb::u32(packet.data + (start ? 2 : 1));
        notifyStatus(bvb::Error, id, id <= protocol.highWater ? bvb::Duplicate : bvb::Busy);
      }
      continue;
    }
    const auto before = protocol.state;
    protocol.receive(packet.data, packet.length, millis());
    if (before == bvb::Idle && protocol.state == bvb::Receiving) requestGeneration = packet.generation;
  }
  protocol.tick(millis()); publishCaps();
}

class KeyboardSink {
public:
  KeyboardSink(uint32_t session, uint16_t interval, bool jis) : session_(session), interval_(interval), jis_(jis) {}
  bool pause(uint32_t ms) {
    const uint32_t start = millis();
    do {
      serviceTransport();
      if (!connected.load() || generation.load() != session_ || usbInterrupted.load() || !tud_mounted() || tud_suspended()) { release(); return false; }
      delay(2);
    } while (uint32_t(millis() - start) < ms);
    return true;
  }
  void release() { Keyboard.releaseAll(); }
  bool character(uint8_t c) {
    if (!pause(0)) return false;
    const auto key = bvb::asciiKey(c, jis_);
    if (!key.usage) return false;
    if (key.shift) Keyboard.pressRaw(0xe1);
    const bool ok = Keyboard.pressRaw(key.usage) != 0;
    const bool held = pause(8); release();
    return ok && held && pause(interval_);
  }
  bool enter() { return character('\n'); }
  bool imeOff() {
    if (!pause(0)) return false;
    // HID LANG2 maps to VK_IME_OFF on Japanese Windows keyboards; it is not a toggle.
    const bool ok = Keyboard.pressRaw(0x91) != 0;
    const bool held = pause(25); release();
    return ok && held && pause(120);
  }
  bool chord(bvb::Modifier modifier, uint8_t key) {
    if (!pause(0)) return false;
    release();
    Keyboard.press(modifier == bvb::Control ? KEY_LEFT_CTRL : modifier == bvb::Alt ? KEY_LEFT_ALT : KEY_LEFT_GUI);
    bool ok = pause(25);
    if (ok) ok = Keyboard.press(key) != 0 && pause(25);
    release();
    return ok && pause(interval_);
  }
private:
  uint32_t session_;
  uint16_t interval_;
  bool jis_;
};

void setup() {
  Serial.begin(115200);
  packetQueue = xQueueCreate(16, sizeof(Packet));
  if (!packetQueue) { while (true) delay(1000); }
  bootId = esp_random(); publishCaps();
  USB.productName("BVB PC Keyboard");
  USB.onEvent([](void *, esp_event_base_t, int32_t event, void *) {
    if (event == ARDUINO_USB_STOPPED_EVENT || event == ARDUINO_USB_SUSPEND_EVENT) usbInterrupted.store(true);
  });
  Keyboard.begin(KeyboardLayout_en_US); USB.begin();
  BLEDevice::init(DEVICE_NAME);
  BLEServer *server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks()); server->advertiseOnDisconnect(true);
  BLEService *service = server->createService(SERVICE_UUID);
  auto *write = service->createCharacteristic(WRITE_UUID, BLECharacteristic::PROPERTY_WRITE);
  write->setCallbacks(new WriteCallbacks());
  statusCharacteristic = service->createCharacteristic(STATUS_UUID, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  auto *caps = service->createCharacteristic(CAPS_UUID, BLECharacteristic::PROPERTY_READ);
  caps->setCallbacks(new CapabilityCallbacks()); caps->setValue(capsSnapshot, sizeof(capsSnapshot));
  service->start();
  BLEAdvertising *advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(SERVICE_UUID); advertising->setScanResponse(true);
  advertising->setMinPreferred(0x06); advertising->setMaxPreferred(0x12);
  BLEDevice::startAdvertising();
}

void loop() {
  serviceTransport();
  if (protocol.begin()) {
    executing.store(true);
    publishCaps();
    usbInterrupted.store(false);
    KeyboardSink sink(requestGeneration, protocol.request.keyMs, protocol.request.layout == 1);
    const bool ok = bvb::runHid(protocol.request, sink);
    Keyboard.releaseAll();
    protocol.complete(ok); publishCaps();
    executing.store(false);
  }
  delay(2);
}
