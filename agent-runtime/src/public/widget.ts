// The sales agent widget, served from runtime.attractacq.com rather than copied
// into each client repository.
//
// That is deliberate. A copy per repo would mean a fix to the widget required a
// commit to every site AA has ever published, and the oldest sites would quietly
// rot. One hosted file means one place to fix.
//
// It is a string rather than a bundled asset because this runtime has no asset
// pipeline and needs none for 8KB of vanilla JavaScript. No dependencies, no
// build step, nothing to go stale.
//
// Everything visual lives in a shadow root. A landing page has its own CSS, and
// unscoped styles would either break the page or be broken by it — on a page
// whose whole job is converting visitors.

export const WIDGET_SOURCE = String.raw`(function () {
  "use strict";
  var script = document.currentScript;
  if (!script) return;
  var id = script.getAttribute("data-agent");
  var base = (script.getAttribute("data-runtime") || script.src.split("/public/")[0]).replace(/\/+$/, "");
  if (!id) return;

  var api = base + "/public/sales/v1/d/" + id;
  var storageKey = "aa-sales-" + id;
  var conversationId = null;
  try { conversationId = sessionStorage.getItem(storageKey); } catch (e) {}

  // An outline robot, drawn rather than fetched: one more network request for a
  // 300-byte icon is a request that can fail on somebody else's landing page.
  var ROBOT = [
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ',
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">',
    '<rect x="4" y="8" width="16" height="12" rx="3"/>',
    '<path d="M12 4.5v3.5"/><circle cx="12" cy="3.2" r="1.3"/>',
    '<path d="M2.5 13v3"/><path d="M21.5 13v3"/>',
    '<circle cx="9" cy="13.5" r="1.1" fill="currentColor" stroke="none"/>',
    '<circle cx="15" cy="13.5" r="1.1" fill="currentColor" stroke="none"/>',
    '<path d="M9.5 17h5"/>',
    "</svg>",
  ].join("");

  var host = document.createElement("div");
  host.setAttribute("data-aa-sales-agent", "");
  var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : null;
  if (!root) return;

  var style = document.createElement("style");
  style.textContent = [
    ":host{all:initial}",
    "*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}",
    // The launcher is a circle, not a pill: it has to read as one small object
    // in the corner of somebody else's page rather than a second call to action
    // competing with the one the page exists for.
    ".dock{position:fixed;right:20px;bottom:20px;z-index:2147483000;display:flex;align-items:flex-end;gap:10px}",
    ".launch{width:56px;height:56px;flex:0 0 56px;border:0;border-radius:999px;padding:0;display:flex;",
    "align-items:center;justify-content:center;color:#fff;background:var(--aa-accent,#1f2937);",
    "box-shadow:0 6px 24px rgba(0,0,0,.18);cursor:pointer}",
    ".launch:focus-visible{outline:3px solid #fff;outline-offset:2px}",
    ".launch svg{width:28px;height:28px;display:block}",
    // The teaser sits to the LEFT of the circle, because the circle is already
    // hard against the right edge of the viewport.
    ".teaser{position:relative;order:-1;max-width:210px;background:#fff;color:#111827;border:1px solid #e5e7eb;",
    "border-radius:14px;padding:10px 26px 10px 13px;font-size:13px;line-height:1.4;",
    "box-shadow:0 6px 20px rgba(0,0,0,.14);cursor:pointer;text-align:left}",
    ".teaser .dismiss{position:absolute;top:3px;right:3px;width:20px;height:20px;border:0;background:none;",
    "color:#9ca3af;font-size:15px;line-height:1;cursor:pointer;border-radius:999px;padding:0}",
    ".teaser .dismiss:hover{color:#374151;background:#f3f4f6}",
    ".teaser .dismiss:focus-visible{outline:2px solid var(--aa-accent,#1f2937);outline-offset:1px}",
    "@media (prefers-reduced-motion:no-preference){.teaser{animation:rise .22s ease-out}}",
    "@media (max-width:480px){.teaser{max-width:150px;font-size:12px}}",
    ".panel{position:fixed;right:20px;bottom:20px;z-index:2147483000;width:360px;max-width:calc(100vw - 32px);",
    "height:520px;max-height:calc(100vh - 40px);display:flex;flex-direction:column;background:#fff;",
    "border-radius:14px;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,.22)}",
    ".head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;",
    "background:var(--aa-accent,#1f2937);color:#fff;font-weight:600;font-size:15px}",
    ".close{background:none;border:0;color:#fff;font-size:22px;line-height:1;cursor:pointer;padding:0 4px}",
    ".log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;background:#f8fafc}",
    ".msg{max-width:85%;padding:10px 13px;border-radius:12px;font-size:14px;line-height:1.45;white-space:pre-wrap}",
    ".them{background:#fff;color:#111827;border:1px solid #e5e7eb;align-self:flex-start}",
    ".me{background:var(--aa-accent,#1f2937);color:#fff;align-self:flex-end}",
    ".note{align-self:center;color:#6b7280;font-size:12px;text-align:center}",
    ".form{display:flex;gap:8px;padding:12px;border-top:1px solid #e5e7eb;background:#fff}",
    ".form input{flex:1;min-width:0;padding:11px 12px;border:1px solid #d1d5db;border-radius:9px;font-size:14px}",
    ".form button{border:0;border-radius:9px;padding:0 16px;font-size:14px;font-weight:600;color:#fff;",
    "background:var(--aa-accent,#1f2937);cursor:pointer}",
    ".form button[disabled]{opacity:.5;cursor:default}",
    "@media (max-width:480px){.panel{right:8px;bottom:8px;width:calc(100vw - 16px);height:calc(100vh - 16px)}}",
    "@media (prefers-reduced-motion:no-preference){.panel{animation:rise .16s ease-out}}",
    "@keyframes rise{from{transform:translateY(8px);opacity:0}to{transform:none;opacity:1}}",
  ].join("");
  root.appendChild(style);

  var wrap = document.createElement("div");
  root.appendChild(wrap);
  document.body.appendChild(host);

  var cfg = {
    greeting: "Hello - how can we help?",
    widget: { label: "Chat", accent: null, title: null, teaser: null },
  };
  var open = false;
  var busy = false;

  // The transcript is kept for the session, not just for the page.
  //
  // The conversation id already survived a navigation, so the server remembered
  // the visitor while the visitor's own screen went blank - they came back to an
  // empty panel and an agent that acted as though they had already spoken. This
  // is the other half of that memory.
  var said = [];
  var logKey = storageKey + "-log";
  var teaserKey = storageKey + "-teaser";
  try {
    var saved = sessionStorage.getItem(logKey);
    if (saved) said = JSON.parse(saved) || [];
  } catch (e) { said = []; }
  function remember() {
    try { sessionStorage.setItem(logKey, JSON.stringify(said.slice(-40))); } catch (e) {}
  }

  // Dismissing the teaser is a decision, and re-offering it on the next page
  // would be ignoring it.
  var teaserHidden = false;
  try { teaserHidden = sessionStorage.getItem(teaserKey) === "1"; } catch (e) {}
  // Someone who has already talked to the agent does not need inviting.
  if (said.length > 0) teaserHidden = true;

  function esc(s) { return String(s == null ? "" : s); }

  /** Opening the chat answers the invitation, so it does not come back. */
  function openChat() {
    open = true;
    teaserHidden = true;
    try { sessionStorage.setItem(teaserKey, "1"); } catch (e) {}
    render();
  }

  function render() {
    if (cfg.widget.accent) wrap.style.setProperty("--aa-accent", cfg.widget.accent);
    if (!open) {
      wrap.innerHTML = "";
      var dock = document.createElement("div");
      dock.className = "dock";

      var b = document.createElement("button");
      b.className = "launch";
      b.type = "button";
      b.setAttribute("aria-haspopup", "dialog");
      // The circle carries no text, so the label has to live here or a screen
      // reader is offered an unnamed button.
      b.setAttribute("aria-label", cfg.widget.label || "Chat");
      b.innerHTML = ROBOT;
      b.addEventListener("click", function () { openChat(); });
      dock.appendChild(b);

      if (!teaserHidden) {
        var teaser = document.createElement("div");
        teaser.className = "teaser";
        // Clicking the invitation opens the chat, which is what it invites.
        teaser.addEventListener("click", function () { openChat(); });

        var teaserText = document.createElement("span");
        teaserText.textContent = cfg.widget.teaser || "Hi - ask me anything.";
        teaser.appendChild(teaserText);

        var dismiss = document.createElement("button");
        dismiss.className = "dismiss";
        dismiss.type = "button";
        dismiss.setAttribute("aria-label", "Dismiss this message");
        dismiss.innerHTML = "&times;";
        dismiss.addEventListener("click", function (e) {
          // Without this the click reaches the teaser and opens the chat the
          // visitor just declined.
          e.stopPropagation();
          teaserHidden = true;
          try { sessionStorage.setItem(teaserKey, "1"); } catch (err) {}
          render();
        });
        teaser.appendChild(dismiss);
        dock.appendChild(teaser);
      }

      wrap.appendChild(dock);
      return;
    }

    wrap.innerHTML = "";
    var panel = document.createElement("div");
    panel.className = "panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "false");
    panel.setAttribute("aria-label", cfg.widget.title || "Chat");

    var head = document.createElement("div");
    head.className = "head";
    var title = document.createElement("span");
    title.textContent = cfg.widget.title || cfg.widget.label || "Chat";
    var x = document.createElement("button");
    x.className = "close";
    x.type = "button";
    x.setAttribute("aria-label", "Close chat");
    x.innerHTML = "&times;";
    x.addEventListener("click", function () { open = false; render(); });
    head.appendChild(title);
    head.appendChild(x);

    var log = document.createElement("div");
    log.className = "log";
    var first = document.createElement("div");
    first.className = "msg them";
    first.textContent = cfg.greeting;
    log.appendChild(first);
    said.forEach(function (m) {
      var el = document.createElement("div");
      el.className = "msg " + (m.role === "user" ? "me" : m.role === "note" ? "note" : "them");
      if (m.role === "note") el.className = "note";
      el.textContent = m.content;
      log.appendChild(el);
    });

    var form = document.createElement("form");
    form.className = "form";
    var input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Type your question";
    input.setAttribute("aria-label", "Your message");
    input.maxLength = 2000;
    var send = document.createElement("button");
    send.type = "submit";
    send.textContent = "Send";
    if (busy) send.disabled = true;
    form.appendChild(input);
    form.appendChild(send);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var text = input.value.trim();
      if (!text || busy) return;
      input.value = "";
      ask(text);
    });

    panel.appendChild(head);
    panel.appendChild(log);
    panel.appendChild(form);
    wrap.appendChild(panel);
    log.scrollTop = log.scrollHeight;
    input.focus();
  }

  function ask(text) {
    said.push({ role: "user", content: text });
    remember();
    busy = true;
    render();

    var payload = { message: text };
    if (conversationId) payload.conversation_id = conversationId;

    fetch(api + "/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (out) {
        busy = false;
        if (!out.ok || !out.body || out.body.ok !== true) {
          // The server deliberately does not say why. Repeat what it said and
          // nothing more - guessing a reason here would be inventing one.
          said.push({ role: "note", content: (out.body && out.body.error) || "Something went wrong." });
          remember();
          render();
          return;
        }
        if (out.body.conversation_id) {
          conversationId = out.body.conversation_id;
          try { sessionStorage.setItem(storageKey, conversationId); } catch (e) {}
        }
        said.push({ role: "assistant", content: esc(out.body.reply) });
        remember();
        render();
      })
      .catch(function () {
        busy = false;
        said.push({ role: "note", content: "Could not reach us just now." });
        remember();
        render();
      });
  }

  // Styling and greeting only. Nothing about how the agent is instructed is
  // ever served to a browser - see publicConfig on the server.
  fetch(api + "/config")
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      if (j && j.ok) {
        if (j.greeting) cfg.greeting = j.greeting;
        if (j.widget) cfg.widget = {
          label: j.widget.label || "Chat",
          accent: j.widget.accent,
          title: j.widget.title,
          teaser: j.widget.teaser,
        };
      }
      render();
    })
    .catch(function () { render(); });
})();
`;
