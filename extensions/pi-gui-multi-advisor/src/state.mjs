import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseState, parseStateText, STATE_VERSION } from "./protocol.mjs";

export function getStatePath(env = process.env, home = os.homedir()) {
  const directory = env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent");
  return path.join(directory, "pi-gui-multi-advisor.json");
}

export async function loadState(filePath = getStatePath(), io = fs) {
  try {
    return parseStateText(await io.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return Object.freeze({ version: STATE_VERSION, enabled: false });
    }
    throw error;
  }
}

export async function saveState(filePath, enabled, io = fs, nonce = `${process.pid}-${Date.now()}`) {
  const state = parseState({ version: STATE_VERSION, enabled });
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(directory, `.pi-gui-multi-advisor.json.${nonce}.tmp`);
  await io.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await io.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    });
    await io.rename(temporaryPath, filePath);
  } catch (error) {
    try {
      await io.unlink(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") {
        error.cleanupError = cleanupError;
      }
    }
    throw error;
  }
  return state;
}
