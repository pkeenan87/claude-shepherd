// shepherd-config: Mission-Control Herdr side panel for shepherd.
// Features: gpui-base Select + Popup dropdowns with knownAgents() icons & installed badges,
// unified 2026 live+curated model discovery, live sub-agent activity strip (Peek/Keep + alerts),
// phase-aware Quick Actions cockpit bar, expandable interactive ticket progress board,
// multi-model reviewers editor, idle-cache action control, and cross-repo spend telemetry.
// Everything is read and written through the shepherd-config CLI named in install.json.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, NumberInput, Select, Popup, Scrollbar, ScrollHandle } from "gpui-base";
import {
  checking,
  exec,
  props,
  focused,
  spaces,
  machines,
  terminals,
  knownAgents,
  theme,
  appHome,
  home,
  readTextFile,
  watchFolder,
  run,
  openOverlay,
  notify,
  playSound,
} from "herdr";
import {
  THINKING_LEVELS,
  agentPick,
  ctxText,
  filterShepherdTerminals,
  fmtUsd,
  formatCtxPill,
  modelValue,
  numberText,
  parseCliDescriptor,
  parseResult,
  positive,
  ratio,
  remoteCliMissing,
  resolveTarget,
  setArgv,
  splitThinking,
  targetKey,
  ticketsText,
  withThinking,
} from "./lib.js";

const REFRESH_MS = 8000;
const AGENT_POLL_MS = 2000;
const MODEL_KEYS = ["low", "medium", "high", "review"];
const KINDS = [["agent", "Agent"], ["local", "Local (Pi)"], ["pi", "Pi"]];
const IDLE_ACTIONS = [
  { value: "warn", label: "warn (non-blocking)" },
  { value: "block", label: "block (once per idle)" },
  { value: "off", label: "off (silent)" },
];
const REVIEWER_PRESETS = [
  { label: "Astra + Argon", models: ["agent:codex/gpt-6-astra", "agent:agy/gemini-4-argon-high"] },
  { label: "Astra + Neon", models: ["agent:codex/gpt-6-astra", "agent:agy/gemini-4-neon-high"] },
  { label: "Fable + Astra", models: ["agent:claude/fable", "agent:codex/gpt-6-astra"] },
];
const SECTIONS = [
  ["models", "Models"],
  ["local", "Local model"],
  ["plans", "Plans"],
  ["costs", "Costs"],
];

export default class ShepherdConfig extends View {
  init(_props, cx) {
    this.machine = null;
    this.root = null;
    this.target = null;             // last loaded { machine, folder }
    this.start = null;              // current { machine, folder } from location()
    this.data = null;
    this.failure = null;
    this.loading = false;
    this.pending = false;
    this.clis = new Map();          // machine key ("" for local) -> { cli, resolvedNode, plugin }
    this.localPlugin = null;
    this.watches = new Map();       // dir -> FolderWatch handle
    this.wanted = new Set();
    this.notes = {};                // note key -> { kind: "ok" | "warn" | "err", text, needsForce? }
    this.busy = new Set();
    this.busyCounts = new Map();    // note key -> active count (supports duplicate queued writes)
    this.pendingWrites = 0;         // only active mutations block refresh(), never catalog/detect probes
    this.draft = {};                // model key -> { kind }
    this.detected = null;
    this.detectedFor = null;
    this.detectTargetKey = null;
    this.catalog = null;            // { agents: { name: { source, smart, models } }, piModels }
    this.catalogMachine = undefined;
    this.agentMeta = new Map();     // agent name -> Program & { installed }
    this.agentMetaMachine = undefined;
    this.scope = "today";
    this.seq = 0;
    this.panelWidth = 360;
    this.ticketsOpen = false;
    this.openSelect = null;         // currently open Select id
    this.highlightIdx = 0;
    this.outClosedId = null;        // flag set by on_mouse_down_out, consumed cleanly by trigger mousedown/click
    this.suppressTriggerClick = null;
    this.prevTermStatus = new Map();// address -> status (for blocked/done alerts)
    this.writeQueue = Promise.resolve();
    try {
      this.collapsed = JSON.parse(localStorage.getItem("collapsed") ?? "{}");
    } catch {
      this.collapsed = {};
    }

    // Allocate all InputStates and Select FocusHandle/ScrollHandle triples once in init(), never in render().
    this.inputs = {};
    this.focusHandles = {};
    const allocSelect = (id) => {
      this.focusHandles[id] = { trigger: cx.focus_handle(), list: cx.focus_handle(), scroll: ScrollHandle.new() };
    };
    for (const k of MODEL_KEYS) {
      this.field(`pi:${k}`, "provider/id");
      this.field(`am:${k}`, "model (blank = agent default)");
      allocSelect(`agent:${k}`);
      allocSelect(`am:${k}`);
      allocSelect(`pi:${k}`);
      allocSelect(`think:${k}`);
      allocSelect(`local:${k}`);
    }
    allocSelect("idleAction");
    allocSelect("addReviewer");
    this.field("base", "http://127.0.0.1:8080/v1");
    this.field("ctx", "context window", true);
    this.field("taskUsd", "20", true);
    this.field("dailyUsd", "75", true);

    if (checking()) return;
    this.refresh(cx);
    this.loadKnownAgents(cx, null);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
    cx.timer.every(AGENT_POLL_MS, (cx) => this.checkSubAgentAlerts(cx));
  }

  async close(_cx) {
    this.wanted.clear();
    for (const handle of this.watches.values()) {
      try {
        handle?.cancel?.();
      } catch { /* ignore */ }
    }
    this.watches.clear();
  }

  field(name, placeholder, numeric) {
    const state = InputState.new({ placeholder });
    if (numeric) {
      state.set_step(1);
      state.set_min(1);
    }
    const slot = (this.inputs[name] = { state, synced: "", focused: false });
    state.on("focus", () => { slot.focused = true; });
    state.on("blur", (_e, cx) => { slot.focused = false; this.commit(name, cx); });
    state.on("submit", (_e, cx) => this.commit(name, cx));
  }

  text(name) {
    return this.inputs[name].state.value();
  }

  follow(name, text) {
    const slot = this.inputs[name];
    if (!slot || slot.focused || slot.synced === text) return;
    slot.state.set_value(text);
    slot.synced = text;
  }

  syncInputs() {
    const d = this.data;
    if (!d) return;
    for (const k of MODEL_KEYS) {
      const row = d.models[k];
      this.follow(`pi:${k}`, row.kind === "pi" ? row.value : "");
      this.follow(`am:${k}`, row.kind === "agent" ? (row.agentModel ?? "") : "");
    }
    if (d.local.configured) this.follow("base", d.local.baseUrl);
    this.follow("taskUsd", numberText(d.budgets.taskUsd));
    this.follow("dailyUsd", numberText(d.budgets.dailyUsd));
  }

  // ---- loading & discovery

  location() {
    return resolveTarget({
      focused: focused(),
      spaces: spaces(),
      forcedFolder: props()?.folder || null,
      previous: this.target,
      localHome: home(),
    });
  }

  refresh(cx) {
    this.start = this.location();
    if (this.loading) {
      this.pending = true;
      return;
    }
    this.loading = true;
    cx.spawn(async (cx) => {
      do {
        this.pending = false;
        try {
          await this.load(cx);
          this.watch(cx);
        } catch (e) {
          this.failure = String(e?.message ?? e);
        }
        if (!this.pending) this.loading = false;
        cx.notify();
      } while (this.pending);
    });
  }

  resetTargetState(machineChanged) {
    this.notes = {};
    this.draft = {};
    this.detected = null;
    this.detectedFor = null;
    this.detectTargetKey = null;
    this.busy.delete("detect");
    if (machineChanged) {
      this.catalog = null;
      this.catalogMachine = undefined;
      this.busy.delete("catalog");
      this.agentMeta = new Map();
      this.agentMetaMachine = undefined;
    }
  }

  async readLocalPlugin() {
    try {
      const raw = await readTextFile(`${appHome()}/mods/shepherd-config/install.json`);
      if (!raw) return;
      const json = JSON.parse(raw);
      if (json && typeof json.plugin === "string" && json.plugin) this.localPlugin = json.plugin;
    } catch { /* ignore */ }
  }

  async cliFor(machine) {
    const key = machine ?? "";
    if (machine === null) {
      const raw = await readTextFile(`${appHome()}/mods/shepherd-config/install.json`);
      if (!raw) {
        this.clis.delete(key);
        return { error: "install.json is missing: run `shepherd herdr-install`." };
      }
      let json;
      try {
        json = JSON.parse(raw);
      } catch {
        this.clis.delete(key);
        return { error: "install.json is not valid JSON: run `shepherd herdr-install` again." };
      }
      const cli = json?.cli;
      if (!Array.isArray(cli) || cli.length === 0 || !cli.every((p) => typeof p === "string" && p.length > 0)) {
        this.clis.delete(key);
        return { error: "install.json has no `cli` argv array: run `shepherd herdr-install` again." };
      }
      const plugin = typeof json.plugin === "string" && json.plugin ? json.plugin : null;
      const prev = this.clis.get(key);
      const resolvedNode = prev && prev.cli?.[0] === cli[0] ? prev.resolvedNode : null;
      const entry = { cli, resolvedNode, plugin };
      this.clis.set(key, entry);
      this.localPlugin = entry.plugin;
      return { entry };
    }
    let res;
    try {
      res = await exec("/bin/sh", ["-c", 'cat "${SHEPHERD_HOME:-$HOME/.claude/shepherd}/panel-cli.json"'], {
        on: machine,
        timeout: 10000,
      });
    } catch (e) {
      this.clis.delete(key);
      let state = "";
      try {
        const m = machines().find((x) => x.name === machine);
        if (m?.layout) state = ` (${m.layout})`;
      } catch { /* ignore */ }
      const detail = String(e?.message ?? e).trim();
      return { error: `${machine} is unreachable${state}${detail ? `: ${detail}` : "."}` };
    }
    if (res.code !== 0 || !res.stdout || !res.stdout.trim()) {
      this.clis.delete(key);
      return { error: remoteCliMissing(machine) };
    }
    const parsed = parseCliDescriptor(res.stdout);
    if (parsed.error) {
      this.clis.delete(key);
      return { error: `${machine}: ${parsed.error}` };
    }
    const prev = this.clis.get(key);
    const resolvedNode = prev && prev.cli?.[0] === parsed.cli[0] ? prev.resolvedNode : null;
    const entry = { cli: parsed.cli, resolvedNode, plugin: parsed.plugin ?? null };
    this.clis.set(key, entry);
    return { entry };
  }

  async load(cx) {
    const start = this.start;
    const machine = start?.machine ?? null;
    const folder = start?.folder ?? null;
    const startKey = targetKey(machine, folder ?? "");
    const startChanged = () => !this.start || targetKey(this.start.machine ?? null, this.start.folder ?? "") !== startKey;

    if (!folder) {
      if (machine !== this.machine) {
        this.machine = machine;
        this.root = null;
        this.data = null;
        this.target = start;
        this.resetTargetState(true);
      }
      this.failure =
        machine !== null
          ? `Open a terminal in a folder on ${machine}.`
          : "No project folder: open the panel from a space with a folder.";
      return;
    }

    const cliRes = await this.cliFor(machine);
    if (startChanged()) return;
    if (cliRes.error) {
      if (machine !== this.machine) {
        this.machine = machine;
        this.root = null;
        this.data = null;
        this.target = start;
        this.resetTargetState(true);
      }
      this.failure = cliRes.error;
      return;
    }
    const entry = cliRes.entry;
    if (machine !== null && this.localPlugin === null) {
      await this.readLocalPlugin();
      if (startChanged()) return;
    }

    let root = folder;
    try {
      const gitOpts = machine !== null ? { cwd: folder, on: machine } : { cwd: folder };
      const g = await exec("git", ["rev-parse", "--show-toplevel"], gitOpts);
      if (g.code === 0 && g.stdout.trim()) root = g.stdout.trim();
    } catch { /* not a git repo: use the folder itself */ }
    if (startChanged()) return;

    const mine = this.seq;
    const target = { machine, entry };
    const json = await this.call(["show", "--cwd", root], target);
    // Gate on seq, pending writes, and start target so space/project switches never overwrite with stale data.
    if (mine !== this.seq || this.pendingWrites > 0 || startChanged()) return;
    if (json.ok === false) {
      if (machine !== this.machine) {
        this.machine = machine;
        this.root = null;
        this.data = null;
        this.target = start;
        this.resetTargetState(true);
      }
      this.failure = json.error ?? "shepherd-config failed";
      return;
    }

    this.failure = null;
    const prevKey = this.root !== null ? targetKey(this.machine, this.root) : null;
    const nextKey = targetKey(machine, root);
    const machineChanged = machine !== this.machine;
    if (nextKey !== prevKey) {
      this.machine = machine;
      this.root = root;
      this.target = { machine, folder: root };
      this.resetTargetState(machineChanged);
    }
    this.data = json;
    for (const key of Object.keys(this.notes)) {
      if (this.notes[key].kind === "ok") delete this.notes[key];
    }
    if (machine !== null && entry.plugin && this.localPlugin && entry.plugin !== this.localPlugin) {
      this.notes.versionSkew = {
        kind: "warn",
        text: `Plugin version mismatch: ${machine} has ${entry.plugin}, local has ${this.localPlugin}. Run \`shepherd herdr-install --remote\` on ${machine}.`,
      };
    } else {
      delete this.notes.versionSkew;
    }
    this.syncInputs();
    if (json.local.configured && this.detectedFor !== nextKey) {
      this.detectedFor = nextKey;
      this.detect(cx, true);
    }
    if (this.catalog === null || this.catalogMachine !== machine) {
      this.loadCatalog(cx, false);
    }
    if (this.agentMetaMachine !== machine) {
      this.loadKnownAgents(cx, machine);
    }
  }

  loadCatalog(cx, forceRefresh) {
    const machine = this.machine;
    const root = this.root;
    const entry = this.clis.get(machine ?? "");
    if (!entry) return;
    if (this.busy.has("catalog") && this.catalogMachine === machine) return;
    this.catalogMachine = machine;
    this.busy.add("catalog");
    if (this.catalog === null) this.catalog = { agents: {}, piModels: [] };
    cx.notify();
    cx.spawn(async (cx) => {
      const args = ["agent-models", ...(root ? ["--cwd", root] : []), ...(forceRefresh ? ["--refresh"] : [])];
      const json = await this.call(args, { machine, entry });
      if (machine !== this.machine) return;
      this.busy.delete("catalog");
      if (json.ok !== false && json.agents) {
        this.catalog = json;
        delete this.notes.catalog;
      } else {
        this.notes.catalog = { kind: "warn", text: json.error ?? "Model discovery failed; using curated list." };
      }
      cx.notify();
    });
  }

  loadKnownAgents(cx, machine = this.machine) {
    this.agentMetaMachine = machine;
    cx.spawn(async (cx) => {
      try {
        const list = await knownAgents({ on: machine });
        if (machine !== this.machine) return;
        if (!Array.isArray(list)) return;
        const map = new Map();
        for (const item of list) {
          const bin = Array.isArray(item.run) && item.run[0] ? String(item.run[0]).split("/").pop() : item.key;
          if (item.key) map.set(item.key, item);
          if (bin) map.set(bin, item);
        }
        this.agentMeta = map;
        cx.notify();
      } catch { /* knownAgents unavailable */ }
    });
  }

  checkSubAgentAlerts(cx) {
    let list;
    try {
      list = filterShepherdTerminals(terminals());
    } catch {
      return;
    }
    const seen = new Set();
    let changed = false;
    for (const term of list) {
      const addr = term.address;
      if (!addr) continue;
      seen.add(addr);
      const prev = this.prevTermStatus.get(addr);
      const next = term.status ?? "idle";
      if (prev !== next) {
        changed = true;
        this.prevTermStatus.set(addr, next);
        if (next === "blocked") {
          try {
            playSound("blocked");
            notify({
              title: "Shepherd sub-agent needs input",
              body: term.name || addr,
              level: "warning",
              action: { name: "terminal.peek", args: { terminal: addr } },
            });
          } catch { /* ignore notification errors */ }
        } else if (prev === "working" && next === "done") {
          try {
            playSound("done");
          } catch { /* ignore */ }
        }
      }
    }
    for (const addr of [...this.prevTermStatus.keys()]) {
      if (!seen.has(addr)) {
        this.prevTermStatus.delete(addr);
        changed = true;
      }
    }
    if (changed) cx.notify();
  }

  async resolveNode(machine, entry) {
    if (entry?.resolvedNode) return entry.resolvedNode;
    const opts = machine !== null ? { on: machine, timeout: 5000 } : { timeout: 5000 };
    for (const [shell, shellArgs] of [
      ["/bin/zsh", ["-lc", "command -v node"]],
      ["/bin/bash", ["-lc", "command -v node"]],
      ["/bin/sh", ["-lc", "command -v node"]],
    ]) {
      try {
        const res = await exec(shell, shellArgs, opts);
        const found = res.code === 0 ? res.stdout.trim().split(/\r?\n/).pop()?.trim() : "";
        if (found && found.startsWith("/")) {
          if (entry) entry.resolvedNode = found;
          return found;
        }
      } catch { /* try next shell */ }
    }
    return null;
  }

  async call(args, target) {
    const machine = target?.machine ?? null;
    const entry = target?.entry;
    if (!entry || !Array.isArray(entry.cli) || entry.cli.length === 0) {
      return {
        ok: false,
        error: machine !== null ? remoteCliMissing(machine) : "install.json is missing: run `shepherd herdr-install`.",
      };
    }
    const cmd = entry.resolvedNode || entry.cli[0];
    const argv = [...entry.cli.slice(1), ...args];
    const execOpts = machine !== null ? { on: machine, timeout: 60000 } : { timeout: 60000 };
    try {
      return parseResult(await exec(cmd, argv, execOpts));
    } catch (e) {
      const msg = String(e?.message ?? e);
      // If the saved node path disappeared (e.g. nvm version removed) or plain "node" isn't in launchd PATH,
      // resolve node once through a login shell on the same machine and retry.
      const base = String(cmd).split("/").pop();
      if (base === "node" && !entry.resolvedNode) {
        const fallback = await this.resolveNode(machine, entry);
        if (fallback && fallback !== cmd) {
          try {
            return parseResult(await exec(fallback, argv, execOpts));
          } catch (e2) {
            return { ok: false, error: String(e2?.message ?? e2) };
          }
        }
      }
      return { ok: false, error: msg };
    }
  }

  // Watch ~/.claude/shepherd.yaml and .shepherd subdirs directly (Linux skips git-ignored roots).
  // Remote targets rely on the 8 s REFRESH_MS timer and cancel any local watches.
  watch(cx) {
    if (this.machine !== null) {
      this.wanted.clear();
      for (const handle of this.watches.values()) {
        try { handle?.cancel?.(); } catch { /* ignore */ }
      }
      this.watches.clear();
      return;
    }
    const f = this.data?.files;
    if (!f) return;
    const userDir = f.user.path.slice(0, f.user.path.lastIndexOf("/"));
    const dirs = new Map([
      [userDir, f.user.path],
      [f.workspace, null],
      [`${f.workspace}/tasks`, null],
      [`${f.workspace}/cost`, null],
    ]);
    const nextWanted = new Set(dirs.keys());
    for (const [dir, handle] of this.watches) {
      if (!nextWanted.has(dir)) {
        try { handle?.cancel?.(); } catch { /* ignore */ }
        this.watches.delete(dir);
      }
    }
    this.wanted = nextWanted;
    for (const [dir, only] of dirs) {
      if (this.watches.has(dir)) continue;
      this.watches.set(dir, null);
      cx.spawn(async (cx) => {
        let handle = null;
        try {
          while (this.wanted.has(dir)) {
            handle = watchFolder(dir);
            this.watches.set(dir, handle);
            const changed = await handle;
            if (!this.wanted.has(dir)) break;
            if (!Array.isArray(changed) || changed.length === 0) break;
            const abs = (p) => (p.startsWith("/") ? p : `${dir}/${p}`);
            if (only === null || changed.some((p) => p === dir || abs(p) === only)) this.refresh(cx);
          }
        } catch { /* timer covers unwatched folders */ }
        if (this.watches.get(dir) === handle) this.watches.delete(dir);
      });
    }
  }

  // ---- serialized writes (prevents stale --expect sha256 races on rapid clicks)

  mutate(noteKey, argsOrFactory, cx, done) {
    const machine = this.machine;
    const clickedRoot = this.root;
    const entry = this.clis.get(machine ?? "");
    if (!clickedRoot || !entry) return;
    const clickedKey = targetKey(machine, clickedRoot);
    const clickedTarget = { machine, entry };
    const clickedSha = this.sha();
    this.pendingWrites += 1;
    this.busyCounts.set(noteKey, (this.busyCounts.get(noteKey) ?? 0) + 1);
    this.busy.add(noteKey);
    delete this.notes[noteKey];
    cx.notify();
    const finishBusy = () => {
      this.pendingWrites = Math.max(0, this.pendingWrites - 1);
      const next = (this.busyCounts.get(noteKey) ?? 1) - 1;
      if (next <= 0) {
        this.busyCounts.delete(noteKey);
        this.busy.delete(noteKey);
      } else {
        this.busyCounts.set(noteKey, next);
      }
    };
    const runOne = async (cx) => {
      const sameTarget = () => this.root !== null && targetKey(this.machine, this.root) === clickedKey;
      try {
        const sha = sameTarget() ? this.sha() : clickedSha;
        const args = typeof argsOrFactory === "function" ? argsOrFactory(clickedRoot, sha) : argsOrFactory;
        const json = await this.call(args, clickedTarget);
        this.seq++;
        if (!sameTarget()) return;
        if (json.ok === false) {
          this.notes[noteKey] = {
            kind: "err",
            text: json.error ?? "shepherd-config refused the change",
            needsForce: json.needsForce === true,
          };
          if (noteKey === "budgets") {
            if (this.inputs.taskUsd) this.inputs.taskUsd.synced = "";
            if (this.inputs.dailyUsd) this.inputs.dailyUsd.synced = "";
            this.syncInputs();
          }
          if (/changed since it was read/.test(json.error ?? "")) this.refresh(cx);
        } else {
          if (Array.isArray(json.plans)) {
            this.data = json;
            this.syncInputs();
          }
          this.notes[noteKey] = { kind: json.note ? "warn" : "ok", text: json.note ?? "Saved." };
          if (done) done(json, cx);
        }
      } catch (e) {
        if (sameTarget()) {
          this.notes[noteKey] = { kind: "err", text: String(e?.message ?? e) };
        }
      } finally {
        finishBusy();
        cx.notify();
      }
    };
    // Only the spawned task's own cx stays valid across awaits (the event's cx does not), so done() gets that one.
    const previous = this.writeQueue;
    let release;
    this.writeQueue = new Promise((resolve) => { release = resolve; });
    cx.spawn(async (cx) => {
      try {
        await previous;
        await runOne(cx);
      } finally {
        release();
      }
    });
  }

  note(key, kind, text, cx) {
    this.notes[key] = { kind, text };
    cx.notify();
  }

  sha() {
    return this.data?.files?.user?.sha256;
  }

  commit(name, cx) {
    const d = this.data;
    if (!d) return;
    const [kind, key] = name.split(":");
    if (kind === "pi") this.saveModel(key, "pi", {}, cx);
    else if (kind === "am") {
      const row = d.models[key];
      if (row.kind === "agent" && this.text(name) !== (row.agentModel ?? "")) {
        this.saveModel(key, "agent", { agent: row.agent }, cx);
      }
    } else if (name === "base") this.saveBase(cx);
    else if (name === "taskUsd" || name === "dailyUsd") this.saveBudget(name, cx);
  }

  saveModel(key, kind, pick, cx) {
    const row = this.data.models[key];
    const parts = { piText: this.text(`pi:${key}`), agentModel: this.text(`am:${key}`), ...pick };
    const r = modelValue(kind, parts);
    if (r.error) {
      if (kind === "pi" && parts.piText.trim() === "" && row.kind !== "pi") return;
      this.note(`m:${key}`, "err", r.error, cx);
      return;
    }
    if (r.value === row.value) {
      delete this.notes[`m:${key}`];
      cx.notify();
      return;
    }
    this.mutate(`m:${key}`, (root, sha) => setArgv(root, `models.${key}`, r.value, sha), cx, () => {
      delete this.draft[key];
    });
  }

  saveReviewers(nextList, cx) {
    const payload = nextList.length > 0 ? JSON.stringify(nextList) : "";
    this.mutate("reviewers", (root, sha) => setArgv(root, "review.reviewers", payload, sha), cx);
  }

  saveIdleAction(action, cx) {
    if (action === this.data?.budgets?.idleAction) return;
    this.mutate("budgets", (root, sha) => setArgv(root, "budgets.idleAction", action, sha), cx);
  }

  toggleAgentBilling(agent, cx) {
    const current = this.data?.agentsBilling?.[agent] ?? "api";
    const next = current === "subscription" ? "api" : "subscription";
    this.mutate(`billing:${agent}`, (root, sha) => setArgv(root, `agents.${agent}.billing`, next, sha), cx);
  }

  saveBudget(name, cx) {
    const n = positive(this.text(name));
    const saved = this.data.budgets[name];
    if (n === null) {
      this.note("budgets", "err", "Enter a dollar amount greater than 0.", cx);
      this.inputs[name].synced = "";
      this.follow(name, numberText(saved));
      return;
    }
    if (n === saved) return;
    this.mutate("budgets", (root, sha) => setArgv(root, `budgets.${name}`, String(n), sha), cx);
  }

  saveBase(cx) {
    const d = this.data;
    const url = this.text("base").trim();
    if (!d.local.configured || url === d.local.baseUrl) return;
    if (url === "") {
      this.follow("base", d.local.baseUrl);
      return;
    }
    this.mutate("local", (root, sha) => setArgv(root, "local.baseUrl", url, sha), cx, (_j, cx) => this.detect(cx, true));
  }

  preset(url, cx) {
    this.inputs.base.state.set_value(url);
    if (this.data.local.configured) this.saveBase(cx);
    else cx.notify();
  }

  detect(cx, quiet) {
    const url = this.text("base").trim() || this.data?.local?.baseUrl || "";
    if (!url) {
      if (!quiet) this.note("local", "err", "Enter the server URL or pick a preset first.", cx);
      return;
    }
    const machine = this.machine;
    const root = this.root;
    const entry = this.clis.get(machine ?? "");
    if (!root || !entry) return;
    const key = targetKey(machine, root);
    if (this.busy.has("detect") && this.detectTargetKey === key) return;
    this.detectTargetKey = key;
    this.busy.add("detect");
    cx.notify();
    cx.spawn(async (cx) => {
      const json = await this.call(["local-detect", "--base-url", url, "--cwd", root], { machine, entry });
      if (this.root === null || targetKey(this.machine, this.root) !== key) return;
      this.busy.delete("detect");
      this.detected = json;
      if (json.ok !== false && json.reachable && json.baseUrl !== url && !this.inputs.base.focused) {
        this.inputs.base.state.set_value(json.baseUrl);
      }
      cx.notify();
    });
  }

  addLocal(m, cx) {
    const ctx = m.contextWindow ?? positive(this.text("ctx"));
    if (!ctx) {
      this.note("local", "err", "The server did not report a context window: enter one below.", cx);
      return;
    }
    const url = this.detected?.baseUrl || this.text("base").trim();
    this.mutate(
      "local",
      (root, sha) => [
        "local-add",
        "--cwd",
        root,
        "--id",
        m.id,
        "--context-window",
        String(Math.round(ctx)),
        ...(url ? ["--base-url", url] : []),
        ...(sha ? ["--expect", sha] : []),
      ],
      cx,
      (_j, cx) => this.detect(cx, true),
    );
  }

  removeLocal(id, cx) {
    this.mutate(
      "local",
      (root, sha) => ["local-remove", "--cwd", root, "--id", id, ...(sha ? ["--expect", sha] : [])],
      cx,
      (_j, cx) => this.detect(cx, true),
    );
  }

  activate(id, cx) {
    this.mutate(`p:${id}`, (root) => ["plan-activate", "--cwd", root, "--id", id], cx);
  }

  closePlan(id, force, cx) {
    this.mutate(`p:${id}`, (root) => ["plan-close", "--cwd", root, "--id", id, ...(force ? ["--force"] : [])], cx);
  }

  openDoc(file) {
    if (!file) return;
    openOverlay({
      kind: "window",
      mod: "shepherd-viewer",
      key: "shepherd-viewer",
      props: { file },
      width: 780,
      height: 640,
    });
  }

  sendToSession(commandText, cx) {
    const foc = focused()?.terminal;
    const all = (() => { try { return terminals(); } catch { return []; } })();
    const isShepherdChild = (term) => Object.keys(term?.labels ?? {}).some((k) => k.startsWith("shepherd."));
    const inRepo = (term) => !this.root || (typeof term?.cwd === "string" && (term.cwd === this.root || term.cwd.startsWith(`${this.root}/`)));
    const isClaude = (term) => /claude/i.test(String(term?.program?.name ?? term?.agent ?? ""));
    const focusedTerm = all.find((term) => term.address === foc);
    const targetTerm =
      focusedTerm && isClaude(focusedTerm) && !isShepherdChild(focusedTerm) && inRepo(focusedTerm)
        ? focusedTerm
        : all.find((term) => isClaude(term) && !isShepherdChild(term) && inRepo(term) && (term.status === "idle" || term.status === "done"));
    if (!targetTerm) {
      notify({
        title: "Shepherd",
        body: `No idle Claude Code session found in ${this.root ? this.root.split("/").pop() : "this repo"} for ${commandText}`,
        level: "warning",
      });
      return;
    }
    cx.spawn(async () => {
      try {
        // hc send presses Enter automatically; --if idle refuses to interrupt a working or blocked session.
        const r = await exec("hc", ["send", "--if", "idle", targetTerm.address, "--", commandText], { timeout: 5000 });
        if (r.code !== 0) {
          notify({
            title: "Shepherd action not sent",
            body: (r.stderr || r.stdout || `exit ${r.code}`).trim().slice(0, 200),
            level: "warning",
          });
        }
      } catch (e) {
        notify({ title: "Shepherd action failed", body: String(e?.message ?? e), level: "error" });
      }
    });
  }

  openOrJumpSpace(name, folder) {
    if (!folder) return;
    const match = spaces().find((sp) => sp.folder === folder);
    if (match) run("space.select", { id: match.id });
    else run("space.new", { name, folder });
  }

  toggle(id, cx) {
    this.collapsed[id] = !this.collapsed[id];
    try {
      localStorage.setItem("collapsed", JSON.stringify(this.collapsed));
    } catch { /* not persisted */ }
    cx.notify();
  }

  // ---- reusable UI primitives

  button(id, label, t, { selected, disabled, accent, onClick }) {
    return div()
      .id(id)
      .px(7)
      .py(2)
      .rounded(4)
      .text_size(11)
      .flex_none()
      .bg(accent ? t.accent : selected ? t.selected : t.raised)
      .text_color(disabled ? t.dim : accent ? (t.accent_foreground ?? t.foreground) : selected ? t.foreground : t.muted)
      .when(!disabled, (el) => el.hover((s) => s.bg(accent ? t.accent : t.hover)).on_click(onClick))
      .child(label);
  }

  input(name, t, busy) {
    return Input.new(this.inputs[name].state)
      .disabled(!!busy)
      .h(26)
      .px(7)
      .items_center()
      .rounded(4)
      .border(1)
      .border_color(t.input)
      .bg(t.background)
      .text_color(t.foreground)
      .text_size(12);
  }

  numberInput(name, t, busy, onStep) {
    return div()
      .w(96)
      .child(
        NumberInput.new(this.inputs[name].state)
          .disabled(!!busy)
          .on_step((action, cx) => onStep(action === "increment" ? 1 : -1, cx))
          .controls_right()
          .decrement_button(div().px(5).text_size(12).child("−"))
          .increment_button(div().px(5).text_size(12).child("+")),
      );
  }

  stepBudget(name, dir, cx) {
    const cur = positive(this.text(name)) ?? this.data.budgets[name];
    const next = Math.max(1, Math.round((cur + dir) * 100) / 100);
    this.inputs[name].state.set_value(String(next));
    this.saveBudget(name, cx);
  }

  agentIcon(agentName, t) {
    const meta = this.agentMeta.get(agentName);
    if (!meta?.icon) return null;
    return meta.tint
      ? svg(meta.icon).size(12).text_color(t.muted)
      : image(meta.icon).size(12);
  }

  openDropdown(id, items, currentValue, cx) {
    this.openSelect = id;
    const idx = Math.max(0, items.findIndex((item) => item.value === currentValue));
    this.highlightIdx = idx;
    const handles = this.focusHandles[id];
    if (handles) {
      handles.list.focus();
      if (items.length > 0) handles.scroll.scroll_to_item(idx);
    }
    cx.notify();
  }

  closeDropdown(id, cx, refocusTrigger = false) {
    if (this.openSelect === id) this.openSelect = null;
    if (refocusTrigger) this.focusHandles[id]?.trigger?.focus();
    cx.notify();
  }

  // Native gpui-base Select + Popup dropdown with scrollable list, ScrollHandle keyboard tracking, and click-outside dismissal.
  selectDropdown(id, displayLabel, items, currentValue, t, { disabled, onSelect, width }) {
    const handles = this.focusHandles[id];
    const open = this.openSelect === id && !disabled;
    const trigger = h_flex()
      .id(`sel-trig-${id}`)
      .track_focus(handles.trigger)
      .h(26)
      .px(8)
      .gap(6)
      .items_center()
      .rounded(4)
      .border(1)
      .border_color(open ? t.accent : t.input)
      .bg(t.background)
      .text_size(11)
      .text_color(disabled ? t.dim : t.foreground)
      .when(!disabled, (el) =>
        el
          .hover((s) => s.bg(t.hover))
          .on_mouse_down("left", () => {
            // If on_mouse_down_out just closed this exact dropdown on this press, consume the follow-up click so it stays closed.
            if (this.outClosedId === id) {
              this.suppressTriggerClick = id;
              this.outClosedId = null;
            }
          })
          .on_click((_e, cx) => {
            if (this.suppressTriggerClick === id) {
              this.suppressTriggerClick = null;
              return;
            }
            if (open) this.closeDropdown(id, cx, true);
            else this.openDropdown(id, items, currentValue, cx);
          }),
      )
      .child(div().flex_1().min_w(0).truncate().child(displayLabel))
      .child(div().text_size(9).text_color(t.dim).child(open ? "▴" : "▾"));

    // Exact height: sum per-row heights + 2px gaps between rows + 8px vertical padding + 2px borders, capped at 280px.
    const rowsHeight = items.reduce((sum, item) => sum + (item.sub ? 38 : 26), 0) + Math.max(0, items.length - 1) * 2;
    const listH = Math.min(280, Math.max(36, rowsHeight + 10));
    const scrollId = `sel-scroll-${id}`;
    const scrollEl = v_flex()
      .id(scrollId)
      .size_full()
      .overflow_y_scroll()
      .track_scroll(handles.scroll)
      .p(4)
      .pr(10)
      .gap(2)
      .children(
        items.length === 0
          ? [div().px(6).py(4).text_size(11).text_color(t.dim).child("No options")]
          : items.map((item, idx) => {
              const active = item.value === currentValue;
              const hi = idx === this.highlightIdx;
              const row = h_flex()
                .id(`sel-opt-${id}-${idx}`)
                .role("list_box_option")
                .flex_none()
                .gap(6)
                .px(6)
                .py(4)
                .rounded(4)
                .items_center()
                .when(active || hi, (el) => el.bg(active ? t.selected : t.hover))
                .hover((s) => s.bg(t.hover))
                .on_click((_e, cx) => {
                  if (disabled) return;
                  this.closeDropdown(id, cx, true);
                  onSelect(item.value, cx);
                });
              if (hi) row.aria_active_descendant();
              if (item.icon) row.child(item.icon);
              row.child(
                v_flex()
                  .flex_1()
                  .min_w(0)
                  .child(div().truncate().text_size(11).text_color(t.foreground).child(item.label))
                  .when(!!item.sub, (el) => el.child(div().truncate().text_size(10).text_color(t.dim).child(item.sub))),
              );
              if (item.badge) {
                row.child(div().px(4).py(1).rounded(3).bg(t.raised).text_size(9).text_color(item.badgeColor ?? t.dim).child(item.badge));
              }
              return row;
            }),
      );

    const listEl = div()
      .id(`sel-list-${id}`)
      .relative()
      .w(width ?? 270)
      .h(listH)
      .rounded(6)
      .bg(t.popover ?? t.raised)
      .border(1)
      .border_color(t.border)
      .shadow_md()
      .track_focus(handles.list)
      .on_mouse_down_out((_e, cx) => {
        if (this.openSelect === id) {
          this.outClosedId = id;
          this.openSelect = null;
          cx.notify();
        }
      })
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          cx.stop_propagation();
          this.closeDropdown(id, cx, true);
          return;
        }
        if (items.length === 0) return;
        if (e.key === "down") {
          cx.stop_propagation();
          this.highlightIdx = (this.highlightIdx + 1) % items.length;
          handles.scroll.scroll_to_item(this.highlightIdx);
          cx.notify();
        } else if (e.key === "up") {
          cx.stop_propagation();
          this.highlightIdx = (this.highlightIdx - 1 + items.length) % items.length;
          handles.scroll.scroll_to_item(this.highlightIdx);
          cx.notify();
        } else if (e.key === "enter") {
          cx.stop_propagation();
          const chosen = items[this.highlightIdx];
          this.closeDropdown(id, cx, true);
          if (chosen && !disabled) onSelect(chosen.value, cx);
        }
      })
      .child(scrollEl)
      .child(Scrollbar.vertical(scrollId).absolute().inset_0());

    return Select.new(`sel-${id}`)
      .accessibility_label(displayLabel)
      .open(open)
      .track_focus(handles.trigger)
      .content_focus_handle(handles.list)
      .on_open_change((nextOpen, cx) => {
        if (nextOpen) {
          if (!disabled) this.openDropdown(id, items, currentValue, cx);
        } else if (this.openSelect === id) {
          this.closeDropdown(id, cx, false);
        }
      })
      .child(
        Popup.new(`sel-pop-${id}`, trigger)
          .anchor("bottom_left")
          .when(open, (el) => el.content(listEl)),
      );
  }

  noteLine(key, t) {
    const n = this.notes[key];
    if (!n) return div();
    const color = { ok: t.done, warn: t.working, err: t.blocked }[n.kind];
    return div().text_size(11).text_color(color).child(n.text);
  }

  section(id, title, summary, body, t) {
    const open = !this.collapsed[id];
    return v_flex()
      .id(`sec-${id}`)
      .border_b(1)
      .border_color(t.border)
      .child(
        h_flex()
          .id(`sec-head-${id}`)
          .gap(6)
          .px(10)
          .py(7)
          .items_center()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.toggle(id, cx))
          .child(div().w(10).text_size(10).text_color(t.dim).child(open ? "▾" : "▸"))
          .child(div().font_semibold().text_size(12).child(title))
          .child(div().flex_1())
          .child(div().text_size(11).text_color(summary.color ?? t.dim).child(summary.text ?? "")),
      )
      .when(open, (el) => el.child(v_flex().gap(8).px(10).pb(10).child(body)));
  }

  // ---- live sub-agent activity strip

  liveSubAgentsBar(t) {
    let active = [];
    try {
      active = filterShepherdTerminals(terminals()).filter(
        (term) => !this.root || !term.cwd || term.cwd === this.root || term.cwd.startsWith(`${this.root}/`),
      );
    } catch {
      return null;
    }
    if (active.length === 0) return null;
    return v_flex()
      .id("sub-agents-strip")
      .gap(4)
      .px(10)
      .py(6)
      .border_b(1)
      .border_color(t.border)
      .bg(t.chrome ?? t.surface)
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(div().text_size(10).font_semibold().text_color(t.dim).child(`LIVE SUB-AGENTS (${active.length})`)),
      )
      .children(
        active.map((term, idx) => {
          const st = term.status ?? "working";
          const color = st === "blocked" ? t.blocked : st === "done" ? t.done : st === "working" ? t.working : t.dim;
          const dot = div().size(7).rounded(4).bg(color);
          if (st === "working") dot.loop("opacity", { from: 0.3, to: 1, period: 1400 });
          const label = term.labels?.["shepherd.ticket"]
            ? `ticket ${term.labels["shepherd.ticket"]}`
            : term.labels?.["shepherd.review"]
              ? "review"
              : term.labels?.["shepherd.review-fix"]
                ? "review fix"
                : term.labels?.["shepherd.ticket-review"]
                  ? `review #${term.labels["shepherd.ticket-review"]}`
                  : term.name || term.address;
          return h_flex()
            .id(`subagent-${idx}`)
            .gap(6)
            .px(6)
            .py(4)
            .rounded(4)
            .bg(t.raised)
            .items_center()
            .child(dot)
            .child(
              v_flex()
                .flex_1()
                .min_w(0)
                .child(div().truncate().text_size(11).font_semibold().child(label))
                .child(div().truncate().text_size(10).text_color(color).child(`${st}${term.program?.name ? ` · ${term.program.name}` : ""}`)),
            )
            .child(this.button(`peek-${idx}`, "Peek", t, { selected: false, disabled: false, onClick: () => run("terminal.peek", { terminal: term.address }) }))
            .child(this.button(`keep-${idx}`, "Keep", t, { selected: false, disabled: false, onClick: () => run("terminal.keep", { terminal: term.address }) }));
        }),
      );
  }

  // ---- phase-aware quick actions cockpit bar

  cockpitBar(current, d, t) {
    const actions = [];
    if (d.planFile) {
      actions.push({ id: "qa-plan", label: "Plan", onClick: () => this.openDoc(d.planFile) });
    }
    if (current) {
      const doneAll = current.ticketsTotal > 0 && current.ticketsDone >= current.ticketsTotal;
      if (d.liveBuild && !d.buildClaimRunning) {
        actions.push({ id: "qa-pause", label: "Pause", onClick: (_e, cx) => this.sendToSession("! shepherd build pause", cx) });
      } else if (
        !d.liveBuild &&
        (current.phase === "AWAITING_PLAN_APPROVAL" || current.phase === "PAUSED" || (current.phase === "IMPLEMENTING" && !doneAll))
      ) {
        actions.push({ id: "qa-build", label: current.phase === "PAUSED" ? "Resume" : "Build", accent: true, onClick: (_e, cx) => this.sendToSession("/shepherd:build", cx) });
      }
      if (doneAll || current.phase === "REVIEWING") {
        actions.push({ id: "qa-review", label: "Review", accent: true, onClick: (_e, cx) => this.sendToSession("/shepherd:review", cx) });
      }
      if (d.latestReviewFile) {
        actions.push({ id: "qa-vrev", label: "Report", onClick: () => this.openDoc(d.latestReviewFile) });
      }
      if (doneAll) {
        actions.push({ id: "qa-ship", label: "Ship", onClick: (_e, cx) => this.sendToSession("/shepherd:ship", cx) });
      }
    }
    actions.push({ id: "qa-clean", label: "Cleanup", onClick: (_e, cx) => this.sendToSession("/shepherd:cleanup", cx) });

    const ctxPill = formatCtxPill(d.sessionContext);
    return h_flex()
      .id("cockpit-bar")
      .gap(4)
      .px(10)
      .py(5)
      .flex_wrap()
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .children(actions.map((a) => this.button(a.id, a.label, t, { selected: false, disabled: false, accent: a.accent, onClick: a.onClick })))
      .child(div().flex_1())
      .when(!!ctxPill, (el) =>
        el.child(
          div()
            .px(5)
            .py(1)
            .rounded(4)
            .bg(t.raised)
            .text_size(10)
            .text_color(d.sessionContext.warm ? t.done : t.working)
            .child(ctxPill),
        ),
      );
  }

  // ---- expandable interactive ticket progress board

  ticketBoard(t) {
    const tickets = this.data?.activeTickets ?? [];
    if (tickets.length === 0) return null;
    const colorFor = (st) => (st === "done" ? t.done : st === "in-progress" ? t.working : st === "failed" ? t.blocked : t.raised);
    return v_flex()
      .id("ticket-board")
      .gap(4)
      .px(10)
      .py(6)
      .border_b(1)
      .border_color(t.border)
      .child(
        h_flex()
          .id("ticket-bar-toggle")
          .gap(6)
          .items_center()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => {
            this.ticketsOpen = !this.ticketsOpen;
            cx.notify();
          })
          .child(
            h_flex()
              .flex_1()
              .gap(2)
              .h(6)
              .children(
                tickets.map((tk) => {
                  const seg = div().flex_1().h(6).rounded(2).bg(colorFor(tk.status));
                  if (tk.status === "in-progress") seg.loop("opacity", { from: 0.4, to: 1, period: 1200 });
                  return seg;
                }),
              ),
          )
          .child(div().text_size(10).text_color(t.dim).child(this.ticketsOpen ? "▾ tickets" : "▸ tickets")),
      )
      .when(this.ticketsOpen, (el) =>
        el.child(
          v_flex()
            .gap(3)
            .pt(2)
            .children(
              tickets.map((tk) =>
                h_flex()
                  .id(`tk-${tk.id}`)
                  .gap(6)
                  .px(4)
                  .py(3)
                  .rounded(4)
                  .bg(t.raised)
                  .items_center()
                  .child(div().size(6).rounded(3).bg(colorFor(tk.status)))
                  .child(div().w(20).font_semibold().text_size(10).text_color(t.muted).child(tk.id))
                  .child(
                    v_flex()
                      .flex_1()
                      .min_w(0)
                      .child(div().truncate().text_size(11).child(tk.title))
                      .child(
                        div()
                          .truncate()
                          .text_size(10)
                          .text_color(t.dim)
                          .child(`${tk.difficulty}${tk.model ? ` · ${tk.model}` : ""}${tk.review && tk.review !== "-" ? ` · rev ${tk.review}` : ""}`),
                      ),
                  )
                  .child(
                    div()
                      .text_size(10)
                      .text_color(tk.status === "failed" ? t.blocked : t.muted)
                      .child(tk.notMetered && !tk.costUsd ? "sub" : tk.costUsd !== undefined ? fmtUsd(tk.costUsd) : tk.status),
                  ),
              ),
            ),
        ),
      );
  }

  // ---- models

  modelRow(key, t) {
    const d = this.data;
    const row = d.models[key];
    const kind = this.draft[key]?.kind ?? row.kind;
    const busy = this.busy.has(`m:${key}`);
    const unsaved = kind !== row.kind;
    let editor;

    if (kind === "pi") {
      const piModels = this.catalog?.piModels ?? [];
      const split = splitThinking(row.kind === "pi" ? row.value : this.text(`pi:${key}`));
      const piOptions = piModels.map((m) => ({
        value: m.value,
        label: m.value,
        sub: m.pricing ? `$${m.pricing.input}/M in · $${m.pricing.output}/M out` : undefined,
        badge: m.group,
      }));
      const thinkOptions = THINKING_LEVELS.map((lvl) => ({ value: lvl, label: lvl === "default" ? "thinking: default" : `thinking: ${lvl}` }));
      editor = v_flex()
        .gap(4)
        .when(piOptions.length > 0, (el) =>
          el.child(
            this.selectDropdown(`pi:${key}`, split.base || "Pick Pi model…", piOptions, split.base, t, {
              disabled: busy,
              onSelect: (val, cx) => {
                const full = withThinking(val, split.thinking);
                this.inputs[`pi:${key}`].state.set_value(full);
                this.inputs[`pi:${key}`].synced = full;
                this.saveModel(key, "pi", { piText: full }, cx);
              },
            }),
          ),
        )
        .child(
          h_flex()
            .gap(4)
            .items_center()
            .child(div().flex_1().child(this.input(`pi:${key}`, t, busy)))
            .child(
              div()
                .w(116)
                .child(
                  this.selectDropdown(`think:${key}`, split.thinking === "default" ? "think: auto" : `:${split.thinking}`, thinkOptions, split.thinking, t, {
                    disabled: busy || !split.base,
                    width: 140,
                    onSelect: (lvl, cx) => {
                      const full = withThinking(split.base, lvl);
                      if (!full) return;
                      this.inputs[`pi:${key}`].state.set_value(full);
                      this.inputs[`pi:${key}`].synced = full;
                      this.saveModel(key, "pi", { piText: full }, cx);
                    },
                  }),
                ),
            ),
        );
    } else if (kind === "local") {
      const ids = d.local.models.map((m) => m.id);
      const localItems = d.local.models.map((m) => ({ value: m.id, label: m.id, sub: `${ctxText(m.contextWindow)} context` }));
      editor =
        ids.length === 0
          ? div().text_size(11).text_color(t.dim).child("No local models yet: add one under Local model (runs via Pi worker).")
          : v_flex()
              .gap(3)
              .child(
                this.selectDropdown(`local:${key}`, row.kind === "local" && row.id ? row.id : "Pick local model…", localItems, row.kind === "local" ? row.id : "", t, {
                  disabled: busy,
                  onSelect: (id, cx) => this.saveModel(key, "local", { localId: id }, cx),
                }),
              )
              .child(div().text_size(10).text_color(t.dim).child("Runs via Pi worker against your local server."));
    } else {
      const selectedAgent = row.kind === "agent" ? row.agent : "";
      const supportsModelFlag = !selectedAgent || (d.agentsWithModelFlag ?? []).includes(selectedAgent);
      const billing = selectedAgent ? (d.agentsBilling?.[selectedAgent] ?? "api") : null;
      const agentItems = d.agents.map((name) => {
        const meta = this.agentMeta.get(name);
        const installed = meta ? meta.installed : undefined;
        const b = d.agentsBilling?.[name] ?? "api";
        return {
          value: name,
          label: meta?.name ? `${name} (${meta.name})` : name,
          icon: this.agentIcon(name, t),
          badge: installed === false ? "missing" : b === "subscription" ? "sub" : installed ? "ready" : undefined,
          badgeColor: installed === false ? t.blocked : b === "subscription" ? t.accent : t.done,
        };
      });
      const catEntry = selectedAgent ? this.catalog?.agents?.[selectedAgent] : undefined;
      const modelOptions = [
        { value: "", label: "(agent default)", sub: "let the CLI choose its default model" },
        ...(catEntry?.models ?? []).map((m) => ({
          value: m.id,
          label: m.label || m.id,
          sub: [m.id, m.pricing ? `$${m.pricing.input}/$${m.pricing.output}` : m.note].filter(Boolean).join(" · "),
          badge: m.source === "live" ? "live" : undefined,
          badgeColor: t.done,
        })),
      ];

      editor = v_flex()
        .gap(4)
        .child(
          h_flex()
            .gap(4)
            .items_center()
            .child(
              div()
                .flex_1()
                .child(
                  this.selectDropdown(`agent:${key}`, selectedAgent || "Pick agent…", agentItems, selectedAgent, t, {
                    disabled: busy,
                    onSelect: (name, cx) => {
                      const pick = agentPick(row, name);
                      const slot = this.inputs[`am:${key}`];
                      if (pick.agentModel === "" && slot) {
                        slot.state.set_value("");
                        slot.synced = "";
                      }
                      this.saveModel(key, "agent", pick, cx);
                    },
                  }),
                ),
            )
            .when(!!selectedAgent, (el) =>
              el.child(
                this.button(`bill-${key}`, billing === "subscription" ? "Sub ($0)" : "API", t, {
                  selected: billing === "subscription",
                  disabled: this.busy.has(`billing:${selectedAgent}`),
                  onClick: (_e, cx) => this.toggleAgentBilling(selectedAgent, cx),
                }),
              ),
            ),
        )
        .when(supportsModelFlag, (el) =>
          el
            .child(
              h_flex()
                .gap(4)
                .items_center()
                .child(
                  div()
                    .flex_1()
                    .child(
                      this.selectDropdown(
                        `am:${key}`,
                        row.kind === "agent" && row.agentModel ? row.agentModel : "Pick model (or type below)…",
                        modelOptions,
                        row.kind === "agent" ? (row.agentModel ?? "") : "",
                        t,
                        {
                          disabled: busy || !selectedAgent,
                          onSelect: (modelId, cx) => {
                            const slot = this.inputs[`am:${key}`];
                            if (slot) {
                              slot.state.set_value(modelId);
                              slot.synced = modelId;
                            }
                            this.saveModel(key, "agent", { agent: selectedAgent, agentModel: modelId }, cx);
                          },
                        },
                      ),
                    ),
                )
                .child(
                  this.button(`ref-am-${key}`, this.busy.has("catalog") ? "…" : "↻", t, {
                    selected: false,
                    disabled: this.busy.has("catalog"),
                    onClick: (_e, cx) => this.loadCatalog(cx, true),
                  }),
                ),
            )
            .child(this.input(`am:${key}`, t, busy)),
        )
        .when(!supportsModelFlag, (el) =>
          el.child(div().text_size(10).text_color(t.dim).child(`${selectedAgent} does not accept a model flag.`)),
        );
    }

    const what = kind === "pi" ? "a model" : kind === "local" ? "a local model" : "an agent";
    return v_flex()
      .id(`model-${key}`)
      .gap(4)
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(div().w(50).font_semibold().text_size(12).child(key))
          .child(
            h_flex()
              .gap(3)
              .children(
                KINDS.map(([id, label]) =>
                  this.button(`kind-${key}-${id}`, label, t, {
                    selected: kind === id,
                    disabled: false,
                    onClick: (_e, cx) => {
                      if (id === row.kind) delete this.draft[key];
                      else this.draft[key] = { kind: id };
                      cx.notify();
                    },
                  }),
                ),
              ),
          )
          .child(div().flex_1())
          .when(row.source !== "default", (el) =>
            el.child(div().text_size(10).text_color(row.source === "project" ? t.working : t.dim).child(row.source)),
          ),
      )
      .child(editor)
      .when(unsaved, (el) => el.child(div().text_size(11).text_color(t.dim).child(`Saved: ${row.value}. Choose ${what} to change it.`)))
      .when(!!row.problem, (el) => el.child(div().text_size(11).text_color(t.blocked).child(row.problem)))
      .child(this.noteLine(`m:${key}`, t));
  }

  reviewersBlock(t) {
    const d = this.data;
    const current = d.reviewReviewers ?? [];
    const busy = this.busy.has("reviewers");
    const addOptions = [
      { value: "agent:codex/gpt-6-astra", label: "Codex · GPT-6 Astra", sub: "correctness & edge cases" },
      { value: "agent:codex/gpt-6.2-astra", label: "Codex · GPT-6.2 Astra", sub: "correctness & edge cases" },
      { value: "agent:agy/gemini-4-neon-high", label: "AGY · Gemini 4 Neon (High)", sub: "reasoning & correctness" },
      { value: "agent:agy/gemini-4-argon-high", label: "AGY · Gemini 4 Argon (High)", sub: "architecture & security" },
      { value: "agent:claude/fable", label: "Claude · Fable", sub: "high-end advisor" },
      { value: "agent:claude/opus", label: "Claude · Opus", sub: "deep reasoning" },
      { value: "openai/gpt-6.2-astra", label: "Pi · openai/gpt-6.2-astra" },
      { value: "google/gemini-4-neon", label: "Pi · google/gemini-4-neon" },
      { value: "google/gemini-4-argon", label: "Pi · google/gemini-4-argon" },
    ];
    return v_flex()
      .gap(5)
      .pt(6)
      .border_t(1)
      .border_color(t.border)
      .child(
        h_flex()
          .gap(4)
          .items_center()
          .child(div().text_size(10).text_color(t.dim).child("MULTI-MODEL /REVIEW PANEL"))
          .child(div().flex_1())
          .children(
            REVIEWER_PRESETS.map((p, idx) =>
              this.button(`rev-pre-${idx}`, p.label, t, {
                selected: false,
                disabled: busy,
                onClick: (_e, cx) => this.saveReviewers(p.models, cx),
              }),
            ),
          ),
      )
      .when(current.length === 0, (el) =>
        el.child(div().text_size(11).text_color(t.dim).child("Single reviewer (uses models.review). Add reviewers below for parallel consensus.")),
      )
      .children(
        current.map((rev, idx) =>
          h_flex()
            .id(`rev-item-${idx}`)
            .gap(6)
            .px(6)
            .py(3)
            .rounded(4)
            .bg(t.raised)
            .items_center()
            .child(
              v_flex()
                .flex_1()
                .min_w(0)
                .child(div().truncate().text_size(11).child(rev.name ? `${rev.name} (${rev.model})` : rev.model))
                .when(!!rev.focus, (e) => e.child(div().truncate().text_size(10).text_color(t.dim).child(rev.focus))),
            )
            .child(
              this.button(`rev-rm-${idx}`, "✕", t, {
                selected: false,
                disabled: busy,
                onClick: (_e, cx) => {
                  const next = current.filter((_, i) => i !== idx).map((r) => (r.name || r.focus ? r : r.model));
                  this.saveReviewers(next, cx);
                },
              }),
            ),
        ),
      )
      .child(
        this.selectDropdown("addReviewer", "+ Add reviewer…", addOptions, "", t, {
          disabled: busy,
          onSelect: (model, cx) => {
            const next = [...current.map((r) => (r.name || r.focus ? r : r.model)), model];
            this.saveReviewers(next, cx);
          },
        }),
      )
      .child(this.noteLine("reviewers", t));
  }

  modelsBody(t) {
    const d = this.data;
    return v_flex()
      .gap(10)
      .when(d.modelsShadowedByProject, (el) =>
        el.child(div().text_size(11).text_color(t.working).child("This project's config sets models: it replaces the whole section, so changes here show but do not apply in this project.")),
      )
      .children(MODEL_KEYS.map((k) => this.modelRow(k, t)))
      .child(this.reviewersBlock(t));
  }

  // ---- local server

  localStatus(t) {
    const x = this.detected;
    if (this.busy.has("detect")) return { text: "checking…", color: t.muted };
    if (!x) return { text: "not checked", color: t.dim };
    if (x.ok === false) return { text: "invalid URL", color: t.blocked };
    if (x.reachable) return { text: `reachable · ${x.models.length} served`, color: t.done };
    return { text: "unreachable", color: t.blocked };
  }

  localBody(t) {
    const d = this.data;
    const x = this.detected && this.detected.ok !== false ? this.detected : null;
    const status = this.localStatus(t);
    const busy = this.busy.has("local");
    const served = x?.reachable ? x.models : [];
    const needCtx = served.some((m) => !m.contextWindow && m.configured === undefined);
    return v_flex()
      .gap(6)
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(div().size(7).rounded(4).bg(status.color))
          .child(div().text_size(11).text_color(status.color).child(status.text))
          .child(div().flex_1())
          .child(this.button("detect", "Detect", t, { selected: false, disabled: this.busy.has("detect"), onClick: (_e, cx) => this.detect(cx, false) })),
      )
      .child(this.input("base", t, busy))
      .child(
        h_flex()
          .gap(4)
          .flex_wrap()
          .children(
            d.local.presets.map((p) =>
              this.button(`preset-${p.name}`, p.name, t, {
                selected: this.text("base").trim() === p.baseUrl,
                disabled: busy,
                onClick: (_e, cx) => this.preset(p.baseUrl, cx),
              }),
            ),
          ),
      )
      .when(!!this.detected && this.detected.ok === false, (el) => el.child(div().text_size(11).text_color(t.blocked).child(this.detected.error)))
      .when(!!x && !x.reachable, (el) => el.child(div().text_size(11).text_color(t.dim).child(x.error)))
      .when(served.length > 0, (el) =>
        el.child(
          v_flex()
            .gap(3)
            .child(div().text_size(10).text_color(t.dim).child("SERVED"))
            .children(served.map((m) => this.servedRow(m, t, busy)))
            .when(needCtx, (e) =>
              e.child(
                h_flex()
                  .gap(6)
                  .items_center()
                  .child(div().text_size(11).text_color(t.dim).child("context for Add"))
                  .child(
                    this.numberInput("ctx", t, false, (dir, cx) => {
                      const cur = positive(this.text("ctx")) ?? 8192;
                      this.inputs.ctx.state.set_value(String(Math.max(4096, cur + dir * 4096)));
                      cx.notify();
                    }),
                  ),
              ),
            ),
        ),
      )
      .when(d.local.models.length > 0, (el) =>
        el.child(
          v_flex()
            .gap(3)
            .child(div().text_size(10).text_color(t.dim).child("IN CONFIG"))
            .children(
              d.local.models.map((m) =>
                h_flex()
                  .id(`cfg-${m.id}`)
                  .gap(6)
                  .items_center()
                  .child(div().flex_1().min_w(0).truncate().text_size(12).child(m.id))
                  .child(div().text_size(11).text_color(t.muted).child(ctxText(m.contextWindow)))
                  .child(this.button(`rm-${m.id}`, "✕", t, { selected: false, disabled: busy, onClick: (_e, cx) => this.removeLocal(m.id, cx) })),
              ),
            ),
        ),
      )
      .child(this.noteLine("local", t));
  }

  servedRow(m, t, busy) {
    const saved = m.configured !== undefined;
    const same = saved && (m.contextWindow === undefined || m.configured === m.contextWindow);
    return v_flex()
      .id(`served-${m.id}`)
      .gap(1)
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(12).child(m.id))
          .child(div().text_size(11).text_color(t.muted).child(m.contextWindow ? ctxText(m.contextWindow) : "ctx ?"))
          .child(
            same
              ? div().px(7).py(2).text_size(11).text_color(t.done).child("saved")
              : this.button(`add-${m.id}`, saved ? "Update" : "Add", t, { selected: false, disabled: busy, onClick: (_e, cx) => this.addLocal(m, cx) }),
          ),
      )
      .when(!!m.mismatch, (el) =>
        el.child(div().text_size(10).text_color(t.working).child(`Saved context is ${ctxText(m.configured)}; the server runs ${ctxText(m.contextWindow)}.`)),
      );
  }

  // ---- plans

  planRow(p, t) {
    const note = this.notes[`p:${p.id}`];
    const busy = this.busy.has(`p:${p.id}`);
    const wt = p.worktree;
    const hasSpace = wt ? spaces().some((sp) => sp.folder === wt) : false;
    return v_flex()
      .id(`plan-${p.id}`)
      .gap(2)
      .py(5)
      .border_b(1)
      .border_color(t.border)
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(div().w(8).text_size(10).text_color(t.accent).child(p.active ? "●" : ""))
          .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(12).text_color(p.closed ? t.dim : t.foreground).child(p.name))
          .child(div().text_size(11).text_color(t.muted).child(p.unknown > 0 ? `${fmtUsd(p.spendUsd)}+?` : fmtUsd(p.spendUsd))),
      )
      .child(div().pl(14).truncate().text_size(11).text_color(t.muted).child(p.state))
      .child(div().pl(14).truncate().text_size(11).text_color(t.dim).child(`${ticketsText(p)}${p.branch ? ` · ${p.branch}` : ""}${wt ? " · wt" : ""}`))
      .when(!p.closed, (el) =>
        el.child(
          h_flex()
            .pl(14)
            .gap(4)
            .flex_wrap()
            .when(!p.active, (e) => e.child(this.button(`act-${p.id}`, "Make active", t, { selected: false, disabled: busy, onClick: (_e, cx) => this.activate(p.id, cx) })))
            .when(!!wt, (e) =>
              e.child(this.button(`wt-${p.id}`, hasSpace ? "Jump to Space" : "Open Space", t, { selected: false, disabled: false, onClick: () => this.openOrJumpSpace(p.name, wt) })),
            )
            .child(this.button(`close-${p.id}`, "Close", t, { selected: false, disabled: busy, onClick: (_e, cx) => this.closePlan(p.id, false, cx) }))
            .when(!!note?.needsForce, (e) =>
              e.child(this.button(`force-${p.id}`, "Close anyway", t, { selected: false, disabled: busy, onClick: (_e, cx) => this.closePlan(p.id, true, cx) })),
            ),
        ),
      )
      .when(!!note, (el) =>
        el.child(div().pl(14).text_size(11).text_color({ ok: t.done, warn: t.working, err: t.blocked }[note.kind]).child(note.text)),
      );
  }

  plansBody(t) {
    const plans = this.data.plans;
    if (plans.length === 0) return div().text_size(11).text_color(t.dim).child("No plans in this project. /shepherd:plan starts one.");
    return v_flex().children(plans.map((p) => this.planRow(p, t)));
  }

  // ---- costs

  meter(label, spend, limit, status, t, unknown, apiEquiv) {
    const color = status === "hard" ? t.blocked : status === "soft" ? t.working : t.accent;
    const equivNote = typeof apiEquiv === "number" && apiEquiv > spend + 0.0005 ? ` (API ≈ ${fmtUsd(apiEquiv)})` : "";
    return v_flex()
      .gap(3)
      .child(
        h_flex()
          .gap(6)
          .child(div().flex_1().min_w(0).truncate().text_size(12).child(label))
          .child(div().text_size(12).text_color(status === "ok" ? t.foreground : color).child(`${fmtUsd(spend)}${unknown > 0 ? "+?" : ""} / ${fmtUsd(limit)}${equivNote}`)),
      )
      .child(div().h(4).rounded(2).bg(t.raised).child(div().h(4).rounded(2).bg(color).w(`${Math.round(ratio(spend, limit) * 100)}%`)));
  }

  costsBody(t) {
    const d = this.data;
    const c = d.costs;
    const scope = this.scope === "plan" && c.plan ? c.plan : c.today;
    const rows = scope.byModel.slice(0, 8);
    const unknownHere = scope.unknown ?? 0;
    const idleAction = d.budgets.idleAction ?? "warn";
    return v_flex()
      .gap(8)
      .child(this.meter("Today (all repos)", c.today.spendUsd, c.today.limitUsd, c.today.status, t, c.today.unknown, c.today.apiEquivalentUsd))
      .when(!!c.plan, (el) => el.child(this.meter(`Plan ${c.plan.name}`, c.plan.spendUsd, c.plan.limitUsd, c.plan.status, t, c.plan.unknown, c.plan.apiEquivalentUsd)))
      .when(!c.plan, (el) => el.child(div().text_size(11).text_color(t.dim).child("No active plan.")))
      .child(
        h_flex()
          .gap(4)
          .items_center()
          .child(div().text_size(10).text_color(t.dim).child("SPEND BY MODEL"))
          .child(div().flex_1())
          .child(this.button("scope-today", "Today", t, { selected: scope === c.today, disabled: false, onClick: (_e, cx) => { this.scope = "today"; cx.notify(); } }))
          .child(this.button("scope-plan", "Plan", t, { selected: scope === c.plan, disabled: !c.plan, onClick: (_e, cx) => { this.scope = "plan"; cx.notify(); } })),
      )
      .child(
        scope.byModel.length === 0
          ? div().text_size(11).text_color(t.dim).child("Nothing spent yet.")
          : v_flex()
              .gap(2)
              .children(
                rows.map((r) =>
                  h_flex()
                    .gap(6)
                    .child(div().flex_1().min_w(0).truncate().text_size(11).child(r.name))
                    .child(div().text_size(11).text_color(t.muted).child(`${fmtUsd(r.spendUsd)}${r.unknown > 0 ? `+? (${r.unknown})` : ""}`)),
                ),
              ),
      )
      .when(scope.byPhase.length > 0, (el) =>
        el.child(
          h_flex()
            .gap(4)
            .flex_wrap()
            .children(scope.byPhase.map((r) => div().px(6).py(1).rounded(4).bg(t.raised).text_size(11).text_color(t.muted).child(`${r.name} ${fmtUsd(r.spendUsd)}`))),
        ),
      )
      .when(unknownHere > 0 || c.unpriced.length > 0, (el) =>
        el.child(
          v_flex()
            .gap(2)
            .when(unknownHere > 0, (e) => e.child(div().text_size(11).text_color(t.working).child(`${unknownHere} unpriced call(s) in this view; budgets count them at an estimate (+?).`)))
            .when(c.unpriced.length > 0, (e) => e.child(div().text_size(11).text_color(t.working).child(`No pricing row: ${c.unpriced.slice(0, 4).join(", ")}${c.unpriced.length > 4 ? "…" : ""}`))),
        ),
      )
      .child(
        v_flex()
          .gap(6)
          .pt(6)
          .border_t(1)
          .border_color(t.border)
          .child(div().text_size(10).text_color(t.dim).child("BUDGETS & CACHE HOOK"))
          .when(d.budgets.shadowedByProject, (el) =>
            el.child(div().text_size(11).text_color(t.working).child("This project's config sets budgets: it replaces the whole section, so changes here do not apply in this project.")),
          )
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(div().text_size(11).text_color(t.muted).child("daily"))
              .child(this.numberInput("dailyUsd", t, this.busy.has("budgets"), (dir, cx) => this.stepBudget("dailyUsd", dir, cx)))
              .child(div().flex_1())
              .child(div().text_size(11).text_color(t.muted).child("task"))
              .child(this.numberInput("taskUsd", t, this.busy.has("budgets"), (dir, cx) => this.stepBudget("taskUsd", dir, cx))),
          )
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(div().text_size(11).text_color(t.muted).child("idle cache"))
              .child(
                div()
                  .flex_1()
                  .child(
                    this.selectDropdown("idleAction", idleAction, IDLE_ACTIONS, idleAction, t, {
                      disabled: this.busy.has("budgets"),
                      width: 190,
                      onSelect: (val, cx) => this.saveIdleAction(val, cx),
                    }),
                  ),
              ),
          )
          .child(this.noteLine("budgets", t)),
      );
  }

  // ---- render

  banner(text, color, t) {
    return div().mx(10).mt(8).p(8).rounded(6).bg(t.raised).border(1).border_color(color).text_size(11).text_color(color).child(text);
  }

  render(cx) {
    const t = theme();
    const root = v_flex()
      .id("shepherd-config")
      .size_full()
      .bg(t.surface)
      .text_color(t.foreground)
      .text_size(12)
      .on_size_change((sz, cx) => {
        if (sz?.width && Math.abs(sz.width - this.panelWidth) > 8) {
          this.panelWidth = sz.width;
          cx.notify();
        }
      });

    const nextLoc = this.location();
    if (
      this.start &&
      (nextLoc.machine !== this.start.machine || nextLoc.folder !== this.start.folder) &&
      !this.loading
    ) {
      this.refresh(cx);
    }
    if (this.failure && !this.data) return root.child(this.banner(this.failure, t.blocked, t));
    if (!this.data) return root.child(div().p(12).text_color(t.muted).child("Loading…"));

    const d = this.data;
    const c = d.costs;
    const tone = (status) => (status === "hard" ? t.blocked : status === "soft" ? t.working : t.dim);
    const usd = (scope) => `${fmtUsd(scope.spendUsd)}${scope.unknown > 0 ? "+?" : ""}`;
    const open = d.plans.filter((p) => !p.closed).length;
    const current = d.plans.find((p) => p.active && !p.closed);
    const summaries = {
      models: { text: (d.reviewReviewers?.length ?? 0) > 0 ? `${d.reviewReviewers.length} reviewers` : "" },
      local: this.localStatus(t),
      plans: { text: current ? `${current.name}${open > 1 ? ` · ${open} open` : ""}` : `${open} open` },
      costs: {
        text: `${c.plan ? `plan ${usd(c.plan)} · ` : ""}today ${usd(c.today)}`,
        color: tone(c.plan?.status === "hard" || c.today.status === "hard" ? "hard" : c.plan?.status === "soft" || c.today.status === "soft" ? "soft" : "ok"),
      },
    };

    const planBar = h_flex()
      .gap(6)
      .px(10)
      .py(6)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .when(!current, (el) => el.child(div().text_size(11).text_color(t.dim).child("No active plan. /shepherd:plan starts one.")))
      .when(!!current, (el) =>
        el
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .child(div().truncate().text_size(12).font_semibold().child(current.name))
              .child(div().truncate().text_size(11).text_color(t.muted).child(current.state)),
          )
          .when(!!c.plan, (e) =>
            e.child(div().text_size(12).text_color(c.plan.status === "ok" ? t.foreground : tone(c.plan.status)).child(`${usd(c.plan)} / ${fmtUsd(c.plan.limitUsd)}`)),
          ),
      );

    const subStrip = this.liveSubAgentsBar(t);
    const tkBoard = this.ticketBoard(t);
    const bodies = {
      models: () => this.modelsBody(t),
      local: () => this.localBody(t),
      plans: () => this.plansBody(t),
      costs: () => this.costsBody(t),
    };

    const repoName = this.root?.split("/").pop() ?? "";
    const headerTitle = this.machine ? `${this.machine} · ${repoName}` : repoName;

    return root
      .child(
        h_flex()
          .gap(6)
          .px(10)
          .py(7)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(div().font_semibold().text_size(13).child("shepherd"))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(headerTitle))
          .child(this.button("refresh", this.loading ? "…" : "↻", t, { selected: false, disabled: false, onClick: (_e, cx) => this.refresh(cx) })),
      )
      .child(planBar)
      .child(this.cockpitBar(current, d, t))
      .when(!!subStrip, (el) => el.child(subStrip))
      .when(!!tkBoard, (el) => el.child(tkBoard))
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .when(!!this.failure, (el) => el.child(this.banner(this.failure, t.blocked, t)))
          .when(!!this.notes.versionSkew, (el) => el.child(this.banner(this.notes.versionSkew.text, t.working, t)))
          .children(d.errors.map((e) => this.banner(e, t.blocked, t)))
          .children(d.warnings.slice(0, 3).map((w) => div().px(10).pt(6).text_size(11).text_color(t.working).child(w)))
          .children(SECTIONS.map(([id, title]) => this.section(id, title, summaries[id], bodies[id](), t))),
      );
  }
}
