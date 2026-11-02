// Aux-jack audio: plays synthesized sound effects and WAV clips through a
// PCM5102A I2S board. Runs in its own task so the game never waits on audio.
//
// Clips must be WAV, 16-bit PCM, mono, 22050 Hz. The host page converts any
// recording to this format before uploading. Optional overrides for the
// built-in effects: /sfx/armed.wav, /sfx/buzz.wav, /sfx/correct.wav, /sfx/wrong.wav
#pragma once
#include <Arduino.h>
#include <ESP_I2S.h>
#include <LittleFS.h>
#include <math.h>

namespace audio {

constexpr int RATE = 22050;
constexpr int CHUNK = 256;  // frames per write

enum Kind : uint8_t { FX_ARMED, FX_BUZZ, FX_CORRECT, FX_WRONG, CLIP };

struct Req {
  Kind kind;
  char path[48];
};

I2SClass i2s;
QueueHandle_t queue;
volatile int volume = 70;          // 0-100
volatile bool stopFlag = false;
volatile bool ready = false;

int16_t frame[CHUNK * 2];  // stereo

inline int16_t scale(float v) {
  float g = volume / 100.0f;
  g = g * g;  // perceptual curve
  float x = v * g * 32767.0f;
  if (x > 32767) x = 32767;
  if (x < -32768) x = -32768;
  return (int16_t)x;
}

void writeFrames(int n) { i2s.write((uint8_t*)frame, n * 4); }

void silence(int ms) {
  memset(frame, 0, sizeof(frame));
  int total = RATE * ms / 1000;
  while (total > 0) {
    int n = total > CHUNK ? CHUNK : total;
    writeFrames(n);
    total -= n;
  }
}

// One synthesized note. wave: 0 sine, 1 square, 2 saw, 3 triangle.
// f2 adds a second oscillator (0 = none).
void note(float f, float f2, int ms, int wave, float amp) {
  int total = RATE * ms / 1000;
  int fadeOut = RATE / 50;  // 20 ms
  for (int i = 0; i < total && !stopFlag;) {
    int n = (total - i) > CHUNK ? CHUNK : (total - i);
    for (int k = 0; k < n; k++, i++) {
      float t = (float)i / RATE;
      auto osc = [&](float fr) {
        float ph = fmodf(t * fr, 1.0f);
        switch (wave) {
          case 1: return ph < 0.5f ? 1.0f : -1.0f;
          case 2: return 2.0f * ph - 1.0f;
          case 3: return ph < 0.5f ? 4.0f * ph - 1.0f : 3.0f - 4.0f * ph;
          default: return sinf(2.0f * (float)M_PI * ph);
        }
      };
      float v = osc(f) + (f2 > 0 ? 0.6f * osc(f2) : 0.0f);
      float env = 1.0f;
      if (i < 200) env = i / 200.0f;
      if (total - i < fadeOut) env = (float)(total - i) / fadeOut;
      int16_t s = scale(v * amp * env * 0.5f);
      frame[k * 2] = s;
      frame[k * 2 + 1] = s;
    }
    writeFrames(n);
  }
}

bool playWav(const char* path) {
  File f = LittleFS.open(path, "r");
  if (!f) return false;
  uint8_t hdr[12];
  if (f.read(hdr, 12) != 12 || memcmp(hdr, "RIFF", 4) || memcmp(hdr + 8, "WAVE", 4)) { f.close(); return false; }
  uint16_t channels = 1, bits = 16;
  uint32_t rate = RATE, dataLen = 0;
  bool haveData = false;
  while (f.available()) {
    uint8_t ch[8];
    if (f.read(ch, 8) != 8) break;
    uint32_t len = ch[4] | (ch[5] << 8) | (ch[6] << 16) | ((uint32_t)ch[7] << 24);
    if (!memcmp(ch, "fmt ", 4)) {
      uint8_t fmt[16];
      f.read(fmt, 16);
      channels = fmt[2] | (fmt[3] << 8);
      rate = fmt[4] | (fmt[5] << 8) | (fmt[6] << 16) | ((uint32_t)fmt[7] << 24);
      bits = fmt[14] | (fmt[15] << 8);
      if (len > 16) f.seek(f.position() + len - 16);
    } else if (!memcmp(ch, "data", 4)) {
      dataLen = len;
      haveData = true;
      break;
    } else {
      f.seek(f.position() + len + (len & 1));
    }
  }
  if (!haveData || bits != 16 || channels < 1 || channels > 2 || rate != RATE) {
    Serial.printf("# skip %s: need 16-bit mono/stereo %d Hz WAV\n", path, RATE);
    f.close();
    return false;
  }
  int16_t in[CHUNK * 2];
  uint32_t left = dataLen;
  while (left > 0 && !stopFlag) {
    int frames = CHUNK;
    uint32_t want = frames * channels * 2;
    if (want > left) { want = left; frames = want / (channels * 2); }
    int got = f.read((uint8_t*)in, want);
    if (got <= 0) break;
    frames = got / (channels * 2);
    for (int k = 0; k < frames; k++) {
      float l = in[k * channels] / 32768.0f;
      float r = in[k * channels + channels - 1] / 32768.0f;
      frame[k * 2] = scale(l);
      frame[k * 2 + 1] = scale(r);
    }
    writeFrames(frames);
    left -= got;
  }
  f.close();
  return true;
}

void playFx(Kind k) {
  static const char* files[] = {"/sfx/armed.wav", "/sfx/buzz.wav", "/sfx/correct.wav", "/sfx/wrong.wav"};
  if (LittleFS.exists(files[k]) && playWav(files[k])) return;
  switch (k) {
    case FX_ARMED:
      note(880, 0, 90, 0, 0.8f);
      note(1320, 0, 140, 0, 0.8f);
      break;
    case FX_BUZZ:
      note(220, 110, 550, 2, 0.9f);
      break;
    case FX_CORRECT:
      note(660, 0, 120, 3, 0.9f);
      note(880, 0, 120, 3, 0.9f);
      note(1320, 0, 300, 3, 0.9f);
      break;
    case FX_WRONG:
      note(160, 80, 700, 2, 0.9f);
      break;
    default:
      break;
  }
}

void task(void*) {
  Req r;
  for (;;) {
    if (xQueueReceive(queue, &r, portMAX_DELAY) != pdTRUE) continue;
    stopFlag = false;
    if (r.kind == CLIP) playWav(r.path);
    else playFx(r.kind);
    silence(30);
  }
}

void begin(int bclk, int lrck, int dout) {
  i2s.setPins(bclk, lrck, dout);
  if (!i2s.begin(I2S_MODE_STD, RATE, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO)) {
    Serial.println("# audio: I2S init failed");
    return;
  }
  queue = xQueueCreate(8, sizeof(Req));
  xTaskCreatePinnedToCore(task, "audio", 6144, nullptr, 2, nullptr, 1);
  ready = true;
}

// interrupt=true drops anything queued or playing (a new buzz beats an old announcement)
void play(Kind k, const char* path = nullptr, bool interrupt = false) {
  if (!ready) return;
  if (interrupt) {
    xQueueReset(queue);
    stopFlag = true;
  }
  Req r;
  r.kind = k;
  r.path[0] = 0;
  if (path) strlcpy(r.path, path, sizeof(r.path));
  xQueueSend(queue, &r, 0);
}

}  // namespace audio
