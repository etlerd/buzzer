// Game rules, independent of hardware so it can be tested on a computer.
// The hub feeds it pod presses and host commands; it answers with state
// (for screens), light modes (for pods) and sound requests (for the aux jack).
#pragma once
#include <ArduinoJson.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <algorithm>
#include <functional>
#include <string>
#include <vector>
#include "protocol.h"

namespace gs {

constexpr int MAX_SEATS = 12;
constexpr int MAX_PODS = GS_MAX_FRAME_ENTRIES;
constexpr int64_t COLLECT_US = 50000;     // wait this long after the first press for radio retries
constexpr uint32_t FALSE_START_MS = 1000; // lockout for pressing before buzzers open
constexpr uint32_t RESULT_MS = 2500;      // correct/wrong flash length
constexpr uint32_t REOPEN_DELAY_MS = 1200;
constexpr uint32_t IDENTIFY_MS = 4000;
constexpr uint32_t POD_OFFLINE_MS = 4000;

static const uint32_t SEAT_COLORS[MAX_SEATS] = {
  0xFF2020, 0x2060FF, 0x20D040, 0xFFC000, 0xB040FF, 0xFF7000,
  0x00D0FF, 0xFF30A0, 0xA0FF20, 0xFFFFFF, 0x8060FF, 0x00FFA0,
};

enum Phase { LOCKED, ARMED, BUZZED };
enum Sound { SND_ARMED, SND_BUZZ, SND_CORRECT, SND_WRONG, SND_NAME };

struct Mac {
  uint8_t b[6] = {0};
  bool operator==(const Mac& o) const { return memcmp(b, o.b, 6) == 0; }
  bool zero() const { static const uint8_t z[6] = {0}; return memcmp(b, z, 6) == 0; }
  std::string str() const {
    char s[18];
    snprintf(s, sizeof(s), "%02x:%02x:%02x:%02x:%02x:%02x", b[0], b[1], b[2], b[3], b[4], b[5]);
    return s;
  }
  static Mac parse(const char* s) {
    Mac m;
    unsigned v[6];
    if (s && sscanf(s, "%x:%x:%x:%x:%x:%x", &v[0], &v[1], &v[2], &v[3], &v[4], &v[5]) == 6)
      for (int i = 0; i < 6; i++) m.b[i] = (uint8_t)v[i];
    return m;
  }
};

struct Pod {
  Mac mac;
  uint32_t lastSeenMs = 0;
  uint8_t ackSeq = 0;
  bool seqValid = false;
};

struct Seat {
  std::string name;
  int score = 0;
  Mac mac;                     // paired pod (zero = none)
  bool out = false;            // locked out for this question (answered wrong)
  uint32_t falseUntilMs = 0;
  uint32_t identifyUntilMs = 0;
};

struct Press {
  int seat;
  int64_t tUs;  // estimated moment of the physical press
};

// File name for a contestant's recorded name: "Mary-Jo O'Neil" -> "maryjooneil"
inline std::string voiceSlug(const std::string& name) {
  std::string s;
  for (char c : name) {
    if (c >= 'A' && c <= 'Z') s += (char)(c - 'A' + 'a');
    else if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) s += c;
    if (s.size() >= 24) break;
  }
  return s;
}

class Game {
 public:
  // ---- settings (saved) ----
  int seatCount = 8;
  int points = 10;
  int penalty = 0;
  int volume = 70;  // 0-100

  // ---- state ----
  Seat seats[MAX_SEATS + 1];  // 1-based
  std::vector<Pod> pods;
  Phase phase = LOCKED;
  uint32_t armId = 0;
  int winner = 0;
  std::vector<Press> queue;
  int64_t collectUntilUs = 0;
  int resultSeat = 0;
  bool resultOk = false;
  uint32_t resultN = 0;
  uint32_t resultAtMs = 0;
  uint32_t reopenAtMs = 0;
  int assigning = 0;  // seat waiting for a pod press to pair
  std::string question;

  bool dirty = true;      // screens need a new state
  bool saveDirty = false; // settings/scores need saving

  // ---- hooks set by the hub ----
  std::function<void(Sound, int seat)> onSound = [](Sound, int) {};
  std::function<bool(const std::string& slug)> hasVoice = [](const std::string&) { return false; };

  // ================= inputs =================

  Pod* podFor(const Mac& m, uint32_t nowMs, bool create) {
    for (auto& p : pods) if (p.mac == m) return &p;
    if (!create) return nullptr;
    if ((int)pods.size() >= MAX_PODS) {
      // replace the pod silent for longest, if it is not paired
      auto it = std::min_element(pods.begin(), pods.end(), [](const Pod& a, const Pod& b) { return a.lastSeenMs < b.lastSeenMs; });
      if (seatOf(it->mac) || nowMs - it->lastSeenMs < POD_OFFLINE_MS) return nullptr;
      pods.erase(it);
    }
    Pod p;
    p.mac = m;
    pods.push_back(p);
    dirty = true;
    return &pods.back();
  }

  int seatOf(const Mac& m) const {
    if (m.zero()) return 0;
    for (int s = 1; s <= MAX_SEATS; s++) if (seats[s].mac == m) return s;
    return 0;
  }

  void podHello(const Mac& m, uint32_t nowMs) {
    Pod* p = podFor(m, nowMs, true);
    if (!p) return;
    if (!podOnline(*p, nowMs)) dirty = true;
    p->lastSeenMs = nowMs;
  }

  void podPress(const Mac& m, uint8_t seq, uint16_t delayMs, int64_t nowUs, uint32_t nowMs) {
    Pod* p = podFor(m, nowMs, true);
    if (!p) return;
    if (!podOnline(*p, nowMs)) dirty = true;
    p->lastSeenMs = nowMs;
    if (p->seqValid && p->ackSeq == seq) return;  // resend of a press we already have
    p->ackSeq = seq;
    p->seqValid = true;

    if (assigning) {
      for (int s = 1; s <= MAX_SEATS; s++) if (seats[s].mac == m) seats[s].mac = Mac();
      seats[assigning].mac = m;
      seats[assigning].identifyUntilMs = nowMs + 1500;
      assigning = 0;
      dirty = saveDirty = true;
      return;
    }

    int s = seatOf(m);
    if (!s || s > seatCount) return;
    Seat& seat = seats[s];
    int64_t pressUs = nowUs - (int64_t)delayMs * 1000;

    if (phase == LOCKED) {
      if (!seat.out && !(resultSeat == s && nowMs - resultAtMs < RESULT_MS)) {
        seat.falseUntilMs = nowMs + FALSE_START_MS;
        dirty = true;
      }
      return;
    }
    if (seat.out || inQueue(s)) return;
    if (phase == ARMED && nowMs < seat.falseUntilMs) return;

    if (phase == ARMED) {
      if (queue.empty()) collectUntilUs = nowUs + COLLECT_US;
      queue.push_back({s, pressUs});
    } else {  // BUZZED: late press, keep in line behind the winner
      queue.push_back({s, pressUs});
      std::sort(queue.begin() + 1, queue.end(), [](const Press& a, const Press& b) { return a.tUs < b.tUs; });
    }
    dirty = true;
  }

  // Call often (every loop).
  void tick(int64_t nowUs, uint32_t nowMs) {
    if (phase == ARMED && !queue.empty() && nowUs >= collectUntilUs) {
      std::sort(queue.begin(), queue.end(), [](const Press& a, const Press& b) { return a.tUs < b.tUs; });
      winner = queue[0].seat;
      phase = BUZZED;
      dirty = true;
      onSound(SND_BUZZ, winner);
    }
    if (reopenAtMs && nowMs >= reopenAtMs) {
      reopenAtMs = 0;
      arm(nowMs);
    }
    // online/offline changes are visible on the host screen
    static uint32_t lastCheck = 0;
    if (nowMs - lastCheck > 1000) {
      lastCheck = nowMs;
      for (auto& p : pods) {
        bool on = podOnline(p, nowMs);
        if (on != wasOnline(p)) { dirty = true; setWasOnline(p, on); }
      }
    }
  }

  // Host commands. Returns false with a reason if the command is invalid.
  bool command(JsonObjectConst c, uint32_t nowMs, std::string& err) {
    const char* cmd = c["c"] | "";
    int s = c["s"] | 0;
    auto seatOk = [&]() { if (s < 1 || s > MAX_SEATS) { err = "bad seat"; return false; } return true; };

    if (!strcmp(cmd, "arm")) arm(nowMs);
    else if (!strcmp(cmd, "correct")) correct(nowMs);
    else if (!strcmp(cmd, "wrong")) wrong(nowMs, strcmp(c["then"] | "reopen", "next") == 0);
    else if (!strcmp(cmd, "lock")) lock();
    else if (!strcmp(cmd, "newq")) { for (auto& st : seats) st.out = false; question.clear(); lock(); }
    else if (!strcmp(cmd, "question")) { question = std::string(c["text"] | "").substr(0, 300); }
    else if (!strcmp(cmd, "name")) {
      if (!seatOk()) return false;
      std::string n = c["name"] | "";
      seats[s].name = clean(n, 20);
      saveDirty = true;
    } else if (!strcmp(cmd, "score")) {
      if (!seatOk()) return false;
      if (c["set"].is<int>()) seats[s].score = c["set"].as<int>();
      else seats[s].score += c["delta"] | 0;
      saveDirty = true;
    } else if (!strcmp(cmd, "resetscores")) {
      for (auto& st : seats) st.score = 0;
      saveDirty = true;
    } else if (!strcmp(cmd, "assign")) {
      if (s != 0 && !seatOk()) return false;
      assigning = s;
    } else if (!strcmp(cmd, "unassign")) {
      if (!seatOk()) return false;
      seats[s].mac = Mac();
      saveDirty = true;
    } else if (!strcmp(cmd, "identify")) {
      if (!seatOk()) return false;
      seats[s].identifyUntilMs = nowMs + IDENTIFY_MS;
    } else if (!strcmp(cmd, "settings")) {
      if (c["seats"].is<int>()) seatCount = std::max(1, std::min(MAX_SEATS, c["seats"].as<int>()));
      if (c["points"].is<int>()) points = c["points"].as<int>();
      if (c["penalty"].is<int>()) penalty = c["penalty"].as<int>();
      if (c["volume"].is<int>()) volume = std::max(0, std::min(100, c["volume"].as<int>()));
      saveDirty = true;
    } else if (!strcmp(cmd, "saysname")) {
      if (!seatOk()) return false;
      onSound(SND_NAME, s);
      return true;
    } else if (!strcmp(cmd, "sound")) {
      const char* n = c["name"] | "";
      if (!strcmp(n, "buzz")) onSound(SND_BUZZ, 0);
      else if (!strcmp(n, "correct")) onSound(SND_CORRECT, 0);
      else if (!strcmp(n, "wrong")) onSound(SND_WRONG, 0);
      else onSound(SND_ARMED, 0);
      return true;
    } else if (!strcmp(cmd, "hello") || !strcmp(cmd, "voices")) {
      // client wants a fresh state (e.g. after uploading a voice clip)
    } else {
      err = "unknown command";
      return false;
    }
    dirty = true;
    return true;
  }

  // ================= game actions =================

  void arm(uint32_t nowMs) {
    (void)nowMs;
    if (phase == ARMED) return;
    reopenAtMs = 0;
    armId++;
    phase = ARMED;
    winner = 0;
    queue.clear();
    resultSeat = 0;
    dirty = true;
    onSound(SND_ARMED, 0);
  }

  void lock() {
    reopenAtMs = 0;
    phase = LOCKED;
    winner = 0;
    queue.clear();
    resultSeat = 0;
    dirty = true;
  }

  void setResult(int s, bool ok, uint32_t nowMs) {
    resultSeat = s;
    resultOk = ok;
    resultN++;
    resultAtMs = nowMs;
  }

  void correct(uint32_t nowMs) {
    if (phase != BUZZED || !winner) return;
    seats[winner].score += points;
    setResult(winner, true, nowMs);
    phase = LOCKED;
    for (auto& st : seats) st.out = false;
    saveDirty = dirty = true;
    onSound(SND_CORRECT, 0);
  }

  void wrong(uint32_t nowMs, bool next) {
    if (phase != BUZZED || !winner) return;
    int s = winner;
    seats[s].score -= penalty;
    seats[s].out = true;
    setResult(s, false, nowMs);
    saveDirty = dirty = true;
    onSound(SND_WRONG, 0);
    if (next) {
      winner = 0;
      for (auto& q : queue) if (!seats[q.seat].out) { winner = q.seat; break; }
      if (winner) onSound(SND_NAME, winner);
      else phase = LOCKED;
      return;
    }
    phase = LOCKED;
    winner = 0;
    // reopen for everyone else once the wrong flash has been seen, unless nobody is left
    bool anyoneLeft = false;
    for (int i = 1; i <= seatCount; i++) if (!seats[i].mac.zero() && !seats[i].out) anyoneLeft = true;
    if (anyoneLeft) reopenAtMs = nowMs + REOPEN_DELAY_MS;
  }

  // ================= outputs =================

  GsLight lightFor(int s, uint32_t nowMs, uint32_t* rgb) const {
    const Seat& st = seats[s];
    *rgb = SEAT_COLORS[(s - 1) % MAX_SEATS];
    if (nowMs < st.identifyUntilMs) return GS_IDENTIFY;
    if (s > seatCount) return GS_OFF;
    if (resultSeat == s && nowMs - resultAtMs < RESULT_MS) return resultOk ? GS_CORRECT : GS_WRONG;
    if (nowMs < st.falseUntilMs) return GS_FALSE;
    if (phase == BUZZED && winner == s) return GS_WINNER;
    if (phase == ARMED && !st.out && !inQueue(s)) return GS_ARMED;
    return GS_OFF;
  }

  // Fill the radio frame every pod reads its light mode from.
  void buildFrame(GsFrame& f, uint32_t nowMs) const {
    gsHeader(f.h, GS_PKT_FRAME);
    f.count = 0;
    for (const auto& p : pods) {
      if (f.count >= GS_MAX_FRAME_ENTRIES) break;
      GsFrameEntry& e = f.e[f.count++];
      memcpy(e.mac, p.mac.b, 6);
      e.ackSeq = p.ackSeq;
      int s = seatOf(p.mac);
      uint32_t rgb = 0x0040FF;
      e.mode = s ? lightFor(s, nowMs, &rgb) : GS_IDENTIFY;  // unpaired pods blink blue
      e.r = rgb >> 16;
      e.g = (rgb >> 8) & 0xFF;
      e.b = rgb & 0xFF;
    }
  }

  void stateJson(JsonDocument& d, uint32_t nowMs) const {
    static const char* names[] = {"locked", "armed", "buzzed"};
    d["t"] = "state";
    d["phase"] = names[phase];
    d["armId"] = armId;
    d["winner"] = winner;
    d["question"] = question;
    d["points"] = points;
    d["penalty"] = penalty;
    d["seatCount"] = seatCount;
    d["volume"] = volume;
    d["assigning"] = assigning;
    if (resultSeat) {
      JsonObject r = d["result"].to<JsonObject>();
      r["s"] = resultSeat;
      r["ok"] = resultOk;
      r["n"] = resultN;
    }
    JsonArray q = d["queue"].to<JsonArray>();
    for (const auto& p : queue) {
      JsonObject o = q.add<JsonObject>();
      o["s"] = p.seat;
      o["ms"] = (int)((p.tUs - queue[0].tUs) / 1000);
    }
    JsonArray arr = d["seats"].to<JsonArray>();
    for (int s = 1; s <= seatCount; s++) {
      const Seat& st = seats[s];
      JsonObject o = arr.add<JsonObject>();
      o["s"] = s;
      o["name"] = st.name;
      o["score"] = st.score;
      char col[8];
      snprintf(col, sizeof(col), "#%06X", (unsigned)SEAT_COLORS[(s - 1) % MAX_SEATS]);
      o["color"] = col;
      const Pod* p = st.mac.zero() ? nullptr : findPod(st.mac);
      o["pod"] = st.mac.zero() ? "none" : (p && podOnline(*p, nowMs)) ? "online" : "offline";
      o["out"] = st.out;
      o["voice"] = !st.name.empty() && hasVoice(voiceSlug(st.name));
    }
    int unpaired = 0;
    for (const auto& p : pods) if (!seatOf(p.mac) && podOnline(p, nowMs)) unpaired++;
    d["unpaired"] = unpaired;
  }

  // ---- persistence ----
  void saveJson(JsonDocument& d) const {
    d["seatCount"] = seatCount;
    d["points"] = points;
    d["penalty"] = penalty;
    d["volume"] = volume;
    JsonArray arr = d["seats"].to<JsonArray>();
    for (int s = 1; s <= MAX_SEATS; s++) {
      JsonObject o = arr.add<JsonObject>();
      o["name"] = seats[s].name;
      o["score"] = seats[s].score;
      o["mac"] = seats[s].mac.zero() ? "" : seats[s].mac.str();
    }
  }

  void loadJson(const JsonDocument& d) {
    seatCount = std::max(1, std::min(MAX_SEATS, d["seatCount"] | 8));
    points = d["points"] | 10;
    penalty = d["penalty"] | 0;
    volume = d["volume"] | 70;
    int s = 1;
    for (JsonObjectConst o : d["seats"].as<JsonArrayConst>()) {
      if (s > MAX_SEATS) break;
      seats[s].name = clean(o["name"] | "", 20);
      seats[s].score = o["score"] | 0;
      seats[s].mac = Mac::parse(o["mac"] | "");
      s++;
    }
    dirty = true;
  }

 private:
  std::vector<std::pair<Mac, bool>> onlineMemo;

  bool inQueue(int s) const {
    for (const auto& q : queue) if (q.seat == s) return true;
    return false;
  }
  const Pod* findPod(const Mac& m) const {
    for (const auto& p : pods) if (p.mac == m) return &p;
    return nullptr;
  }
  static bool podOnline(const Pod& p, uint32_t nowMs) {
    return p.lastSeenMs && nowMs - p.lastSeenMs < POD_OFFLINE_MS;
  }
  bool wasOnline(const Pod& p) {
    for (auto& m : onlineMemo) if (m.first == p.mac) return m.second;
    onlineMemo.push_back({p.mac, false});
    return false;
  }
  void setWasOnline(const Pod& p, bool on) {
    for (auto& m : onlineMemo) if (m.first == p.mac) { m.second = on; return; }
    onlineMemo.push_back({p.mac, on});
  }
  static std::string clean(const std::string& in, size_t max) {
    std::string out;
    bool space = false;
    for (unsigned char c : in) {
      if (c < 32) continue;
      if (c == ' ') { space = !out.empty(); continue; }
      if (space) { out += ' '; space = false; }
      out += (char)c;
    }
    if (out.size() > max) {
      out.resize(max);
      // drop a UTF-8 character that was cut in half
      size_t i = out.size();
      while (i > 0 && ((unsigned char)out[i - 1] & 0xC0) == 0x80) i--;
      if (i > 0 && (unsigned char)out[i - 1] >= 0xC0) {
        unsigned char lead = out[i - 1];
        size_t need = lead >= 0xF0 ? 4 : lead >= 0xE0 ? 3 : 2;
        if (out.size() - (i - 1) < need) out.resize(i - 1);
      }
    }
    return out;
  }
};

}  // namespace gs
