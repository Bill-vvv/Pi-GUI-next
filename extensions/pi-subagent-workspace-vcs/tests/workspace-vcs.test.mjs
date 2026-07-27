import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  inspectWorkspaceDiff,
  inspectWorkspaceStatus,
} from "../src/workspace-vcs.mjs";

const execFileAsync = promisify(execFile);

test("returns a compact clean repository snapshot", async (t) => {
  const root = await createRepository(t);
  const result = await inspectWorkspaceStatus(root);

  assert.equal(result.repository, root);
  assert.equal(result.branch, "main");
  assert.match(result.head, /^[0-9a-f]{40}$/u);
  assert.match(result.snapshotId, /^[0-9a-f]{64}$/u);
  assert.equal(result.dirty, false);
  assert.deepEqual(result.counts, {
    staged: 0,
    modified: 0,
    untracked: 0,
    conflicts: 0,
    total: 0,
  });
  assert.equal("files" in result, false);
});

test("classifies staged, working-tree, and untracked files with a prefix filter", async (t) => {
  const root = await createRepository(t);
  await writeFile(join(root, "src", "staged.txt"), "staged\n", "utf8");
  await git(root, "add", "src/staged.txt");
  await writeFile(join(root, "tracked.txt"), "changed\n", "utf8");
  await writeFile(join(root, "src", "untracked.txt"), "untracked\n", "utf8");

  const result = await inspectWorkspaceStatus(root, { detail: "files", pathPrefix: "src" });

  assert.equal(result.dirty, true);
  assert.deepEqual(result.counts, {
    staged: 1,
    modified: 1,
    untracked: 1,
    conflicts: 0,
    total: 3,
  });
  assert.equal(result.matchingCount, 2);
  assert.deepEqual(
    result.files.map(({ path, kind }) => ({ path, kind })),
    [
      { path: "src/staged.txt", kind: "added" },
      { path: "src/untracked.txt", kind: "untracked" },
    ],
  );
});

test("ignores inherited Git repository overrides", async (t) => {
  const root = await createRepository(t);
  const otherRoot = await createRepository(t);
  await writeFile(join(otherRoot, "tracked.txt"), "other repository\n", "utf8");
  await git(otherRoot, "add", "tracked.txt");
  await git(otherRoot, "commit", "-m", "different head");
  const previousGitDirectory = process.env.GIT_DIR;
  process.env.GIT_DIR = join(otherRoot, ".git");
  try {
    const result = await inspectWorkspaceStatus(root);
    assert.equal(result.repository, root);
    assert.notEqual(result.head, (await gitOutput(otherRoot, "rev-parse", "HEAD")).trim());
  } finally {
    if (previousGitDirectory === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previousGitDirectory;
  }
});

test("reads an explicit working-tree diff without exposing untracked contents", async (t) => {
  const root = await createRepository(t);
  await writeFile(join(root, "tracked.txt"), "changed value\n", "utf8");
  await writeFile(join(root, "secret-untracked.txt"), "must not appear\n", "utf8");
  const status = await inspectWorkspaceStatus(root);

  const result = await inspectWorkspaceDiff(root, {
    snapshotId: status.snapshotId,
    paths: ["tracked.txt", "secret-untracked.txt"],
  });

  assert.equal(result.truncated, false);
  assert.match(result.diff, /-initial/u);
  assert.match(result.diff, /\+changed value/u);
  assert.doesNotMatch(result.diff, /must not appear/u);
  assert.equal("artifactPath" in result, false);
});

test("treats Git pathspec magic as a literal path", async (t) => {
  const root = await createRepository(t);
  await writeFile(join(root, "tracked.txt"), "changed value\n", "utf8");
  const status = await inspectWorkspaceStatus(root);

  const result = await inspectWorkspaceDiff(root, {
    snapshotId: status.snapshotId,
    paths: [":(top,glob)**"],
  });

  assert.equal(result.diff, "");
});

test("disables repository-configured fsmonitor and external diff commands", async (t) => {
  const root = await createRepository(t);
  const marker = join(root, "command-ran.marker");
  const helper = join(root, "git-helper.sh");
  await writeFile(helper, `#!/bin/sh\nprintf invoked > ${JSON.stringify(marker)}\nexit 0\n`, "utf8");
  await chmod(helper, 0o700);
  await git(root, "config", "core.fsmonitor", helper);
  await git(root, "config", "diff.external", helper);
  await writeFile(join(root, "tracked.txt"), "changed value\n", "utf8");

  const status = await inspectWorkspaceStatus(root);
  const result = await inspectWorkspaceDiff(root, {
    snapshotId: status.snapshotId,
    paths: ["tracked.txt"],
  });

  assert.match(result.diff, /\+changed value/u);
  await assert.rejects(access(marker), { code: "ENOENT" });
});

test("rejects stale snapshots before reading a diff", async (t) => {
  const root = await createRepository(t);
  const status = await inspectWorkspaceStatus(root);
  await writeFile(join(root, "tracked.txt"), "changed after snapshot\n", "utf8");

  await assert.rejects(
    inspectWorkspaceDiff(root, {
      snapshotId: status.snapshotId,
      paths: ["tracked.txt"],
    }),
    /Workspace snapshot changed/u,
  );
});

test("untracked runtime artifact churn does not invalidate a tracked diff snapshot", async (t) => {
  const root = await createRepository(t);
  await writeFile(join(root, "tracked.txt"), "tracked change\n", "utf8");
  await writeFile(join(root, "runtime.log"), "first\n", "utf8");
  const status = await inspectWorkspaceStatus(root);
  await writeFile(join(root, "runtime.log"), "second\n", "utf8");
  await writeFile(join(root, "new-runtime.log"), "new\n", "utf8");

  const result = await inspectWorkspaceDiff(root, {
    snapshotId: status.snapshotId,
    paths: ["tracked.txt"],
  });

  assert.match(result.diff, /\+tracked change/u);
});

test("bounds status file details by serialized bytes", async (t) => {
  const root = await createRepository(t);
  for (let index = 0; index < 250; index += 1) {
    const name = `${String(index).padStart(3, "0")}-${"x".repeat(180)}.txt`;
    await writeFile(join(root, "src", name), "untracked\n", "utf8");
  }

  const result = await inspectWorkspaceStatus(root, { detail: "files", pathPrefix: "src" });

  assert.equal(result.matchingCount, 250);
  assert.ok(result.omittedFiles > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(result.files), "utf8") <= 41_000);
});

test("truncates large diffs, preserves the artifact, and removes expired artifacts", async (t) => {
  const expiredDirectory = await mkdtemp(join(tmpdir(), "pi-workspace-vcs-"));
  await writeFile(join(expiredDirectory, "workspace.diff"), "expired\n", "utf8");
  const expiredAt = new Date(Date.now() - 2 * 60 * 60 * 1_000);
  await utimes(expiredDirectory, expiredAt, expiredAt);
  t.after(() => rm(expiredDirectory, { recursive: true, force: true }));
  const root = await createRepository(t);
  const lines = Array.from({ length: 400 }, (_, index) => `changed-${index}-${"x".repeat(40)}`);
  await writeFile(join(root, "tracked.txt"), `${lines.join("\n")}\n`, "utf8");
  const status = await inspectWorkspaceStatus(root);

  const result = await inspectWorkspaceDiff(root, {
    snapshotId: status.snapshotId,
    paths: ["tracked.txt"],
    maxBytes: 1_000,
    maxLines: 20,
  });

  assert.equal(result.truncated, true);
  assert.ok(result.artifactPath);
  await access(result.artifactPath);
  assert.ok(result.outputBytes <= 1_000);
  assert.ok(result.outputLines <= 20);
  assert.ok(result.totalBytes > result.outputBytes);
  await assert.rejects(access(expiredDirectory), { code: "ENOENT" });
  t.after(() => rm(dirname(result.artifactPath), { recursive: true, force: true }));
});

test("rejects paths that escape the repository", async (t) => {
  const root = await createRepository(t);
  const status = await inspectWorkspaceStatus(root);
  await assert.rejects(
    inspectWorkspaceDiff(root, {
      snapshotId: status.snapshotId,
      paths: ["../outside"],
    }),
    /stay inside the repository/u,
  );
});

async function createRepository(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-workspace-vcs-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, "init", "--initial-branch=main");
  await git(root, "config", "user.email", "tests@example.invalid");
  await git(root, "config", "user.name", "Workspace VCS Tests");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "tracked.txt"), "initial\n", "utf8");
  await git(root, "add", "tracked.txt");
  await git(root, "commit", "-m", "initial");
  return root;
}

async function git(root, ...args) {
  await execFileAsync("git", ["-C", root, ...args], { encoding: "utf8" });
}

async function gitOutput(root, ...args) {
  return (await execFileAsync("git", ["-C", root, ...args], { encoding: "utf8" })).stdout;
}
