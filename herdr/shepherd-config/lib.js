// Pure helpers of the shepherd-config panel (no herdr imports, so tests can load them).

export const THINKING_LEVELS = ["default", "off", "minimal", "low", "medium", "high", "xhigh"];

// Cheap guard against sending a secret: the CLI refuses them too, but nothing secret should reach even an argv.
export function looksSecret(text) {
  const v = String(text).trim();
  if (/-----BEGIN [A-Z ]*PRIVATE KEY/.test(v)) return true;
  if (/\b(sk|pk|rk|xai|ghp|gho|ghs|github_pat|xox[abp]|AKIA|AIza|hf|glpat|xapp|pypi)[-_][A-Za-z0-9_-]{12,}/.test(v)) return true;
  if (/^(bearer|basic)\s+\S{8,}/i.test(v)) return true;
  if (/^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./.test(v)) return true;
  return false;
}

/** Splits a Pi `provider/id[:thinking]` string into `{ base, thinking }`. */
export function splitThinking(value) {
  const text = String(value ?? "").trim();
  const match = /:((?:off|minimal|low|medium|high|xhigh))$/.exec(text);
  if (!match) return { base: text, thinking: "default" };
  return { base: text.slice(0, match.index), thinking: match[1] };
}

/** Recombines a Pi model id with an optional thinking level (`"default"` omits the suffix). */
export function withThinking(value, thinking) {
  const { base } = splitThinking(value);
  if (!base) return "";
  return !thinking || thinking === "default" ? base : `${base}:${thinking}`;
}

// The models.* value for a kind and what was entered: { value } or { error }. The CLI validates again with the real parser.
export function modelValue(kind, parts) {
  const clean = (s) => String(s ?? "").trim();
  let value;
  if (kind === "local") {
    const id = clean(parts.localId);
    if (!id) return { error: "Pick a local model." };
    value = "local/" + id;
  } else if (kind === "agent") {
    const name = clean(parts.agent);
    if (!name) return { error: "Pick an agent." };
    const model = clean(parts.agentModel);
    if (/\s/.test(model)) return { error: "An agent model has no spaces." };
    value = "agent:" + name + (model ? "/" + model : "");
  } else {
    value = clean(parts.piText);
    if (!value) return { error: "Enter provider/id, for example anthropic/claude-sonnet-5-5." };
    if (/\s/.test(value) || value.indexOf("/") < 1 || value.endsWith("/")) return { error: "Use provider/id, for example anthropic/claude-sonnet-5-5." };
  }
  if (looksSecret(value)) return { error: "That looks like a secret. shepherd config never holds secrets; nothing was sent." };
  return { value };
}

// The parts a click on agent `name` saves for a models row: another agent drops the model text (a model id belongs to one
// agent's CLI), the agent already chosen keeps it.
export function agentPick(row, name) {
  return row.kind === "agent" && row.agent === name ? { agent: name } : { agent: name, agentModel: "" };
}

// "$4.05", "$0.0042" for small amounts, "$0" for none.
export function fmtUsd(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  if (n === 0) return "$0";
  if (Math.abs(n) < 0.01) return "$" + n.toFixed(4);
  if (Math.abs(n) >= 100) return "$" + Math.round(n);
  return "$" + n.toFixed(2);
}

// How much of a limit is spent, 0 to 1.
export function ratio(spend, limit) {
  if (!(limit > 0) || !(spend > 0)) return 0;
  return Math.min(1, spend / limit);
}

// 131072 -> "128k"; small numbers as they are.
export function ctxText(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "?";
  return n >= 1024 ? Math.round(n / 1024) + "k" : String(n);
}

export function formatCtxPill(ctx) {
  if (!ctx || typeof ctx.contextTokens !== "number" || ctx.contextTokens <= 0) return null;
  const k = ctx.contextTokens >= 1000 ? Math.round(ctx.contextTokens / 1000) + "k" : String(ctx.contextTokens);
  return `ctx ${k} ${ctx.warm ? "warm" : "cold"}`;
}

export function ticketsText(plan) {
  const failed = plan.ticketsFailed > 0 ? ", " + plan.ticketsFailed + " failed" : "";
  return plan.ticketsDone + "/" + plan.ticketsTotal + " tickets" + failed;
}

/** Filters Herdr `terminals()` to live shepherd sub-agents (carrying any `shepherd.*` label). */
export function filterShepherdTerminals(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((term) => {
    const labels = term?.labels;
    if (!labels || typeof labels !== "object") return false;
    return Object.keys(labels).some((key) => key.startsWith("shepherd."));
  });
}

// What an exec of the CLI gives back as one document: the JSON it printed, or an { ok: false, error }.
export function parseResult(r) {
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { json = null; }
  if (json && typeof json === "object") return json;
  return { ok: false, error: "shepherd-config printed no JSON (exit " + r.code + "): " + String(r.stderr || r.stdout || "").trim().slice(0, 300) };
}

// The CLI argv (after its own command prefix) for a user-file write; `sha` is the file's sha256 from the last show.
export function setArgv(root, key, value, sha) {
  return ["set", "--cwd", root, "--key", key, "--value", String(value), ...(sha ? ["--expect", sha] : [])];
}

// The text of an input for a number: no trailing zeros.
export function numberText(n) {
  return typeof n === "number" && Number.isFinite(n) ? String(Math.round(n * 1e6) / 1e6) : "";
}

// A positive number from input text, or null.
export function positive(text) {
  const t = String(text).trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// The machine an address belongs to: the text before the first "/" ("omarchy/t7" -> "omarchy"), null for a local address.
export function machineOfAddress(addr) {
  const text = String(addr ?? "");
  const slash = text.indexOf("/");
  if (slash < 1) return null;
  return text.slice(0, slash);
}

// Resolves where the panel should work: the focused space's machine and the folder to use on it. A remote target
// never falls back to a local path (no forced folder, no home): the machine it resolves to owns the folder.
export function resolveTarget({ focused, spaces, forcedFolder, previous, localHome }) {
  const list = Array.isArray(spaces) ? spaces : [];
  const space = focused?.space ? list.find((s) => s.id === focused.space) : null;
  const machine = (space && space.machine) ?? machineOfAddress(focused?.terminal) ?? null;
  if (machine === null) {
    const folder = forcedFolder ?? focused?.cwd ?? (space && space.folder) ?? (previous?.machine === null ? previous?.folder : null) ?? localHome ?? null;
    return { machine: null, folder };
  }
  const folder = focused?.cwd ?? (space && space.folder) ?? (previous?.machine === machine ? previous?.folder : null) ?? null;
  return { machine, folder };
}

// Per-machine, per-repo state key: the same path on two machines is two targets.
export function targetKey(machine, root) {
  return `${machine ?? ""}:${root}`;
}

// The message shown when the panel CLI is not installed on a remote machine.
export function remoteCliMissing(machine) {
  return `shepherd's panel CLI is not installed on ${machine}: run \`shepherd herdr-install --remote\` there (inside Claude Code: \`! shepherd herdr-install --remote\`).`;
}

// Parses a remote panel-cli.json: a JSON object whose cli is a non-empty array of absolute-path strings.
// Returns { cli, plugin? } or { error }.
export function parseCliDescriptor(raw) {
  let json = null;
  try { json = JSON.parse(raw); } catch { return { error: "panel-cli.json is not valid JSON." }; }
  if (!json || typeof json !== "object" || Array.isArray(json)) return { error: "panel-cli.json must be an object." };
  const cli = json.cli;
  if (!Array.isArray(cli) || cli.length === 0) return { error: "panel-cli.json needs a non-empty cli array." };
  for (const part of cli) {
    if (typeof part !== "string" || !part.startsWith("/")) return { error: "panel-cli.json cli entries must be strings starting with /." };
  }
  const out = { cli };
  if (typeof json.plugin === "string" && json.plugin) out.plugin = json.plugin;
  return out;
}

// A terminal belongs to a machine+root when it is on the same machine and its cwd is the root or under it.
export function termInTarget(term, machine, root) {
  if (!term || machineOfAddress(term.address) !== machine) return false;
  const cwd = term.cwd;
  if (!root) return true;
  if (!cwd) return false;
  return cwd === root || cwd.startsWith(root + "/");
}

// The space at machine+folder (null machine is this computer).
export function findSpace(spaces, machine, folder) {
  if (!Array.isArray(spaces)) return null;
  return spaces.find((s) => (s?.machine ?? null) === machine && s?.folder === folder) ?? null;
}
