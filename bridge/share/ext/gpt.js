// Runs inside chatgpt.com. Same contract as content.js (the DeepSeek worker):
// type the prompt into the page's own composer, submit it, report the
// assistant's answer as full-text snapshots, and let the host do the diffing.
//
// The two sites differ in ways that matter:
//   * ChatGPT's composer is a ProseMirror contenteditable, not a React-owned
//     textarea, so the write path is execCommand instead of the value setter.
//   * Its selectors are far more stable: data-testid and
//     data-message-author-role are part of OpenAI's own test surface, unlike
//     DeepSeek's hashed class names.
//   * chatgpt.com sits behind Cloudflare bot management, so a tab can be
//     parked on a challenge page instead of the app. That state is detected
//     and reported as its own error rather than as a missing composer.

(() => {
  const BUILD = "__BUILD__" // rewritten to the manifest version when packing
  // A fresh injection into a page that already carries an older build must
  // retire that build's listener, or both would answer the same question.
  if (typeof window.__omarchyGptwebRetire === "function") window.__omarchyGptwebRetire()
  if (window.__omarchyGptwebLoaded === BUILD) return
  window.__omarchyGptwebLoaded = BUILD

  const SEL = {
    composer: [
      "#prompt-textarea",
      'div.ProseMirror[contenteditable="true"]',
      'form [contenteditable="true"]',
      '[contenteditable="true"][role="textbox"]',
      "textarea#prompt-textarea",
      "form textarea",
    ],
    submit: [
      'button[data-testid="send-button"]',
      "#composer-submit-button",
      'button[aria-label*="Send" i]',
      'button[aria-label*="发送" i]',
      'button[type="submit"]',
    ],
    stop: [
      'button[data-testid="stop-button"]',
      'button[aria-label*="Stop" i]',
      '[aria-label*="Stop streaming" i]',
      'button[aria-label*="停止" i]',
      'button[aria-label*="停止生成" i]',
      'button[aria-label*="停止思考" i]',
      '[aria-label*="停止" i]',
    ],
    // A finished turn keeps its role attribute for the life of the page, so
    // "the last one" is the answer being written now. The desktop shell marks
    // turns with data-message-author-role; the narrow-window (mobile) shell,
    // which is what a small Chrome window gets, uses data-message-role on an
    // <li> instead.
    answer: [
      '[data-message-author-role="assistant"]',
      'li[data-message-role="assistant"]',
      'section[data-testid^="conversation-turn"] [data-message-author-role="assistant"]',
      'article[data-testid^="conversation-turn"]',
      ".markdown",
    ],
    // Chrome furniture inside a turn: the "ChatGPT said:" heading, the copy /
    // share / read-aloud buttons, and the placeholder the stream renders into.
    skip: [
      "[data-message-attribution]",
      '[aria-label="Response actions"]',
      "button",
      "[data-assistant-placeholder-slot]",
      "svg",
    ],
    // Reasoning blocks belong to the model's scratchpad, not the answer.
    thinking: ['[data-testid*="reason" i]', '[data-testid*="thought" i]', '[class*="reasoning" i]'],
    login: ['input[type="password"]', 'a[href*="/auth/login"]', 'button[data-testid="login-button"]'],
  }

  const MAX_TEXT = 400000
  const POLL_MS = 250
  // Long enough that a stall in the stream is not mistaken for the end of the
  // answer: the panel would truncate what it already showed.
  const STABLE_MS = 2000
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

  // Cloudflare parks the whole page on an interstitial before the app loads.
  // It is neither "signed out" nor "no composer": the user has to finish the
  // check by hand once, and then this tab works like any other.
  function challenged() {
    const title = (document.title || "").toLowerCase()
    if (/just a moment|attention required|checking your browser/.test(title)) return true
    const text = (document.body && document.body.innerText ? document.body.innerText : "")
      .replace(/\s+/g, " ")
      .slice(0, 3000)
    return /verifying you are human|enable javascript and cookies|checking your browser/i.test(text)
  }

  function signedOut() {
    return /\/auth\/login|\/login/i.test(location.pathname) || !!firstMatch(SEL.login)
  }

  function composer() {
    for (const sel of SEL.composer) {
      for (const el of document.querySelectorAll(sel)) if (visible(el)) return el
    }
    return null
  }

  function composerBox(el) {
    // The send button lives in the same form as the composer.
    return el.closest("form") || el.parentElement?.parentElement?.parentElement || el.parentElement
  }

  function composerText(el) {
    if (!el) return ""
    return el.tagName === "TEXTAREA" || el.tagName === "INPUT" ? el.value : el.innerText || ""
  }

  // Tailwind arbitrary variants put whole selectors in the class attribute, so
  // a plain container can carry the word "thinking" without being a reasoning
  // block: ChatGPT's turn wrapper is `flex ... [&>div:has([data-free-thinking-
  // preview-answer=true])+:is(.text-token-text-primary)]`. A class holding a
  // bracket is that kind of rule, never a marker, so it does not count.
  function inThinking(el) {
    const turn = el.closest ? (el.closest('[data-testid^="conversation-turn"]') || el.closest('[data-message-author-role="assistant"]') || el.closest("article")) : null
    for (const sel of SEL.thinking) {
      for (let n = el; n && n !== turn?.parentElement; n = n.parentElement) {
        if (!n.matches || !n.matches(sel)) continue
        if (String(n.className).includes("[")) continue
        return true
      }
    }
    return false
  }

  function skippable(el) {
    for (const sel of SEL.skip) if (el.matches(sel)) return true
    return el.hasAttribute("hidden")
  }

  function stopButton() {
    for (const sel of SEL.stop) {
      for (const el of document.querySelectorAll(sel)) {
        if (visible(el)) return el
      }
    }
    return null
  }

  // Attachments, model pickers and the dictation mic sit in the composer row
  // next to send; none of them may be clicked.
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
      return true
    }
    if (!el.isContentEditable) return false

    const range = document.createRange()
    range.selectNodeContents(el)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)

    // ProseMirror (ChatGPT's editor) reads the text out of the DOM mutation
    // and its own beforeinput/input handlers. execCommand goes through the
    // browser's editing pipeline, which is what it observes; a plain
    // textContent write is invisible to it unless the events are fired too.
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

  // ChatGPT renders markdown in the DOM; turn the block back into markdown so
  // the launcher's renderer keeps code fences and lists.
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
        if (skippable(child)) continue
        const tag = child.tagName.toLowerCase()
        if (tag === "pre") {
          pushCode((child.querySelector("code") || child).innerText || "")
          continue
        }
        // A code block comes wrapped in a container that also holds the
        // language label and the copy button. Take the code and drop the
        // chrome, but only when the chrome is all the container carries.
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
        // snapshot is an extension of this one. Verbatim text is written
        // before the prose that follows it, so nothing before it changes
        // again.
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

  // Answer turns, oldest first. Reasoning sections are skipped: only the
  // polished answer is wanted.
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
    try {
      if (node.querySelector && (node.querySelector(".result-streaming") || node.querySelector('[aria-busy="true"]'))) return true
      if (node.classList && (node.classList.contains("result-streaming") || node.getAttribute("aria-busy") === "true")) return true
      const turn = node.closest ? node.closest('[data-testid^="conversation-turn"]') : null
      if (turn && (turn.querySelector(".result-streaming") || turn.querySelector('[aria-busy="true"]'))) return true
    } catch (e) {}
    return false
  }

  // End-of-answer signals.
  // 1. Actively streaming (.result-streaming or aria-busy) is never finished.
  // 2. Mobile shell: data-message-complete attribute.
  // 3. Desktop shell: action buttons (feedback/response actions) strictly within the assistant's turn.
  // Note: Must NEVER use generic [aria-label*="Copy" i] because that matches "Copy code" on code blocks!
  function turnFinished(node) {
    if (!node) return false
    if (isStreaming(node)) return false

    if (node.hasAttribute && node.hasAttribute("data-message-role")) {
      return node.hasAttribute("data-message-complete")
    }

    const turn = node.closest ? (node.closest('[data-testid^="conversation-turn"]') || node.closest("article")) : null
    if (turn) {
      const actionBtn = turn.querySelector(
        'button[data-testid="copy-turn-action-button"], button[data-testid="feedback-turn-action-button"], [aria-label="Response actions"]'
      )
      if (actionBtn && visible(actionBtn)) return true
    }

    return false
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
    if (challenged()) {
      post({
        op: "error",
        id,
        kind: "challenge",
        message: "ChatGPT is showing a Cloudflare check in that tab (open it, pass the check, retry)",
      })
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
          ? "ChatGPT is not signed in in that Chrome tab"
          : "Could not find the ChatGPT message box",
      })
      return
    }

    const prevStop = stopButton()
    if (prevStop) {
      prevStop.click()
      await sleep(600)
    }

    const beforeNode = answerNode()
    const beforeId = beforeNode ? (beforeNode.getAttribute("data-message-id") || "") : ""
    const beforeText = beforeNode ? toMarkdown(beforeNode).slice(0, MAX_TEXT) : ""
    const beforeCount = answerNodes().length

    if (!setComposerText(box, prompt)) {
      post({ op: "error", id, message: "Could not type into the ChatGPT message box", kind: "no-composer" })
      return
    }
    await sleep(250)
    if (!sameText(composerText(box), prompt)) {
      post({ op: "error", id, message: "The ChatGPT page did not take the question text", kind: "no-composer" })
      return
    }
    const btn = sendButton(box)
    if (btn) btn.click()
    else pressEnter(box)

    // Sending from a brand new chat moves the page to /c/<id> and rebuilds the
    // composer, so "did the text go away" has to be asked about the composer
    // that is on the page now: the detached node keeps its value and would
    // otherwise look like a failed submit.
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
        message: "The ChatGPT page did not accept the question",
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

      // Ensure the turn on show belongs to THIS question, not the previous one.
      // In ChatGPT, submitting a question doesn't immediately mount the assistant
      // turn; during that window answerNode() is still the PREVIOUS answer.
      // We must only mark sawNew when a genuinely new assistant node is mounted.
      if (!a.sawNew) {
        const isNewNode = a.beforeNode
          ? (node && node !== a.beforeNode && (!a.beforeId || nodeId !== a.beforeId))
          : !!node
        const countGrew = answerNodes().length > a.beforeCount
        const textDiffers = node && text && a.beforeText && text !== a.beforeText && !a.beforeText.startsWith(text)

        if (countGrew || (isNewNode && nodeId && nodeId !== a.beforeId) || textDiffers) {
          a.sawNew = true
        }
      }

      // Do NOT read or publish text from the previous turn while waiting for the new one!
      if (!a.sawNew || (text && a.beforeText && text === a.beforeText)) {
        if (Date.now() - a.started > HARD_LIMIT_MS) {
          finish(id, false, "ChatGPT did not start its answer in time", "timeout")
        }
        return
      }

      const stop = stopButton()
      const streaming = isStreaming(node)
      const turnDone = turnFinished(node)
      const done = !stop && !streaming && turnDone

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

      // If the turn has action buttons rendered (turnDone === true), we know it is finished;
      // otherwise require at least 3.5s of stability without a stop button or streaming marker.
      const minStable = turnDone ? 2000 : 4000
      const minStreak = turnDone ? 4 : 8
      const settled = Date.now() - a.lastChange > minStable

      if (a.sawNew && !streaming && a.doneStreak >= minStreak && settled) {
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
        finish(id, false, "ChatGPT did not finish its answer in time", "timeout")
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
      site: "gptweb",
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
      answerCounts: {
        authorRole: document.querySelectorAll("[data-message-author-role]").length,
        assistant: document.querySelectorAll('[data-message-author-role="assistant"]').length,
        markdown: document.querySelectorAll('[class*="markdown"]').length,
        turns: document.querySelectorAll('article[data-testid^="conversation-turn"]').length,
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
            answers: answers.length,
            stop: !!stopButton(),
            sameNode: last === active.beforeNode,
            textIsBefore: last ? toMarkdown(last) === active.beforeText : false,
          }
        : null,
      // Why a candidate turn was thrown away: a redesign usually breaks the
      // filter, not the selector, and this says which half did it.
      answerDebug: SEL.answer.map((sel) => ({
        sel: sel,
        n: document.querySelectorAll(sel).length,
        rejected: [...document.querySelectorAll(sel)].slice(0, 4).map((el) => ({
          box: box(el),
          hidden: (() => {
            for (const t of SEL.thinking) {
              const n = el.closest(t)
              if (n) return t + " <- " + n.tagName.toLowerCase() + "." + String(n.className).slice(0, 90)
            }
            return null
          })(),
          text: (el.innerText || "").replace(/\s+/g, " ").slice(0, 40),
        })),
      })),
      lastAnswer: describe(last),
      lastAnswerText: last ? toMarkdown(last).slice(0, 600) : "",
      lastAnswerHtml: last ? last.outerHTML.slice(0, 4000) : "",
      lastAnswerRaw: last ? (last.innerText || "").replace(/\s+/g, " ").slice(-200) : "",
      viewport: [window.innerWidth, window.innerHeight],
      shell: document.querySelector('[data-testid="mobile-app-shell"]') ? "mobile" : "desktop",
      conversationHtml: (
        document.querySelector('ol[aria-label="Conversation"], [aria-label="Conversation"]')?.outerHTML || ""
      ).slice(0, 14000),
      turns: [...document.querySelectorAll('ol[aria-label="Conversation"] > li, [aria-label="Conversation"] > li')]
        .slice(-4)
        .map((li) => ({ ...describe(li), html: li.outerHTML.slice(0, 900) })),
    }
    post({ op: "probe-result", id, data })
  }

  // Per-request selector overrides, same escape hatch as the DeepSeek worker:
  // the host forwards {"sel": {...}} so a redesign is absorbed by editing a
  // local JSON file instead of repacking the extension.
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
        sendResponse({ ok: true, build: BUILD, site: "gptweb" })
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
  // with it, then clears it again. Nothing is submitted, so a broken selector
  // can be diagnosed without sending a message into the user's chat.
  async function selftest(id) {
    const out = { site: "gptweb", build: BUILD, url: location.href, steps: [] }
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
        sendSkippedReason: sendSkipReason(el),
      }
      out.boxButtons = [...box.querySelectorAll('div[role="button"], button, [data-testid], [aria-label]')].map(describe)
      setComposerText(el, "")
      await sleep(400)
      out.afterClear = { value: composerText(el).slice(0, 60), cleared: composerText(el).trim() === "" }
    }
    post({ op: "probe-result", id, data: { selftest: out } })
  }

  function sendSkipReason(el) {
    const box = composerBox(el)
    if (!box) return "no composer box"
    const reasons = []
    for (const sel of SEL.submit) {
      const found = [...box.querySelectorAll(sel)]
      reasons.push(sel + " -> " + found.length + (found[0] && found[0].hasAttribute("disabled") ? " (disabled)" : ""))
    }
    return reasons.join("; ")
  }

  chrome.runtime.onMessage.addListener(onMessage)
  window.__omarchyGptwebRetire = () => {
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
