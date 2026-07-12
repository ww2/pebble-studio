# qemu-pebble patches

The 7 patches applied (in `apply-order.txt` order) to `coredevices/qemu@pebble-10.1`
before building `qemu-pebble.exe`. See `docs/build/windows-qemu-msys2.md` for the full
description of each. Committed here (rather than only under the gitignored `docs/`) so
the `.github/workflows/qemu-arm64.yml` CI build can reach them on a fresh checkout.
