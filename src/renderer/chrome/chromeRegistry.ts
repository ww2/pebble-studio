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

const CHROMES: Record<PlatformId, Chrome> = {
  aplite:  rectChrome({ x: 24, y: 30, width: 144, height: 168 }, 200, 240),
  basalt:  rectChrome({ x: 24, y: 30, width: 144, height: 168 }, 200, 240),
  diorite: rectChrome({ x: 24, y: 30, width: 144, height: 168 }, 200, 240),
  flint:   rectChrome({ x: 24, y: 30, width: 144, height: 168 }, 200, 240),
  chalk:   rectChrome({ x: 30, y: 30, width: 180, height: 180 }, 248, 248),
  emery:   rectChrome({ x: 30, y: 30, width: 200, height: 228 }, 268, 300),
  gabbro:  rectChrome({ x: 30, y: 30, width: 260, height: 260 }, 328, 328),
};

export function getChrome(id: PlatformId): Chrome { return CHROMES[id]; }

export function hitTestButton(id: PlatformId, x: number, y: number): ButtonId | null {
  for (const b of CHROMES[id].buttons) {
    if (x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height) return b.id;
  }
  return null;
}
