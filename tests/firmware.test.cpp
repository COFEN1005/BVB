#include "../firmware/BVB_ESP32S3/HidSequence.h"
#include "../firmware/BVB_ESP32S3/AsciiKeys.h"
#include <cassert>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>
#include <tuple>
using namespace bvb;
using Frame = std::vector<uint8_t>;
std::vector<std::tuple<uint8_t, uint32_t, uint8_t>> replies;
void notify(uint8_t e, uint32_t id, uint8_t why) { replies.emplace_back(e,id,why); }
std::vector<Frame> fixture(const char *name) {
  std::ifstream in(std::string(".build/") + name + ".bin", std::ios::binary);
  assert(in); std::vector<Frame> frames; char length;
  while (in.get(length)) { Frame f(uint8_t(length), 0); in.read(reinterpret_cast<char*>(f.data()), f.size()); assert(in); frames.push_back(f); }
  return frames;
}
void feed(Protocol &p, const Frame &f, uint32_t t = 1) { p.receive(f.data(), f.size(), t); }
struct Sink {
  std::string text;
  std::vector<std::string> actions;
  int enters = 0, releases = 0, steps = 0, imeOffs = 0, cancelAfter = 100000;
  bool next() { return ++steps < cancelAfter; }
  bool pause(uint32_t) { return next(); }
  void release() { ++releases; }
  bool chord(Modifier m, uint8_t key) { actions.push_back(std::to_string(m) + ":" + char(key)); return next(); }
  bool character(uint8_t c) { text += char(c); return next(); }
  bool enter() { ++enters; return next(); }
  bool imeOff() { ++imeOffs; return next(); }
};
int main() {
  // Expected physical HID usages for : / ? = % on US and Japanese JIS hosts.
  for (bool jis : {false, true}) {
    const uint8_t expected[] = {uint8_t(jis ? 0x34 : 0x33), 0x38, 0x38, uint8_t(jis ? 0x2d : 0x2e), 0x22};
    const bool shifted[] = {!jis, false, true, jis, true};
    const std::string chars = ":/?=%";
    for (size_t i=0; i<chars.size(); ++i) { auto k=asciiKey(chars[i],jis); assert(k.usage==expected[i] && k.shift==shifted[i]); }
    for (int c=32; c<=126; ++c) assert(asciiKey(c,jis).usage != 0);
    assert(asciiKey('_',jis).usage == (jis ? 0x87 : 0x2d));
  }
  for (const char *name : {"search-win", "search-mac", "max", "legacy", "open"}) {
    Protocol p(notify); auto frames = fixture(name); replies.clear();
    for (const auto &f : frames) feed(p, f);
    assert(p.state == Queued && replies.size() == 1 && std::get<0>(replies[0]) == Accepted);
    assert(p.begin() && p.state == Executing);
    auto duplicate = frames[0]; feed(p, duplicate); assert(p.state == Executing && std::get<2>(replies.back()) == Duplicate);
    put32(duplicate.data()+2, 2); feed(p, duplicate); assert(p.state == Executing && std::get<2>(replies.back()) == Busy);
    feed(p, frames.back()); assert(p.state == Executing);
    for (bool enter : {false, true}) {
      auto r = p.request; if (r.op != Open) r.enter = enter;
      Sink sink; assert(runHid(r, sink)); assert(sink.releases == 2);
      if (r.op != Legacy) {
        assert(sink.imeOffs == 0);
        const bool win = r.os == Windows;
        assert(sink.actions[0] == (win ? "2:r" : "2: "));
        assert(sink.actions[1] == (win ? "0:a" : "2:a"));
        std::string expected = win ? "chrome" : "Google Chrome";
        if (r.op == Search) {
          assert(sink.actions[2] == (win ? "0:l" : "2:l"));
          expected += std::string(reinterpret_cast<const char*>(r.data), r.length);
        }
        assert(sink.text == expected);
        assert(sink.enters == (r.op == Search && enter ? 2 : 1));
      } else {
        assert(sink.imeOffs == 1);
        assert(sink.text == "aU+6F22U+1F600\n"); assert(sink.enters == int(enter));
        assert(sink.actions == std::vector<std::string>({"1:x", "1:x"}));
      }
      for (int cancel = 1; cancel <= sink.steps; ++cancel) {
        Sink interrupted; interrupted.cancelAfter = cancel;
        assert(!runHid(r, interrupted)); assert(interrupted.releases == 2);
      }
    }
    p.complete(true); assert(p.state == Idle && std::get<0>(replies.back()) == Done);
    p.disconnected(); feed(p, frames[0]); assert(p.state == Idle && std::get<2>(replies.back()) == Duplicate);
  }
  for (uint8_t os : {uint8_t(Windows), uint8_t(Mac)}) {
    Request ascii; ascii.op = Legacy; ascii.os = os; ascii.length = 3; memcpy(ascii.data, "abc", 3);
    Sink sink; assert(runHid(ascii, sink)); assert(sink.imeOffs == 0 && sink.text == "abc");
  }
  auto f = fixture("search-win");
  { Protocol p(notify); feed(p,f[0]); auto other=f[0]; put32(other.data()+2,2); feed(p,other); assert(p.request.id==1 && p.state==Receiving); }
  { Protocol p(notify); feed(p,f[0]); auto bad=f[1]; bad[5]=1; feed(p,bad); assert(p.state==Idle && std::get<2>(replies.back())==Sequence); }
  { Protocol p(notify); feed(p,f[0]); feed(p,f.back()); assert(p.state==Idle && std::get<2>(replies.back())==Sequence); }
  { Protocol p(notify); feed(p,f[0]); p.tick(10002); assert(p.state==Idle && p.highWater==1); }
  { Protocol p(notify); feed(p,f[0]); p.disconnected(); feed(p,f[1]); assert(p.state==Idle); }
  { Protocol p(notify); auto bad=f[0]; bad[10]=1; bad[11]=16; feed(p,bad); assert(p.state==Idle && std::get<2>(replies.back())==Size); }
  { Protocol p(notify); auto bad=f[0]; bad[6]=255; feed(p,bad); assert(p.highWater==0); }
  { Protocol p(notify); Frame old={0xa1,1,0,5,0,0,0,1}; feed(p,old); assert(p.state==Idle); }
  for (std::string bad : {"chrome", "https://www.google.com/search?q=%GG", "https://www.google.com/search?q=a\n", "https://evil.test/?q=a"}) {
    Request r; r.op=Search; r.length=bad.size(); memcpy(r.data,bad.data(),r.length); assert(!validPayload(r));
  }
  { Request r; r.op=Legacy; r.os=Mac; r.length=6; memcpy(r.data,"\x1e" "6F22;",6); assert(!validPayload(r)); r.os=Windows; assert(validPayload(r)); memcpy(r.data,"\x1e" "D800;",6); assert(!validPayload(r)); }
  std::cout << "Firmware protocol, JS wire fixtures, HID sequences, cancellation and limits passed\n";
}
