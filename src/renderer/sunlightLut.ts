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

// Grid spacing: the four nominal channel levels 0/85/170/255 sit at 0,1,2,3.
const STEP = 85;
// Snap tolerance, in 0..255 channel units. A channel within this of a grid node
// is treated as exactly that node — so full-brightness nominal frames (and minor
// VNC/LCD jitter around the grid) map to the exact LUT entry, byte-identical to a
// plain nearest-grid lookup. Genuinely off-grid values (a fading backlight) fall
// through to interpolation instead.
const SNAP_TOL = 6;

/** Resolve a 0..255 channel to a grid segment: lower node `i0`, upper node `i1`
 * (both 0..3) and the fraction `f` (0..1) between them. `f === 0` means the value
 * snapped to a node (within SNAP_TOL), so i0 === i1. */
function gridPos(v: number): { i0: number; i1: number; f: number } {
  const pos = v / STEP; // 0..3
  let i0 = Math.floor(pos);
  let f = pos - i0;
  if (f * STEP <= SNAP_TOL) {
    f = 0; // close to the node below — snap down
  } else if ((1 - f) * STEP <= SNAP_TOL) {
    i0 += 1; // close to the node above — snap up
    f = 0;
  }
  if (i0 >= 3) return { i0: 3, i1: 3, f: 0 }; // clamp (255 -> node 3)
  return { i0, i1: f === 0 ? i0 : i0 + 1, f };
}

/**
 * Apply the Pebble sunlight LUT to an RGBA byte array in place (alpha untouched).
 *
 * The LUT is only defined at the 64 nominal colours, so we TRILINEARLY INTERPOLATE
 * between the eight surrounding nodes rather than snapping to the nearest. On-grid
 * (full-brightness) frames are unchanged — interpolation at a node returns that
 * node exactly. The interpolation matters while the backlight fades: those frames
 * carry off-grid intermediate brightnesses, and a nearest-grid snap would recolour
 * them in discrete steps as channels cross node boundaries (the "colours change
 * three times as the screen dims" artifact). Interpolating makes the fade smooth.
 */
export function applySunlightLut(data: Uint8Array): void {
  for (let i = 0; i + 4 <= data.length; i += 4) {
    const R = gridPos(data[i]);
    const G = gridPos(data[i + 1]);
    const B = gridPos(data[i + 2]);
    // Eight surrounding LUT-entry offsets (each *3 to index the RGB triple).
    const o000 = (R.i0 * 16 + G.i0 * 4 + B.i0) * 3;
    const o001 = (R.i0 * 16 + G.i0 * 4 + B.i1) * 3;
    const o010 = (R.i0 * 16 + G.i1 * 4 + B.i0) * 3;
    const o011 = (R.i0 * 16 + G.i1 * 4 + B.i1) * 3;
    const o100 = (R.i1 * 16 + G.i0 * 4 + B.i0) * 3;
    const o101 = (R.i1 * 16 + G.i0 * 4 + B.i1) * 3;
    const o110 = (R.i1 * 16 + G.i1 * 4 + B.i0) * 3;
    const o111 = (R.i1 * 16 + G.i1 * 4 + B.i1) * 3;
    for (let ch = 0; ch < 3; ch++) {
      // Interpolate along blue, then green, then red.
      const c00 = CORRECTED[o000 + ch] + (CORRECTED[o001 + ch] - CORRECTED[o000 + ch]) * B.f;
      const c01 = CORRECTED[o010 + ch] + (CORRECTED[o011 + ch] - CORRECTED[o010 + ch]) * B.f;
      const c10 = CORRECTED[o100 + ch] + (CORRECTED[o101 + ch] - CORRECTED[o100 + ch]) * B.f;
      const c11 = CORRECTED[o110 + ch] + (CORRECTED[o111 + ch] - CORRECTED[o110 + ch]) * B.f;
      const c0 = c00 + (c01 - c00) * G.f;
      const c1 = c10 + (c11 - c10) * G.f;
      data[i + ch] = Math.round(c0 + (c1 - c0) * R.f);
    }
    // data[i + 3] (alpha) unchanged
  }
}
