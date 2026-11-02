// Radio packets between seat pods and the hub (ESP-NOW, max 250 bytes).
// Keep firmware/hub/protocol.h and firmware/pod/protocol.h identical.
#pragma once
#include <stdint.h>

#define GS_MAGIC0 'G'
#define GS_MAGIC1 'S'
#define GS_VERSION 1

// Pod -> hub
#define GS_PKT_HELLO 1   // heartbeat, every second
#define GS_PKT_PRESS 2   // button pressed

// Hub -> all pods (broadcast)
#define GS_PKT_FRAME 3   // what every pod should show right now

// Light modes a pod can show
enum GsLight : uint8_t {
  GS_OFF = 0,
  GS_ARMED = 1,      // buzzers open: breathing white, button LED pulsing
  GS_WINNER = 2,     // this seat buzzed first: solid seat color
  GS_CORRECT = 3,    // green flashing
  GS_WRONG = 4,      // red flashing
  GS_FALSE = 5,      // pressed too early: dim red
  GS_IDENTIFY = 6,   // blue blinking: unpaired pod, or "find this pod"
};

#pragma pack(push, 1)
struct GsHeader {
  uint8_t magic[2];
  uint8_t version;
  uint8_t type;
};

struct GsHello {
  GsHeader h;
  uint8_t pressSeq;   // last press sequence number (lets the hub ack after a reboot)
};

struct GsPress {
  GsHeader h;
  uint8_t seq;        // increments on every press; resends reuse it
  uint16_t delayMs;   // ms between the physical press and this send (0 on first try)
};

struct GsFrameEntry {
  uint8_t mac[6];
  uint8_t mode;       // GsLight
  uint8_t r, g, b;
  uint8_t ackSeq;     // last press seq the hub received from this pod
};

#define GS_MAX_FRAME_ENTRIES 20
struct GsFrame {
  GsHeader h;
  uint8_t count;
  GsFrameEntry e[GS_MAX_FRAME_ENTRIES];
};
#pragma pack(pop)

static_assert(sizeof(GsFrame) <= 250, "ESP-NOW payload limit");

inline void gsHeader(GsHeader& h, uint8_t type) {
  h.magic[0] = GS_MAGIC0;
  h.magic[1] = GS_MAGIC1;
  h.version = GS_VERSION;
  h.type = type;
}

inline bool gsValid(const uint8_t* data, int len, uint8_t type, int minLen) {
  if (len < minLen || len < (int)sizeof(GsHeader)) return false;
  const GsHeader* h = (const GsHeader*)data;
  return h->magic[0] == GS_MAGIC0 && h->magic[1] == GS_MAGIC1 && h->version == GS_VERSION && h->type == type;
}
