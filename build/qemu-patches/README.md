# qemu-pebble patches

The patches applied (in `apply-order.txt` order) to `coredevices/qemu@pebble-10.1`
before building `qemu-pebble.exe`. See `docs/build/windows-qemu-msys2.md` for the full
description of each. Committed here (rather than only under the gitignored `docs/`) so
the `.github/workflows/qemu-arm64.yml` CI build can reach them on a fresh checkout.

## Note on `qemu-pebble-faketime.patch` (present but NOT in apply-order)

The vmstate patches were each extracted as a full `git diff pristine -- <files>`, so the
two that touch a file the faketime work also edits already contain faketime's diff verbatim:
`qemu-pebble-m33-vmstate.patch` is a strict superset of faketime's `hw/misc/pebble_rtc.c`
changes, and `qemu-pebble-peripheral-vmstate.patch` is a strict superset of faketime's
`hw/timer/stm32_pebble_rtc.c` changes (verified: every faketime +/- line is present in the
respective vmstate patch). Applying `qemu-pebble-faketime.patch` first therefore made those
two vmstate patches fail (their pristine-based hunks no longer matched the already-modified
file). Since faketime touches only those two files and both are fully subsumed, it is dropped
from `apply-order.txt`; the resulting tree is byte-identical. The patch file is kept for
provenance/documentation of the faketime design.
