#pragma once
#include "BridgeProtocol.h"

namespace bvb {
enum Modifier { Control, Alt, GUI };
// Sink provides interruptible key/chord/pause and unconditional release. The
// same sequence runs on hardware and in host tests; payload is never a command.
template<class Sink> bool runHid(const Request &r, Sink &s) {
  struct Release { Sink &sink; ~Release() { sink.release(); } } guard{s};
  s.release();
  const auto primary = r.os == Windows ? Control : GUI;
  if (r.op == Legacy && r.os == Windows) {
    bool unicode = false;
    for (size_t i = 0; i < r.length; ++i) if (r.data[i] == 0x1e) { unicode = true; break; }
    // Preserve upstream's IME-off fix for legacy Unicode input only.
    if (unicode && !s.imeOff()) return false;
  }
  if (r.op == Open || r.op == Search) {
    if (!s.chord(GUI, r.os == Windows ? 'r' : ' ') || !s.pause(r.shortcutMs)) return false;
    if (!s.chord(primary, 'a') || !s.pause(r.shortcutMs)) return false;
    const char *command = r.os == Windows ? "chrome" : "Google Chrome";
    while (*command) if (!s.character(*command++)) return false;
    if (!s.pause(r.shortcutMs) || !s.enter() || !s.pause(r.launchMs)) return false;
    if (r.op == Open) return true;
    if (!s.chord(primary, 'l') || !s.pause(r.focusMs)) return false;
  }
  for (size_t i = 0; i < r.length; ++i) {
    if (r.op == Legacy && r.data[i] == 0x1e) {
      if (!s.character('U') || !s.character('+')) return false;
      while (++i < r.length && r.data[i] != ';') if (!s.character(r.data[i])) return false;
      if (!s.pause(60) || !s.chord(Alt, 'x') || !s.pause(250)) return false;
    } else if (!s.character(r.data[i])) return false;
  }
  return !r.enter || s.enter();
}
}
