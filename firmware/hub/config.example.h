// Copy to config.h (git-ignored) and edit.
#pragma once

// Wi-Fi network the hub creates. Host and TV join it, then open http://192.168.4.1
#define AP_SSID      "GameShow"
#define AP_PASS      "buzzer123"   // 8+ characters
#define HOSTNAME     "buzzer"      // also reachable as http://buzzer.local on most devices

// Radio channel shared by the hub's Wi-Fi and the seat pods (1-13).
// Must match RADIO_CHANNEL in the pod config. Pick one the venue Wi-Fi does not use.
#define RADIO_CHANNEL 6

// PCM5102A audio board (aux jack)
#define I2S_BCLK  4
#define I2S_LRCK  5
#define I2S_DOUT  6
