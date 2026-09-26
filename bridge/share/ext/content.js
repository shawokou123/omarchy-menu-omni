// Runs inside chat.deepseek.com. Types the prompt into the page's own composer,
// submits it, and reports the assistant's answer back as full-text snapshots.
// The host side diffs consecutive snapshots, so this file stays dumb.
//
// Selectors are the fragile part of this bridge: DeepSeek ships obfuscated
// class names that change between releases. Everything page-specific is
// therefore collected in SEL below, with layered fallbacks, and `probe`
// exists to re-calibrate them against a live page.

(() => {
  const BUILD = "__BUILD__" // rewritten to the manifest version when packing
  // A fresh injection into a page that already carries an older build must
  // retire that build's listener, or both would answer the same question.
  if (typeof window.__omarchyDswebRetire === "function") window.__omarchyDswebRetire()
  if (window.__omarchyDswebLoaded === BUILD) return
  window.__omarchyDswebLoaded = BUILD

  const SEL = {
    composer: [
      "textarea#chat-input",
      "textarea[placeholder]",
      'div[contenteditable="true"][role="textbox"]',
      "textarea",
      '[contenteditable="true"]',
    ],
    // The send button on chat.deepseek.com is a round icon button
    // (ds-button--circle) at the end of the composer row. Anything that looks
    // like a mode switch is excluded below: clicking "deep think" by accident
    // would change the user's page settings.
    submit: [
      'div[role="button"][class*="send" i]',
      '[aria-label*="send" i][role="button"]',
      '[aria-label*="发送"]',
      'button[type="submit"]',
      'div[role="button"][class*="circle"]',
    ],
    stop: [
      'div[role="button"][class*="stop" i]',
      'div[role="button"][aria-label*="stop" i]',
      '[aria-label*="Stop" i]',
      '[aria-label*="停止"]',
      '[class*="stop" i][role="button"]',
    ],
    answer: [".ds-markdown", '[class*="markdown"]'],
    // Reasoning blocks are named in the DOM; their text must not be mistaken
    // for the answer.
    thinking: ['[class*="thinking" i]', '[class*="reason" i]', '[class*="thought" i]'],
    login: ['input[type="password"]', 'form[action*="login"]'],
  }

  const MAX_TEXT = 400000
  const POLL_MS = 250
  // Long enough that a stall in the stream is not mistaken for the end of the
  // answer: the panel would truncate what it already showed.
  const STABLE_MS = 2000
  const HARD_LIMIT_MS = 240000
  const SUBMIT_GRACE_MS = 2500

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

  // The sign-in page is the one reliable signal that nobody is logged in:
  // class names are obfuscated, but the route is not.
  function signedOut() {
    return /\/sign_in|\/login/i.test(location.pathname) || !!firstMatch(SEL.login)
  }

  function composer() {
    for (const sel of SEL.composer) {
      for (const el of document.querySelectorAll(sel)) if (visible(el)) return el
    }
    return null
  }

  function composerBox(el) {
    // The send button sits in the same row/container as the composer.
    return el.closest("form") || el.parentElement?.parentElement?.parentElement || el.parentElement
  }

  function composerText(el) {
    if (!el) return ""
    return el.tagName === "TEXTAREA" || el.tagName === "INPUT" ? el.value : el.innerText || ""
  }

  function inThinking(el) {
    for (const sel of SEL.thinking) if (el.closest(sel)) return true
    return false
  }

  function stopButton() {
    for (const sel of SEL.stop) {
      for (const el of document.querySelectorAll(sel)) {
        if (visible(el)) return el
      }
    }
    return null
  }

  // Mode switches ("deep think", web search, attachments) must never be
  // clicked: they change the user's own page settings.
  const NOT_SEND = /iconLabel|deep.?think|reason|search|web|attach|upload|file|mic|voice|stop/i

  function sendButton(el) {
    const box = composerBox(el)
    if (!box) return null
    for (const sel of SEL.submit) {
      const candidates = [...box.querySelectorAll(sel)].reverse()
      for (const c of candidates) {
        if (!visible(c)) continue
        if (c.hasAttribute("disabled")) continue
        if (c === el) continue
        const cls = typeof c.className === "string" ? c.className : ""
        if (NOT_SEND.test(cls)) continue
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
      // React tracks its own value: assigning through the prototype setter and
      // then firing `input` is what makes the framework see the change.
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set
      setter.call(el, text)
      el.dispatchEvent(new Event("input", { bubbles: true }))
      return true
    }
    if (el.isContentEditable) {
      const range = document.createRange()
      range.selectNodeContents(el)
      const sel = window.getSelection()
      sel.removeAllRanges()
      sel.addRange(range)
      const ok = document.execCommand("insertText", false, text)
      if (!ok) {
        el.textContent = text
        el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }))
      }
      return true
    }
    return false
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

  // DeepSeek renders answers as markdown in the DOM; turn the block back into
  // markdown so the launcher's markdown renderer keeps code fences and lists.
  //
  // `streaming` drops a trailing code block. The host turns consecutive
  // snapshots into appended deltas, so each snapshot has to be a prefix of the
  // next: a fence that closes over half-typed code and then reopens is not,
  // and the panel would show the block twice. A trailing fence is therefore
  // withheld until the answer moves on to something else, or finishes.
  // Text that a code-block wrapper carries beside the code itself. Anything
  // else in the container means the container holds real content too, and
  // collapsing it to the code would throw that content away.
  const CODE_CHROME = /^(?:[\w+#.-]{1,20}\s*)?(?:(?:copy|run|download|edit|save|share|code|复制|运行|下载|编辑|代码)\s*)*$/i

  function chromeOnly(container, pre) {
    const whole = (container.innerText || "").replace(/\s+/g, " ").trim()
    const code = (pre.innerText || "").replace(/\s+/g, " ").trim()
    const rest = (code ? whole.split(code).join(" ") : whole).replace(/\s+/g, " ").trim()
    return rest.length < 40 && CODE_CHROME.test(rest)
  }

  // Code blocks seen in the previous snapshot of the answer in progress, by
  // position. A block that is still being written is rewritten in place
  // between two snapshots, and a snapshot that is not an extension of the last
  // one makes the host resend the whole answer, duplicating it in the panel.
  let markMemo = []

  function toMarkdown(node, streaming) {
    const out = []
    // Every piece of verbatim text that the page rewrites in place while the
    // answer streams: code blocks and inline code. A snapshot may only be
    // published up to the first one of these that has changed.
    const marks = []
    const emit = (s) => out.push(s)
    const fence = (code) => "\n```\n" + code.replace(/\n+$/, "") + "\n```\n"
    // An empty <pre> is the page's placeholder for a code block that has not
    // started arriving. A fence for it would make the next snapshot unrelated
    // to this one, so it is left out entirely.
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
        const tag = child.tagName.toLowerCase()
        if (tag === "pre") {
          pushCode((child.querySelector("code") || child).innerText || "")
          continue
        }
        // A code block comes wrapped in a container that also holds the
        // language label and the copy/download buttons. Take the code and drop
        // the chrome, but only when the chrome is all the container carries.
        const inner = child.querySelector("pre")
        if (inner && chromeOnly(child, inner)) {
          pushCode((inner.querySelector("code") || inner).innerText || "")
          continue
        }
        if (tag === "code") {
          // Inline code grows a character at a time while the answer streams,
          // and it grows in the middle of a line: it has to be held back the
          // same way, or every snapshot that catches it half-written stops
          // extending the one before it.
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
          // A block right after a list marker continues that item's line.
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
        // Still growing: withhold it and everything after it, so the next
        // snapshot is an extension of this one. Code is written before the
        // prose that follows it, so nothing before it can change again.
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

  // Answer blocks, newest last. Blocks inside a reasoning ("deep think")
  // section are skipped: only the polished answer is wanted.
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

  function answerText() {
    const node = answerNode()
    if (!node) return ""
    const md = toMarkdown(node)
    return md.length > MAX_TEXT ? md.slice(0, MAX_TEXT) : md
  }

  function post(obj) {
    try {
      chrome.runtime.sendMessage(obj)
    } catch (e) {
      /* extension context invalidated: nothing useful to do */
    }
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
    // The host never starts a second question while one is live, so a run that
    // is still marked active long past the hard limit is a corpse: its timer
    // died with the tab's throttling or its client vanished before the cancel
    // arrived. Take it over rather than refuse every question from then on.
    if (active && Date.now() - active.started > HARD_LIMIT_MS) {
      clearInterval(active.timer)
      active = null
    }
    if (active) {
      post({ op: "error", id, message: "another question is still running", kind: "busy" })
      return
    }
    const box = composer()
    if (!box) {
      const out = signedOut()
      post({
        op: "error",
        id,
        kind: out ? "auth" : "no-composer",
        message: out
          ? "DeepSeek is not signed in in that Chrome tab"
          : "Could not find the DeepSeek message box",
      })
      return
    }

    const before = answerNode()
    const beforeText = before ? toMarkdown(before) : ""
    const beforeCount = answerNodes().length

    if (!setComposerText(box, prompt)) {
      post({ op: "error", id, message: "Could not type into the DeepSeek message box", kind: "no-composer" })
      return
    }
    await sleep(150)
    if (!sameText(composerText(box), prompt)) {
      post({ op: "error", id, message: "The DeepSeek page did not take the question text", kind: "no-composer" })
      return
    }
    const btn = sendButton(box)
    if (btn) btn.click()
    else pressEnter(box)

    // The first question of a conversation moves the page to /a/chat/s/<id>,
    // which rebuilds the composer. "Did the text go away" therefore has to be
    // asked about the composer on the page now, not the one typed into: the
    // detached node keeps its value and would look like a failed submit.
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
        message: "The DeepSeek page did not accept the question",
        kind: "submit",
      })
      return
    }

    markMemo = []
    // The turn that is on the page before the question, kept on the run so the
    // poll and the probe can both tell it apart from the answer that follows.
    active = {
      id,
      last: "",
      lastChange: Date.now(),
      started: Date.now(),
      sawNew: false,
      before,
      beforeText,
      beforeCount,
    }
    post({ op: "progress", id, activity: "thinking" })

    active.timer = setInterval(() => {
      const a = active
      if (!a || a.id !== id) return
      const node = answerNode()
      const stop = stopButton()
      const done = !stop
      // The last sample of a finished turn is converted with everything in it,
      // so the withheld code block arrives with the closing snapshot.
      // Always streaming: the hold-back is what keeps a half-rendered code
      // block out of the panel, and a published stump can never be repaired,
      // because the panel only appends and the finished block does not extend
      // it. Nothing is lost by never turning the hold-back off, since an answer
      // that is really over stops changing and its whole text then passes the
      // comparison on the next poll — which is why `done` is not consulted here.
      const text = node ? toMarkdown(node, true).slice(0, MAX_TEXT) : ""
      // Until the answer of *this* question shows up, the last assistant turn
      // on the page is still the previous one, and publishing it would put the
      // old answer in the panel before the new one starts. Three signals say a
      // new turn is here, and each covers a case the others miss: a longer
      // message list (the usual one), a stop button that only exists while the
      // page generates, and text that differs from the previous answer. The
      // last one has to stand on its own, because a page may stream the new
      // answer into the very node that held the old one rather than appending
      // a turn, and then nothing else about the page has changed yet.
      if (answerNodes().length > a.beforeCount || stop || text !== a.beforeText) {
        a.sawNew = true
      }
      // The panel only appends, so a snapshot has to extend the one before it.
      // A shorter or rewritten sample is a code block caught half-written, or
      // the end-of-turn marker flipping for a moment. Publishing it would make
      // the host resend the whole answer and show it twice, so it is held
      // back; the next poll normally extends properly, and if none ever does,
      // the run ends with the last good sample.
      if (a.sawNew && text.indexOf(a.last) === 0 && text !== a.last) {
        a.last = text
        a.lastChange = Date.now()
        if (text) post({ op: "snapshot", id, text })
      }
      // The end-of-turn signal is "the stop button is gone", sampled twice a
      // second, and it flickers while the page re-renders. Only a run of them
      // counts as the answer being over.
      a.doneStreak = done ? (a.doneStreak || 0) + 1 : 0
      const settled = Date.now() - a.lastChange > STABLE_MS
      if (a.sawNew && a.doneStreak >= 3 && settled) {
        // One last conversion with the hold-back off. An answer that opens
        // with a code block is withheld in full while that block streams, so
        // without this the run would end having published nothing at all.
        const full = node ? toMarkdown(node, false).slice(0, MAX_TEXT) : ""
        if (full && full.indexOf(a.last) === 0 && full !== a.last) {
          a.last = full
          post({ op: "snapshot", id, text: full })
        }
        // The turn arrived, so an empty run now means the page rendered no
        // answer text at all: an error, never a successful answer of nothing.
        if (!a.last) {
          finish(id, false, "The page finished the turn without any answer text", "no-answer")
          return
        }
        finish(id, true)
        return
      }
      if (Date.now() - a.started > HARD_LIMIT_MS) {
        finish(id, false, "DeepSeek did not finish its answer in time", "timeout")
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
      aria: el.getAttribute("aria-label"),
      text: (el.innerText || "").replace(/\s+/g, " ").slice(0, 40),
      placeholder: el.getAttribute("placeholder"),
      role: el.getAttribute("role"),
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
      build: BUILD,
      url: location.href,
      title: document.title,
      signedInHint: !signedOut(),
      passwordInputs: document.querySelectorAll('input[type="password"]').length,
      bodySample: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 200),
      composer: describe(el),
      composerChain: chain,
      composerSiblings: el
        ? [...composerBox(el).querySelectorAll('div[role="button"], button')].slice(-12).map(describe)
        : [],
      sendButton: describe(btn),
      stopButton: describe(stopButton()),
      allTextareas: [...document.querySelectorAll("textarea")].slice(0, 5).map(describe),
      allEditable: [...document.querySelectorAll('[contenteditable="true"]')].slice(0, 5).map(describe),
      buttons: [...document.querySelectorAll('div[role="button"], button, [aria-label]')]
        .filter(visible)
        .slice(0, 40)
        .map(describe),
      answerCounts: {
        dsMarkdown: document.querySelectorAll(".ds-markdown").length,
        markdown: document.querySelectorAll('[class*="markdown"]').length,
        message: document.querySelectorAll('[class*="message"]').length,
      },
      answerCount: answers.length,
      // What the live run itself has seen, so a run that publishes nothing can
      // be explained from the probe instead of guessed at.
      run: active
        ? {
            id: active.id,
            sawNew: !!active.sawNew,
            lastLen: (active.last || "").length,
            elapsed: Math.round((Date.now() - active.started) / 1000),
            beforeCount: active.beforeCount,
            beforeLen: (active.beforeText || "").length,
            answers: answers.length,
            stop: !!stopButton(),
            sameNode: last === active.before,
            textIsBefore: last ? toMarkdown(last) === active.beforeText : false,
          }
        : null,
      lastAnswer: describe(last),
      lastAnswerText: last ? toMarkdown(last).slice(0, 600) : "",
      lastAnswerHtml: last ? last.outerHTML.slice(0, 1500) : "",
      thinkingBlocks: [...document.querySelectorAll(SEL.thinking.join(","))].filter(visible).length,
      doc: {
        vis: document.visibilityState,
        focus: document.hasFocus(),
        viewport: [window.innerWidth, window.innerHeight],
      },
      // The message list is a virtualized one: it mounts items only for the
      // range it believes is on screen, so a container that measures 0x0
      // renders no messages and every answer selector comes back empty. This
      // reports each list with the styles that decide that measurement.
      lists: [...document.querySelectorAll(".ds-virtual-list")].map((el) => {
        const hide = []
        for (let n = el, i = 0; n && i < 5; n = n.parentElement, i++) {
          const cs = getComputedStyle(n)
          hide.push(
            n.tagName.toLowerCase() +
              "[" +
              cs.display +
              "/" +
              cs.visibility +
              "/" +
              cs.contentVisibility +
              "]"
          )
        }
        const itemsHost = el.querySelector(".ds-virtual-list-items")
        return {
          cls: String(el.className).slice(0, 90),
          box: box(el),
          itemsHostBox: itemsHost ? box(itemsHost) : null,
          ancestors: hide.join(" < "),
          inner: [...el.querySelectorAll(".ds-virtual-list-items > *")].slice(0, 6).map((n) => ({
            cls: String(n.className).slice(0, 60),
            box: box(n),
            text: (n.innerText || "").replace(/\s+/g, " ").slice(0, 60),
          })),
        }
      }),
      // Every sizeable block of visible text on the page, so an answer that
      // moved to a new container still shows up here.
      bigText: [...document.querySelectorAll("div,section,article,main")]
        .filter((el) => {
          const t = (el.innerText || "").trim()
          return t.length > 100 && t.length < 20000 && visible(el)
        })
        .slice(-12)
        .map((el) => ({
          cls: String(el.className).slice(0, 60),
          box: box(el),
          len: (el.innerText || "").trim().length,
          text: (el.innerText || "").replace(/\s+/g, " ").slice(0, 90),
        })),
    }
    post({ op: "probe-result", id, data })
  }

  // Per-request selector overrides. The host forwards `{"sel": {...}}` on ask
  // and probe, so a DeepSeek redesign can be absorbed by editing a local JSON
  // file instead of repacking and reinstalling the extension.
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
        sendResponse({ ok: true, build: BUILD })
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

  // Non-destructive calibration: types a test string, reports what the page did
  // with it, then clears it again. Nothing is ever submitted, so a broken
  // selector can be diagnosed without sending a message into the user's chat.
  async function selftest(id) {
    const out = { build: BUILD, url: location.href, steps: [] }
    const el = composer()
    out.composer = describe(el)
    out.signedInHint = !signedOut()
    if (!el) {
      out.steps.push("no composer found")
    } else {
      const box = composerBox(el)
      out.box = describe(box)
      const text = "omarchy bridge self test"
      out.setReturned = setComposerText(el, text)
      await sleep(400)
      out.afterSet = {
        value: composerText(el).slice(0, 60),
        accepted: composerText(el).trim() === text.trim(),
        send: describe(sendButton(el)),
        sendSkippedReason: sendSkipReason(el),
      }
      out.boxButtons = [...box.querySelectorAll('div[role="button"], button, [aria-label]')].map(describe)
      setComposerText(el, "")
      await sleep(300)
      out.afterClear = { value: composerText(el).slice(0, 60), cleared: composerText(el).trim() === "" }
    }
    post({ op: "probe-result", id, data: { selftest: out } })
  }

  // Why the send-button search came up empty: the caller needs to know whether
  // the button is missing, disabled, or excluded as a mode switch.
  function sendSkipReason(el) {
    const box = composerBox(el)
    if (!box) return "no composer box"
    const reasons = []
    for (const sel of SEL.submit) {
      const found = [...box.querySelectorAll(sel)]
      reasons.push(sel + " -> " + found.length)
    }
    return reasons.join("; ")
  }

  chrome.runtime.onMessage.addListener(onMessage)
  window.__omarchyDswebRetire = () => {
    try {
      chrome.runtime.onMessage.removeListener(onMessage)
    } catch (e) {
      /* context already gone */
    }
    if (active) {
      clearInterval(active.timer)
      active = null
    }
  }
})()
