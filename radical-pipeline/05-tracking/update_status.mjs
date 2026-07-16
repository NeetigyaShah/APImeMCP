#!/usr/bin/env node
// Atomically read-modify-write ONE status/<ID>.json. No external deps.
//
// Usage:
//   node update_status.mjs <ID> <S#> <Todo|In-Prog|In-Review|Blocked|Done|N/A>
//   node update_status.mjs <ID> --overall <Not-started|In-Progress|Blocked|Done>
//   node update_status.mjs <ID> --gate <G0|G1|G2|G3|G3b|G4|G5|G6|G7|G8|null>
//   node update_status.mjs <ID> --blocked <free text | null>
//   node update_status.mjs <ID> --owner <name | null>
//   node update_status.mjs <ID> --reviewer <name | null>
//
// Flags can be combined with an S#-update in one call, e.g.:
//   node update_status.mjs F01 S6 Done --overall In-Progress
//
// Only touches status/<ID>.json — safe for many subagents to call in parallel
// on different IDs (each owns exactly one file).

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATUS_DIR = join(HERE, "status");

const SUBTASK_STATUSES = new Set(["Todo", "In-Prog", "In-Review", "Blocked", "Done", "N/A"]);
const S_KEY_RE = /^S(1[01]|[0-9])$/; // S0..S11

function die(msg) {
  console.error("update_status.mjs: " + msg);
  process.exit(1);
}

const argv = process.argv.slice(2);
if (argv.length < 1) {
  die("usage: node update_status.mjs <ID> [<S#> <status>] [--overall X] [--gate X] [--blocked X] [--owner X] [--reviewer X]");
}

const id = argv[0];
const rest = argv.slice(1);
const file = join(STATUS_DIR, `${id}.json`);
if (!existsSync(file)) die(`no status file for "${id}" at ${file}`);

let raw;
try {
  raw = JSON.parse(readFileSync(file, "utf-8"));
} catch (e) {
  die(`could not parse ${file}: ${e.message}`);
}

let i = 0;
let touched = false;

while (i < rest.length) {
  const tok = rest[i];

  if (tok.startsWith("--")) {
    const flag = tok.slice(2);
    const value = rest[i + 1];
    if (value === undefined) die(`flag --${flag} needs a value`);
    const val = value === "null" ? null : value;
    if (flag === "overall") raw.overall = val;
    else if (flag === "gate") raw.currentGate = val;
    else if (flag === "blocked") raw.blockedBy = val;
    else if (flag === "owner") raw.owner = val;
    else if (flag === "reviewer") raw.reviewer = val;
    else die(`unknown flag --${flag}`);
    touched = true;
    i += 2;
    continue;
  }

  if (S_KEY_RE.test(tok)) {
    const status = rest[i + 1];
    if (!status) die(`${tok} needs a status value`);
    if (!SUBTASK_STATUSES.has(status)) {
      die(`invalid status "${status}" for ${tok}; expected one of ${[...SUBTASK_STATUSES].join("|")}`);
    }
    if (!raw.subtasks) raw.subtasks = {};
    if (raw.subtasks[tok] === "N/A" && status !== "N/A") {
      console.error(`update_status.mjs: warning — ${tok} was N/A for ${id}; setting to ${status} anyway`);
    }
    raw.subtasks[tok] = status;
    touched = true;
    i += 2;
    continue;
  }

  die(`unrecognized argument "${tok}"`);
}

if (!touched) die("nothing to update — pass an S# + status and/or a --flag");

raw.updatedAt = new Date().toISOString();

// atomic write: temp file + rename (same directory => same filesystem, rename is atomic)
const tmp = file + `.${process.pid}.${Date.now()}.tmp`;
writeFileSync(tmp, JSON.stringify(raw, null, 2) + "\n", "utf-8");
renameSync(tmp, file);

console.log(`updated ${file}`);
