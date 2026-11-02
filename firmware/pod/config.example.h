// Copy to config.h (git-ignored) and edit. Every pod uses the same file;
// seats are assigned from the host console, not here.
#pragma once

// Must match RADIO_CHANNEL in the hub config.
#define RADIO_CHANNEL 6

// Pins for an ESP32-C3 SuperMini (change for other boards)
#define BUTTON_PIN       3    // arcade button switch to GND (internal pull-up)
#define BUTTON_LED_PIN   4    // arcade button lamp, through a transistor (see README)
#define STRIP_PIN        5    // WS2812B data, through a 330 ohm resistor
#define STATUS_LED_PIN   8    // on-board LED; blinks when the hub is not heard (-1 = none)
#define STATUS_LED_ON    LOW  // SuperMini on-board LED is active-low

// Overhead LED strip
#define STRIP_LEDS       15
#define STRIP_BRIGHTNESS 160  // 0-255. Each LED draws up to 60 mA at full white
