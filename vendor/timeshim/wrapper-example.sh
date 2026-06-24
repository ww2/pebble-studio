#!/bin/sh
export LD_PRELOAD=/tmp/timeshim/timeshim2.so
export PEBBLE_FAKETIME_FILE=/tmp/pb-faketime.ctl
# Point this at your local pebble-sdk qemu-pebble binary (adjust the SDK version).
exec "$HOME/.local/share/pebble-sdk/SDKs/<sdk-version>/toolchain/bin/qemu-pebble" "$@"
