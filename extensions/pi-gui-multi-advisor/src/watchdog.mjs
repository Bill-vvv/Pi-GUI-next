import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { READ_ONLY_TOOLS } from "./protocol.mjs";

const CONFIG_NAMES = Object.freeze(["WATCHDOG.yml", "WATCHDOG.yaml"]);
const MARKDOWN_NAME = "WATCHDOG.md";
const ALLOWED_TOOLS = new Set([...READ_ONLY_TOOLS, "edit", "write"]);
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const MAX_IMPORT_DEPTH = 8;
const MAX_IMPORT_BYTES = 64 * 1024;

export const BUILTIN_ADVISOR = Object.freeze({
  slug: "default-advisor",
  name: "Default Advisor",
  model: "gpt-5.6-sol",
  thinking: "medium",
  tools: [...READ_ONLY_TOOLS],
  instructions: "",
  enabled: true,
});

export function slugifyAdvisor(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "advisor";
}

function diagnostic(file, message) {
  return { file, message };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeWatchdog(value, file = "<WATCHDOG>", diagnostics = []) {
  if (!isRecord(value)) {
    diagnostics.push(diagnostic(file, "expected an object containing instructions and advisors"));
    return undefined;
  }
  if (value.instructions !== undefined && typeof value.instructions !== "string") {
    diagnostics.push(diagnostic(file, "instructions must be a string"));
    return undefined;
  }
  if (value.advisors !== undefined && !Array.isArray(value.advisors)) {
    diagnostics.push(diagnostic(file, "advisors must be an array"));
    return undefined;
  }

  const advisors = [];
  for (const [index, raw] of (value.advisors ?? []).entries()) {
    const prefix = `advisors[${index}]`;
    if (
      !isRecord(raw) ||
      typeof raw.name !== "string" ||
      (raw.model !== undefined && raw.model !== null && typeof raw.model !== "string") ||
      (raw.thinking !== undefined &&
        raw.thinking !== null &&
        (typeof raw.thinking !== "string" || !THINKING_LEVELS.has(raw.thinking))) ||
      (raw.instructions !== undefined && typeof raw.instructions !== "string") ||
      (raw.enabled !== undefined && typeof raw.enabled !== "boolean") ||
      (raw.tools !== undefined &&
        (!Array.isArray(raw.tools) || raw.tools.some((tool) => typeof tool !== "string")))
    ) {
      diagnostics.push(diagnostic(file, `${prefix} has an invalid field or value`));
      return undefined;
    }

    const requestedTools =
      !raw.tools || raw.tools.length === 0 ? [...READ_ONLY_TOOLS] : raw.tools;
    const tools = [];
    for (const tool of requestedTools) {
      if (!ALLOWED_TOOLS.has(tool)) {
        diagnostics.push(diagnostic(file, `${prefix}: unknown tool "${tool}" was ignored`));
      } else if (!tools.includes(tool)) {
        tools.push(tool);
      }
    }
    advisors.push({
      slug: slugifyAdvisor(raw.name),
      name: raw.name,
      model: raw.model ?? null,
      thinking: raw.thinking ?? null,
      tools,
      instructions: raw.instructions ?? "",
      enabled: raw.enabled ?? true,
    });
  }
  const slugs = advisors.map(({ slug }) => slug);
  if (new Set(slugs).size !== slugs.length) {
    diagnostics.push(diagnostic(file, "advisor slugs must be unique within one WATCHDOG file"));
    return undefined;
  }
  return { instructions: value.instructions ?? "", advisors };
}

function ancestorsFrom(root, cwd) {
  const values = [];
  let current = path.resolve(cwd);
  const boundary = path.resolve(root);
  while (true) {
    values.push(current);
    if (current === boundary) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return values.reverse();
}

async function exists(target, io) {
  try {
    await io.stat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

export async function findProjectBoundary(cwd, home = os.homedir(), io = fs) {
  let current = path.resolve(cwd);
  while (true) {
    if (await exists(path.join(current, ".git"), io)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const resolvedHome = path.resolve(home);
  const relative = path.relative(resolvedHome, path.resolve(cwd));
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) ? resolvedHome : path.parse(cwd).root;
}

export async function discoverWatchdogFiles({
  cwd,
  agentDir,
  home = os.homedir(),
  io = fs,
  projectTrusted = true,
}) {
  const files = [];
  for (const name of [...CONFIG_NAMES, MARKDOWN_NAME]) {
    const file = path.join(path.resolve(agentDir), name);
    if (await exists(file, io)) files.push(file);
  }
  if (!projectTrusted) return files;
  const boundary = await findProjectBoundary(cwd, home, io);
  for (const layer of ancestorsFrom(boundary, cwd)) {
    for (const directory of [layer, path.join(layer, ".omp")]) {
      for (const name of [...CONFIG_NAMES, MARKDOWN_NAME]) {
        const file = path.join(directory, name);
        if (await exists(file, io)) files.push(file);
      }
    }
  }
  return files;
}

function splitInlineCode(line) {
  const parts = [];
  let start = 0;
  let inCode = false;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== "`") continue;
    if (index > start) parts.push({ text: line.slice(start, index), code: inCode });
    let end = index + 1;
    while (line[end] === "`") end += 1;
    parts.push({ text: line.slice(index, end), code: true });
    inCode = !inCode;
    start = end;
    index = end - 1;
  }
  if (start < line.length) parts.push({ text: line.slice(start), code: inCode });
  return parts;
}

function resolveImportPath(specifier, sourceFile, home) {
  if (specifier.startsWith("~/")) return path.resolve(home, specifier.slice(2));
  return path.resolve(path.dirname(sourceFile), specifier);
}

async function expandImportsInText(text, sourceFile, options, stack, depth) {
  const { io, home, diagnostics } = options;
  if (depth >= MAX_IMPORT_DEPTH) {
    diagnostics.push(diagnostic(sourceFile, `import depth limit (${MAX_IMPORT_DEPTH}) reached`));
    return text;
  }
  let fenced = false;
  const lines = text.split("\n");
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const parts = splitInlineCode(line);
    for (const part of parts) {
      if (part.code) continue;
      const matches = [...part.text.matchAll(/@((?:~\/|\.{0,2}\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)/g)];
      for (const match of matches.reverse()) {
        const original = match[0];
        const importedPath = resolveImportPath(match[1], sourceFile, home);
        if (stack.has(importedPath)) {
          diagnostics.push(diagnostic(sourceFile, `cyclic import skipped: ${original}`));
          part.text = part.text.slice(0, match.index) + part.text.slice(match.index + original.length);
          continue;
        }
        try {
          const imported = await io.readFile(importedPath, "utf8");
          if (Buffer.byteLength(imported) > MAX_IMPORT_BYTES) {
            diagnostics.push(diagnostic(sourceFile, `import exceeds ${MAX_IMPORT_BYTES} bytes: ${original}`));
            continue;
          }
          const expanded = await expandImportsInText(
            imported,
            importedPath,
            options,
            new Set([...stack, importedPath]),
            depth + 1,
          );
          part.text =
            part.text.slice(0, match.index) + expanded + part.text.slice(match.index + original.length);
        } catch (error) {
          if (error?.code === "ENOENT") {
            diagnostics.push(diagnostic(sourceFile, `missing import retained: ${original}`));
          } else {
            diagnostics.push(diagnostic(sourceFile, `import failed: ${original}: ${error.message}`));
          }
        }
      }
    }
    lines[lineIndex] = parts.map((part) => part.text).join("");
  }
  return lines.join("\n");
}

export async function expandInstructionImports(
  text,
  sourceFile,
  { io = fs, home = os.homedir(), diagnostics = [] } = {},
) {
  return expandImportsInText(
    text,
    sourceFile,
    { io, home, diagnostics },
    new Set([path.resolve(sourceFile)]),
    0,
  );
}

export async function loadWatchdog({
  cwd,
  agentDir,
  home = os.homedir(),
  io = fs,
  files,
  projectTrusted = true,
} = {}) {
  const diagnostics = [];
  const discovered =
    files ?? (await discoverWatchdogFiles({ cwd, agentDir, home, io, projectTrusted }));
  const shared = [];
  const advisors = new Map([
    [BUILTIN_ADVISOR.slug, { ...BUILTIN_ADVISOR, tools: [...BUILTIN_ADVISOR.tools] }],
  ]);

  for (const file of discovered) {
    let text;
    try {
      text = await io.readFile(file, "utf8");
    } catch (error) {
      diagnostics.push(diagnostic(file, `read failed: ${error.message}`));
      continue;
    }
    if (path.basename(file) === MARKDOWN_NAME) {
      shared.push(await expandInstructionImports(text, file, { io, home, diagnostics }));
      continue;
    }
    let parsed;
    try {
      parsed = parse(text);
    } catch (error) {
      diagnostics.push(diagnostic(file, `invalid YAML skipped: ${error.message}`));
      continue;
    }
    const normalized = normalizeWatchdog(parsed, file, diagnostics);
    if (!normalized) continue;
    if (normalized.instructions) {
      shared.push(
        await expandInstructionImports(normalized.instructions, file, { io, home, diagnostics }),
      );
    }
    for (const advisor of normalized.advisors) {
      advisors.set(advisor.slug, {
        ...advisor,
        instructions: await expandInstructionImports(advisor.instructions, file, {
          io,
          home,
          diagnostics,
        }),
      });
    }
  }

  return {
    instructions: shared.filter(Boolean).join("\n\n"),
    advisors: [...advisors.values()],
    diagnostics,
    files: discovered,
  };
}
