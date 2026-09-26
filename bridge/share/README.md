# Omarchy Web bridge

Answers launcher questions from a chat tab already open in the user's own
Chrome, so asking from `omarchy-menu-omni`'s `ai` mode costs no API tokens. Two
sites share one extension: `chat.deepseek.com` and `chatgpt.com`.

```
menu  ai <question>
  └─ dsweb -s <site> ask "<question>"       ~/.local/bin/dsweb
       └─ unix socket  $XDG_RUNTIME_DIR/omarchy-dsweb-<uid>.sock
            └─ omarchy-dsweb-host           ~/.local/bin/omarchy-dsweb-host
                 └─ native messaging (stdio, 4-byte LE length + JSON)
                      └─ service worker      ext/background.js  (SITES table)
                           └─ content script ext/content.js | ext/gpt.js
                                └─ the page: types, submits, reads back
```

`-s` selects the site and defaults to `dsweb`; the site id picks the tab, the
content script and the wording of every error. Adding a site is a row in
`background.js`'s `SITES` table plus a content script.

The content script reports the answer as *full-text snapshots*; the host turns
consecutive snapshots into the deltas `dsweb` streams. The client writes one
JSON event per line:

    {"type":"activity","activity":"thinking"}
    {"type":"text","text":"..."}          delta, append in order
    {"type":"done"}
    {"type":"error","message":"...","kind":"..."}

Those lines are what `ai/AiAdapters.js`'s `dswebAdapter.parseLine` reads, so the
client and the adapter change together.

## Files

| Path | Role |
| --- | --- |
| `ext/` | Extension source (MV3). `content.js` and `gpt.js` each hold one site's page-specific selectors. |
| `keys/` | RSA key pinning the extension id `ofgecdhhcjemflbccnbohdomliblhdjc`; `pub.b64`, `ext_id`. |
| `web/omarchy-dsweb.crx`, `web/update.xml` | What Chrome force-installs. |
| `pack.sh` | Bumps the version, substitutes `__BUILD__` in `content.js`, packs the CRX. |
| `~/.local/bin/omarchy-dsweb-host` | Native messaging host **and** unix socket server. |
| `~/.local/bin/dsweb` | Client: `ask` / `probe` / `selftest` / `reload` / `status`, `-s <site>`. |
| `~/.local/bin/omarchy-dsweb-crx-serve` | Socket-activated static server for `web/` on `127.0.0.1:8788`. |
| `~/.config/google-chrome/NativeMessagingHosts/com.omarchy.dsweb.json` | Tells Chrome about the host. |
| `/etc/opt/chrome/policies/managed/omarchy-dsweb.json` | `ExtensionInstallForcelist` entry. |
| `~/.config/systemd/user/omarchy-dsweb-crx.{socket,service}` | Keep the CRX server at zero idle cost. |

## Deploying a change

`--load-extension` is ignored by branded Chrome 154, and so is an
`External Extensions` entry: the extension is installed by enterprise policy.
Chrome re-reads that policy **while it is running**, so a new build reaches the
open browser without restarting it:

```sh
cd ~/.local/share/omarchy-dsweb
bash pack.sh                       # bump + pack
bash rotate.sh                     # forcelist off, then on: Chrome re-installs
```

`rotate.sh` clears the forcelist entry and writes it back a few seconds later.
Chrome uninstalls and then re-fetches `update.xml`, so the running browser picks
up the new version within seconds. The DeepSeek tab is reloaded automatically on
the next request: the service worker compares the build the content script
reports on `ping` with its own manifest version and reloads the tab on a
mismatch.

Host and client changes need no redeploy — the host is restarted by Chrome, and
`pkill -f 'omarchy-dsweb[-]host'` makes it respawn from disk. (Quote the bracket
form: a plain pattern matches the shell running the `pkill` itself.)

## When a chat site changes its page

Selectors live in the `SEL` table at the top of that site's content script.
Diagnose with:

```sh
dsweb -s gptweb probe   # read-only DOM summary of the target tab
dsweb -s gptweb reload  # reload the tab the bridge is driving
dsweb -s gptweb selftest  # types a test string, reports what the page did, clears it
```

`probe` and `reload` never touch the question slot, so they work while one is
running. `selftest` never submits anything, so it is safe to run against a real
conversation. To fix a selector without repacking the extension, write
`~/.config/omarchy-dsweb/selectors.json` with any subset of `SEL`; a flat object
applies to whichever site asked, and an object keyed by site id targets one:

```json
{ "gptweb": { "submit": ["button[data-testid=\"send-button\"]"] } }
```

The host re-reads that file on every request. Selector-relevant facts measured
against the live pages (2026-09):

- composer: `textarea[placeholder="Message DeepSeek"]`; React takes the text
  only through the prototype value setter plus an `input` event.
- send button: `div[role="button"].ds-button--circle` at the end of the
  composer row, and it stays `ds-button--disabled` until React has the text.
  Mode switches (`ds-button--iconLabelPrimary`: Deep Think, Search) sit in the
  same row and must never be clicked.
- answer: `div.ds-markdown.ds-assistant-message-main-content`, paragraphs in
  `p.ds-markdown-paragraph`.
- the first question of a conversation moves the page to `/a/chat/s/<id>` and
  rebuilds the composer, so "did the composer clear" must be asked about the
  composer currently on the page — the detached node keeps its old value and
  otherwise looks like a failed submit.

## Behaviour worth knowing

- **The target tab is brought to the front before every question.** A chat page
  in a background tab keeps its message list out of the layout — DeepSeek parks
  the live list under an ancestor with `display:none` — so nothing can be read
  from it. The page also switches shells with the viewport: a 507x547 px window
  makes chatgpt.com render its narrow shell (`li[data-message-role]`,
  `textarea#mobile-composer-prompt`) instead of the desktop one, so both sets of
  selectors stay in `SEL`.
- **Snapshots only ever grow.** The panel appends, so the content script
  publishes a sample only when it extends the previous one, and withholds
  verbatim text (code blocks, inline code) until it stops changing, and never
  turns that hold-back off mid-answer — a half-rendered code block that got
  published could never be repaired, because the finished block does not extend
  it and the panel only appends. A sample that shrank used to make the host
  resend the whole answer, which showed the answer twice. When the turn is
  confirmed over the content script converts the turn one last time with the
  hold-back off: an answer that opens with a code block is withheld in full
  while it streams, so without that last flush it would arrive truncated or not
  at all.
- **Nothing is published until the answer of the current question is on the
  page.** The last assistant turn before the question is the previous answer,
  and reading it would put that answer in the panel again. Arrival is decided
  on three signals, because no one of them holds everywhere: the message list
  got longer, the page shows a stop button that only exists while it
  generates, or the text differs from the previous answer. Asking the same
  question twice is why the third signal cannot stand alone: the answer may be
  a verbatim copy of the previous one, so only the turn being new proves
  anything. A turn that ends without ever carrying text is an error
  (`no-answer`), not an empty answer.
- One question at a time. A second `ask` while one runs fails with `busy`.
- Killing the client (the panel's Escape, or `maxRunSeconds`) closes the socket;
  the host reads that as a cancel and clicks the page's stop button.
- The page's own Deep Think / Search switches are never touched.
- With Chrome closed the bridge is simply absent, and the menu shows
  "The Chrome bridge is not running".
- `touch $XDG_RUNTIME_DIR/omarchy-dsweb-debug` makes the host append every frame
  to `$XDG_RUNTIME_DIR/omarchy-dsweb-host.log`. Remove the flag file to stop it.
