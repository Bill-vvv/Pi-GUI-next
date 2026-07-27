import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  formatDiffResult,
  formatStatusResult,
  inspectWorkspaceDiff,
  inspectWorkspaceStatus,
} from "./workspace-vcs.mjs";

const statusParameters = Type.Object({
  detail: Type.Optional(
    StringEnum(["summary", "files"] as const, {
      description: "Return only counts or include bounded changed-file records.",
    }),
  ),
  pathPrefix: Type.Optional(
    Type.String({ description: "Optional repository-relative prefix used only to filter file records." }),
  ),
}, { additionalProperties: false });

const diffParameters = Type.Object({
  snapshotId: Type.String({ description: "Tracked-diff snapshot id returned by workspace_vcs_status." }),
  paths: Type.Array(
    Type.String({ description: "Repository-relative file or directory path." }),
    { minItems: 1, maxItems: 50 },
  ),
  stage: Type.Optional(StringEnum(["working", "staged", "both"] as const)),
  maxBytes: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 50_000 })),
  maxLines: Type.Optional(Type.Integer({ minimum: 10, maximum: 2_000 })),
}, { additionalProperties: false });

export default function workspaceVcsExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "workspace_vcs_status",
    label: "Workspace VCS Status",
    description: "Read the current Git repository root, branch, HEAD, dirty counts, and an on-demand bounded file list. Returns a tracked-diff snapshotId for follow-up diff queries; untracked paths are observations only and their contents are never read. This tool never changes repository state.",
    parameters: statusParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("workspace_vcs_status was cancelled.");
      const result = await inspectWorkspaceStatus(ctx.cwd, params, signal);
      return {
        content: [{ type: "text", text: formatStatusResult(result) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "workspace_vcs_diff",
    label: "Workspace VCS Diff",
    description: "Read a bounded Git diff for literal repository-relative paths and a tracked-diff workspace_vcs_status snapshotId. Rejects stale tracked state, never includes untracked file contents, and retains a quota-limited temporary artifact only when the preview is truncated.",
    parameters: diffParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("workspace_vcs_diff was cancelled.");
      const result = await inspectWorkspaceDiff(ctx.cwd, params, signal);
      const { diff: _diff, ...details } = result;
      return {
        content: [{ type: "text", text: formatDiffResult(result) }],
        details,
      };
    },
  });
}
