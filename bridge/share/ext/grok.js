// Runs inside x.com/i/grok or grok.com. Same contract as content.js (DeepSeek)
// and gpt.js (ChatGPT): type the prompt into the page's composer, submit it,
// report the assistant's answer as full-text snapshots, and let the host do
// the diffing.

(() => {
  const BUILD = (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getManifest) ? chrome.runtime.getManifest().version : "1.44"
  if (typeof window.__omarchyGrokwebRetire === "function") window.__omarchyGrokwebRetire()
  if (window.__omarchyGrokwebLoaded === BUILD) return
  window.__omarchyGrokwebLoaded = BUILD

  const SEL = {
    composer: [
      '[data-testid="grokInput"]',
      'div[data-testid="tweetTextarea_0"]',
      'div[role="textbox"][contenteditable="true"]',
      'div.ProseMirror[contenteditable="true"]',
      'form [contenteditable="true"]',
      '[contenteditable="true"][role="textbox"]',
      'textarea[placeholder*="Ask" i]',
      'textarea[placeholder*="Grok" i]',
      'textarea[aria-label*="Grok" i]',
      'textarea[aria-label*="Ask" i]',
      "form textarea",
      "textarea",
    ],
    submit: [
      'button[data-testid="grokSendButton"]',
      'button[data-testid="tweetButton"]',
      'button[aria-label*="Grok" i]',
      'button[aria-label*="Send" i]',
      'button[aria-label*="发送" i]',
      'button[type="submit"]',
      'div[role="button"][data-testid="grokSendButton"]',
      'div[role="button"][aria-label*="Send" i]',
    ],
    stop: [
      'button[data-testid="grokStopButton"]',
      'button[aria-label*="Stop" i]',
      '[aria-label*="Stop streaming" i]',
      'button[aria-label*="停止" i]',
      'button[aria-label*="停止生成" i]',
      '[aria-label*="停止" i]',
    ],
    answer: [
      'div:has(> * > * > * > * > * > * > button[aria-label*="复制" i])',
      'div:has(> * > * > * > * > * > * > button[aria-label*="Copy" i])',
      'div:has(> * > * > * > * > * > button[aria-label*="复制" i])',
      'div:has(> * > * > * > * > * > button[aria-label*="Copy" i])',
      '[data-testid="grokResponse"]',
      'div[data-testid="grok-response"]',
      '[data-testid="message-bubble"]',
      '[data-message-author-role="assistant"]',
      'div[data-message-role="assistant"]',
      'div[aria-label*="Grok response" i]',
      'article[data-testid^="conversation-turn"]',
      '.markdown',
      'div.prose',
    ],
    skip: [
      "[data-message-attribution]",
      '[aria-label="Response actions"]',
      "button",
      "svg",
      '[data-testid="like"]',
      '[data-testid="dislike"]',
      '[data-testid="copy"]',
      '[data-testid="share"]',
    ],
    thinking: [
      '[data-testid*="thought" i]',
      '[data-testid*="reason" i]',
      '[class*="thought" i]',
      '[class*="thinking" i]',
      '[class*="reasoning" i]',
    ],
    login: [
      'input[type="password"]',
      'a[href*="/i/flow/login"]',
      'a[href*="/login"]',
      'a[href*="/auth/login"]',
      'a[data-testid="loginButton"]',
    ],
  }

  const MAX_TEXT = 400000
  const POLL_MS = 250
  const HARD_LIMIT_MS = 240000

  function firstMatch(list, root = document) {
    for (const sel of list) {
      const el = root.querySelector(sel)
      if (el) return el
    }
    return null
  }

  function visible(el) {
    if (!el) return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }

  function box(el) {
    const r = el.getBoundingClientRect()
    return [Math.round(r.width), Math.round(r.height)]
  }

  function challenged() {
    const title = (document.title || "").toLowerCase()
    if (/just a moment|attention required|checking your browser/.test(title)) return true
    const text = (document.body && document.body.innerText ? document.body.innerText : "")
      .replace(/\s+/g, " ")
      .slice(0, 3000)
    return /verifying you are human|enable javascript and cookies|checking your browser/i.test(text)
  }

  function signedOut() {
    return /\/login|\/i\/flow\/login/i.test(location.pathname) || !!firstMatch(SEL.login)
  }

  function composer() {
    for (const sel of SEL.composer) {
      for (const el of document.querySelectorAll(sel)) if (visible(el)) return el
    }
    return null
  }

  function composerBox(el) {
    return el.closest("form") || el.closest('[data-testid="grokInput"]') || el.parentElement?.parentElement?.parentElement || el.parentElement
  }

  function composerText(el) {
    if (!el) return ""
    return el.tagName === "TEXTAREA" || el.tagName === "INPUT" ? el.value : el.innerText || ""
  }

  function inThinking(el) {
    for (const sel of SEL.thinking) {
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        if (!n.matches || !n.matches(sel)) continue
        if (String(n.className).includes("[")) continue
        return true
      }
    }
    return false
  }

  function skippable(el) {
    for (const sel of SEL.skip) if (el.matches && el.matches(sel)) return true
    return el.hasAttribute ? el.hasAttribute("hidden") : false
  }

  function stopButton() {
    for (const sel of SEL.stop) {
      for (const el of document.querySelectorAll(sel)) {
        if (visible(el)) return el
      }
    }
    return null
  }

  const NOT_SEND = /attach|upload|file|mic|voice|dictat|model|tool|reason|deep.?research|stop/i

  function sendButton(el) {
    const box = composerBox(el)
    if (!box) return null
    for (const sel of SEL.submit) {
      const candidates = [...box.querySelectorAll(sel)].reverse()
      for (const c of candidates) {
        if (!visible(c)) continue
        if (c.hasAttribute("disabled") || c.getAttribute("aria-disabled") === "true") continue
        if (c === el) continue
        const cls = typeof c.className === "string" ? c.className : ""
        if (NOT_SEND.test(cls)) continue
        if (NOT_SEND.test(c.getAttribute("aria-label") || "")) continue
        if (/\bdisabled\b/.test(cls)) continue
        return c
      }
    }
    return null
  }

  function sameText(a, b) {
    return (a || "").replace(/\s+/g, " ").trim() === (b || "").replace(/\s+/g, " ").trim()
  }

  function setComposerText(el, text) {
    el.focus()
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set
      setter.call(el, text)
      el.dispatchEvent(new Event("input", { bubbles: true }))
      el.dispatchEvent(new Event("change", { bubbles: true }))
      return true
    }
    if (!el.isContentEditable) return false

    const range = document.createRange()
    range.selectNodeContents(el)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)

    let ok = false
    try {
      if (text.includes("\n")) {
        const lines = text.split("\n")
        for (let i = 0; i < lines.length; i++) {
          if (i > 0) document.execCommand("insertLineBreak", false, null)
          if (lines[i]) document.execCommand("insertText", false, lines[i])
        }
        ok = true
      } else {
        ok = document.execCommand("insertText", false, text)
      }
    } catch (e) {
      ok = false
    }
    if (!ok || !sameText(composerText(el), text)) {
      el.textContent = text
      const opts = { bubbles: true, cancelable: true, inputType: "insertText", data: text }
      el.dispatchEvent(new InputEvent("beforeinput", opts))
      el.dispatchEvent(new InputEvent("input", opts))
    }
    return true
  }

  function pressEnter(el) {
    for (const type of ["keydown", "keypress", "keyup"]) {
      el.dispatchEvent(
        new KeyboardEvent(type, {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        })
      )
    }
  }

  const CODE_CHROME = /^(?:[\w+#.-]{1,20}\s*)?(?:(?:copy|run|download|edit|save|share|code|复制|运行|下载|编辑|代码)\s*)*$/i

  function chromeOnly(container, pre) {
    const whole = (container.innerText || "").replace(/\s+/g, " ").trim()
    const code = (pre.innerText || "").replace(/\s+/g, " ").trim()
    const rest = (code ? whole.split(code).join(" ") : whole).replace(/\s+/g, " ").trim()
    return rest.length < 40 && CODE_CHROME.test(rest)
  }

  let markMemo = []

  function toMarkdown(node, streaming) {
    const out = []
    const marks = []
    const emit = (s) => out.push(s)
    const fence = (code) => "\n```\n" + code.replace(/\n+$/, "") + "\n```\n"
    const pushCode = (code) => {
      if (!code.trim()) return
      marks.push({ at: out.length, text: code })
      out.push(fence(code))
    }
    const walk = (n) => {
      for (const child of n.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          emit(child.nodeValue.replace(/\s+/g, " "))
          continue
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue
        if (skippable(child)) continue
        const tag = child.tagName.toLowerCase()
        if (tag === "pre") {
          pushCode((child.querySelector("code") || child).innerText || "")
          continue
        }
        const inner = child.querySelector("pre")
        if (inner && chromeOnly(child, inner)) {
          pushCode((inner.querySelector("code") || inner).innerText || "")
          continue
        }
        if (tag === "code") {
          const t = child.innerText || ""
          if (t.trim()) {
            marks.push({ at: out.length, text: t })
            emit("`" + t + "`")
          }
          continue
        }
        if (/^h[1-6]$/.test(tag)) {
          emit("\n" + "#".repeat(Number(tag[1])) + " " + child.innerText.trim() + "\n")
          continue
        }
        if (tag === "li") {
          emit("\n- ")
          walk(child)
          continue
        }
        if (tag === "br") {
          emit("\n")
          continue
        }
        if (tag === "p" || tag === "div" || tag === "ul" || tag === "ol" || tag === "table" || tag === "tr") {
          if (out.length && !/\n$/.test(out[out.length - 1]) && !/[-*] $/.test(out[out.length - 1])) emit("\n")
          walk(child)
          if (tag === "p" || tag === "div" || tag === "tr") emit("\n")
          continue
        }
        walk(child)
      }
    }
    walk(node)
    let src = out.join("")
    if (streaming) {
      for (let i = 0; i < marks.length; i++) {
        if (marks[i].text === markMemo[i]) continue
        src = out.slice(0, marks[i].at).join("")
        break
      }
    }
    markMemo = marks.map((m) => m.text)
    return src
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  }

  function answerNodes() {
    for (const sel of SEL.answer) {
      const found = [...document.querySelectorAll(sel)].filter((el) => visible(el) && !inThinking(el))
      if (found.length) return found
    }
    return []
  }

  function answerNode() {
    const nodes = answerNodes()
    return nodes.length ? nodes[nodes.length - 1] : null
  }

  function isStreaming(node) {
    if (!node) return false
    if (stopButton()) return true
    try {
      if (node.querySelector && (node.querySelector(".result-streaming") || node.querySelector('[aria-busy="true"]'))) return true
      if (node.classList && (node.classList.contains("result-streaming") || node.getAttribute("aria-busy") === "true")) return true
      const container = node.closest ? (node.closest('[data-testid="grokResponse"]') || node.parentElement) : null
      if (container && (container.querySelector(".result-streaming") || container.querySelector('[aria-busy="true"]'))) return true
    } catch (e) {}
    return false
  }

  function turnFinished(node) {
    if (!node) return false
    if (isStreaming(node)) return false
    if (stopButton()) return false

    for (let p = node; p && p !== document.body; p = p.parentElement) {
      const btn = p.querySelector(
        'button[aria-label*="复制" i], button[aria-label*="Copy" i], button[aria-label*="分享" i], button[aria-label*="Share" i], button[aria-label*="重新生成" i], button[aria-label*="Regenerate" i], button[data-testid="copy"]'
      )
      if (btn && visible(btn)) return true
      if (p.children && p.children.length > 8) break
    }
    return false
  }

  function post(obj) {
    try {
      chrome.runtime.sendMessage(obj)
    } catch (e) {}
  }

  let active = null

  function finish(id, ok, message, kind) {
    if (!active || active.id !== id) return
    clearInterval(active.timer)
    active = null
    if (ok) post({ op: "done", id })
    else post({ op: "error", id, message, kind })
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  async function ask(id, prompt) {
    if (active) {
      clearInterval(active.timer)
      active = null
    }

    if (challenged()) {
      post({
        op: "error",
        id,
        message: "Grok is showing a verification check (pass it in Chrome, then retry)",
        kind: "challenge",
      })
      return
    }

    if (signedOut()) {
      post({
        op: "error",
        id,
        message: "Sign in to Grok in the Chrome tab, then ask again",
        kind: "auth",
      })
      return
    }

    const beforeNode = answerNode()
    const beforeId = beforeNode ? (beforeNode.getAttribute("data-message-id") || "") : ""
    const beforeText = beforeNode ? toMarkdown(beforeNode, false) : ""
    const beforeCount = answerNodes().length

    const box = composer()
    if (!box) {
      post({
        op: "error",
        id,
        message: "Could not find the Grok chat box (reload that Chrome tab)",
        kind: "no-composer",
      })
      return
    }

    if (!setComposerText(box, prompt)) {
      post({
        op: "error",
        id,
        message: "Could not type the prompt into Grok",
        kind: "no-composer",
      })
      return
    }
    const btn = sendButton(box)
    if (btn) btn.click()
    else pressEnter(box)

    let submitted = false
    for (let attempt = 0; attempt < 12 && !submitted; attempt++) {
      await sleep(400)
      if (stopButton()) submitted = true
      else {
        const live = composer()
        if (!live || !sameText(composerText(live), prompt)) submitted = true
        else if (attempt === 3) pressEnter(live)
      }
    }
    if (!submitted) {
      post({
        op: "error",
        id,
        message: "The Grok page did not accept the question",
        kind: "submit",
      })
      return
    }

    markMemo = []
    active = {
      id,
      last: "",
      lastChange: Date.now(),
      started: Date.now(),
      sawNew: false,
      beforeNode,
      beforeId,
      beforeText,
      beforeCount,
    }
    post({ op: "progress", id, activity: "thinking" })

    active.timer = setInterval(() => {
      const a = active
      if (!a || a.id !== id) return
      const node = answerNode()
      const nodeId = node ? (node.getAttribute("data-message-id") || "") : ""
      const text = node ? toMarkdown(node, true).slice(0, MAX_TEXT) : ""

      if (!a.sawNew) {
        const isNewNode = a.beforeNode ? (node && node !== a.beforeNode) : !!node
        const countGrew = answerNodes().length > a.beforeCount
        const textDiffers = node && text && a.beforeText && text !== a.beforeText && !a.beforeText.startsWith(text)
        const isGenerating = !!stopButton() || isStreaming(node)

        if (countGrew || isNewNode || textDiffers || isGenerating) {
          a.sawNew = true
        }
      }

      if (!a.sawNew) {
        if (Date.now() - a.started > HARD_LIMIT_MS) {
          finish(id, false, "Grok did not start its answer in time", "timeout")
        }
        return
      }

      const stop = stopButton()
      const streaming = isStreaming(node)
      const turnDone = turnFinished(node)
      const done = !stop && !streaming

      if (text.indexOf(a.last) === 0 && text !== a.last) {
        a.last = text
        a.lastChange = Date.now()
        if (text) post({ op: "snapshot", id, text })
      } else if (text !== a.last && text.length > a.last.length) {
        a.last = text
        a.lastChange = Date.now()
        if (text) post({ op: "snapshot", id, text })
      }

      a.doneStreak = done ? (a.doneStreak || 0) + 1 : 0

      const minStable = turnDone ? 1500 : 3000
      const minStreak = turnDone ? 3 : 6
      const settled = Date.now() - a.lastChange > minStable

      if (a.sawNew && !streaming && ((turnDone && settled) || (a.doneStreak >= minStreak && settled))) {
        const full = node ? toMarkdown(node, false).slice(0, MAX_TEXT) : ""
        if (full && full !== a.last) {
          a.last = full
          post({ op: "snapshot", id, text: full })
        }
        if (!a.last) {
          finish(id, false, "The page finished the turn without any answer text", "no-answer")
          return
        }
        finish(id, true)
        return
      }
      if (Date.now() - a.started > HARD_LIMIT_MS) {
        finish(id, false, "Grok did not finish its answer in time", "timeout")
      }
    }, POLL_MS)
  }

  function cancel(id) {
    const stop = stopButton()
    if (stop) stop.click()
    if (active) {
      clearInterval(active.timer)
      active = null
    }
    post({ op: "done", id, cancelled: true })
  }

  function describe(el) {
    if (!el) return null
    const r = el.getBoundingClientRect()
    const cls = typeof el.className === "string" ? el.className : ""
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      cls: cls.slice(0, 90),
      clsFull: cls.slice(0, 400),
      disabledClass: /\bdisabled\b/.test(cls),
      disabled: el.hasAttribute ? el.hasAttribute("disabled") : false,
      testid: el.getAttribute ? el.getAttribute("data-testid") : null,
      aria: el.getAttribute ? el.getAttribute("aria-label") : null,
      text: (el.innerText || "").replace(/\s+/g, " ").slice(0, 40),
      placeholder: el.getAttribute ? el.getAttribute("placeholder") : null,
      role: el.getAttribute ? el.getAttribute("role") : null,
      editable: !!el.isContentEditable,
      box: [Math.round(r.width), Math.round(r.height)],
    }
  }

  function probe(id) {
    const el = composer()
    const btn = el ? sendButton(el) : null
    const answers = answerNodes()
    const last = answers[answers.length - 1] || null
    const chain = []
    for (let n = el, i = 0; n && i < 6; n = n.parentElement, i++) chain.push(describe(n))
    const data = {
      site: "grokweb",
      build: BUILD,
      url: location.href,
      title: document.title,
      challenged: challenged(),
      signedInHint: !signedOut(),
      passwordInputs: document.querySelectorAll('input[type="password"]').length,
      bodySample: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 300),
      composer: describe(el),
      composerChain: chain,
      composerSiblings: el
        ? [...composerBox(el).querySelectorAll('div[role="button"], button')].slice(-12).map(describe)
        : [],
      sendButton: describe(btn),
      stopButton: describe(stopButton()),
      allTextareas: [...document.querySelectorAll("textarea")].slice(0, 5).map(describe),
      allEditable: [...document.querySelectorAll('[contenteditable="true"]')].slice(0, 5).map(describe),
      buttons: [...document.querySelectorAll('div[role="button"], button, [data-testid], [aria-label]')]
        .filter(visible)
        .slice(0, 40)
        .map(describe),
      answerCount: answers.length,
      answerDebug: SEL.answer.map((sel) => ({
        sel: sel,
        n: document.querySelectorAll(sel).length,
        rejected: [...document.querySelectorAll(sel)].slice(0, 4).map((el) => ({
          box: box(el),
          text: (el.innerText || "").replace(/\s+/g, " ").slice(0, 40),
        })),
      })),
      lastAnswer: describe(last),
      lastAnswerText: last ? toMarkdown(last).slice(0, 600) : "",
      lastAnswerHtml: last ? last.outerHTML.slice(0, 4000) : "",
      testStreaming: isStreaming(last),
      testTurnDone: turnFinished(last),
      viewport: [window.innerWidth, window.innerHeight],
    }
    post({ op: "probe-result", id, data })
  }

  function applyOverrides(sel) {
    if (!sel || typeof sel !== "object") return
    for (const key of Object.keys(SEL)) {
      const list = sel[key]
      if (Array.isArray(list) && list.length && list.every((s) => typeof s === "string")) {
        SEL[key] = list
      }
    }
  }

  const onMessage = (msg, sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return
    switch (msg.op) {
      case "ping":
        sendResponse({ ok: true, build: BUILD, site: "grokweb" })
        return false
      case "ask":
        applyOverrides(msg.sel)
        ask(msg.id, String(msg.prompt || ""))
        sendResponse({ ok: true })
        return false
      case "cancel":
        cancel(msg.id)
        sendResponse({ ok: true })
        return false
      case "probe":
        applyOverrides(msg.sel)
        probe(msg.id)
        sendResponse({ ok: true })
        return false
      case "selftest":
        applyOverrides(msg.sel)
        selftest(msg.id)
        sendResponse({ ok: true })
        return false
      default:
        return false
    }
  }

  async function selftest(id) {
    const out = { site: "grokweb", build: BUILD, url: location.href, steps: [] }
    const el = composer()
    out.composer = describe(el)
    out.challenged = challenged()
    out.signedInHint = !signedOut()
    if (!el) {
      out.steps.push("no composer found")
    } else {
      const box = composerBox(el)
      out.box = describe(box)
      const text = "omarchy bridge self test"
      out.setReturned = setComposerText(el, text)
      await sleep(600)
      out.afterSet = {
        value: composerText(el).slice(0, 60),
        accepted: composerText(el).trim() === text.trim(),
        send: describe(sendButton(el)),
      }
      out.boxButtons = [...box.querySelectorAll('div[role="button"], button, [data-testid], [aria-label]')].map(describe)
      setComposerText(el, "")
      await sleep(400)
      out.afterClear = { value: composerText(el).slice(0, 60), cleared: composerText(el).trim() === "" }
    }
    post({ op: "probe-result", id, data: { selftest: out } })
  }

  chrome.runtime.onMessage.addListener(onMessage)
  window.__omarchyGrokwebRetire = () => {
    try {
      chrome.runtime.onMessage.removeListener(onMessage)
    } catch (e) {}
    if (active) {
      clearInterval(active.timer)
      active = null
    }
  }
})()
