import assert from "node:assert/strict";
import test from "node:test";
import { parseState, parseStateText } from "../src/protocol.mjs";
import { loadState, saveState } from "../src/state.mjs";

test("state schema is strict and ENOENT means disabled", async () => {
  assert.deepEqual(parseStateText('{"version":1,"enabled":true}'), { version: 1, enabled: true });
  assert.throws(() => parseState({ version: 1, enabled: true, extra: false }), /expected exactly/);
  assert.throws(() => parseStateText('{"version":2,"enabled":true}'), /expected exactly/);
  assert.throws(() => parseStateText("{"), /state JSON/);
  const missing = await loadState("/fixed/state.json", {
    readFile: async () => {
      const error = new Error("missing");
      error.code = "ENOENT";
      throw error;
    },
  });
  assert.deepEqual(missing, { version: 1, enabled: false });
});

test("atomic save publishes only after temporary write and rename", async () => {
  const calls = [];
  const io = {
    mkdir: async (...args) => calls.push(["mkdir", ...args]),
    writeFile: async (...args) => calls.push(["writeFile", ...args]),
    rename: async (...args) => calls.push(["rename", ...args]),
    unlink: async (...args) => calls.push(["unlink", ...args]),
  };
  const result = await saveState("/fixed/pi-gui-multi-advisor.json", true, io, "test");
  assert.deepEqual(result, { version: 1, enabled: true });
  assert.deepEqual(calls.map(([name]) => name), ["mkdir", "writeFile", "rename"]);
  assert.match(calls[1][1], /\.pi-gui-multi-advisor\.json\.test\.tmp$/);
  assert.equal(calls[2][2], "/fixed/pi-gui-multi-advisor.json");
});
