// Throwaway WSL-path validation: boot the emulator THROUGH wsl.exe (the same
// interface a Windows host uses), confirm ws://localhost:6080 opens and the
// state file has a qemu pid, then tear it down via the wsl stopEmulator.
//
// Run after bundling:
//   node_modules/.bin/esbuild scripts/try-wsl-boot.ts --bundle --platform=node \
//     --format=esm --outfile=scripts/.try-wsl-boot.bundle.mjs --packages=external
//   node scripts/.try-wsl-boot.bundle.mjs
import { connect } from "node:net";
import { bootEmulator, makeWslBootDeps, stopEmulator } from "./.boot.bundle.mjs";

function tcpOpens(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    const done = (ok) => { try { sock.destroy(); } catch {} resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.once("timeout", () => done(false));
  });
}

const overall = setTimeout(() => { console.error("OVERALL TIMEOUT"); process.exit(2); }, 120_000);

try {
  console.log("[try-wsl] booting basalt via wsl.exe ...");
  const ep = await bootEmulator("basalt", makeWslBootDeps());
  console.log("[try-wsl] bootEmulator returned endpoint:", JSON.stringify(ep));

  const wsOpen = await tcpOpens("localhost", 6080, 3000);
  console.log(`[try-wsl] ws://localhost:6080 TCP open = ${wsOpen}`);

  // Read the state file THROUGH wsl (same way the prod path does).
  const { spawn } = await import("node:child_process");
  const cat = () => new Promise((res) => {
    const c = spawn("wsl.exe", ["--", "bash", "-lc", "cat /tmp/pb-emulator.json"]);
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.on("close", () => res(out));
  });
  const raw = await cat();
  let qemuPid;
  try {
    const j = JSON.parse(raw);
    for (const v of Object.values(j.basalt ?? {})) if (v?.qemu?.pid) qemuPid = v.qemu.pid;
  } catch {}
  // Fallback: the pebble tool clears the version sub-object once the control
  // session settles, so also confirm via a live qemu-pebble process.
  if (!qemuPid) {
    const pg = () => new Promise((res) => {
      const c = spawn("wsl.exe", ["--", "bash", "-lc", "pgrep -f qemu-pebble | head -1"]);
      let o = ""; c.stdout.on("data", (d) => (o += d)); c.on("close", () => res(o.trim()));
    });
    qemuPid = (await pg()) || undefined;
  }
  console.log(`[try-wsl] qemu pid (state file or live proc) = ${qemuPid}`);

  console.log("[try-wsl] tearing down via wsl stopEmulator ...");
  await stopEmulator({ killAll: makeWslBootDeps().killAll });

  const wsAfter = await tcpOpens("localhost", 6080, 1500);
  console.log(`[try-wsl] ws://localhost:6080 open AFTER stop = ${wsAfter}`);

  const pass = wsOpen && !!qemuPid && !wsAfter;
  console.log(`[try-wsl] RESULT: ${pass ? "PASS" : "FAIL"}`);
  clearTimeout(overall);
  process.exit(pass ? 0 : 1);
} catch (e) {
  clearTimeout(overall);
  console.error("[try-wsl] ERROR:", e);
  process.exit(1);
}
