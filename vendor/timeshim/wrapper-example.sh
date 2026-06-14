#!/bin/sh
export LD_PRELOAD=/tmp/timeshim/timeshim2.so
export PEBBLE_FAKETIME_FILE=/tmp/pb-faketime.ctl
exec /home/jason_lin/.local/share/pebble-sdk/SDKs/4.9.169/toolchain/bin/qemu-pebble "$@"
