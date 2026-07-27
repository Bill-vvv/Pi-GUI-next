import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SMALL_COMMAND_MAX_BYTES = 4 * 1024 * 1024;
const DIFF_COMMAND_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_DIFF_MAX_BYTES = 30_000;
const DEFAULT_DIFF_MAX_LINES = 800;
const MAX_DIFF_BYTES = 50_000;
const MAX_DIFF_LINES = 2_000;
const MAX_FILE_RESULTS = 500;
const MAX_DIFF_PATHS = 50;
const MAX_STDERR_BYTES = 64 * 1024;
const STATUS_FILE_LIST_MAX_BYTES = 40_000;
const ARTIFACT_PREFIX = "pi-workspace-vcs-";
const ARTIFACT_TTL_MS = 60 * 60 * 1_000;
const ARTIFACT_MAX_DIRECTORIES = 16;
const ARTIFACT_MAX_TOTAL_BYTES = 128 * 1024 * 1024;

export async function inspectWorkspaceStatus(cwd, options = {}, signal) {
  const repository = await resolveRepository(cwd, signal);
  const snapshot = await captureSnapshot(repository, signal);
  const detail = options.detail ?? "summary";
  if (detail !== "summary" && detail !== "files") {
    throw new Error("detail must be 'summary' or 'files'.");
  }
  const pathPrefix = normalizeRelativePath(options.pathPrefix, "pathPrefix", { optional: true });
  const matchingFiles = pathPrefix === undefined
    ? snapshot.files
    : snapshot.files.filter((entry) => pathMatchesPrefix(entry.path, pathPrefix));
  const files = detail === "files" ? selectBoundedFiles(matchingFiles) : undefined;
  return {
    repository: repository.root,
    branch: snapshot.branch,
    head: snapshot.head,
    snapshotId: snapshot.snapshotId,
    snapshotScope: "tracked-diff-state",
    dirty: snapshot.files.length > 0,
    counts: countStatus(snapshot.files),
    ...(pathPrefix === undefined ? {} : { pathPrefix, matchingCount: matchingFiles.length }),
    ...(files === undefined ? {} : {
      files,
      omittedFiles: matchingFiles.length - files.length,
    }),
  };
}

export async function inspectWorkspaceDiff(cwd, options, signal) {
  const repository = await resolveRepository(cwd, signal);
  const expectedSnapshotId = requiredText(options?.snapshotId, "snapshotId");
  const paths = normalizeDiffPaths(options?.paths);
  const stage = options?.stage ?? "working";
  if (!new Set(["working", "staged", "both"]).has(stage)) {
    throw new Error("stage must be 'working', 'staged', or 'both'.");
  }
  const maxBytes = boundedInteger(
    options?.maxBytes,
    "maxBytes",
    DEFAULT_DIFF_MAX_BYTES,
    1_000,
    MAX_DIFF_BYTES,
  );
  const maxLines = boundedInteger(
    options?.maxLines,
    "maxLines",
    DEFAULT_DIFF_MAX_LINES,
    10,
    MAX_DIFF_LINES,
  );

  const before = await captureSnapshot(repository, signal);
  if (before.snapshotId !== expectedSnapshotId) {
    throw new Error(
      `Workspace snapshot changed (expected ${expectedSnapshotId}, current ${before.snapshotId}); call workspace_vcs_status again.`,
    );
  }

  await cleanupArtifactDirectories();
  const artifactDirectory = await mkdtemp(join(tmpdir(), ARTIFACT_PREFIX));
  const artifactPath = join(artifactDirectory, "workspace.diff");
  try {
    const sections = [];
    if (stage === "working" || stage === "both") {
      sections.push({ label: "working tree", args: ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", "--", ...paths] });
    }
    if (stage === "staged" || stage === "both") {
      sections.push({ label: "staged", args: ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", "--", ...paths] });
    }

    let combined = "";
    for (const section of sections) {
      const output = await runGit(repository.root, section.args, {
        maxBuffer: DIFF_COMMAND_MAX_BYTES,
        signal,
      });
      if (sections.length > 1) combined += `### ${section.label}\n`;
      combined += output;
      if (combined && !combined.endsWith("\n")) combined += "\n";
    }
    await writeFile(artifactPath, combined, { encoding: "utf8", mode: 0o600 });

    const after = await captureSnapshot(repository, signal);
    if (after.snapshotId !== expectedSnapshotId) {
      throw new Error(
        `Workspace changed while reading the diff (expected ${expectedSnapshotId}, current ${after.snapshotId}); retry from workspace_vcs_status.`,
      );
    }

    const preview = await readBoundedPreview(artifactPath, maxBytes, maxLines);
    if (!preview.truncated) await rm(artifactDirectory, { recursive: true, force: true });
    else await cleanupArtifactDirectories(artifactDirectory);
    return {
      repository: repository.root,
      branch: before.branch,
      head: before.head,
      snapshotId: expectedSnapshotId,
      snapshotScope: "tracked-diff-state",
      stage,
      paths,
      diff: preview.text,
      truncated: preview.truncated,
      outputBytes: preview.outputBytes,
      totalBytes: preview.totalBytes,
      outputLines: preview.outputLines,
      totalLines: preview.totalLines,
      ...(preview.truncated ? { artifactPath } : {}),
    };
  } catch (error) {
    await rm(artifactDirectory, { recursive: true, force: true });
    throw error;
  }
}

export function formatStatusResult(result) {
  const lines = [
    "Workspace VCS status",
    `repository: ${result.repository}`,
    `branch: ${result.branch ?? "(detached or unborn)"}`,
    `HEAD: ${result.head ?? "(unborn)"}`,
    `snapshotId: ${result.snapshotId}`,
    "snapshotScope: tracked diff state (untracked paths are observations only)",
    `state: ${result.dirty ? "dirty" : "clean"}`,
    `counts: staged=${result.counts.staged}, modified=${result.counts.modified}, untracked=${result.counts.untracked}, conflicts=${result.counts.conflicts}, total=${result.counts.total}`,
  ];
  if (result.pathPrefix !== undefined) {
    lines.push(`pathPrefix: ${result.pathPrefix || "."} (${result.matchingCount} matching)`);
  }
  if (result.files) {
    lines.push("files:");
    if (result.files.length === 0) lines.push("  (none)");
    for (const file of result.files) {
      const code = `${file.index}${file.worktree}`;
      const renamed = file.originalPath ? ` <- ${file.originalPath}` : "";
      lines.push(`  ${code} ${file.path}${renamed}`);
    }
    if (result.omittedFiles > 0) lines.push(`  ... ${result.omittedFiles} more omitted; narrow pathPrefix for details`);
  }
  return lines.join("\n");
}

export function formatDiffResult(result) {
  const header = [
    "Workspace VCS diff",
    `repository: ${result.repository}`,
    `snapshotId: ${result.snapshotId}`,
    "snapshotScope: tracked diff state",
    `stage: ${result.stage}`,
    `paths: ${result.paths.join(", ")}`,
  ];
  if (!result.diff) header.push("", "(no diff for the selected paths and stage)");
  else header.push("", result.diff.replace(/\n$/u, ""));
  if (result.truncated) {
    header.push(
      "",
      `[Output truncated: ${result.outputLines}/${result.totalLines} lines, ${result.outputBytes}/${result.totalBytes} bytes. Full diff saved to: ${result.artifactPath}]`,
    );
  }
  return header.join("\n");
}

async function resolveRepository(cwd, signal) {
  const requested = resolve(cwd);
  const root = (await runGit(requested, ["rev-parse", "--show-toplevel"], { signal })).trim();
  if (!root) throw new Error(`No Git repository found from '${requested}'.`);
  return { root: resolve(root) };
}

async function captureSnapshot(repository, signal) {
  const [headResult, branchResult, statusOutput, indexDigest] = await Promise.all([
    runGitOptional(repository.root, ["rev-parse", "HEAD"], signal),
    runGitOptional(repository.root, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal),
    runGit(repository.root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { signal }),
    gitIndexDigest(repository.root, signal),
  ]);
  const files = parsePorcelainStatus(statusOutput);
  const trackedFiles = files.filter((entry) => entry.kind !== "untracked");
  const metadataPaths = trackedFiles.flatMap((entry) => [
    entry.path,
    ...(entry.originalPath ? [entry.originalPath] : []),
  ]);
  const fileMetadata = await Promise.all(
    metadataPaths.map(async (path) => [path, await pathMetadata(repository.root, path)]),
  );
  const head = headResult?.trim() || null;
  const branch = branchResult?.trim() || null;
  const snapshotId = createHash("sha256")
    .update(JSON.stringify({ head, branch, indexDigest, trackedFiles, fileMetadata }))
    .digest("hex");
  return { head, branch, files, snapshotId };
}

function parsePorcelainStatus(output) {
  if (!output) return [];
  const fields = output.split("\0");
  const files = [];
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (!record) continue;
    if (record.length < 4 || record[2] !== " ") {
      throw new Error("Git returned an unsupported porcelain status record.");
    }
    const code = record.slice(0, 2);
    const path = record.slice(3);
    const renamed = code[0] === "R" || code[0] === "C" || code[1] === "R" || code[1] === "C";
    const originalPath = renamed ? fields[index += 1] : undefined;
    if (renamed && !originalPath) throw new Error("Git returned an incomplete rename status record.");
    files.push({
      path,
      ...(originalPath ? { originalPath } : {}),
      index: code[0],
      worktree: code[1],
      kind: statusKind(code),
    });
  }
  return files;
}

function statusKind(code) {
  if (code === "??") return "untracked";
  if (code === "!!") return "ignored";
  if (new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]).has(code)) return "conflict";
  if (code[0] === "R" || code[1] === "R") return "renamed";
  if (code[0] === "C" || code[1] === "C") return "copied";
  if (code[0] === "A") return "added";
  if (code[0] === "D" || code[1] === "D") return "deleted";
  return "modified";
}

function countStatus(files) {
  let staged = 0;
  let modified = 0;
  let untracked = 0;
  let conflicts = 0;
  for (const file of files) {
    if (file.kind === "untracked") untracked += 1;
    else {
      if (file.index !== " " && file.index !== "?") staged += 1;
      if (file.worktree !== " " && file.worktree !== "?") modified += 1;
    }
    if (file.kind === "conflict") conflicts += 1;
  }
  return { staged, modified, untracked, conflicts, total: files.length };
}

async function gitIndexDigest(root, signal) {
  const gitDirectory = (await runGit(root, ["rev-parse", "--git-dir"], { signal })).trim();
  const absoluteGitDirectory = isAbsolute(gitDirectory) ? gitDirectory : resolve(root, gitDirectory);
  try {
    const contents = await readFile(join(absoluteGitDirectory, "index"));
    return createHash("sha256").update(contents).digest("hex");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function pathMetadata(root, relativePath) {
  const target = resolveContainedPath(root, relativePath);
  try {
    const value = await lstat(target, { bigint: true });
    return {
      type: value.isFile() ? "file" : value.isDirectory() ? "directory" : value.isSymbolicLink() ? "symlink" : "other",
      size: value.size.toString(),
      mtimeNs: value.mtimeNs.toString(),
      ctimeNs: value.ctimeNs.toString(),
      ino: value.ino.toString(),
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { type: "missing" };
    throw error;
  }
}

function resolveContainedPath(root, relativePath) {
  const target = resolve(root, relativePath);
  const relation = relative(root, target);
  if (relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation))) {
    return target;
  }
  throw new Error(`Git reported a path outside the repository: ${relativePath}`);
}

function normalizeDiffPaths(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("paths must contain at least one repository-relative path.");
  }
  if (value.length > MAX_DIFF_PATHS) {
    throw new Error(`paths may contain at most ${MAX_DIFF_PATHS} entries.`);
  }
  return [...new Set(value.map((entry, index) =>
    normalizeRelativePath(entry, `paths[${index}]`, { optional: false }) || ".",
  ))];
}

function normalizeRelativePath(value, field, { optional }) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error(`${field} must be a repository-relative path.`);
  }
  const trimmed = value.trim().replaceAll("\\", "/");
  if (!trimmed || trimmed === ".") return "";
  if (isAbsolute(trimmed) || /^[A-Za-z]:\//u.test(trimmed)) {
    throw new Error(`${field} must be repository-relative.`);
  }
  const normalized = normalize(trimmed).replaceAll("\\", "/").replace(/^\.\//u, "");
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${field} must stay inside the repository.`);
  }
  return normalized;
}

function pathMatchesPrefix(path, prefix) {
  if (!prefix) return true;
  return path === prefix || path.startsWith(`${prefix}/`);
}

function selectBoundedFiles(files) {
  const selected = [];
  let serializedBytes = 0;
  for (const file of files) {
    if (selected.length >= MAX_FILE_RESULTS) break;
    const nextBytes = Buffer.byteLength(JSON.stringify(file), "utf8") + 1;
    if (serializedBytes + nextBytes > STATUS_FILE_LIST_MAX_BYTES) break;
    selected.push(file);
    serializedBytes += nextBytes;
  }
  return selected;
}

function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required.`);
  return value.trim();
}

function boundedInteger(value, field, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

async function runGit(cwd, args, options = {}) {
  try {
    const result = await execFileAsync(
      "git",
      [
        "--literal-pathspecs",
        "-c", "core.fsmonitor=false",
        "-c", "diff.external=",
        "-C", cwd,
        ...args,
      ],
      {
        encoding: "utf8",
        env: createGitEnvironment(),
        maxBuffer: options.maxBuffer ?? SMALL_COMMAND_MAX_BYTES,
        signal: options.signal,
        timeout: 20_000,
        windowsHide: true,
      },
    );
    return result.stdout;
  } catch (error) {
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    const suffix = stderr ? `: ${stderr.slice(0, MAX_STDERR_BYTES)}` : "";
    throw new Error(`git ${args[0] ?? "command"} failed${suffix}`);
  }
}

function createGitEnvironment() {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith("GIT_")) environment[key] = value;
  }
  return {
    ...environment,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
  };
}

async function runGitOptional(cwd, args, signal) {
  try {
    return await runGit(cwd, args, { signal });
  } catch {
    return null;
  }
}

async function cleanupArtifactDirectories(preserveDirectory) {
  let entries;
  try {
    entries = await readdir(tmpdir(), { withFileTypes: true });
  } catch {
    return;
  }
  const owner = typeof process.getuid === "function" ? process.getuid() : undefined;
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(ARTIFACT_PREFIX)) continue;
    const directory = join(tmpdir(), entry.name);
    try {
      const metadata = await lstat(directory);
      if (!metadata.isDirectory() || (owner !== undefined && metadata.uid !== owner)) continue;
      candidates.push({
        directory,
        mtimeMs: metadata.mtimeMs,
        size: await artifactDirectorySize(directory),
      });
    } catch {
      // A concurrent process may already have removed the directory.
    }
  }

  const preserve = preserveDirectory ? resolve(preserveDirectory) : undefined;
  const now = Date.now();
  for (const candidate of candidates) {
    if (resolve(candidate.directory) === preserve) continue;
    if (now - candidate.mtimeMs > ARTIFACT_TTL_MS) {
      await rm(candidate.directory, { recursive: true, force: true });
      candidate.removed = true;
    }
  }

  const remaining = candidates
    .filter((candidate) => !candidate.removed)
    .sort((left, right) => left.mtimeMs - right.mtimeMs);
  let directoryCount = remaining.length;
  let totalBytes = remaining.reduce((sum, candidate) => sum + candidate.size, 0);
  for (const candidate of remaining) {
    if (directoryCount <= ARTIFACT_MAX_DIRECTORIES && totalBytes <= ARTIFACT_MAX_TOTAL_BYTES) break;
    if (resolve(candidate.directory) === preserve) continue;
    await rm(candidate.directory, { recursive: true, force: true });
    directoryCount -= 1;
    totalBytes -= candidate.size;
  }
}

async function artifactDirectorySize(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  let totalBytes = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      totalBytes += (await lstat(join(directory, entry.name))).size;
    } catch {
      // Ignore files concurrently removed during cleanup.
    }
  }
  return totalBytes;
}

async function readBoundedPreview(filePath, maxBytes, maxLines) {
  const fileStat = await stat(filePath);
  const totalBytes = fileStat.size;
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(Math.min(totalBytes, maxBytes + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const byteTruncated = totalBytes > maxBytes;
    const available = buffer.subarray(0, Math.min(bytesRead, maxBytes)).toString("utf8");
    const allLines = available === "" ? [] : available.split("\n");
    const lineTruncated = allLines.length > maxLines;
    const selectedLines = lineTruncated ? allLines.slice(0, maxLines) : allLines;
    const text = selectedLines.join("\n");
    const totalLines = await countFileLines(handle, totalBytes);
    return {
      text,
      truncated: byteTruncated || lineTruncated,
      outputBytes: Buffer.byteLength(text, "utf8"),
      totalBytes,
      outputLines: countTextLines(text),
      totalLines,
    };
  } finally {
    await handle.close();
  }
}

async function countFileLines(handle, totalBytes) {
  if (totalBytes === 0) return 0;
  const buffer = Buffer.alloc(64 * 1024);
  let position = 0;
  let newlineCount = 0;
  let lastByte = -1;
  while (position < totalBytes) {
    const length = Math.min(buffer.length, totalBytes - position);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead === 0) break;
    for (let index = 0; index < bytesRead; index += 1) {
      if (buffer[index] === 10) newlineCount += 1;
    }
    lastByte = buffer[bytesRead - 1];
    position += bytesRead;
  }
  return newlineCount + (lastByte === 10 ? 0 : 1);
}

function countTextLines(text) {
  if (text === "") return 0;
  const newlineCount = [...text].reduce((count, character) =>
    count + (character === "\n" ? 1 : 0), 0);
  return newlineCount + (text.endsWith("\n") ? 0 : 1);
}
