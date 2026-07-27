import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  discoverWatchdogFiles,
  expandInstructionImports,
  loadWatchdog,
  normalizeWatchdog,
  slugifyAdvisor,
} from "../src/watchdog.mjs";

async function fixture(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "multi-advisor-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("slug normalization is stable and has an advisor fallback", () => {
  assert.equal(slugifyAdvisor("  Security + UX  "), "security-ux");
  assert.equal(slugifyAdvisor("!!!"), "advisor");
});

test("normalization defaults tools safely and rejects unknown tools", () => {
  const diagnostics = [];
  const value = normalizeWatchdog(
    {
      advisors: [
        { name: "Reader", tools: [] },
        { name: "Writer", tools: ["read", "edit", "write", "bash", "browser", "edit"] },
      ],
    },
    "WATCHDOG.yml",
    diagnostics,
  );
  assert.deepEqual(value.advisors[0].tools, ["read", "grep", "find", "ls"]);
  assert.deepEqual(value.advisors[1].tools, ["read", "edit", "write"]);
  assert.equal(diagnostics.length, 2);
  assert.match(diagnostics[0].message, /bash/);
  assert.match(diagnostics[1].message, /browser/);
});

test("a duplicate slug invalidates one WATCHDOG file", () => {
  const diagnostics = [];
  const normalized = normalizeWatchdog(
    {
      advisors: [
        { name: "Same Name" },
        { name: "same-name" },
      ],
    },
    "WATCHDOG.yml",
    diagnostics,
  );
  assert.equal(normalized, undefined);
  assert.match(diagnostics[0]?.message ?? "", /unique/u);
});

test("discovery orders user config, then project ancestors with root before .omp", async () => {
  await fixture(async (directory) => {
    const home = path.join(directory, "home");
    const agentDir = path.join(home, ".pi", "agent");
    const project = path.join(home, "work");
    const cwd = path.join(project, "packages", "app");
    await mkdir(path.join(project, ".git"), { recursive: true });
    const expected = [
      path.join(agentDir, "WATCHDOG.yml"),
      path.join(project, "WATCHDOG.md"),
      path.join(project, ".omp", "WATCHDOG.yaml"),
      path.join(cwd, "WATCHDOG.yml"),
    ];
    for (const file of expected) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "");
    }
    assert.deepEqual(await discoverWatchdogFiles({ cwd, agentDir, home }), expected);
  });
});

test("untrusted projects discover only the user-level WATCHDOG files", async () => {
  await fixture(async (directory) => {
    const agentDir = path.join(directory, "agent");
    const projectDir = path.join(directory, "project");
    const userConfig = path.join(agentDir, "WATCHDOG.yml");
    const projectConfig = path.join(projectDir, "WATCHDOG.yml");
    await mkdir(agentDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await writeFile(userConfig, "");
    await writeFile(projectConfig, "");
    assert.deepEqual(
      await discoverWatchdogFiles({
        cwd: projectDir,
        agentDir,
        home: directory,
        projectTrusted: false,
      }),
      [userConfig],
    );
  });
});

test("merge concatenates shared instructions and wholly replaces later matching slugs", async () => {
  await fixture(async (directory) => {
    const first = path.join(directory, "WATCHDOG.yml");
    const markdown = path.join(directory, "WATCHDOG.md");
    const later = path.join(directory, "nested", "WATCHDOG.yaml");
    await mkdir(path.dirname(later), { recursive: true });
    await writeFile(
      first,
      "instructions: first\nadvisors:\n  - name: Same Name\n    model: old\n    instructions: old\n",
    );
    await writeFile(markdown, "second");
    await writeFile(
      later,
      "instructions: third\nadvisors:\n  - name: Same Name\n    model: primary\n    tools: [read, edit]\n    instructions: new\n  - name: Other\n    enabled: false\n",
    );
    const result = await loadWatchdog({
      cwd: directory,
      agentDir: directory,
      home: directory,
      files: [first, markdown, later],
    });
    assert.equal(result.instructions, "first\n\nsecond\n\nthird");
    assert.deepEqual(
      result.advisors.map(({ slug, model, tools, instructions, enabled }) => ({
        slug,
        model,
        tools,
        instructions,
        enabled,
      })),
      [
        {
          slug: "default-advisor",
          model: "gpt-5.6-sol",
          tools: ["read", "grep", "find", "ls"],
          instructions: "",
          enabled: true,
        },
        {
          slug: "same-name",
          model: "primary",
          tools: ["read", "edit"],
          instructions: "new",
          enabled: true,
        },
        {
          slug: "other",
          model: null,
          tools: ["read", "grep", "find", "ls"],
          instructions: "",
          enabled: false,
        },
      ],
    );
  });
});

test("invalid files are diagnosed and skipped; no valid config keeps the builtin", async () => {
  await fixture(async (directory) => {
    const invalid = path.join(directory, "WATCHDOG.yml");
    await writeFile(invalid, "advisors: [");
    const result = await loadWatchdog({
      cwd: directory,
      agentDir: directory,
      home: directory,
      files: [invalid],
    });
    assert.equal(result.advisors.length, 1);
    assert.equal(result.advisors[0].name, "Default Advisor");
    assert.equal(result.advisors[0].model, "gpt-5.6-sol");
    assert.equal(result.advisors[0].thinking, "medium");
    assert.deepEqual(result.advisors[0].tools, ["read", "grep", "find", "ls"]);
    assert.match(result.diagnostics[0].message, /invalid YAML skipped/);
  });
});

test("instruction imports expand with bounds while code, missing paths, and cycles stay safe", async () => {
  await fixture(async (directory) => {
    const source = path.join(directory, "WATCHDOG.md");
    const child = path.join(directory, "child.md");
    const cycle = path.join(directory, "cycle.md");
    await writeFile(child, "child text");
    await writeFile(cycle, "@WATCHDOG.md");
    const input = [
      "before @child.md after",
      "`@child.md`",
      "```",
      "@child.md",
      "```",
      "@missing.md",
      "@cycle.md",
    ].join("\n");
    await writeFile(source, input);
    const diagnostics = [];
    const expanded = await expandInstructionImports(input, source, {
      home: directory,
      diagnostics,
    });
    assert.match(expanded, /before child text after/);
    assert.match(expanded, /`@child\.md`/);
    assert.match(expanded, /```\n@child\.md\n```/);
    assert.match(expanded, /@missing\.md/);
    assert.doesNotMatch(expanded, /@cycle\.md/);
    assert.ok(diagnostics.some(({ message }) => /missing import retained/.test(message)));
    assert.ok(diagnostics.some(({ message }) => /cyclic import skipped/.test(message)));
  });
});
