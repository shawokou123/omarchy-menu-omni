.pragma library

// AiAdapters: per-CLI argv construction and NDJSON event normalization.
//
// Every adapter implements the same shape:
//   id, label
//   binary                          executable name resolved on PATH
//   capabilities                    { continuity, modelOverride, webSearchDetection, resumeBeforeExit }
//   createSessionRef()              caller-generated session id, or null
//   buildRun(prompt, sessionRef, config)     -> argv (array of strings)
//   buildResume(sessionRef, config)          -> argv (array of strings)
//   parseLine(line, parserState)             -> array of normalized events
//   classifyFailure(exitCode, stderrText)    -> { message, kind } | null
//
// Normalized events (kept deliberately small, see plan §18):
//   { type: "text",     text: "..." }
//   { type: "session",  sessionRef: "..." }
//   { type: "tool",     tool: "web_search" }
//   { type: "activity", activity: "thinking" | "searching" }
//   { type: "error",    message: "..." }
//
// Ported from omarchy-find by Jessé Burlamaque (MIT). Local change: every
// headless run is started with its tools narrowed to what answering a
// question needs. The run starts in $HOME from a search field, so an agent
// with its usual tools could read, edit or execute on the strength of
// whatever was typed there -- or of a web page the answer pulled in. The
// terminal handoff (buildResume) is left alone: that is an ordinary
// interactive session the user drives and approves.
//
// Adapters never touch a shell string. Every argv element is passed through
// to Quickshell's Process.command as a literal argument — see AiBackend.js
// and Find.qml, which only ever assign arrays, never concatenate strings.

function uuidv4() {
  // Local correlation id only (Antigravity conversation id) — Math.random()
  // is adequate; this is not a security token.
  var bytes = new Array(16)
  for (var i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  function hex(n) {
    var s = n.toString(16)
    return s.length === 1 ? "0" + s : s
  }
  var h = ""
  for (var j = 0; j < 16; j++) h += hex(bytes[j])
  return h.substr(0, 8) + "-" + h.substr(8, 4) + "-" + h.substr(12, 4) + "-" +
    h.substr(16, 4) + "-" + h.substr(20, 12)
}

function safeParse(line) {
  var text = String(line === undefined || line === null ? "" : line).trim()
  if (text.length === 0) return undefined
  try {
    return JSON.parse(text)
  } catch (e) {
    // Malformed JSON event (plan §26.13): ignore the line, never throw.
    return undefined
  }
}

// Generic stderr classification shared by every adapter's classifyFailure as
// a last resort. Adapters check their own known strings first.
function classifyGeneric(stderrText) {
  var s = String(stderrText || "").toLowerCase()
  if (s.length === 0) return null
  if (s.indexOf("command not found") !== -1 || s.indexOf("no such file or directory") !== -1) {
    return { message: "CLI binary not found on PATH", kind: "binary_missing" }
  }
  if (s.indexOf("not logged in") !== -1 || s.indexOf("authentication") !== -1 ||
      s.indexOf("api key") !== -1 || s.indexOf("unauthorized") !== -1 || s.indexOf("please login") !== -1 ||
      s.indexOf("please run") !== -1 && s.indexOf("login") !== -1) {
    return { message: "Authentication required for this CLI", kind: "auth" }
  }
  if (s.indexOf("usage limit") !== -1 || s.indexOf("quota") !== -1 || s.indexOf("credits") !== -1 ||
      s.indexOf("rate limit") !== -1 || s.indexOf("429") !== -1) {
    return { message: "Usage limit reached for this CLI", kind: "quota" }
  }
  if (s.indexOf("network") !== -1 || s.indexOf("econnrefused") !== -1 || s.indexOf("enotfound") !== -1 ||
      s.indexOf("timed out") !== -1 || s.indexOf("timeout") !== -1) {
    return { message: "Network error talking to the provider", kind: "network" }
  }
  if (s.indexOf("unrecognized") !== -1 || s.indexOf("unknown flag") !== -1 || s.indexOf("invalid option") !== -1 ||
      s.indexOf("invalid argument") !== -1) {
    return { message: "CLI rejected an argument (see logs)", kind: "invalid_arg" }
  }
  return null
}

// ---------------------------------------------------------------- Claude ---

var claudeAdapter = {
  id: "claude",
  label: "Claude",
  binary: "claude",
  capabilities: {
    continuity: "returned-id",
    modelOverride: true,
    webSearchDetection: true,
    resumeBeforeExit: false
  },

  createSessionRef: function() { return null },

  buildRun: function(prompt, sessionRef, config) {
    var argv = ["claude", "-p", prompt, "--output-format", "stream-json", "--verbose", "--include-partial-messages"]
    // Only the web tools exist in this run (--tools), and those two are
    // pre-approved so a search is not silently refused for want of a prompt.
    // No Read, no Bash, no Edit. One comma-joined value each: the flags are
    // variadic, and a following positional would be swallowed.
    //
    // --tools only covers the built-in tools. MCP servers -- including the
    // claude.ai connectors (Gmail, Docs, ...) -- load regardless, and a page
    // the answer read could steer the model into them, so --strict-mcp-config
    // with no --mcp-config loads none at all. --restricted additionally drops
    // the user's settings files (hooks, allow rules) from this one run.
    argv.push("--tools", "WebSearch,WebFetch", "--allowedTools", "WebSearch,WebFetch",
              "--strict-mcp-config", "--restricted")
    if (config && config.model) argv.push("--model", config.model)
    if (config && config.effort) argv.push("--effort", config.effort)
    return argv
  },

  buildResume: function(sessionRef, config) {
    var argv = ["claude", "--resume", sessionRef]
    if (resumeModel(config)) argv.push("--model", resumeModel(config))
    return argv
  },

  parseLine: function(line, ps) {
    var obj = safeParse(line)
    if (obj === undefined || obj === null || typeof obj !== "object") return []
    var events = []

    // The session id shows up on hook/init events alike; take the first one
    // we see and never let a later line clobber it (Claude never rotates it
    // mid-run).
    if (!ps.sessionCaptured && typeof obj.session_id === "string" && obj.session_id.length > 0) {
      ps.sessionCaptured = true
      events.push({ type: "session", sessionRef: obj.session_id })
    }

    if (obj.type === "system" && obj.subtype === "status" && obj.status === "requesting") {
      events.push({ type: "activity", activity: "thinking" })
    } else if (obj.type === "stream_event" && obj.event && typeof obj.event === "object") {
      var se = obj.event
      if (se.type === "content_block_start" && se.content_block) {
        var cb = se.content_block
        if (cb.type === "thinking" || cb.type === "text") {
          events.push({ type: "activity", activity: "thinking" })
        } else if (cb.type === "tool_use") {
          var name = String(cb.name || "").toLowerCase()
          if (name.indexOf("websearch") !== -1 || name.indexOf("web_search") !== -1 ||
              name.indexOf("webfetch") !== -1 || name.indexOf("web_fetch") !== -1) {
            events.push({ type: "tool", tool: "web_search" })
            events.push({ type: "activity", activity: "searching" })
          } else {
            events.push({ type: "activity", activity: "thinking" })
          }
        }
      } else if (se.type === "content_block_delta" && se.delta) {
        if (se.delta.type === "text_delta" && typeof se.delta.text === "string" && se.delta.text.length > 0) {
          events.push({ type: "text", text: se.delta.text })
        }
        // thinking_delta / signature_delta / input_json_delta: internal
        // reasoning and tool-call payloads, never surfaced as answer text.
      } else if (se.type === "content_block_stop") {
        events.push({ type: "activity", activity: "thinking" })
      }
    } else if (obj.type === "result") {
      ps.sawResult = true
      if (obj.is_error) {
        var msg = (typeof obj.result === "string" && obj.result) ||
          (typeof obj.error === "string" && obj.error) ||
          "Claude reported an error"
        events.push({ type: "error", message: msg })
      } else if (typeof obj.result === "string") {
        // Authoritative fallback only — AiBackend only uses this if no text
        // deltas were captured at all (defense in depth, not the primary path).
        ps.finalText = obj.result
      }
    }
    return events
  },

  classifyFailure: function(exitCode, stderrText) {
    var s = String(stderrText || "")
    var lower = s.toLowerCase()
    if (lower.indexOf("not logged in") !== -1 || lower.indexOf("please run") !== -1 && lower.indexOf("login") !== -1 ||
        lower.indexOf("authentication") !== -1) {
      return { message: "Claude authentication required", kind: "auth" }
    }
    return classifyGeneric(s)
  }
}

// ----------------------------------------------------------------- Codex ---

// Codex features that add tools beyond the read-only sandbox; see buildRun.
var CODEX_DISABLED_FEATURES = [
  "apps", "plugins", "remote_plugin", "browser_use", "browser_use_external",
  "computer_use", "in_app_browser", "hooks", "memories", "image_generation"
]

var codexAdapter = {
  id: "codex",
  label: "Codex",
  binary: "codex",
  capabilities: {
    continuity: "returned-id",
    modelOverride: true,
    webSearchDetection: true,
    resumeBeforeExit: false
  },

  createSessionRef: function() { return null },

  buildRun: function(prompt, sessionRef, config) {
    // Read-only sandbox: codex may still look things up, but cannot write or
    // run anything with side effects.
    //
    // The sandbox covers local files and commands only, not MCP: a page the
    // answer read could steer the model into the user's MCP servers, ChatGPT
    // connectors (apps) or plugins, which act on accounts outside it. So this
    // run loads none of them. --ignore-user-config skips config.toml (its
    // mcp_servers, plugins, hooks and features) and mcp_servers={} keeps any
    // other layer from adding one; the --disable list switches off the
    // features that bring tools of their own even without a config: account
    // connectors, plugins, browser and computer use, hooks, memories and
    // image generation. Hosted web search stays: it is how codex looks
    // things up. The terminal continuation (codex resume) is the user's own
    // session with their normal configuration.
    var argv = ["codex", "exec", "--skip-git-repo-check", "--json", "--sandbox", "read-only",
                "--ignore-user-config", "--ignore-rules", "-c", "mcp_servers={}"]
    for (var i = 0; i < CODEX_DISABLED_FEATURES.length; i++) argv.push("--disable", CODEX_DISABLED_FEATURES[i])
    if (config && config.model) argv.push("--model", config.model)
    if (config && config.effort) argv.push("-c", "model_reasoning_effort=\"" + config.effort + "\"")
    argv.push(prompt)
    return argv
  },

  buildResume: function(sessionRef, config) {
    var argv = ["codex", "resume", sessionRef]
    if (resumeModel(config)) argv.push("--model", resumeModel(config))
    return argv
  },

  parseLine: function(line, ps) {
    var obj = safeParse(line)
    if (obj === undefined || obj === null || typeof obj !== "object") return []
    if (!ps.itemTextLen) ps.itemTextLen = {}
    var events = []

    switch (obj.type) {
      case "thread.started":
        if (typeof obj.thread_id === "string" && obj.thread_id.length > 0) {
          events.push({ type: "session", sessionRef: obj.thread_id })
        }
        break
      case "turn.started":
        events.push({ type: "activity", activity: "thinking" })
        break
      case "item.started":
      case "item.updated":
      case "item.completed": {
        var item = obj.item || {}
        var itype = item.type
        if (itype === "agent_message" || itype === "reasoning") {
          var full = typeof item.text === "string" ? item.text : ""
          var key = String(item.id || itype)
          var prevLen = ps.itemTextLen[key] || 0
          if (full.length > prevLen) {
            var delta = full.slice(prevLen)
            ps.itemTextLen[key] = full.length
            if (itype === "agent_message") {
              events.push({ type: "text", text: delta })
              ps.finalText = full
            } else {
              events.push({ type: "activity", activity: "thinking" })
            }
          }
        } else if (itype === "web_search") {
          events.push({ type: "tool", tool: "web_search" })
          events.push({ type: "activity", activity: "searching" })
        } else if (itype === "command_execution" || itype === "mcp_tool_call" || itype === "file_change") {
          events.push({ type: "activity", activity: "thinking" })
        } else if (itype === "error") {
          events.push({ type: "error", message: String(item.message || "Codex reported an error") })
        }
        break
      }
      case "turn.completed":
        ps.sawTurnCompleted = true
        break
      case "turn.failed":
        events.push({ type: "error", message: String((obj.error && obj.error.message) || "Codex turn failed") })
        break
      case "error":
        events.push({ type: "error", message: String(obj.message || "Codex reported an error") })
        break
      default:
        break
    }
    return events
  },

  classifyFailure: function(exitCode, stderrText) {
    var s = String(stderrText || "")
    var lower = s.toLowerCase()
    if (lower.indexOf("usage limit") !== -1 || lower.indexOf("quota") !== -1 || lower.indexOf("credits") !== -1) {
      return { message: "Codex usage limit reached", kind: "quota" }
    }
    if (lower.indexOf("not logged in") !== -1 || lower.indexOf("authentication") !== -1) {
      return { message: "Codex authentication required", kind: "auth" }
    }
    return classifyGeneric(s)
  }
}

// ------------------------------------------------------------ Antigravity --

var agyAdapter = {
  id: "agy",
  label: "Antigravity",
  binary: "agy",
  // LOCAL MODIFICATION (this machine only, not upstream). Upstream disables
  // agy for headless runs because a single invocation cannot be kept away
  // from agy's MCP servers and plugins (--mode plan --sandbox limits edits
  // and the terminal, not MCP), so this field normally reads:
  //
  //   disabledReason: "Antigravity is disabled for AI search: its headless
  //   run cannot be kept away from MCP servers and plugins. Use claude, codex
  //   or pi (set \"agent\" in ~/.local/state/omarchy-menu-omni/ai.json).",
  //
  // Removing it is safe here because `agy mcp list` and `agy plugin list` are
  // both empty on this machine: the headless run has nothing to reach for.
  // If MCP servers or plugins are ever added to agy, restore the field above.
  // `omarchy plugin update` overwrites this file and brings the gate back.
  capabilities: {
    continuity: "caller-id",
    modelOverride: true,
    webSearchDetection: false,
    resumeBeforeExit: false
  },

  createSessionRef: function() { return uuidv4() },

  // Flag-order gotcha (verified against the real CLI): --print/--prompt is a
  // VALUE-TAKING flag, not a boolean switch — "Alias for --print" per
  // `agy --help`. Putting a positional prompt after `--print --conversation
  // <uuid> ...` makes --print swallow the literal string "--conversation" as
  // the prompt and every other token becomes a stray positional, so agy runs
  // with a garbage prompt (confirmed via a real transcript inspection: the
  // model actually received "--conversation" as its request). The prompt
  // MUST be the argv element immediately following --print.
  buildRun: function(prompt, sessionRef, config) {
    var argv = ["agy", "--conversation", sessionRef, "--print", prompt, "--output-format", "stream-json"]
    // Plan mode: agy answers but does not act -- asked to write a file or
    // run a command it drafts a plan and waits for an approval that never
    // comes in print mode. --sandbox restricts its terminal on top.
    argv.push("--mode", "plan", "--sandbox")
    if (config && config.model) argv.push("--model", config.model)
    if (config && config.effort) argv.push("--effort", config.effort)
    return argv
  },

  buildResume: function(sessionRef, config) {
    var argv = ["agy", "--conversation", sessionRef]
    if (resumeModel(config)) argv.push("--model", resumeModel(config))
    return argv
  },

  // Schema verified against a real successful `agy --conversation <uuid>
  // --print '<prompt>' --output-format stream-json` run (corrected argv
  // order above):
  //   {"event":"init","conversation_id":"...","init":{...}}
  //   {"event":"step_update","step_update":{"conversation_id":"...","step_index":0,"state":"DONE","step_type":"user_input"}}
  //   {"event":"step_update","step_update":{...,"step_type":"checkpoint","duration_seconds":...}}
  //   {"event":"step_update","step_update":{...,"step_type":"agent_response","text_delta":"OK\n",...}}
  //   {"event":"result","result":{"conversation_id":"...","status":"SUCCESS","response":"OK\n",...}}
  //
  // Confirmed 4/4: agy does NOT honor the caller-supplied --conversation
  // uuid — it silently substitutes its own id and only warns on stderr
  // ("conversation \"<uuid>\" not found"). The init event's conversation_id
  // is therefore the ONLY authoritative sessionRef; it always overrides
  // whatever caller-generated uuid seeded buildRun's argv.
  parseLine: function(line, ps) {
    var obj = safeParse(line)
    if (obj === undefined || obj === null || typeof obj !== "object") return []
    var events = []
    var kind = obj.event

    if (kind === "init") {
      if (typeof obj.conversation_id === "string" && obj.conversation_id.length > 0) {
        events.push({ type: "session", sessionRef: obj.conversation_id })
      }
      events.push({ type: "activity", activity: "thinking" })
      return events
    }

    if (kind === "step_update" && obj.step_update && typeof obj.step_update === "object") {
      var step = obj.step_update
      if (step.step_type === "agent_response") {
        if (typeof step.text_delta === "string" && step.text_delta.length > 0) {
          events.push({ type: "text", text: step.text_delta })
          ps.finalText = (ps.finalText || "") + step.text_delta
        }
      } else if (step.step_type === "tool_call" || step.step_type === "tool_use") {
        var toolName = String(step.tool || step.name || "").toLowerCase()
        if (toolName.indexOf("search") !== -1 || toolName.indexOf("web") !== -1) {
          events.push({ type: "tool", tool: "web_search" })
          events.push({ type: "activity", activity: "searching" })
        } else {
          events.push({ type: "activity", activity: "thinking" })
        }
      } else {
        events.push({ type: "activity", activity: "thinking" })
      }
      return events
    }

    if (kind === "result") {
      var result = obj.result || {}
      if (typeof result.response === "string" && result.response.length > 0) {
        ps.finalText = result.response
      }
      if (result.status && result.status !== "SUCCESS") {
        events.push({ type: "error", message: String(result.error || result.message || "Antigravity reported an error") })
      }
      return events
    }

    if (kind === "error") {
      events.push({ type: "error", message: String(obj.message || obj.error || "Antigravity reported an error") })
      return events
    }

    return events
  },

  classifyFailure: function(exitCode, stderrText) {
    var s = String(stderrText || "")
    var lower = s.toLowerCase()
    if (lower.indexOf("no output produced") !== -1 && lower.indexOf("permission") !== -1) {
      return {
        message: "Antigravity needs interactive tool approval that headless mode can't grant for this prompt",
        kind: "permission"
      }
    }
    if (lower.indexOf("not found") !== -1 && lower.indexOf("conversation") !== -1) {
      return { message: "Antigravity conversation not found", kind: "continuity" }
    }
    return classifyGeneric(s)
  }
}

// --------------------------------------------------------------- OpenCode ---

var opencodeAdapter = {
  id: "opencode",
  label: "OpenCode",
  binary: "opencode",
  // `opencode run` has no switch that verifiably takes its tools away
  // (`--agent plan` depends on that agent's configured permissions), so it is
  // not started headless from here. AiBackend turns this into an error row.
  disabledReason: "OpenCode is disabled for AI search: its headless run cannot be limited to read-only tools. " +
    "Use claude, codex or pi (set \"agent\" in ~/.local/state/omarchy-menu-omni/ai.json).",
  capabilities: {
    continuity: "returned-id",
    modelOverride: true,
    webSearchDetection: true,
    resumeBeforeExit: false
  },

  createSessionRef: function() { return null },

  buildRun: function(prompt, sessionRef, config) {
    if (config && config.model) {
      return ["opencode", "run", "--format", "json", "--model", config.model, prompt]
    }
    var script = 'M=$(sqlite3 ~/.local/share/opencode/opencode.db "SELECT json_extract(model, \'$.providerID\') || \'/\' || json_extract(model, \'$.id\') FROM session WHERE model IS NOT NULL ORDER BY time_updated DESC LIMIT 1;" 2>/dev/null); if [ -n "$M" ]; then exec opencode run --format json --model "$M" "$1"; else exec opencode run --format json "$1"; fi'
    return ["sh", "-c", script, "sh", prompt]
  },

  buildResume: function(sessionRef, config) {
    var argv = ["opencode", "--session", sessionRef]
    if (resumeModel(config)) argv.push("--model", resumeModel(config))
    return argv
  },

  parseLine: function(line, ps) {
    var obj = safeParse(line)
    if (obj === undefined || obj === null || typeof obj !== "object") return []
    var events = []

    if (typeof obj.sessionID === "string" && obj.sessionID.length > 0 && !ps.sessionCaptured) {
      ps.sessionCaptured = true
      events.push({ type: "session", sessionRef: obj.sessionID })
    }

    if (obj.type === "step_start") {
      events.push({ type: "activity", activity: "thinking" })
    } else if (obj.type === "message.part.updated" && obj.properties && obj.properties.part) {
      var part = obj.properties.part
      if (part.type === "text" && typeof part.text === "string") {
        var full = part.text
        var prevLen = ps.lastTextLen || 0
        if (full.length > prevLen) {
          var delta = full.slice(prevLen)
          ps.lastTextLen = full.length
          events.push({ type: "text", text: delta })
          ps.finalText = full
        }
      } else if (part.type === "web_search" || part.type === "tool") {
        events.push({ type: "tool", tool: "web_search" })
        events.push({ type: "activity", activity: "searching" })
      }
    } else if (obj.type === "text") {
      var textVal = (obj.part && typeof obj.part.text === "string")
        ? obj.part.text
        : (typeof obj.text === "string" ? obj.text : "")
      if (textVal.length > 0) {
        var prevLen = ps.lastTextLen || 0
        if (textVal.length > prevLen) {
          var delta = textVal.slice(prevLen)
          ps.lastTextLen = textVal.length
          events.push({ type: "text", text: delta })
          ps.finalText = textVal
        } else if (prevLen === 0) {
          events.push({ type: "text", text: textVal })
          ps.lastTextLen = textVal.length
          ps.finalText = textVal
        }
      }
    } else if (obj.type === "error") {
      var msg = (obj.error && obj.error.data && obj.error.data.message) ||
                (obj.error && obj.error.message) ||
                (typeof obj.error === "string" && obj.error) ||
                "OpenCode reported an error"
      events.push({ type: "error", message: String(msg) })
    }
    return events
  },

  classifyFailure: function(exitCode, stderrText) {
    var s = String(stderrText || "")
    var lower = s.toLowerCase()
    if (lower.indexOf("insufficient balance") !== -1 || lower.indexOf("billing") !== -1 || lower.indexOf("quota") !== -1) {
      return { message: "OpenCode usage limit reached", kind: "quota" }
    }
    if (lower.indexOf("not logged in") !== -1 || lower.indexOf("unauthorized") !== -1 || lower.indexOf("authentication") !== -1) {
      return { message: "OpenCode authentication required", kind: "auth" }
    }
    return classifyGeneric(s)
  }
}

// -------------------------------------------------------------------- Pi ---

var piAdapter = {
  id: "pi",
  label: "Pi",
  binary: "pi",
  capabilities: {
    // The session id lands in the very first NDJSON event and `pi
    // --session-id <id>` resumes it from the same working directory — see
    // the buildResume note below for the project-scoping caveat.
    continuity: "returned-id",
    modelOverride: true,
    webSearchDetection: false,
    resumeBeforeExit: false
  },

  createSessionRef: function() { return null },

  // Verified against real `pi -p '<prompt>' --mode json` runs: the prompt
  // must be the argv element immediately following -p (same value-taking
  // gotcha as agy's --print — a trailing positional after other options is
  // likewise bound correctly, but keeping -p+prompt adjacent removes any
  // ambiguity). Options are grouped BEFORE -p so --model can never be
  // mistaken for the prompt value.
  buildRun: function(prompt, sessionRef, config) {
    // --no-tools: pi answers from the model alone. It already covers
    // extension tools; --no-extensions and --no-skills keep extension code
    // and skills from loading into the run at all.
    var argv = ["pi", "--mode", "json", "--no-tools", "--no-extensions", "--no-skills"]
    if (config && config.model) argv.push("--model", config.model)
    if (config && config.effort) argv.push("--thinking", config.effort)
    argv.push("-p", prompt)
    return argv
  },

  // pi scopes session files per project (working directory). The overlay
  // spawns the agent with quickshell's cwd and xdg-terminal-exec resumes
  // with --dir=$HOME, and quickshell runs from $HOME (its service cwd), so
  // both sides resolve to the same project and the exact --session-id
  // lookup finds the file the headless run saved. If the shell were ever
  // started from elsewhere, resume would open a fresh session for that id
  // instead — same class of limitation as any per-project session store.
  buildResume: function(sessionRef, config) {
    var argv = ["pi", "--session-id", sessionRef]
    if (resumeModel(config)) argv.push("--model", resumeModel(config))
    return argv
  },

  // NDJSON schema captured from real `pi -p ... --mode json` runs:
  //   {"type":"session","id":"01a0...","cwd":"/home/user"}
  //   {"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"Hello"}}
  //   {"type":"turn_end","message":{...}} / {"type":"agent_end","messages":[...]}
  // text_delta events are already incremental (unlike codex's full-text
  // item updates) so each is emitted as-is. thinking/toolcall deltas are
  // surfaced as activity only, never as answer text. The authoritative
  // final answer lives in turn_end/agent_end message content — kept as a
  // fallback for AiBackend's defense-in-depth, never the primary path.
  parseLine: function(line, ps) {
    var obj = safeParse(line)
    if (obj === undefined || obj === null || typeof obj !== "object") return []
    var events = []
    var type = obj.type

    if (type === "session") {
      if (!ps.sessionCaptured && typeof obj.id === "string" && obj.id.length > 0) {
        ps.sessionCaptured = true
        events.push({ type: "session", sessionRef: obj.id })
      }
      return events
    }

    if (type === "turn_start") {
      ps.turnIndex = (ps.turnIndex || 0) + 1
      events.push({ type: "activity", activity: "thinking" })
      return events
    }

    if (type === "message_update" && obj.assistantMessageEvent && typeof obj.assistantMessageEvent === "object") {
      var se = obj.assistantMessageEvent
      if (se.type === "text_delta" && typeof se.delta === "string" && se.delta.length > 0) {
        events.push({ type: "text", text: se.delta })
      } else if (se.type === "thinking_start" || se.type === "thinking_delta" ||
                 se.type === "toolcall_start" || se.type === "toolcall_delta") {
        events.push({ type: "activity", activity: "thinking" })
      }
      return events
    }

    if (type === "turn_end" || type === "agent_end") {
      // turn_end -> obj.message (assistant message); agent_end ->
      // obj.messages (conversation array, last entry is the assistant
      // reply). Concatenate the type:"text" content parts only — thinking
      // and tool-call payloads never leak into the answer fallback.
      var msg = (type === "agent_end" && Array.isArray(obj.messages))
        ? obj.messages[obj.messages.length - 1]
        : obj.message
      if (msg && Array.isArray(msg.content)) {
        var full = ""
        for (var i = 0; i < msg.content.length; i++) {
          var part = msg.content[i]
          if (part && part.type === "text" && typeof part.text === "string") full += part.text
        }
        if (full.length > 0) ps.finalText = full
      }
      return events
    }

    return events
  },

  classifyFailure: function(exitCode, stderrText) {
    return classifyGeneric(stderrText)
  }
}

// Local addition (omarchy-menu-omni): the web bridge. The answer comes from a
// chat tab that is already open inside the user's own Chrome, reached through
// a native messaging bridge (extension in ~/.local/share/omarchy-dsweb, host
// and client in ~/.local/bin). Asking from the launcher therefore costs no API
// tokens. The launcher still renders the answer itself: the `dsweb` client
// streams one JSON event per line over a unix socket, and the host diffs the
// page's full-text snapshots into the deltas this adapter forwards.
//
// Three things are deliberately not offered: a model override (each site has
// its own model picker), a web-search toggle (the page's own switch is used,
// never touched), and a terminal handoff (there is no CLI session to resume —
// the conversation stays in the browser tab).
//
// One adapter per site; the shape is identical, only the site id and the
// wording differ.
function webBridgeAdapter(spec) {
  return {
    id: spec.id,
    label: spec.label,
    binary: "dsweb",
    capabilities: {
      // No session id exists to hand to anything: every launcher question
      // continues the same web conversation, and the terminal continuation is
      // a status read-out rather than a resumed run.
      continuity: "none",
      modelOverride: false,
      webSearchDetection: false,
      resumeBeforeExit: false
    },

    createSessionRef: function() { return null },

    // The prompt is one argv element, passed to Quickshell's Process.command as
    // a literal: it is never assembled into a shell string, and the client
    // forwards it verbatim to the host over the socket. The site is named
    // explicitly so the bridge never has to guess which tab to drive.
    buildRun: function(prompt) {
      return ["dsweb", "-s", spec.site, "ask", prompt]
    },

    // Nothing to resume in a terminal. `dsweb status` is the honest answer
    // here: it reports whether the Chrome bridge is up instead of opening a
    // session that cannot exist.
    buildResume: function() {
      return ["dsweb", "status"]
    },

    // Exactly the lines the client writes (see the module docstring in
    // ~/.local/bin/dsweb; the two change together):
    //   {"type":"activity","activity":"thinking"}
    //   {"type":"text","text":"..."}   delta, appended in order
    //   {"type":"done"}                end of answer, nothing to show
    //   {"type":"error","message":"...","kind":"..."}
    parseLine: function(line, ps) {
      var obj = safeParse(line)
      if (obj === undefined || obj === null || typeof obj !== "object") return []
      var events = []
      if (obj.type === "text") {
        if (typeof obj.text === "string" && obj.text.length > 0) events.push({ type: "text", text: obj.text })
        return events
      }
      if (obj.type === "activity") {
        events.push({ type: "activity", activity: obj.activity === "searching" ? "searching" : "thinking" })
        return events
      }
      if (obj.type === "error") {
        events.push({ type: "error", message: webMessage(obj, spec.target) })
        return events
      }
      // "done", "status" and "probe" carry no answer text: the process exit
      // code is what tells AiBackend the run is over.
      return events
    },

    classifyFailure: function(exitCode, stderrText) {
      var text = String(stderrText || "")
      // The host's own failures reach stderr before any JSON event does, and
      // they name the fix better than a generic message can.
      if (/bridge is not running|not responding|restart Chrome/i.test(text)) {
        return { message: "The Chrome bridge is not running (start Chrome, then ask again)", kind: "bridge" }
      }
      if (/sign(ed)? in/i.test(text)) {
        return { message: "Sign in to " + spec.target + " in the Chrome tab, then ask again", kind: "auth" }
      }
      return classifyGeneric(stderrText)
    }
  }
}

// A short, actionable message per failure kind: the panel shows this text on
// its own, without the surrounding context a terminal would give.
var WEB_ERRORS = {
  auth: "Sign in to %T in the Chrome tab, then ask again",
  "no-composer": "Could not reach the %T chat box (reload that Chrome tab)",
  "no-content": "Could not reach the %T chat box (reload that Chrome tab)",
  challenge: "%T is showing a Cloudflare check (open that tab, pass it, then retry)",
  submit: "The %T page did not accept the question",
  "no-answer": "The %T page ended the turn without any answer text",
  timeout: "%T did not answer in time",
  bridge: "The Chrome bridge is not running (start Chrome, then ask again)",
  busy: "Another question is still running",
  cancel: "Question cancelled"
}

function webMessage(obj, target) {
  var kind = typeof obj.kind === "string" ? obj.kind : ""
  if (WEB_ERRORS[kind] !== undefined) return WEB_ERRORS[kind].replace("%T", target)
  var message = typeof obj.message === "string" ? obj.message : ""
  return message.length > 0 ? message : target + " bridge error"
}

var dswebAdapter = webBridgeAdapter({ id: "dsweb", label: "DeepSeek Web", site: "dsweb", target: "DeepSeek" })
var gptwebAdapter = webBridgeAdapter({ id: "gptweb", label: "ChatGPT Web", site: "gptweb", target: "ChatGPT" })
var grokwebAdapter = webBridgeAdapter({ id: "grokweb", label: "Grok Web", site: "grokweb", target: "Grok" })

var ADAPTERS = {
  claude: claudeAdapter,
  codex: codexAdapter,
  agy: agyAdapter,
  opencode: opencodeAdapter,
  pi: piAdapter,
  dsweb: dswebAdapter,
  gptweb: gptwebAdapter,
  grokweb: grokwebAdapter
}

// The model a terminal continuation should pin: only one the user chose
// explicitly (resumeModel), never the cheap launcher default.
function resumeModel(config) {
  if (!config) return null
  return config.resumeModel !== undefined ? config.resumeModel : config.model
}

function get(id) {
  return ADAPTERS[id] || null
}

