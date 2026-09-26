// Service worker: bridges the local native messaging host and the content
// script running inside the user's own chat tab. The host is the only thing
// that can send it commands; nothing from a web page reaches this code.
//
// One extension serves every site in SITES. The host tags each request with a
// site id, and the worker picks the tab, the file and the wording from that
// entry, so adding a site is a table row plus a content script.

const HOST = "com.omarchy.dsweb"
const RECONNECT_MS = 2000

const SITES = {
  dsweb: {
    label: "DeepSeek",
    match: "https://chat.deepseek.com/*",
    home: "https://chat.deepseek.com/",
    file: "content.js",
  },
  gptweb: {
    label: "ChatGPT",
    match: "https://chatgpt.com/*",
    home: "https://chatgpt.com/",
    file: "gpt.js",
  },
}

function siteOf(msg) {
  return SITES[msg && msg.site] || SITES.dsweb
}

let port = null
let connecting = false

function log(...args) {
  console.log("[web-bridge]", ...args)
}

function connect() {
  if (port || connecting) return
  connecting = true
  try {
    port = chrome.runtime.connectNative(HOST)
  } catch (e) {
    connecting = false
    log("connectNative threw:", String(e))
    scheduleReconnect()
    return
  }
  connecting = false
  port.onMessage.addListener(onHostMessage)
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError
    log("host disconnected:", err ? err.message : "(no error)")
    port = null
    scheduleReconnect()
  })
  log("connected to", HOST)
}

function scheduleReconnect() {
  // An alarm is the only timer that survives the worker being stopped, so it
  // is what brings the bridge back after a Chrome restart or a host crash.
  chrome.alarms.create("dsweb-reconnect", { delayInMinutes: RECONNECT_MS / 60000 })
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "dsweb-reconnect") connect()
})

chrome.runtime.onStartup.addListener(connect)
chrome.runtime.onInstalled.addListener(connect)
connect()

function send(obj) {
  if (!port) {
    log("no host port, dropping", obj && obj.op)
    return false
  }
  try {
    port.postMessage(obj)
    return true
  } catch (e) {
    log("postMessage failed:", String(e))
    port = null
    scheduleReconnect()
    return false
  }
}

async function targetTab(site) {
  const tabs = await chrome.tabs.query({ url: site.match })
  if (tabs.length === 0) return null
  const active = tabs.find((t) => t.active)
  if (active) return active
  return tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0]
}

const BUILD = chrome.runtime.getManifest().version

// The tab keeps whatever build was injected when it loaded, so a freshly
// updated extension has to reload it: the alternative is a page answering with
// selectors from an older release.
async function pingTab(tabId) {
  try {
    const reply = await chrome.tabs.sendMessage(tabId, { op: "ping" })
    return reply && reply.ok ? String(reply.build || "") : null
  } catch (e) {
    return null
  }
}

async function ensureContent(tabId, file) {
  if (await pingTab(tabId)) return true
  // Declarative content scripts only apply to pages loaded after install, so a
  // tab that was already open needs a manual injection.
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [file] })
  } catch (e) {
    return false
  }
  return (await pingTab(tabId)) !== null
}

async function deliver(msg) {
  const site = siteOf(msg)
  let tab = await targetTab(site)
  if (tab && tab.discarded) {
    // A discarded tab has no content script and cannot be messaged.
    await chrome.tabs.reload(tab.id)
    tab = null
    await new Promise((r) => setTimeout(r, 3000))
    tab = await targetTab(site)
  }
  if (!tab) {
    tab = await chrome.tabs.create({ url: site.home, active: false })
    // Give the SPA time to boot before its composer can be inspected.
    await new Promise((r) => setTimeout(r, 3500))
  }

  // A chat SPA in a background tab keeps its message list out of the layout
  // (DeepSeek parks the live list under display:none), so every selector the
  // content script uses comes back empty and the answer never arrives.
  // Bringing the tab forward is what makes the page render the way it does
  // for a person sitting in front of it.
  if (!tab.active) {
    try {
      await chrome.tabs.update(tab.id, { active: true })
      await new Promise((r) => setTimeout(r, 800))
    } catch (e) {
      // Tab went away; the sendMessage below reports it.
    }
  }

  let build = await pingTab(tab.id)
  if (build && build !== BUILD) {
    await chrome.tabs.reload(tab.id)
    await new Promise((r) => setTimeout(r, 4000))
    build = null
  }
  if (build === null && !(await ensureContent(tab.id, site.file))) {
    send({
      op: "error",
      id: msg.id,
      kind: "no-content",
      message: "The " + site.label + " tab did not accept the bridge script (try reloading that tab)",
    })
    return
  }
  try {
    await chrome.tabs.sendMessage(tab.id, msg)
  } catch (e) {
    send({ op: "error", id: msg.id, kind: "no-content", message: String(e) })
  }
}

// A chat SPA that has lost its message list (a half-finished reload, an
// extension update landing mid-stream) only recovers by loading again. This is
// the escape hatch for that, so nobody has to go find the tab by hand.
async function reloadTab(msg) {
  const site = siteOf(msg)
  const tab = await targetTab(site)
  if (!tab) {
    send({ op: "error", id: msg.id, kind: "no-composer", message: "No " + site.label + " tab is open" })
    return
  }
  try {
    await chrome.tabs.reload(tab.id)
  } catch (e) {
    send({ op: "error", id: msg.id, kind: "no-content", message: String(e) })
    return
  }
  await new Promise((r) => setTimeout(r, 4000))
  send({ op: "reloaded", id: msg.id, tabId: tab.id })
}

function onHostMessage(msg) {
  if (!msg || typeof msg !== "object") return
  switch (msg.op) {
    case "ping":
      send({ op: "pong", t: Date.now() })
      break
    case "hello":
      // The host announces itself on startup so the worker can prove it is
      // awake: without this reply the first question would time out whenever
      // the worker had been stopped in the meantime.
      connect()
      send({ op: "pong", t: Date.now(), hello: true })
      break
    case "reload":
      reloadTab(msg)
      break
    case "ask":
    case "probe":
    case "selftest":
    case "cancel":
      deliver(msg)
      break
    default:
      log("unknown op from host:", msg.op)
  }
}

// Content script -> host.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg !== "object") return
  if (msg.op === "snapshot") send({ ...msg, tabId: sender.tab ? sender.tab.id : null })
  else if (msg.op === "done" || msg.op === "error" || msg.op === "probe-result" || msg.op === "progress")
    send({ ...msg, tabId: sender.tab ? sender.tab.id : null })
})
