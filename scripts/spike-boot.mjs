#!/usr/bin/env node
/**
 * spike-boot.mjs — Phase 0 SPIKE: prove VNC-over-WebSocket emulator boot
 *
 * This is a THROWAWAY probe script. It manually launches qemu-pebble for
 * basalt with VNC on display :1 (raw RFB port 5901), then starts websockify
 * on port 6080 to expose the VNC stream as a WebSocket, and verifies both
 * endpoints respond.
 *
 * Run:  node scripts/spike-boot.mjs
 *
 * Requirements:
 *   - pebble-tool installed (provides websockify in its venv)
 *   - qemu-pebble at ~/.local/share/pebble-sdk/SDKs/4.9.169/toolchain/bin/qemu-pebble
 *   - Keymap dir at ~/.pebble-qemu-data/keymaps/en-us
 *   - SDK SPI flash extracted to ~/.local/share/pebble-sdk/4.9.169/basalt/qemu_spi_flash.bin
 */

import { spawn, execSync } from "child_process";
import { createConnection } from "net";
import { homedir } from "os";
import { join } from "path";

const HOME = homedir();
const SDK_VER = "4.9.169";
const SDK_ROOT = join(HOME, ".local/share/pebble-sdk/SDKs", SDK_VER);
const PEBBLE_TOOL_BIN = join(HOME, ".local/share/uv/tools/pebble-tool/bin");

const QEMU_BIN = join(SDK_ROOT, "toolchain/bin/qemu-pebble");
const MICRO_FLASH = join(SDK_ROOT, "sdk-core/pebble/basalt/qemu/qemu_micro_flash.bin");
const SPI_FLASH = join(HOME, `.local/share/pebble-sdk/${SDK_VER}/basalt/qemu_spi_flash.bin`);
const KEYMAP_DIR = join(HOME, ".pebble-qemu-data");

// Ports
const QEMU_PORT = 15002;     // pebble protocol (phonesim)
const SERIAL_PORT = 15001;   // serial/debug
const GDB_PORT = 15004;
const MONITOR_PORT = 15003;
const VNC_PORT = 5901;       // raw RFB (display :1)
const WS_PORT = 6080;        // websockify WebSocket port

function waitForPort(port, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    function attempt() {
      const s = createConnection(port, "localhost");
      s.once("connect", () => { s.destroy(); resolve(); });
      s.once("error", () => {
        if (Date.now() > deadline) reject(new Error(`Port ${port} did not open in ${timeoutMs}ms`));
        else setTimeout(attempt, 300);
      });
    }
    attempt();
  });
}

function readBanner(port) {
  return new Promise((resolve) => {
    const s = createConnection(port, "localhost");
    let data = Buffer.alloc(0);
    s.setTimeout(3000);
    s.on("data", (chunk) => { data = Buffer.concat([data, chunk]); });
    s.on("timeout", () => { s.destroy(); resolve(data); });
    s.on("error", () => resolve(data));
    s.on("close", () => resolve(data));
  });
}

async function main() {
  console.log("=== Pebble Studio Phase 0 SPIKE: VNC-over-WebSocket ===\n");

  // Kill any existing emulator
  try { execSync("pkill -9 -f qemu-pebble"); } catch {}
  try { execSync("pkill -9 -f websockify"); } catch {}
  await new Promise(r => setTimeout(r, 1000));

  // --- Step 1: Launch qemu-pebble with VNC ---
  console.log("Step 1: Launching qemu-pebble (basalt) with -vnc :1 ...");
  const qemuArgs = [
    "-L", KEYMAP_DIR,
    "-rtc", "base=localtime",
    "-serial", "null",
    "-serial", `tcp::${QEMU_PORT},server=on,wait=off`,
    "-serial", `tcp::${SERIAL_PORT},server=on,wait=off`,
    "-kernel", MICRO_FLASH,
    "-gdb", `tcp::${GDB_PORT},server=on,wait=off`,
    "-monitor", `tcp::${MONITOR_PORT},server=on,wait=off`,
    "-machine", "pebble-snowy-bb",
    "-cpu", "cortex-m4",
    "-drive", `if=none,id=spi-flash,file=${SPI_FLASH},format=raw`,
    "-vnc", ":1",
    "-nographic",
  ];

  const qemu = spawn(QEMU_BIN, qemuArgs, {
    detached: true,
    stdio: "ignore",
  });
  qemu.unref();
  console.log(`  qemu-pebble spawned (pid ${qemu.pid})`);

  // Wait for VNC port to open (up to 15s)
  console.log(`  Waiting for VNC RFB on port ${VNC_PORT}...`);
  await waitForPort(VNC_PORT, 15000);
  const vncBanner = await readBanner(VNC_PORT);
  console.log(`  VNC banner: ${vncBanner.toString().trim()}`);
  if (!vncBanner.includes("RFB")) throw new Error("VNC port open but not RFB protocol");
  console.log("  [PASS] VNC RFB port is open and responding.\n");

  // --- Step 2: Launch websockify ---
  console.log("Step 2: Launching websockify (port 6080 -> localhost:5901) ...");
  const python = join(PEBBLE_TOOL_BIN, "python3");
  const wsArgs = ["-m", "websockify", "--heartbeat=30", String(WS_PORT), `localhost:${VNC_PORT}`];
  const ws = spawn(python, wsArgs, {
    detached: true,
    stdio: "ignore",
  });
  ws.unref();
  console.log(`  websockify spawned (pid ${ws.pid})`);

  await waitForPort(WS_PORT, 8000);
  console.log(`  WebSocket port ${WS_PORT} is open.`);

  // Verify WebSocket upgrade
  const wsHandshake = await new Promise((resolve) => {
    const s = createConnection(WS_PORT, "localhost");
    s.once("connect", () => {
      s.write(
        "GET / HTTP/1.1\r\n" +
        "Host: localhost\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
        "Sec-WebSocket-Version: 13\r\n\r\n"
      );
    });
    let buf = "";
    s.on("data", (d) => { buf += d.toString(); if (buf.includes("\r\n\r\n")) { s.destroy(); resolve(buf); } });
    s.setTimeout(5000);
    s.on("timeout", () => { s.destroy(); resolve(buf); });
    s.on("error", () => resolve(buf));
  });

  if (wsHandshake.includes("101 Switching Protocols")) {
    console.log("  [PASS] WebSocket upgrade succeeded (101 Switching Protocols).");
    console.log("  noVNC can connect to: ws://localhost:6080/");
  } else {
    throw new Error("WebSocket handshake failed: " + wsHandshake.slice(0, 200));
  }

  console.log("\n=== SPIKE RESULTS ===");
  console.log(`VNC raw RFB:   localhost:${VNC_PORT}  (display :1)`);
  console.log(`WebSocket VNC: ws://localhost:${WS_PORT}/`);
  console.log("noVNC should connect to: ws://localhost:6080/");
  console.log("\nClean up: pkill -9 -f qemu-pebble; pkill -9 -f websockify");
}

main().catch(err => {
  console.error("SPIKE FAILED:", err.message);
  process.exit(1);
});
