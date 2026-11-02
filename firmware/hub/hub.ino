// Buzzer hub: receives seat-pod presses over ESP-NOW, runs the game,
// serves the host and display pages over its own Wi-Fi, and plays sound
// through the aux jack.
//
// Board: ESP32-S3 with 16 MB flash (e.g. ESP32-S3-DevKitC-1 N16R8).
// Arduino core: esp32 by Espressif, version 3.x.
// Tools menu: Flash Size "16MB"; Partition Scheme is taken from partitions.csv in this folder
//   (if your IDE ignores it, choose "16M Flash (3MB APP/9.9MB FATFS)").
// Libraries: ArduinoJson (v7), WebSockets (Markus Sattler / Links2004).

#if __has_include("config.h")
#include "config.h"
#else
#warning "config.h not found: using config.example.h"
#include "config.example.h"
#endif

#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <esp_timer.h>
#include <WebServer.h>
#include <WebSocketsServer.h>
#include <LittleFS.h>
#include <ESPmDNS.h>
#include <Update.h>
#include <ArduinoJson.h>
#include <set>
#include "game.h"
#include "audio.h"
#include "admin_page.h"

#define FW_VERSION "2.0.0"

gs::Game game;
WebServer http(80);
WebSocketsServer ws(81);
std::set<std::string> voices;  // slugs with a clip in /voice/
static const uint8_t BROADCAST[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

// ---------------- radio (runs in the Wi-Fi task; hand off to loop) ----------------
struct RadioEvt {
  uint8_t mac[6];
  uint8_t type;
  uint8_t seq;
  uint16_t delayMs;
  int64_t us;
};
QueueHandle_t radioQ;

void onRadio(const esp_now_recv_info_t* info, const uint8_t* data, int len) {
  RadioEvt e;
  e.us = esp_timer_get_time();  // stamp first: this is the press arrival time
  memcpy(e.mac, info->src_addr, 6);
  if (gsValid(data, len, GS_PKT_PRESS, sizeof(GsPress))) {
    const GsPress* p = (const GsPress*)data;
    e.type = GS_PKT_PRESS;
    e.seq = p->seq;
    e.delayMs = p->delayMs;
  } else if (gsValid(data, len, GS_PKT_HELLO, sizeof(GsHello))) {
    e.type = GS_PKT_HELLO;
  } else {
    return;
  }
  xQueueSend(radioQ, &e, 0);
}

void radioBegin() {
  if (esp_now_init() != ESP_OK) {
    Serial.println("# ESP-NOW init failed");
    return;
  }
  esp_now_register_recv_cb(onRadio);
  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, BROADCAST, 6);
  peer.channel = 0;  // current channel (the AP's)
  peer.ifidx = WIFI_IF_AP;
  peer.encrypt = false;
  esp_now_add_peer(&peer);
}

void sendFrame(uint32_t nowMs) {
  static GsFrame last;
  static uint32_t lastSent = 0;
  GsFrame f;
  game.buildFrame(f, nowMs);
  size_t len = sizeof(GsHeader) + 1 + f.count * sizeof(GsFrameEntry);
  // send at once on change, otherwise every 200 ms so pods that missed one catch up
  if (memcmp(&f, &last, len) == 0 && nowMs - lastSent < 200) return;
  if (esp_now_send(BROADCAST, (const uint8_t*)&f, len) == ESP_OK) {
    memcpy(&last, &f, len);
    lastSent = nowMs;
  }
}

// ---------------- sounds ----------------
void playName(int seat) {
  const std::string& name = game.seats[seat].name;
  std::string slug = gs::voiceSlug(name);
  if (slug.empty() || !voices.count(slug)) return;
  std::string path = "/voice/" + slug + ".wav";
  audio::play(audio::CLIP, path.c_str());
}

void onSound(gs::Sound s, int seat) {
  switch (s) {
    case gs::SND_ARMED: audio::play(audio::FX_ARMED, nullptr, true); break;
    case gs::SND_BUZZ:
      audio::play(audio::FX_BUZZ, nullptr, true);
      if (seat) playName(seat);
      break;
    case gs::SND_CORRECT: audio::play(audio::FX_CORRECT, nullptr, true); break;
    case gs::SND_WRONG: audio::play(audio::FX_WRONG, nullptr, true); break;
    case gs::SND_NAME: playName(seat); break;
  }
}

void scanVoices() {
  voices.clear();
  File dir = LittleFS.open("/voice");
  if (!dir || !dir.isDirectory()) return;
  for (File f = dir.openNextFile(); f; f = dir.openNextFile()) {
    String n = f.name();
    if (n.endsWith(".wav")) voices.insert(std::string(n.substring(0, n.length() - 4).c_str()));
  }
  game.dirty = true;
}

// ---------------- saving ----------------
void saveGame() {
  JsonDocument d;
  game.saveJson(d);
  File f = LittleFS.open("/game.json", "w");
  if (!f) return;
  serializeJson(d, f);
  f.close();
}

void loadGame() {
  File f = LittleFS.open("/game.json", "r");
  if (!f) return;
  JsonDocument d;
  if (!deserializeJson(d, f)) game.loadJson(d);
  f.close();
}

// ---------------- commands (WebSocket and USB serial share this) ----------------
String stateString() {
  JsonDocument d;
  game.stateJson(d, millis());
  String out;
  serializeJson(d, out);
  return out;
}

String handleMessage(const char* text, size_t len) {
  JsonDocument d;
  if (deserializeJson(d, text, len)) return "{\"t\":\"error\",\"msg\":\"bad json\"}";
  std::string err;
  if (!game.command(d.as<JsonObjectConst>(), millis(), err)) {
    JsonDocument e;
    e["t"] = "error";
    e["msg"] = err;
    String out;
    serializeJson(e, out);
    return out;
  }
  if (game.volume != audio::volume) audio::volume = game.volume;
  if (!strcmp(d["c"] | "", "voices")) scanVoices();
  return "";
}

void onWs(uint8_t client, WStype_t type, uint8_t* payload, size_t len) {
  if (type == WStype_CONNECTED) {
    String s = stateString();
    ws.sendTXT(client, s);
  } else if (type == WStype_TEXT) {
    String reply = handleMessage((const char*)payload, len);
    if (reply.length()) ws.sendTXT(client, reply);
  }
}

void readSerial() {
  static String line;
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      line.trim();
      if (line.startsWith("{")) {
        String reply = handleMessage(line.c_str(), line.length());
        if (reply.length()) Serial.println(reply);
      }
      line = "";
    } else if (c != '\r' && line.length() < 1024) {
      line += c;
    }
  }
}

// ---------------- HTTP ----------------
bool safePath(const String& p) {
  return p.startsWith("/") && p.indexOf("..") < 0 && p.length() < 64 && p != "/game.json";
}

String contentType(const String& p) {
  if (p.endsWith(".html")) return "text/html; charset=utf-8";
  if (p.endsWith(".css")) return "text/css";
  if (p.endsWith(".js")) return "application/javascript";
  if (p.endsWith(".json")) return "application/json";
  if (p.endsWith(".svg")) return "image/svg+xml";
  if (p.endsWith(".png")) return "image/png";
  if (p.endsWith(".ico")) return "image/x-icon";
  if (p.endsWith(".wav")) return "audio/wav";
  return "application/octet-stream";
}

void listDir(JsonArray arr, const String& path) {
  File dir = LittleFS.open(path);
  if (!dir || !dir.isDirectory()) return;
  for (File f = dir.openNextFile(); f; f = dir.openNextFile()) {
    String full = path == "/" ? "/" + String(f.name()) : path + "/" + f.name();
    if (f.isDirectory()) listDir(arr, full);
    else {
      JsonObject o = arr.add<JsonObject>();
      o["path"] = full;
      o["size"] = f.size();
    }
  }
}

File uploadFile;
String uploadPath;
bool uploadOk;

void handleUploadData() {
  HTTPUpload& up = http.upload();
  if (up.status == UPLOAD_FILE_START) {
    uploadPath = http.arg("path");
    uploadOk = safePath(uploadPath);
    if (uploadOk) {
      uploadFile = LittleFS.open(uploadPath, "w", true);  // true: create folders
      uploadOk = (bool)uploadFile;
    }
  } else if (up.status == UPLOAD_FILE_WRITE) {
    if (uploadOk && uploadFile.write(up.buf, up.currentSize) != up.currentSize) uploadOk = false;
  } else if (up.status == UPLOAD_FILE_END || up.status == UPLOAD_FILE_ABORTED) {
    if (uploadFile) uploadFile.close();
    if (up.status == UPLOAD_FILE_ABORTED) uploadOk = false;
    if (!uploadOk && safePath(uploadPath)) LittleFS.remove(uploadPath);
  }
}

void handleUploadDone() {
  if (!uploadOk) { http.send(400, "text/plain", "upload failed (bad path or storage full)"); return; }
  if (uploadPath.startsWith("/voice/")) scanVoices();
  http.send(200, "text/plain", "ok");
}

bool updateOk;
void handleUpdateData() {
  HTTPUpload& up = http.upload();
  if (up.status == UPLOAD_FILE_START) {
    updateOk = Update.begin(UPDATE_SIZE_UNKNOWN);
  } else if (up.status == UPLOAD_FILE_WRITE) {
    if (updateOk && Update.write(up.buf, up.currentSize) != up.currentSize) updateOk = false;
  } else if (up.status == UPLOAD_FILE_END) {
    updateOk = updateOk && Update.end(true);
  } else if (up.status == UPLOAD_FILE_ABORTED) {
    Update.abort();
    updateOk = false;
  }
}

void httpBegin() {
  http.on("/admin", HTTP_GET, []() { http.send_P(200, "text/html; charset=utf-8", ADMIN_PAGE); });
  http.on("/api/files", HTTP_GET, []() {
    JsonDocument d;
    d["version"] = FW_VERSION;
    d["total"] = LittleFS.totalBytes();
    d["used"] = LittleFS.usedBytes();
    listDir(d["files"].to<JsonArray>(), "/");
    String out;
    serializeJson(d, out);
    http.send(200, "application/json", out);
  });
  http.on("/api/upload", HTTP_POST, handleUploadDone, handleUploadData);
  http.on("/api/delete", HTTP_POST, []() {
    String p = http.arg("path");
    if (!safePath(p) || !LittleFS.remove(p)) { http.send(400, "text/plain", "not deleted"); return; }
    if (p.startsWith("/voice/")) scanVoices();
    http.send(200, "text/plain", "ok");
  });
  http.on("/api/update", HTTP_POST, []() {
    http.send(updateOk ? 200 : 500, "text/plain", updateOk ? "ok" : Update.errorString());
    if (updateOk) {
      saveGame();
      delay(500);
      ESP.restart();
    }
  }, handleUpdateData);
  http.onNotFound([]() {
    String p = http.uri();
    if (p.endsWith("/")) p += "index.html";
    if (safePath(p) && LittleFS.exists(p)) {
      File f = LittleFS.open(p, "r");
      http.sendHeader("Cache-Control", "no-cache");
      http.streamFile(f, contentType(p));
      f.close();
    } else if (p == "/index.html") {
      http.sendHeader("Location", "/admin");  // nothing uploaded yet
      http.send(302);
    } else {
      http.send(404, "text/plain", "not found");
    }
  });
  http.begin();
}

// ---------------- main ----------------
void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("# buzzer hub " FW_VERSION);

  if (!LittleFS.begin(true)) Serial.println("# LittleFS mount failed");
  loadGame();
  scanVoices();

  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASS, RADIO_CHANNEL, 0, 8);
  esp_wifi_set_ps(WIFI_PS_NONE);
  Serial.printf("# Wi-Fi \"%s\" on channel %d, open http://%s\n", AP_SSID, RADIO_CHANNEL, WiFi.softAPIP().toString().c_str());

  radioQ = xQueueCreate(32, sizeof(RadioEvt));
  radioBegin();

  audio::volume = game.volume;
  audio::begin(I2S_BCLK, I2S_LRCK, I2S_DOUT);
  game.onSound = onSound;
  game.hasVoice = [](const std::string& slug) { return voices.count(slug) > 0; };

  httpBegin();
  ws.begin();
  ws.onEvent(onWs);
  if (MDNS.begin(HOSTNAME)) MDNS.addService("http", "tcp", 80);
}

void loop() {
  RadioEvt e;
  while (xQueueReceive(radioQ, &e, 0) == pdTRUE) {
    gs::Mac m;
    memcpy(m.b, e.mac, 6);
    if (e.type == GS_PKT_PRESS) game.podPress(m, e.seq, e.delayMs, e.us, millis());
    else game.podHello(m, millis());
  }

  uint32_t nowMs = millis();
  game.tick(esp_timer_get_time(), nowMs);
  sendFrame(nowMs);

  static uint32_t lastState = 0;
  if (game.dirty && nowMs - lastState >= 30) {
    game.dirty = false;
    lastState = nowMs;
    String s = stateString();
    ws.broadcastTXT(s);
    Serial.println(s);
  }

  static uint32_t lastSave = 0;
  if (game.saveDirty && nowMs - lastSave > 2000) {
    game.saveDirty = false;
    lastSave = nowMs;
    saveGame();
  }

  http.handleClient();
  ws.loop();
  readSerial();
  delay(1);
}
