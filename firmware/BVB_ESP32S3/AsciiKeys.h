#pragma once
#include <stdint.h>

namespace bvb {
struct AsciiKey { uint8_t usage; bool shift; };
// USB HID Usage Tables keyboard usages. Keep Shift separate from the usage:
// Japanese International1 (0x87) cannot fit Arduino's 7-bit ASCII layout table.
inline AsciiKey asciiKey(uint8_t c, bool jis) {
  if (c >= 'a' && c <= 'z') return {uint8_t(0x04 + c - 'a'), false};
  if (c >= 'A' && c <= 'Z') return {uint8_t(0x04 + c - 'A'), true};
  if (c >= '1' && c <= '9') return {uint8_t(0x1e + c - '1'), false};
  if (c == '0') return {0x27, false};
  switch (c) {
    case '\n': return {0x28, false}; case '\t': return {0x2b, false}; case ' ': return {0x2c, false};
    case '!': return {0x1e, true}; case '"': return {uint8_t(jis ? 0x1f : 0x34), true};
    case '#': return {0x20, true}; case '$': return {0x21, true}; case '%': return {0x22, true};
    case '&': return {uint8_t(jis ? 0x23 : 0x24), true};
    case '\'': return {uint8_t(jis ? 0x24 : 0x34), jis};
    case '(': return {uint8_t(jis ? 0x25 : 0x26), true}; case ')': return {uint8_t(jis ? 0x26 : 0x27), true};
    case '*': return {uint8_t(jis ? 0x34 : 0x25), true}; case '+': return {uint8_t(jis ? 0x33 : 0x2e), true};
    case ',': return {0x36, false}; case '-': return {0x2d, false}; case '.': return {0x37, false}; case '/': return {0x38, false};
    case ':': return {uint8_t(jis ? 0x34 : 0x33), !jis}; case ';': return {0x33, false};
    case '<': return {0x36, true}; case '=': return {uint8_t(jis ? 0x2d : 0x2e), jis};
    case '>': return {0x37, true}; case '?': return {0x38, true};
    case '@': return {uint8_t(jis ? 0x2f : 0x1f), !jis}; case '[': return {uint8_t(jis ? 0x30 : 0x2f), false};
    case '\\': return {uint8_t(jis ? 0x87 : 0x31), false}; case ']': return {uint8_t(jis ? 0x32 : 0x30), false};
    case '^': return {uint8_t(jis ? 0x2e : 0x23), !jis}; case '_': return {uint8_t(jis ? 0x87 : 0x2d), true};
    case '`': return {uint8_t(jis ? 0x2f : 0x35), jis}; case '{': return {uint8_t(jis ? 0x30 : 0x2f), true};
    case '|': return {uint8_t(jis ? 0x89 : 0x31), true}; case '}': return {uint8_t(jis ? 0x32 : 0x30), true};
    case '~': return {uint8_t(jis ? 0x2e : 0x35), true}; default: return {0, false};
  }
}
}
