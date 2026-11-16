#pragma once
#include <stdint.h>
#include <stddef.h>
#include <string.h>

namespace bvb {
constexpr size_t MAX_BYTES = 4096;
constexpr char GOOGLE[] = "https://www.google.com/search?q=";
enum Operation : uint8_t { Open = 1, Search = 2, Legacy = 3 };
enum OS : uint8_t { Windows = 1, Mac = 2 };
enum State : uint8_t { Idle, Receiving, Queued, Executing };
enum Event : uint8_t { Accepted = 1, Done = 2, Error = 3 };
enum Reason : uint8_t { Busy = 1, Duplicate, Format, Size, Sequence, Encoding, ReceiveTimeout, Cancelled };
inline uint16_t u16(const uint8_t *p) { return p[0] | (uint16_t(p[1]) << 8); }
inline uint32_t u32(const uint8_t *p) { return p[0] | (uint32_t(p[1]) << 8) | (uint32_t(p[2]) << 16) | (uint32_t(p[3]) << 24); }
inline void put32(uint8_t *p, uint32_t n) { for (int i = 0; i < 4; ++i) p[i] = uint8_t(n >> (8 * i)); }
inline bool hex(uint8_t c) { return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'F'); }
inline unsigned hexNumber(uint8_t c) { return c <= '9' ? c - '0' : c - 'A' + 10; }
inline bool unreserved(uint8_t c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.'; }

struct Request {
  uint32_t id = 0;
  uint8_t op = 0, os = 0, enter = 0, layout = 0;
  uint16_t length = 0, shortcutMs = 0, launchMs = 0, focusMs = 0, keyMs = 0;
  uint8_t data[MAX_BYTES] = {};
};
inline bool validPayload(const Request &r) {
  if (r.op == Open) return r.length == 0;
  if (!r.length) return false;
  if (r.op == Search) {
    constexpr size_t prefix = sizeof(GOOGLE) - 1;
    if (r.length <= prefix || memcmp(r.data, GOOGLE, prefix)) return false;
    for (size_t i = prefix; i < r.length; ++i) {
      if (unreserved(r.data[i])) continue;
      if (r.data[i] != '%' || i + 2 >= r.length || !hex(r.data[i+1]) || !hex(r.data[i+2])) return false;
      i += 2;
    }
    return true;
  }
  for (size_t i = 0; i < r.length; ++i) {
    const auto c = r.data[i];
    if (c == 0x1e) {
      if (r.os != Windows) return false;
      size_t digits = 0; uint32_t code = 0;
      while (++i < r.length && r.data[i] != ';') {
        if (!hex(r.data[i]) || ++digits > 6) return false;
        code = (code << 4) | hexNumber(r.data[i]);
      }
      if (i == r.length || digits < 4 || code < 128 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return false;
    } else if (c >= 127 || (c < 32 && c != '\n' && c != '\t')) return false;
  }
  return true;
}

// Used only by the Arduino loop task. BLE callbacks enqueue packets; they never
// mutate a request or perform HID operations.
class Protocol {
public:
  using Notify = void (*)(uint8_t, uint32_t, uint8_t);
  explicit Protocol(Notify notify) : notify_(notify) {}
  State state = Idle;
  uint32_t highWater = 0;
  Request request;
  void receive(const uint8_t *p, size_t n, uint32_t now) {
    if (!n) return;
    if (p[0] == 0xb1) {
      if (n != 20) return;
      const uint32_t id = u32(p + 2);
      if (id <= highWater) { error(id, Duplicate); return; }
      if (state != Idle) { error(id, Busy); return; }
      if (p[1] != 2 || p[6] < Open || p[6] > Legacy || (p[7] != Windows && p[7] != Mac) || p[8] > 1 || p[9] > 1 ||
          u16(p+12) < 200 || u16(p+12) > 5000 || u16(p+14) < 500 || u16(p+14) > 15000 ||
          u16(p+16) < 100 || u16(p+16) > 5000 || u16(p+18) < 8 || u16(p+18) > 100) { error(id, Format); return; }
      const uint16_t len = u16(p+10);
      if (len > MAX_BYTES || (p[6] == Open ? len != 0 || p[8] != 0 : len == 0)) { error(id, Size); return; }
      request.id = id; request.op = p[6]; request.os = p[7]; request.enter = p[8]; request.layout = p[9];
      request.length = len; request.shortcutMs = u16(p+12); request.launchMs = u16(p+14);
      request.focusMs = u16(p+16); request.keyMs = u16(p+18);
      highWater = id; received_ = 0; state = Receiving; lastPacket_ = now;
      return;
    }
    if ((p[0] != 0xb2 && p[0] != 0xb3) || n < 5) return;
    const uint32_t id = u32(p+1);
    if (state != Receiving || request.id != id) { error(id, id <= highWater ? Duplicate : Sequence); return; }
    lastPacket_ = now;
    if (p[0] == 0xb2) {
      if (n < 8 || n > 20 || u16(p+5) != received_ || received_ + n - 7 > request.length) { fail(Sequence); return; }
      memcpy(request.data + received_, p+7, n-7); received_ += n-7;
    } else {
      if (n != 5 || received_ != request.length) { fail(Sequence); return; }
      if (!validPayload(request)) { fail(Encoding); return; }
      state = Queued; notify_(Accepted, id, 0);
    }
  }
  void tick(uint32_t now) { if (state == Receiving && uint32_t(now - lastPacket_) > 10000) fail(ReceiveTimeout); }
  bool begin() { if (state != Queued) return false; state = Executing; return true; }
  void complete(bool ok) { if (state != Executing) return; state = Idle; notify_(ok ? Done : Error, request.id, ok ? 0 : Cancelled); }
  void disconnected() { if (state != Executing) state = Idle; } // highWater survives BLE reconnects
private:
  Notify notify_;
  size_t received_ = 0;
  uint32_t lastPacket_ = 0;
  void error(uint32_t id, uint8_t reason) { notify_(Error, id, reason); }
  void fail(uint8_t reason) { state = Idle; error(request.id, reason); }
};
}
