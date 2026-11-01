// Copy this file to config.h and edit. config.h is git-ignored so your WiFi
// password never lands in the repository.
#pragma once

// ---------- network ----------
#define WIFI_SSID     "your-wifi"
#define WIFI_PASS     "your-password"

// Must be the same broker the web pages use. The web pages use the WebSocket
// port (8884); the ESP32 uses plain MQTT (1883) on the same broker.
#define MQTT_HOST     "broker.hivemq.com"
#define MQTT_PORT     1883
#define MQTT_USER     ""            // leave empty for the public broker
#define MQTT_PASS     ""

// Room code shown on the host console. Can be changed later without
// reflashing: open the serial monitor (115200 baud) and type:  room ABCDE
#define ROOM_CODE     "ABCDE"

// ---------- outputs: enable any combination ----------

// 1) Addressable LED strip (WS2812B / NeoPixel). One segment per player,
//    mounted over each contestant's seat. Low voltage (5 V), the safe default.
#define USE_NEOPIXEL      1
#define NEOPIXEL_PIN      5
#define NUM_SLOTS         8         // number of contestant positions
#define LEDS_PER_SLOT     10        // LEDs in each contestant's segment
#define BRIGHTNESS        180       // 0-255; keep below ~200 on USB power

// 2) Relay board: one relay per contestant, switches a lamp or 12 V light.
//    Mains (110/230 V) wiring is dangerous: use an enclosed, rated relay
//    module or a smart plug instead of bare relay boards.
#define USE_RELAYS        0
#define RELAY_ACTIVE_LOW  1         // most cheap relay boards switch on LOW
static const int RELAY_PINS[] = {16, 17, 18, 19, 23, 25, 26, 27};  // slot 1..N

// 3) Small OLED (SSD1306 128x64, I2C) showing the name of who buzzed in.
#define USE_OLED          1
#define OLED_SDA          21
#define OLED_SCL          22
#define OLED_ADDR         0x3C

// 4) Piezo beeper on buzz (-1 = none).
#define PIEZO_PIN         -1
