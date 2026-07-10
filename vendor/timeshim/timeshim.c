/* Runtime-controllable fake-realtime shim for qemu-pebble.
 *
 * Env vars:
 *   PEBBLE_FAKETIME_OFFSET  initial offset seconds (default 0)
 *   PEBBLE_FAKETIME_RATE    initial rate (default 1.0)
 *   PEBBLE_FAKETIME_FILE    control file, re-read when mtime changes
 *                           (checked at most every 200ms of real time)
 *
 * Control file format (one line):  <target_unix_seconds|-> <rate>
 *   "1577836800 1"   -> jump fake clock to 2020-01-01T00:00:00Z, run 1x
 *   "- 0"            -> keep current fake time, freeze
 *   "- 60"           -> keep current fake time, run 60x
 */
#define _GNU_SOURCE
#include <time.h>
#include <sys/time.h>
#include <sys/stat.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <dlfcn.h>
#include <pthread.h>

static int (*real_clock_gettime)(clockid_t, struct timespec *);
static int (*real_gettimeofday)(struct timeval *, void *);

static int64_t anchor_real = 0;   /* CLOCK_REALTIME ns at anchor */
static int64_t anchor_fake = 0;   /* fake ns at anchor */
static double rate = 1.0;
static const char *ctl_file = NULL;
static time_t ctl_mtime = 0;
static long ctl_mtime_nsec = -1;   /* sub-second mtime; -1 = never read */
static int64_t last_check_mono = 0;
static int ready = 0;
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;

static int64_t raw_ns(clockid_t clk) {
    struct timespec ts;
    real_clock_gettime(clk, &ts);
    return (int64_t)ts.tv_sec * 1000000000LL + ts.tv_nsec;
}

static int64_t fake_now_locked(int64_t real) {
    return anchor_fake + (int64_t)((double)(real - anchor_real) * rate);
}

static void check_ctl_file(int64_t real) {
    if (!ctl_file) return;
    int64_t mono = raw_ns(CLOCK_MONOTONIC);
    if (mono - last_check_mono < 200000000LL) return;  /* 200ms */
    last_check_mono = mono;
    struct stat st;
    if (stat(ctl_file, &st) != 0) return;
    /* Compare BOTH whole-second and nanosecond mtime: two writes within the same
     * second (rapid time changes, and fix #1's two-write System switch) share
     * st_mtime, so a whole-second-only check silently drops the second write. */
    if (st.st_mtime == ctl_mtime && st.st_mtim.tv_nsec == ctl_mtime_nsec) return;
    ctl_mtime = st.st_mtime;
    ctl_mtime_nsec = st.st_mtim.tv_nsec;
    FILE *f = fopen(ctl_file, "r");
    if (!f) return;
    char tgt[64]; double r;
    if (fscanf(f, "%63s %lf", tgt, &r) == 2) {
        int64_t cur_fake = fake_now_locked(real);
        anchor_real = real;
        anchor_fake = (tgt[0] == '-' && tgt[1] == '\0')
                      ? cur_fake
                      : (int64_t)atoll(tgt) * 1000000000LL;
        rate = r;
    }
    fclose(f);
}

static void init_once(void) {
    if (ready) return;
    pthread_mutex_lock(&lock);
    if (!ready) {
        real_clock_gettime = dlsym(RTLD_NEXT, "clock_gettime");
        real_gettimeofday = dlsym(RTLD_NEXT, "gettimeofday");
        const char *o = getenv("PEBBLE_FAKETIME_OFFSET");
        const char *r = getenv("PEBBLE_FAKETIME_RATE");
        ctl_file = getenv("PEBBLE_FAKETIME_FILE");
        anchor_real = raw_ns(CLOCK_REALTIME);
        anchor_fake = anchor_real + (o ? (int64_t)atoll(o) * 1000000000LL : 0);
        rate = r ? atof(r) : 1.0;
        ready = 1;
    }
    pthread_mutex_unlock(&lock);
}

static int64_t fake_now(void) {
    int64_t real = raw_ns(CLOCK_REALTIME);
    pthread_mutex_lock(&lock);
    check_ctl_file(real);
    int64_t f = fake_now_locked(real);
    pthread_mutex_unlock(&lock);
    return f;
}

int clock_gettime(clockid_t clk, struct timespec *ts) {
    init_once();
    if (clk == CLOCK_REALTIME || clk == CLOCK_REALTIME_COARSE) {
        int64_t f = fake_now();
        ts->tv_sec = f / 1000000000LL;
        ts->tv_nsec = f % 1000000000LL;
        return 0;
    }
    return real_clock_gettime(clk, ts);
}

int gettimeofday(struct timeval *tv, void *tz) {
    init_once();
    if (tv) {
        int64_t f = fake_now();
        tv->tv_sec = f / 1000000000LL;
        tv->tv_usec = (f % 1000000000LL) / 1000;
    }
    if (tz) { struct timeval d; real_gettimeofday(&d, tz); }
    return 0;
}

time_t time(time_t *t) {
    init_once();
    time_t r = (time_t)(fake_now() / 1000000000LL);
    if (t) *t = r;
    return r;
}
