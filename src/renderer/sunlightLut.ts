// src/renderer/sunlightLut.ts
// Pebble "sunlight" colour correction — the exact 64-entry LUT from
// pebble_tool/commands/screenshot.py `_correct_colours`. The Pebble Time colour
// e-paper renders the nominal 64 colours (channels ∈ {0,85,170,255}) muted/gamma-
// shifted; this maps emulator output to the real on-display appearance.

// Corrected RGB triples in nominal order: for r in [0,85,170,255], g in [...], b in [...].
// Index of nominal (ri,gi,bi) (each 0..3) is ri*16 + gi*4 + bi.
const CORRECTED: number[] = [
  0,0,0,      0,30,65,    0,67,135,   0,104,202,
  43,74,44,   39,81,79,   22,99,141,  0,125,206,
  94,152,96,  92,155,114, 87,165,162, 76,180,219,
  142,227,145,142,230,158,138,235,192,132,245,241,
  74,22,27,   72,39,72,   64,72,138,  47,107,204,
  86,78,54,   84,84,84,   79,103,144, 65,128,208,
  117,154,100,117,157,118,113,166,164,105,181,221,
  158,229,148,157,231,160,155,236,194,149,246,242,
  153,53,63,  152,62,90,  149,86,148, 143,116,210,
  157,91,77,  157,96,100, 154,112,153,149,135,213,
  175,160,114,174,163,130,171,171,171,167,186,226,
  201,232,157,201,234,167,199,240,200,195,249,247,
  227,84,98,  226,88,116, 225,106,163,222,131,220,
  230,110,107,230,114,124,227,127,167,225,148,223,
  241,170,134,241,173,147,239,181,184,236,195,235,
  255,238,171,255,241,181,255,246,211,255,255,255,
];

// Snap a 0..255 channel to its grid index 0..3 (nearest of 0/85/170/255).
const SNAP_IDX = new Uint8Array(256);
for (let v = 0; v < 256; v++) SNAP_IDX[v] = Math.min(3, Math.floor((v + 42) / 85));

/** Apply the Pebble sunlight LUT to an RGBA byte array in place (alpha untouched). */
export function applySunlightLut(data: Uint8Array): void {
  for (let i = 0; i + 4 <= data.length; i += 4) {
    const k = (SNAP_IDX[data[i]] * 16 + SNAP_IDX[data[i + 1]] * 4 + SNAP_IDX[data[i + 2]]) * 3;
    data[i] = CORRECTED[k];
    data[i + 1] = CORRECTED[k + 1];
    data[i + 2] = CORRECTED[k + 2];
    // data[i + 3] (alpha) unchanged
  }
}
