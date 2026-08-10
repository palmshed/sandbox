/*
 * scripts/probes/landlock-run.c
 *
 * Reusable Landlock confinement trampoline (RFC 0006, issue #3). Applies
 * OS-level filesystem isolation to a process and then exec's the workload
 * command in its place:
 *
 *   1. Builds a ruleset whose HANDLED set is every filesystem right the ABI
 *      supports (any bit left unhandled is silently unrestricted, so there is
 *      no subsetting).
 *   2. Grants the full access set to the workspace directory only.
 *   3. Grants the caller's written allowlist (read-only runtime deps) to the
 *      interpreter, loader, shared objects, config, zoneinfo, and the traction
 *      dirs needed to reach them.
 *   4. Calls PR_SET_NO_NEW_PRIVS (unprivileged) then landlock_restrict_self.
 *      The restriction is IRREVOCABLE for this process and every descendant.
 *   5. execv()'s the workload. If Landlock is unavailable or restricting
 *      fails, it exits non-zero WITHOUT running the workload: never a silent
 *      fallback. (Callers that want a graceful path must probe first, e.g.
 *      with landlock-capability.mjs, and decide explicitly.)
 *
 * Allowlist file format: one `mode:path` per line; '#' comments and blank
 * lines ignored.
 *   r:  READ_FILE | READ_DIR   (read-only data, config, traversal)
 *   rx: READ_FILE | READ_DIR | EXECUTE  (binaries, loader, shared objects)
 *   w:  WRITE_FILE            (append/discard sinks like /dev/null)
 *   rw: READ_FILE | WRITE_FILE (read-write data files, dirs get READ_DIR)
 *   x:  EXECUTE                (runner itself; exec-only)
 *
 * Build:  cc -O2 -Wall -Wextra -o landlock-run landlock-run.c
 * Usage:  ./landlock-run <workspace> <allowlistFile> -- <cmd> [args...]
 *
 * This is the primitive under test; it is NOT the SDK sandbox path. Its pass
 * under the smoke checks proves the mechanism + allowlist work; promotion of
 * `osFilesystemIsolation: supported` still requires the real Native backend
 * to pass the RFC 0006 escape suite.
 */

#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef __linux__
#include <sys/stat.h>
#endif
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

#ifdef __linux__
#include <linux/landlock.h>
#include <sys/prctl.h>
#endif

#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#endif
#ifndef __NR_landlock_add_rule
#define __NR_landlock_add_rule 445
#endif
#ifndef __NR_landlock_restrict_self
#define __NR_landlock_restrict_self 446
#endif

#define PR_SET_NO_NEW_PRIVS 38

/* Fallbacks so the helper still compiles for a syntax check off-Linux.
 * On Linux these come from <linux/landlock.h>. */
#ifndef LANDLOCK_CREATE_RULESET_VERSION
#define LANDLOCK_CREATE_RULESET_VERSION (1U << 0)
#endif
#ifndef LANDLOCK_ACCESS_FS_EXECUTE
#define LANDLOCK_ACCESS_FS_EXECUTE (1ULL << 0)
#endif
#ifndef LANDLOCK_ACCESS_FS_WRITE_FILE
#define LANDLOCK_ACCESS_FS_WRITE_FILE (1ULL << 1)
#endif
#ifndef LANDLOCK_ACCESS_FS_READ_FILE
#define LANDLOCK_ACCESS_FS_READ_FILE (1ULL << 2)
#endif
#ifndef LANDLOCK_ACCESS_FS_READ_DIR
#define LANDLOCK_ACCESS_FS_READ_DIR (1ULL << 3)
#endif
#ifndef LANDLOCK_ACCESS_FS_REMOVE_DIR
#define LANDLOCK_ACCESS_FS_REMOVE_DIR (1ULL << 4)
#endif
#ifndef LANDLOCK_ACCESS_FS_REMOVE_FILE
#define LANDLOCK_ACCESS_FS_REMOVE_FILE (1ULL << 5)
#endif
#ifndef LANDLOCK_ACCESS_FS_MAKE_CHAR
#define LANDLOCK_ACCESS_FS_MAKE_CHAR (1ULL << 6)
#endif
#ifndef LANDLOCK_ACCESS_FS_MAKE_DIR
#define LANDLOCK_ACCESS_FS_MAKE_DIR (1ULL << 7)
#endif
#ifndef LANDLOCK_ACCESS_FS_MAKE_REG
#define LANDLOCK_ACCESS_FS_MAKE_REG (1ULL << 8)
#endif
#ifndef LANDLOCK_ACCESS_FS_MAKE_SOCK
#define LANDLOCK_ACCESS_FS_MAKE_SOCK (1ULL << 9)
#endif
#ifndef LANDLOCK_ACCESS_FS_MAKE_FIFO
#define LANDLOCK_ACCESS_FS_MAKE_FIFO (1ULL << 10)
#endif
#ifndef LANDLOCK_ACCESS_FS_MAKE_BLOCK
#define LANDLOCK_ACCESS_FS_MAKE_BLOCK (1ULL << 11)
#endif
#ifndef LANDLOCK_ACCESS_FS_MAKE_SYM
#define LANDLOCK_ACCESS_FS_MAKE_SYM (1ULL << 12)
#endif
#ifndef LANDLOCK_ACCESS_FS_REFER
#define LANDLOCK_ACCESS_FS_REFER (1ULL << 13)
#endif
#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif
#ifndef LANDLOCK_ACCESS_FS_IOCTL_DEV
#define LANDLOCK_ACCESS_FS_IOCTL_DEV (1ULL << 15)
#endif
#ifndef LANDLOCK_ACCESS_FS_RESOLVE_UNIX
#define LANDLOCK_ACCESS_FS_RESOLVE_UNIX (1ULL << 16)
#endif

/* Off-Linux fallback declarations so the file still passes a syntax check
 * (it never runs outside Linux; the real types come from <linux/landlock.h>). */
#ifndef __linux__
#define __NR_landlock_create_ruleset 444
#define __NR_landlock_add_rule 445
#define __NR_landlock_restrict_self 446
#define PR_SET_NO_NEW_PRIVS 38
#define LANDLOCK_RULE_PATH_BENEATH 1
#define LANDLOCK_CREATE_RULESET_VERSION (1U << 0)
#ifndef O_PATH
#define O_PATH 010000000
#endif
typedef unsigned long long __u64;
#define LANDLOCK_ACCESS_FS_EXECUTE (1ULL << 0)
#define LANDLOCK_ACCESS_FS_WRITE_FILE (1ULL << 1)
#define LANDLOCK_ACCESS_FS_READ_FILE (1ULL << 2)
#define LANDLOCK_ACCESS_FS_READ_DIR (1ULL << 3)
#define LANDLOCK_ACCESS_FS_REMOVE_DIR (1ULL << 4)
#define LANDLOCK_ACCESS_FS_REMOVE_FILE (1ULL << 5)
#define LANDLOCK_ACCESS_FS_MAKE_CHAR (1ULL << 6)
#define LANDLOCK_ACCESS_FS_MAKE_DIR (1ULL << 7)
#define LANDLOCK_ACCESS_FS_MAKE_REG (1ULL << 8)
#define LANDLOCK_ACCESS_FS_MAKE_SOCK (1ULL << 9)
#define LANDLOCK_ACCESS_FS_MAKE_FIFO (1ULL << 10)
#define LANDLOCK_ACCESS_FS_MAKE_BLOCK (1ULL << 11)
#define LANDLOCK_ACCESS_FS_MAKE_SYM (1ULL << 12)
#define LANDLOCK_ACCESS_FS_REFER (1ULL << 13)
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#define LANDLOCK_ACCESS_FS_IOCTL_DEV (1ULL << 15)
#define LANDLOCK_ACCESS_FS_RESOLVE_UNIX (1ULL << 16)
struct landlock_ruleset_attr { __u64 handled_access_fs; };
struct landlock_path_beneath_attr { __u64 allowed_access; int parent_fd; };
extern int prctl(int, ...);
#endif

static int query_abi(void) {
  long abi = syscall(__NR_landlock_create_ruleset, NULL, 0,
                     LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 0) return -1;
  return (int)abi;
}

static int die(const char *msg) {
  fprintf(stderr, "landlock-run: %s (errno=%d)\n", msg, errno);
  return 1;
}

int main(int argc, char **argv) {
  if (argc < 4) {
    fprintf(stderr, "usage: %s <workspace> <allowlistFile> -- <cmd> [args...]\n", argv[0]);
    return 2;
  }

  const char *ws = argv[1];
  const char *allowlistFile = argv[2];
  int dash = (strcmp(argv[3], "--") == 0) ? 1 : 0;
  int cmdIdx = 3 + dash;
  if (cmdIdx >= argc) {
    fprintf(stderr, "landlock-run: no command after --\n");
    return 2;
  }

  int abi = query_abi();
  if (abi < 1) {
    fprintf(stderr, "landlock-run: Landlock unavailable (ABI @ %d, errno=%d); refusing to run unconfined\n", abi, errno);
    return 1;
  }
  if (abi < 2) {
    fprintf(stderr, "landlock-run: Landlock ABI %d is too old (REFER semantics require ABI >= 2); refusing to run\n", abi);
    return 1;
  }

  /* Handle every right the ABI supports. Nothing may be silently open.
   * Landlock denies-by-default ONLY the rights listed in handled_access_fs;
   * unhandled rights remain unrestricted. Version-gate the rights added
   * after ABI 2: TRUNCATE (>= 3), IOCTL_DEV (>= 5), RESOLVE_UNIX (>= 9).
   * The CI probe observed ABI 7 on ubuntu-24.04, so IOCTL_DEV is live in
   * production CI. Charged per inode type below, so READ_DIR is only granted
   * on directories (granting it on a file inode is EINVAL). */
  __u64 allAccess =
      LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_WRITE_FILE |
      LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR |
      LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE |
      LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR |
      LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SOCK |
      LANDLOCK_ACCESS_FS_MAKE_FIFO | LANDLOCK_ACCESS_FS_MAKE_BLOCK |
      LANDLOCK_ACCESS_FS_MAKE_SYM | LANDLOCK_ACCESS_FS_REFER;
  if (abi >= 3) allAccess |= LANDLOCK_ACCESS_FS_TRUNCATE;
  if (abi >= 5) allAccess |= LANDLOCK_ACCESS_FS_IOCTL_DEV;
  if (abi >= 9) allAccess |= LANDLOCK_ACCESS_FS_RESOLVE_UNIX;
  /* Known rights we do handle above are all version-gated, so no known bit
   * silently stays unhandled on a kernel that exposes it. Rights introduced
   * in a FUTURE ABI (bits unknown to this build) cannot be handled here; the
   * Linux headers backfill, but a runtime new right would remain unrestricted.
   * That is a documented build-time boundary, not a silent fallback on a
   * supported right. */
  if (getenv("LL_VERBOSE"))
    fprintf(stderr, "landlock-run: ABI %d handled bytes %#llx\n", abi,
            (unsigned long long)allAccess);

  struct landlock_ruleset_attr attrs = {.handled_access_fs = allAccess};
  int ruleset_fd =
      syscall(__NR_landlock_create_ruleset, &attrs, sizeof(attrs), 0);
  if (ruleset_fd < 0) return die("landlock_create_ruleset");

  /* Workspace: full access (the sandbox cell). */
  struct landlock_path_beneath_attr pr = {.allowed_access = allAccess};
  pr.parent_fd = open(ws, O_PATH | O_CLOEXEC);
  if (pr.parent_fd < 0) return die("open workspace");
  if (syscall(__NR_landlock_add_rule, ruleset_fd, LANDLOCK_RULE_PATH_BENEATH,
              &pr, 0) != 0)
    return die("add workspace rule");
  close(pr.parent_fd);

  /* Parse the allowlist. */
  FILE *f = fopen(allowlistFile, "r");
  if (!f) return die("open allowlist");
  char line[4096];
  unsigned long added = 0, skipped = 0;
  while (fgets(line, sizeof(line), f)) {
    /* strip trailing newline/CR */
    size_t n = strlen(line);
    while (n && (line[n - 1] == '\n' || line[n - 1] == '\r')) line[--n] = 0;
    if (n == 0 || line[0] == '#') continue;

    /* mode is 'r', 'rx', 'rw', or 'x' followed by ':' then the path. */
    int isRx = (n >= 3 && line[0] == 'r' && line[1] == 'x' && line[2] == ':');
    int isRw = (n >= 3 && line[0] == 'r' && line[1] == 'w' && line[2] == ':');
    int isR  = (n >= 2 && line[0] == 'r' && line[1] == ':');
    int isX  = (n >= 2 && line[0] == 'x' && line[1] == ':');
    int isW  = (n >= 2 && line[0] == 'w' && line[1] == ':');
    if (!isRx && !isRw && !isR && !isX && !isW) {
      skipped++;
      continue;
    }
    const char *p = line + ((isRx || isRw) ? 3 : 2);
    __u64 acc = 0;
    struct stat st;
    int isDir = (stat(p, &st) == 0 && S_ISDIR(st.st_mode));
    /* READ_DIR is a directory-only right; granting it on a non-directory
     * inode makes landlock_add_rule fail with EINVAL. The right set must
     * match the target's inode type (Landlock has no WRITE_DIR: directory
     * writes are expressed via the MAKE_ and REMOVE_ right families, which
     * this runner never grants through the allowlist). */
    if (isRx)
      acc = LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_EXECUTE |
            (isDir ? LANDLOCK_ACCESS_FS_READ_DIR : 0);
    else if (isRw)
      acc = LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE |
            (isDir ? LANDLOCK_ACCESS_FS_READ_DIR : 0);
    else if (isR)
      acc = LANDLOCK_ACCESS_FS_READ_FILE | (isDir ? LANDLOCK_ACCESS_FS_READ_DIR : 0);
    else if (isX)
      acc = LANDLOCK_ACCESS_FS_EXECUTE;
    else if (isW)
      acc = LANDLOCK_ACCESS_FS_WRITE_FILE;
    if (acc == 0) {
      if (getenv("LL_VERBOSE"))
        fprintf(stderr, "  [skip] %s: not a file/dir or unparseable\n", p);
      skipped++;
      continue;
    }
    pr.allowed_access = acc;
    pr.parent_fd = open(p, O_PATH | O_CLOEXEC);
    if (pr.parent_fd < 0) {
      if (getenv("LL_VERBOSE"))
        fprintf(stderr, "  [skip] open(%s): errno=%d\n", p, errno);
      skipped++;
      continue;
    }
    if (syscall(__NR_landlock_add_rule, ruleset_fd, LANDLOCK_RULE_PATH_BENEATH,
                &pr, 0) == 0) {
      if (getenv("LL_VERBOSE"))
        fprintf(stderr, "  [add ] %s\n", p);
      added++;
    } else {
      if (getenv("LL_VERBOSE"))
        fprintf(stderr, "  [skip] add_rule(%s): errno=%d\n", p, errno);
      skipped++;
    }
    close(pr.parent_fd);
  }
  fclose(f);

  if (added == 0) {
    fprintf(stderr, "landlock-run: allowlist produced no rules; refusing to run\n");
    return 1;
  }
  if (skipped) {
    if (getenv("LL_VERBOSE"))
      fprintf(stderr, "landlock-run: allowlist skipped %lu unparseable/missing entries\n", skipped);
  }

  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0)
    return die("PR_SET_NO_NEW_PRIVS");
  if (syscall(__NR_landlock_restrict_self, ruleset_fd, 0) != 0)
    return die("landlock_restrict_self");
  close(ruleset_fd);

  execvp(argv[cmdIdx], &argv[cmdIdx]);
  fprintf(stderr, "landlock-run: exec %s failed (errno=%d)\n", argv[cmdIdx], errno);
  return (errno == ENOENT) ? 127 : 126;
}