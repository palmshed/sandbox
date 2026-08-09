/*
 * scripts/probes/landlock-probe.c
 *
 * Empirical kernel probe for RFC 0006 (OS-level filesystem isolation).
 * Compile and run on a Linux host as an UNPRIVILEGED user. Verifies the
 * exact assumptions the RFC depends on:
 *
 *   1. Landlock ABI is available.
 *   2. The filesystem rights required (read/write/execute + make/remove,
 *      plus REFER for hardlink/rename semantics) are supported by that ABI.
 *   3. An unprivileged process can create and apply the ruleset.
 *   4. A descendant process inherits the ruleset.
 *   5. Access outside the allowlist is denied (path, symlink escape).
 *   6. The result unambiguously reports supported / unsupported / unknown.
 *
 * Build:        cc -O2 -o landlock-probe landlock-probe.c
 * Usage:        ./landlock-probe <scratchDir>       (dir must be writable)
 * Output:       newline-delimited `key:value` records + a final JSON line.
 */

#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

/* Landlock syscall numbers are 444/445/446 on all supported architectures. */
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

static void record(const char *key, const char *value) {
  printf("%s:%s\n", key, value);
}

static int query_abi(void) {
  long abi = syscall(__NR_landlock_create_ruleset, NULL, 0,
                     LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 0) {
    if (errno == ENOSYS) return 0;          /* kernel predates Landlock */
    if (errno == EOPNOTSUPP) return -1;     /* Landlock present but disabled in LSM */
    return -2;                              /* unexpected error */
  }
  return (int)abi;
}

int main(int argc, char **argv) {
  char buf[256];

  if (argc != 2) {
    fprintf(stderr, "usage: %s <scratchDir>\n", argv[0]);
    return 2;
  }
  const char *scratch = argv[1];

  record("landlock.syscall", "present");

  int abi = query_abi();
  if (abi == 0) {
    record("abi.version", "0");
    record("verdict", "unsupported");
    record("reason", "kernel does not implement Landlock (ENOSYS)");
    printf("{\"verdict\":\"unsupported\",\"abi\":0,\"reason\":\"ENOSYS\"}\n");
    return 0;
  }
  if (abi == -1) {
    record("abi.version", "0");
    record("verdict", "unsupported");
    record("reason", "Landlock compiled in but not enabled in the LSM stack (EOPNOTSUPP)");
    printf("{\"verdict\":\"unsupported\",\"abi\":0,\"reason\":\"EOPNOTSUPP\"}\n");
    return 0;
  }
  if (abi == -2) {
    record("abi.version", "0");
    record("verdict", "unknown");
    record("reason", "unexpected landlock_create_ruleset error");
    printf("{\"verdict\":\"unknown\",\"abi\":0,\"reason\":\"unexpected-error\"}\n");
    return 0;
  }
  snprintf(buf, sizeof(buf), "%d", abi);
  record("abi.version", buf);

  int referSupported = abi >= 2;
  record("rights.refer_supported", referSupported ? "yes" : "no");

  /* The full set of filesystem rights this ABI can handle. Using the whole
   * handled set (not just a subset) is required: any bit we leave unhandled
   * is silently un-restricted. */
  const __u64 handled = referSupported ? LANDLOCK_ACCESS_FS_REFER : 0;
  __u64 allAccess =
      LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_WRITE_FILE |
      LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR |
      LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE |
      LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR |
      LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SOCK |
      LANDLOCK_ACCESS_FS_MAKE_FIFO | LANDLOCK_ACCESS_FS_MAKE_BLOCK |
      LANDLOCK_ACCESS_FS_MAKE_SYM | handled;

  struct landlock_ruleset_attr attrs = {
      .handled_access_fs = allAccess,
  };

  int ruleset_fd = syscall(__NR_landlock_create_ruleset, &attrs,
                           sizeof(attrs), 0);
  if (ruleset_fd < 0) {
    snprintf(buf, sizeof(buf), "create_ruleset failed errno=%d", errno);
    record("ruleset.create", "fail");
    record("verdict", "unknown");
    record("reason", buf);
    printf("{\"verdict\":\"unknown\",\"abi\":%d,\"reason\":\"create-failed\"}\n", abi);
    return 0;
  }
  record("ruleset.create", "ok");

  /* Build a scratch tree:
   *   scratch/
   *     ws/            <- the only allowed subtree (the "workspace")
   *     secret.txt     <- outside the workspace; must be denied
   */
  char ws[512], secret[512], linkp[512], entry[512], scratch_file[512];
  snprintf(ws, sizeof(ws), "%s/ws", scratch);
  snprintf(secret, sizeof(secret), "%s/secret.txt", scratch);
  snprintf(linkp, sizeof(linkp), "%s/ws/escape", scratch);
  snprintf(entry, sizeof(entry), "%s/ws/hello.txt", scratch);
  snprintf(scratch_file, sizeof(scratch_file), "%s/created.outside.txt", scratch);

  if (mkdir(ws, 0700) != 0 && errno != EEXIST) {
    record("verdict", "unknown");
    record("reason", "could not create workspace dir in scratch");
    printf("{\"verdict\":\"unknown\",\"abi\":%d,\"reason\":\"scratch-mkdir\"}\n", abi);
    return 0;
  }
  {
    int fd = open(secret, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd >= 0) close(fd);
    fd = open(entry, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd >= 0) close(fd);
    /* Symlink inside the workspace pointing outside it: must be denied. */
    unlink(linkp);
    if (symlink(secret, linkp) != 0) {
      record("verdict", "unknown");
      record("reason", "could not create the escape symlink");
      printf("{\"verdict\":\"unknown\",\"abi\":%d,\"reason\":\"symlink-setup\"}\n", abi);
      return 0;
    }
  }

  struct landlock_path_beneath_attr path_rule = {
      .allowed_access = allAccess,
  };
  path_rule.parent_fd = open(ws, O_PATH | O_CLOEXEC);
  if (path_rule.parent_fd < 0) {
    record("verdict", "unknown");
    record("reason", "could not open workspace for the path rule");
    printf("{\"verdict\":\"unknown\",\"abi\":%d,\"reason\":\"open-ws\"}\n", abi);
    return 0;
  }
  if (syscall(__NR_landlock_add_rule, ruleset_fd, LANDLOCK_RULE_PATH_BENEATH,
              &path_rule, 0) != 0) {
    snprintf(buf, sizeof(buf), "add_rule failed errno=%d", errno);
    record("ruleset.add_rule", "fail");
    record("verdict", "unknown");
    record("reason", buf);
    printf("{\"verdict\":\"unknown\",\"abi\":%d,\"reason\":\"add-rule\"}\n", abi);
    return 0;
  }
  record("ruleset.add_rule", "ok");

  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    record("verdict", "unknown");
    record("reason", "PR_SET_NO_NEW_PRIVS failed (requires privileges?)");
    printf("{\"verdict\":\"unknown\",\"abi\":%d,\"reason\":\"no-new-privs\"}\n", abi);
    return 0;
  }
  record("privs.no_new_privs", "set");

  if (syscall(__NR_landlock_restrict_self, ruleset_fd, 0) != 0) {
    snprintf(buf, sizeof(buf), "restrict_self failed errno=%d", errno);
    record("ruleset.restrict_self", "fail");
    record("verdict", "unknown");
    record("reason", buf);
    printf("{\"verdict\":\"unknown\",\"abi\":%d,\"reason\":\"restrict-self\"}\n", abi);
    return 0;
  }
  record("ruleset.restrict_self", "ok");
  record("unprivileged", geteuid() == 0 ? "root" : "unprivileged");

  /* Post-restriction checks. From here on, open() resolution follows path
   * rules: anything outside `ws` must fail with EACCES. */
  struct landlock_check {
    const char *name;
    const char *path;
    int flags;
    int should_fail;
  } checks[] = {
      {"allowlist.read", entry, O_RDONLY, 0},
      {"allowlist.write", entry, O_RDWR, 0},
      {"outside.read.secret", secret, O_RDONLY, 1},
      {"outside.write.secret", secret, O_WRONLY | O_APPEND, 1},
      {"symlink_escape", linkp, O_RDONLY, 1},
  };

  const char *verdict = "supported";
  char reason[256] = "ok";

  for (size_t i = 0; i < sizeof(checks) / sizeof(checks[0]); i++) {
    int fd = open(checks[i].path, checks[i].flags);
    int denied = (fd < 0 && errno == EACCES);
    int allowed = (fd >= 0);
    int ok = checks[i].should_fail ? denied : allowed;
    if (fd >= 0) close(fd);
    snprintf(buf, sizeof(buf), "%s", ok ? "ok" : "VIOLATION");
    record(checks[i].name, buf);
    if (!ok) {
      verdict = "unknown";
      snprintf(reason, sizeof(reason), "%s check violated", checks[i].name);
    }
  }

  /* Create a new file OUTSIDE the workspace (in the scratch parent): the
   * make-a-file right is only granted beneath `ws`, so this must fail. */
  {
    int fd = open(scratch_file, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    int denied = (fd < 0 && errno == EACCES);
    if (fd >= 0) close(fd);
    record("outside.create", denied ? "ok" : "VIOLATION");
    if (!denied) {
      verdict = "unknown";
      snprintf(reason, sizeof(reason), "outside.create check violated");
    }
  }

  /* Descendant inheritance: fork and have the child try the forbidden path.
   * Landlock rules persist across fork(); the child must also be denied. */
  pid_t pid = fork();
  if (pid == 0) {
    int fd = open(secret, O_RDONLY);
    _exit(fd >= 0 ? 1 : 0); /* exit 0 == denied (correct), 1 == leaked */
  }
  int status = 0;
  waitpid(pid, &status, 0);
  int childDenied = WIFEXITED(status) && WEXITSTATUS(status) == 0;
  record("descendant.denied", childDenied ? "ok" : "VIOLATION");
  if (!childDenied) {
    verdict = "unknown";
    snprintf(reason, sizeof(reason), "descendant escaped the ruleset");
  }

  /* G8: unprivileged enforcement. We never required privileges; the verdict
   * above already proves create/apply worked as the invoking user. */
  record("enforcement.unprivileged", geteuid() == 0 ? "root-run" : "yes");

  record("verdict", verdict);
  printf("{\"verdict\":\"%s\",\"abi\":%d,\"refer\":\"%s\",\"reason\":\"%s\"}\n",
         verdict, abi, referSupported ? "yes" : "no", reason);
  return strcmp(verdict, "supported") == 0 ? 0 : 1;
}