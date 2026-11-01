// Studio light for the Game Show Buzzer.
// Subscribes to gsbuzz/v1/<ROOM>/iot and lights up whoever buzzed in:
//   - NeoPixel segment over each contestant (default)
//   - and/or one relay per contestant (lamps)
//   - and/or an OLED showing the name
//
// Board: any ESP32 (Arduino core 2.x or 3.x).
// Libraries (Arduino Library Manager): PubSubClient (Nick O'Leary),
//   ArduinoJson (Benoit Blanchon, v7), Adafruit NeoPixel,
//   Adafruit SSD1306 + Adafruit GFX (only if USE_OLED).
//
// Serial commands (115200 baud):  room ABCDE   |   status   |   test

#if __has_include("config.h")
#include "config.h"
#else
#warning "config.h not found: using config.example.h. Copy it to config.h and set your WiFi."
#include "config.example.h"
#endif

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>

#if USE_NEOPIXEL
#include <Adafruit_NeoPixel.h>
Adafruit_NeoPixel strip(NUM_SLOTS * LEDS_PER_SLOT, NEOPIXEL_PIN, NEO_GRB + NEO_KHZ800);
#endif

#if USE_OLED
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
Adafruit_SSD1306 oled(128, 64, &Wire, -1);
bool oledOk = false;
#endif

WiFiClient net;
PubSubClient mqtt(net);
Preferences prefs;

String room;
String deviceId;

// ---------- game state from the host ----------
struct Show {
  String phase = "locked";   // locked | armed | buzzed
  int slot = 0;              // contestant to light (1-based, 0 = none)
  String name;
  uint32_t color = 0xFFFFFF;
  String result;             // "", "ok", "bad" (last correct/wrong call)
  int resultSlot = 0;        // who that call was about
  String resultName;
  long resultSeq = -1;
  bool excluded[33] = {false};
} show;

bool haveState = false;
uint32_t resultStartedMs = 0;  // when the current correct/wrong flash began
const uint32_t RESULT_MS = 2500;
uint32_t lastConnectTry = 0;

// ---------- helpers ----------
// True while the correct/wrong flash for the latest call is running.
bool resultActive() {
  return show.result.length() && resultStartedMs && millis() - resultStartedMs < RESULT_MS;
}

String topicFor(const char* sub) { return "gsbuzz/v1/" + room + "/" + sub; }

uint32_t parseHex(const char* s) {
  if (!s || !*s) return 0xFFFFFF;
  return (uint32_t)strtoul(s, nullptr, 16) & 0xFFFFFF;
}

void beep(int freq, int ms) {
#if PIEZO_PIN >= 0
  tone(PIEZO_PIN, freq, ms);
#endif
}

// ---------- outputs ----------
#if USE_NEOPIXEL
void fillSlot(int slot, uint32_t rgb, float level) {
  if (slot < 1 || slot > NUM_SLOTS) return;
  uint8_t r = ((rgb >> 16) & 0xFF) * level;
  uint8_t g = ((rgb >> 8) & 0xFF) * level;
  uint8_t b = (rgb & 0xFF) * level;
  for (int i = 0; i < LEDS_PER_SLOT; i++) strip.setPixelColor((slot - 1) * LEDS_PER_SLOT + i, strip.Color(r, g, b));
}
#endif

void setRelay(int slot, bool on) {
#if USE_RELAYS
  const int n = sizeof(RELAY_PINS) / sizeof(RELAY_PINS[0]);
  if (slot < 1 || slot > n) return;
  digitalWrite(RELAY_PINS[slot - 1], (on ^ RELAY_ACTIVE_LOW) ? HIGH : LOW);
#endif
}

void allRelays(bool on) {
#if USE_RELAYS
  const int n = sizeof(RELAY_PINS) / sizeof(RELAY_PINS[0]);
  for (int i = 1; i <= n; i++) setRelay(i, on);
#endif
}

void drawOled() {
#if USE_OLED
  if (!oledOk) return;
  oled.clearDisplay();
  oled.setTextColor(SSD1306_WHITE);
  oled.setTextSize(1);
  oled.setCursor(0, 0);
  if (WiFi.status() != WL_CONNECTED) oled.print("WiFi...");
  else if (!mqtt.connected()) oled.print("Broker...");
  else oled.print("Room " + room);

  String headline, big;
  if (show.phase == "buzzed") { headline = "BUZZED IN"; big = show.name; }
  else if (resultActive()) { headline = show.result == "ok" ? "CORRECT" : "WRONG"; big = show.resultName; }
  else if (show.phase == "armed") { big = "OPEN"; }
  else { big = "READY"; }

  oled.setCursor(0, 14);
  oled.print(headline);
  // largest text size that fits 128 px (6 px per char per size unit)
  int size = big.length() <= 5 ? 4 : big.length() <= 7 ? 3 : big.length() <= 10 ? 2 : 1;
  oled.setTextSize(size);
  oled.setCursor(0, 28);
  oled.print(big);
  oled.display();
#endif
}

// Called every loop: renders the current state with simple animations.
void renderLights() {
  uint32_t now = millis();
  bool flashing = resultActive();

#if USE_NEOPIXEL
  strip.clear();
  if (show.phase == "armed") {
    // slow white breathing on everyone still allowed to buzz
    float level = 0.08 + 0.12 * (0.5 + 0.5 * sin(now / 300.0));
    for (int s = 1; s <= NUM_SLOTS; s++) if (!show.excluded[s]) fillSlot(s, 0xFFFFFF, level);
  } else if (show.phase == "buzzed") {
    fillSlot(show.slot, show.color, 1.0);
  }
  if (flashing) {
    // flash green (correct) or red (wrong) over the contestant who answered
    bool on = ((now - resultStartedMs) / 200) % 2 == 0 || now - resultStartedMs > 1200;
    fillSlot(show.resultSlot, on ? (show.result == "ok" ? 0x00FF00 : 0xFF0000) : 0, 1.0);
  }
  strip.show();
#endif

#if USE_RELAYS
  // lamp on for whoever buzzed in, and briefly for whoever just answered
  static int lastA = -1, lastB = -1;
  int a = show.phase == "buzzed" ? show.slot : 0;
  int b = flashing ? show.resultSlot : 0;
  if (a != lastA || b != lastB) {
    allRelays(false);
    if (a) setRelay(a, true);
    if (b) setRelay(b, true);
    lastA = a;
    lastB = b;
  }
#endif

  static uint32_t lastOled = 0;
  static bool lastFlashing = false;
  if (now - lastOled > 250 || flashing != lastFlashing) {
    drawOled();
    lastOled = now;
    lastFlashing = flashing;
  }
}

// ---------- MQTT ----------
void onMessage(char* topic, byte* payload, unsigned int len) {
  JsonDocument doc;
  if (len == 0) {  // host cleared the room
    show = Show();
    haveState = false;
    return;
  }
  if (deserializeJson(doc, payload, len)) return;

  String prevPhase = show.phase;
  int prevSlot = show.slot;

  show.phase = doc["p"] | "locked";
  show.slot = doc["s"] | 0;
  show.name = doc["n"] | "";
  show.color = parseHex(doc["c"] | "");
  show.result = doc["r"] | "";
  show.resultSlot = doc["rs"] | 0;
  show.resultName = doc["rn"] | "";
  for (int i = 0; i < 33; i++) show.excluded[i] = false;
  for (JsonVariant v : doc["x"].as<JsonArray>()) {
    int s = v.as<int>();
    if (s >= 0 && s < 33) show.excluded[s] = true;
  }

  long k = doc["k"] | 0L;
  if (haveState && k != show.resultSeq && show.result.length()) {
    resultStartedMs = millis();
    beep(show.result == "ok" ? 1320 : 180, show.result == "ok" ? 250 : 600);
  }
  if (!haveState) resultStartedMs = 0;  // don't replay an old result after boot
  show.resultSeq = k;

  if (haveState && show.phase == "buzzed" && (prevPhase != "buzzed" || prevSlot != show.slot)) beep(440, 300);
  haveState = true;

  Serial.printf("[iot] phase=%s slot=%d name=%s result=%s\n", show.phase.c_str(), show.slot, show.name.c_str(), show.result.c_str());
}

void mqttConnect() {
  if (mqtt.connected() || WiFi.status() != WL_CONNECTED) return;
  if (millis() - lastConnectTry < 3000) return;
  lastConnectTry = millis();

  String clientId = "gsbuzz-iot-" + deviceId;
  String willTopic = topicFor("device/") + deviceId;
  String offline = "{\"id\":\"" + deviceId + "\",\"online\":false}";
  bool ok = strlen(MQTT_USER)
    ? mqtt.connect(clientId.c_str(), MQTT_USER, MQTT_PASS, willTopic.c_str(), 1, true, offline.c_str())
    : mqtt.connect(clientId.c_str(), willTopic.c_str(), 1, true, offline.c_str());
  if (!ok) {
    Serial.printf("[mqtt] connect failed, state=%d\n", mqtt.state());
    return;
  }
  Serial.println("[mqtt] connected, room " + room);
  String online = "{\"id\":\"" + deviceId + "\",\"online\":true,\"name\":\"studio-light\"}";
  mqtt.publish(willTopic.c_str(), online.c_str(), true);
  mqtt.subscribe(topicFor("iot").c_str(), 1);
}

void switchRoom(const String& code) {
  String clean;
  for (unsigned i = 0; i < code.length(); i++) {
    char c = code[i];
    if (isalnum((unsigned char)c)) clean += (char)toupper((unsigned char)c);
  }
  if (!clean.length() || clean.length() > 12) { Serial.println("room code must be 1-12 letters/digits"); return; }
  if (mqtt.connected()) {
    mqtt.publish((topicFor("device/") + deviceId).c_str(), "", true);  // clear old presence
    mqtt.unsubscribe(topicFor("iot").c_str());
    mqtt.disconnect();
  }
  room = clean;
  prefs.putString("room", room);
  show = Show();
  haveState = false;
  lastConnectTry = 0;
  Serial.println("room set to " + room);
}

// ---------- serial console ----------
void handleSerial() {
  static String line;
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\r') continue;
    if (c != '\n') { if (line.length() < 64) line += c; continue; }
    line.trim();
    if (line.startsWith("room ")) switchRoom(line.substring(5));
    else if (line == "status") {
      Serial.printf("room=%s wifi=%d ip=%s mqtt=%d phase=%s slot=%d\n", room.c_str(), WiFi.status() == WL_CONNECTED,
                    WiFi.localIP().toString().c_str(), mqtt.connected(), show.phase.c_str(), show.slot);
    } else if (line == "test") {
      // light every slot in turn to check wiring
      for (int s = 1; s <= NUM_SLOTS; s++) {
#if USE_NEOPIXEL
        strip.clear(); fillSlot(s, 0xFFFFFF, 1.0); strip.show();
#endif
        allRelays(false); setRelay(s, true);
        Serial.printf("slot %d\n", s);
        delay(600);
      }
      allRelays(false);
    } else if (line.length()) Serial.println("commands: room CODE | status | test");
    line = "";
  }
}

// ---------- setup / loop ----------
void setup() {
  Serial.begin(115200);
  delay(200);

  WiFi.mode(WIFI_STA);  // must run before reading the MAC on core 3.x
  uint8_t mac[6];
  WiFi.macAddress(mac);
  char buf[13];
  snprintf(buf, sizeof(buf), "%02x%02x%02x%02x%02x%02x", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  deviceId = buf;

  prefs.begin("gsbuzz", false);
  room = prefs.getString("room", ROOM_CODE);

#if USE_NEOPIXEL
  strip.begin();
  strip.setBrightness(BRIGHTNESS);
  strip.clear();
  strip.show();
#endif
#if USE_RELAYS
  for (int pin : RELAY_PINS) pinMode(pin, OUTPUT);
  allRelays(false);
#endif
#if USE_OLED
  Wire.begin(OLED_SDA, OLED_SCL);
  oledOk = oled.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR);
  if (!oledOk) Serial.println("[oled] not found");
#endif

  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.printf("[wifi] connecting to %s, room %s\n", WIFI_SSID, room.c_str());

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(1024);
  mqtt.setKeepAlive(20);
  mqtt.setCallback(onMessage);
}

void loop() {
  handleSerial();
  mqttConnect();
  mqtt.loop();
  renderLights();
  delay(10);
}
