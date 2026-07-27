# pi-subagent-workspace-vcs

A child-only Pi extension that gives read-only subagents bounded Git provenance tools without granting a general shell.

## Tools

### `workspace_vcs_status`

Returns the repository root, branch, HEAD, clean/dirty counts, and a tracked-diff `snapshotId`. The default `summary` response does not list files. Use `detail: "files"` with an optional repository-relative `pathPrefix` to request a bounded file list.

### `workspace_vcs_diff`

Returns a bounded working-tree and/or staged diff for explicit literal repository-relative paths. The call must include a current `snapshotId`; it fails if tracked diff state changed before or during the query. Untracked file contents are never included. A full private temporary artifact is retained only when the displayed result is truncated.

## Subagent configuration

Load the extension only in the child and keep both registered tool names in the strict allowlist:

```yaml
tools: read, grep, find, ls, workspace_vcs_status, workspace_vcs_diff
subagentOnlyExtensions: /absolute/path/to/pi-subagent-workspace-vcs/src/index.ts
```

The extension does not inject Git state into the system prompt. Tool definitions remain stable, and repository state is queried lazily only when an agent needs provenance.

## Safety and limits

- Executes only `git` with argument arrays and `shell: false` semantics.
- Strips inherited `GIT_*` overrides, disables fsmonitor/external diff/textconv execution, and treats every requested path as a literal pathspec.
- Uses the child session's `ctx.cwd`; callers cannot supply an arbitrary cwd.
- Rejects absolute paths and repository traversal.
- Requires explicit diff paths, capped at 50 entries.
- Defaults to 30,000 bytes and 800 lines; hard preview limits are 50,000 bytes and 2,000 lines. Each underlying diff command is capped at 16 MiB.
- Status file lists are capped at 500 entries and 40,000 serialized bytes, and can be narrowed with `pathPrefix`.
- Truncated diff artifacts use private temporary directories, expire after one hour, and are kept under a 16-directory/128 MiB cleanup quota.
- Snapshot ids identify HEAD, branch, the Git index, tracked status records, and tracked changed-path filesystem metadata. Untracked counts and paths are point-in-time observations and do not participate in the token because this extension never diffs untracked contents; this also prevents Subagent transcript/artifact churn from invalidating an unrelated tracked diff. Snapshot ids are consistency tokens for a query sequence, not cryptographic attestations of a repository release.

## Development

```bash
npm install
npm test
```
