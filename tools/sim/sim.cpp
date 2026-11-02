// Runs the hub's game logic (firmware/hub/game.h) on a computer.
// stdin:  one JSON per line, either a host command {"c":"arm"} or a simulated pod
//         event {"sim":"press","mac":"aa:..","seq":1,"delay":0} / {"sim":"hello","mac":".."}
// stdout: state JSON lines (same as the hub sends), plus {"t":"sound"} and {"t":"frame"} lines.
// argv[1]: folder holding voice clips (<slug>.wav), used for the "voice" flag.
#include <poll.h>
#include <sys/stat.h>
#include <unistd.h>
#include <chrono>
#include <iostream>
#include <string>
#include "../../firmware/hub/game.h"

static std::string voiceDir;
static int64_t nowUs() {
  using namespace std::chrono;
  return duration_cast<microseconds>(steady_clock::now().time_since_epoch()).count();
}
static uint32_t nowMs() { return (uint32_t)(nowUs() / 1000); }

int main(int argc, char** argv) {
  if (argc > 1) voiceDir = argv[1];
  std::ios::sync_with_stdio(false);
  gs::Game game;
  game.onSound = [](gs::Sound s, int seat) {
    static const char* n[] = {"armed", "buzz", "correct", "wrong", "name"};
    std::cout << "{\"t\":\"sound\",\"name\":\"" << n[s] << "\",\"s\":" << seat << "}" << std::endl;
  };
  game.hasVoice = [](const std::string& slug) {
    struct stat st;
    return !voiceDir.empty() && stat((voiceDir + "/" + slug + ".wav").c_str(), &st) == 0;
  };

  std::string buf;
  GsFrame lastFrame{};
  for (;;) {
    pollfd p{0, POLLIN, 0};
    if (poll(&p, 1, 2) > 0) {
      char tmp[4096];
      ssize_t r = read(0, tmp, sizeof(tmp));
      if (r <= 0) return 0;
      buf.append(tmp, r);
      size_t i;
      while ((i = buf.find('\n')) != std::string::npos) {
        std::string line = buf.substr(0, i);
        buf.erase(0, i + 1);
        JsonDocument d;
        if (deserializeJson(d, line)) continue;
        const char* sim = d["sim"] | "";
        gs::Mac mac = gs::Mac::parse(d["mac"] | "");
        if (!strcmp(sim, "press")) game.podPress(mac, d["seq"] | 0, d["delay"] | 0, nowUs(), nowMs());
        else if (!strcmp(sim, "hello")) game.podHello(mac, nowMs());
        else {
          std::string err;
          if (!game.command(d.as<JsonObjectConst>(), nowMs(), err))
            std::cout << "{\"t\":\"error\",\"msg\":\"" << err << "\"}" << std::endl;
        }
      }
    }
    game.tick(nowUs(), nowMs());

    GsFrame f;
    game.buildFrame(f, nowMs());
    size_t len = sizeof(GsHeader) + 1 + f.count * sizeof(GsFrameEntry);
    if (memcmp(&f, &lastFrame, len) != 0) {
      memcpy(&lastFrame, &f, len);
      JsonDocument fd;
      fd["t"] = "frame";
      JsonArray a = fd["e"].to<JsonArray>();
      for (int k = 0; k < f.count; k++) {
        gs::Mac m;
        memcpy(m.b, f.e[k].mac, 6);
        JsonObject o = a.add<JsonObject>();
        o["mac"] = m.str();
        o["mode"] = f.e[k].mode;
        char col[8];
        snprintf(col, sizeof(col), "%02x%02x%02x", f.e[k].r, f.e[k].g, f.e[k].b);
        o["rgb"] = col;
        o["ack"] = f.e[k].ackSeq;
      }
      serializeJson(fd, std::cout);
      std::cout << std::endl;
    }
    if (game.dirty) {
      game.dirty = false;
      JsonDocument d;
      game.stateJson(d, nowMs());
      serializeJson(d, std::cout);
      std::cout << std::endl;
    }
  }
}
