/* probe.exe — minimal self-test target. Prints the process wall clock (seconds)
 * once via clock_gettime(CLOCK_REALTIME) — the same path qemu-pebble uses — then
 * exits. ensureWinTimeShim runs this THROUGH launcher.exe with an injected shim
 * and PEBBLE_FAKETIME_OFFSET set, and checks the printed value jumped. It does NOT
 * load the shim itself, so a passing run proves real injection works. */
#include <time.h>
#include <stdio.h>

int main(void) {
    struct timespec ts = {0};
    clock_gettime(CLOCK_REALTIME, &ts);
    printf("%lld\n", (long long)ts.tv_sec);
    return 0;
}
