import type { PlatformId, ButtonId } from "../../shared/types.js";

export interface Rect { x: number; y: number; width: number; height: number; }
export interface ButtonRegion extends Rect { id: ButtonId; }
export interface Chrome { screen: Rect; buttons: ButtonRegion[]; bodyWidth: number; bodyHeight: number; }

// Coordinates are in chrome-image pixel space. Right-side: up/select/down. Left: back.
function rectChrome(screen: Rect, bodyW: number, bodyH: number): Chrome {
  const rightX = screen.x + screen.width + 8;
  const leftX = screen.x - 24;
  return {
    screen, bodyWidth: bodyW, bodyHeight: bodyH,
    buttons: [
      { id: "back",   x: leftX,  y: screen.y + screen.height / 2 - 16, width: 16, height: 32 },
      { id: "up",     x: rightX, y: screen.y + 20,                     width: 16, height: 32 },
      { id: "select", x: rightX, y: screen.y + screen.height / 2 - 16, width: 16, height: 32 },
      { id: "down",   x: rightX, y: screen.y + screen.height - 52,     width: 16, height: 32 },
    ],
  };
}

// B3 (v0.0.5): the SCREEN bezel — the dark margin between the live screen and
// the body edge — is shrunk to ~40% of its v0.0.4 size so the screen fills more
// of the watch face. (The CASE rim is restored separately in app.css.) Margins
// below were cut to ~40% of the old values per platform:
//   basalt-class  L24/T30/R32/B42 → L10/T12/R13/B17  (body 200×240 → 167×197)
//   emery         L30/T30/R38/B42 → L12/T12/R15/B17  (body 268×300 → 227×257)
//   chalk (round) centered gap 34 → 14               (body 248 → 208)
//   gabbro(round) centered gap 34 → 14               (body 328 → 288)
const CHROMES: Record<PlatformId, Chrome> = {
  aplite:  rectChrome({ x: 10, y: 12, width: 144, height: 168 }, 167, 197),
  basalt:  rectChrome({ x: 10, y: 12, width: 144, height: 168 }, 167, 197),
  diorite: rectChrome({ x: 10, y: 12, width: 144, height: 168 }, 167, 197),
  flint:   rectChrome({ x: 10, y: 12, width: 144, height: 168 }, 167, 197),
  chalk:   rectChrome({ x: 14, y: 14, width: 180, height: 180 }, 208, 208),
  // emery: the LOGICAL panel is 200×228, but QEMU's VNC server rounds its
  // framebuffer width UP to a 16px dirty-tile boundary → the real RFB surface is
  // 208×228 (cols 200–207 are black padding). noVNC's scaleViewport uses ONE
  // aspect-preserving scale; if the container aspect (200:228) ≠ the fb aspect
  // (208:228) that single scale is wrong on the non-limiting axis, so touches
  // drifted DOWN (Y over-scaled by 208/200). Sizing the screen container to the
  // TRUE fb width (208) makes the aspect match → noVNC maps clicks 1:1 to fb
  // pixels on both axes. x is unchanged so the watch content stays put; the extra
  // 8px is the (black) padding strip. Pairs with the qemu pebble_touch X-align
  // fix (qemu-pebble-touch-xalign.patch) which corrects the qemu side.
  emery:   rectChrome({ x: 12, y: 12, width: 208, height: 228 }, 227, 257),
  gabbro:  rectChrome({ x: 14, y: 14, width: 260, height: 260 }, 288, 288),
};

export function getChrome(id: PlatformId): Chrome { return CHROMES[id]; }

export function hitTestButton(id: PlatformId, x: number, y: number): ButtonId | null {
  for (const b of CHROMES[id].buttons) {
    if (x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height) return b.id;
  }
  return null;
}
