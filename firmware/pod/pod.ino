// Seat pod: an arcade button plus an overhead LED strip.
// Sends button presses to the hub over ESP-NOW and shows whatever light
// mode the hub broadcasts for this pod. All pods run identical firmware;
// the host pairs each pod with a seat from the host console.
//
// Board: ESP32-C3 SuperMini (any ESP32 works; adjust pins in config.h).
// Arduino core: esp32 by Espressif, 2.x or 3.x.
// Library: Adafruit NeoPixel.

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
#include <Adafruit_NeoPixel.h>
#include <math.h>
#include "protocol.h"

Adafruit_NeoPixel strip(STRIP_LEDS, STRIP_PIN, NEO_GRB + NEO_KHZ800);

static const uint8_t BROADCAST[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};
uint8_t myMac[6];
uint8_t hubMac[6];
bool haveHub = false;

// shown state, written by the radio callback
volatile uint8_t mode = GS_OFF;
volatile uint8_t colR, colG, colB;
volatile uint8_t ackSeq = 0;
volatile uint32_t lastFrameMs = 0;
volatile uint32_t modeSinceMs = 0;

// press handling
volatile uint32_t pressAtMs = 0;
volatile bool pressFlag = false;
uint8_t pressSeq = 0;
bool pressPending = false;
uint32_t pendingSinceMs = 0;
uint32_t lastSendMs = 0;

// ---------------- radio ----------------
void handleFrame(const uint8_t* src, const uint8_t* data, int len) {
  if (!gsValid(data, len, GS_PKT_FRAME, sizeof(GsHeader) + 1)) return;
  const GsFrame* f = (const GsFrame*)data;
  int count = f->count;
  if ((int)(sizeof(GsHeader) + 1 + count * sizeof(GsFrameEntry)) > len) return;

  if (!haveHub || memcmp(src, hubMac, 6) != 0) {
    memcpy(hubMac, src, 6);
    haveHub = true;  // peer is added in loop (not allowed from this callback on all cores)
  }
  lastFrameMs = millis();
  for (int i = 0; i < count; i++) {
    const GsFrameEntry& e = f->e[i];
    if (memcmp(e.mac, myMac, 6) != 0) continue;
    if (e.mode != mode) modeSinceMs = millis();
    mode = e.mode;
    colR = e.r;
    colG = e.g;
    colB = e.b;
    ackSeq = e.ackSeq;
    return;
  }
  mode = GS_OFF;  // hub does not know us yet; it will after our next hello
}

#if ESP_ARDUINO_VERSION_MAJOR >= 3
void onRadio(const esp_now_recv_info_t* info, const uint8_t* data, int len) { handleFrame(info->src_addr, data, len); }
#else
void onRadio(const uint8_t* mac, const uint8_t* data, int len) { handleFrame(mac, data, len); }
#endif

void addPeer(const uint8_t* mac) {
  if (esp_now_is_peer_exist(mac)) return;
  esp_now_peer_info_t p = {};
  memcpy(p.peer_addr, mac, 6);
  p.channel = RADIO_CHANNEL;
  p.ifidx = WIFI_IF_STA;
  p.encrypt = false;
  esp_now_add_peer(&p);
}

void send(const void* data, size_t len) {
  esp_now_send(haveHub ? hubMac : BROADCAST, (const uint8_t*)data, len);
}

void sendPress() {
  GsPress p;
  gsHeader(p.h, GS_PKT_PRESS);
  p.seq = pressSeq;
  uint32_t d = millis() - pressAtMs;
  p.delayMs = d > 60000 ? 60000 : d;
  send(&p, sizeof(p));
  lastSendMs = millis();
}

void sendHello() {
  GsHello h;
  gsHeader(h.h, GS_PKT_HELLO);
  h.pressSeq = pressSeq;
  send(&h, sizeof(h));
}

// ---------------- button ----------------
void IRAM_ATTR onButton() {
  static uint32_t last = 0;
  uint32_t now = millis();
  if (now - last < 150) return;  // debounce
  last = now;
  pressAtMs = now;
  pressFlag = true;
}

// ---------------- lights ----------------
void setButtonLed(float level) {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite(BUTTON_LED_PIN, (uint32_t)(level * 255));
#else
  ledcWrite(0, (uint32_t)(level * 255));
#endif
}

void fill(uint8_t r, uint8_t g, uint8_t b, float level) {
  uint32_t c = strip.Color(r * level, g * level, b * level);
  for (int i = 0; i < STRIP_LEDS; i++) strip.setPixelColor(i, c);
}

void render(uint32_t now) {
  bool hubLost = now - lastFrameMs > 3000;
  uint8_t m = hubLost ? (uint8_t)GS_OFF : mode;
  uint32_t t = now - modeSinceMs;
  bool blinkFast = (t / 200) % 2 == 0;
  bool blinkSlow = (now / 500) % 2 == 0;

  strip.clear();
  float btn = 0;
  switch (m) {
    case GS_ARMED: {
      float breathe = 0.5f + 0.5f * sinf(now / 300.0f);
      fill(255, 255, 255, 0.08f + 0.17f * breathe);
      btn = 0.3f + 0.7f * breathe;
      break;
    }
    case GS_WINNER:
      fill(colR, colG, colB, 1.0f);
      btn = 1;
      break;
    case GS_CORRECT:
      if (blinkFast || t > 1200) fill(0, 255, 0, 1.0f);
      btn = 1;
      break;
    case GS_WRONG:
      if (blinkFast || t > 1200) fill(255, 0, 0, 1.0f);
      break;
    case GS_FALSE:
      fill(255, 0, 0, 0.15f);
      break;
    case GS_IDENTIFY:
      if (blinkSlow) fill(colR, colG, colB, 0.6f);
      btn = blinkSlow ? 1 : 0;
      break;
    default:
      break;
  }
  strip.show();
  setButtonLed(btn);

#if STATUS_LED_PIN >= 0
  // on-board LED: blinks while the hub is not heard, off otherwise
  digitalWrite(STATUS_LED_PIN, (hubLost && blinkSlow) ? STATUS_LED_ON : !STATUS_LED_ON);
#endif
}

// ---------------- setup / loop ----------------
void setup() {
  Serial.begin(115200);

  pinMode(BUTTON_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(BUTTON_PIN), onButton, FALLING);
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcAttach(BUTTON_LED_PIN, 1000, 8);
#else
  ledcSetup(0, 1000, 8);
  ledcAttachPin(BUTTON_LED_PIN, 0);
#endif
#if STATUS_LED_PIN >= 0
  pinMode(STATUS_LED_PIN, OUTPUT);
#endif
  strip.begin();
  strip.setBrightness(STRIP_BRIGHTNESS);
  strip.clear();
  strip.show();

  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  esp_wifi_set_ps(WIFI_PS_NONE);  // keep the radio listening for light updates
  esp_wifi_set_promiscuous(true);
  esp_wifi_set_channel(RADIO_CHANNEL, WIFI_SECOND_CHAN_NONE);
  esp_wifi_set_promiscuous(false);
  WiFi.macAddress(myMac);
  Serial.printf("pod %02x:%02x:%02x:%02x:%02x:%02x channel %d\n", myMac[0], myMac[1], myMac[2], myMac[3], myMac[4], myMac[5], RADIO_CHANNEL);

  if (esp_now_init() != ESP_OK) {
    Serial.println("ESP-NOW init failed");
    return;
  }
  esp_now_register_recv_cb(onRadio);
  addPeer(BROADCAST);
  pressSeq = (uint8_t)esp_random();  // so a rebooted pod is never mistaken for a resend
}

void loop() {
  uint32_t now = millis();
  if (haveHub) addPeer(hubMac);

  if (pressFlag) {
    pressFlag = false;
    pressSeq++;
    pressPending = true;
    pendingSinceMs = now;
    sendPress();
  }
  // resend until the hub's frame echoes our sequence number
  if (pressPending) {
    if (ackSeq == pressSeq || now - pendingSinceMs > 2000) pressPending = false;
    else if (now - lastSendMs >= 25) sendPress();
  }

  static uint32_t lastHello = 0;
  if (now - lastHello >= 1000) {
    lastHello = now;
    sendHello();
  }

  static uint32_t lastRender = 0;
  if (now - lastRender >= 15) {
    lastRender = now;
    render(now);
  }
  delay(1);
}
