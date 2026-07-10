/**
 * Fixed TCP ports for the emulator stack, shared by every teardown/boot path.
 *
 * emu-control hardcodes `-vnc :1`, so qemu's raw RFB always lands on 5901 and
 * websockify always proxies it on 6080. These were previously duplicated in
 * bootEmulator.ts and winBootDeps.ts; a drift between the two would make one
 * path probe the wrong port and silently misdiagnose a live/stale stack. Keep
 * them here so both import the SAME value.
 */
export const VNC_RFB_PORT = 5901;
export const WS_PORT = 6080;
