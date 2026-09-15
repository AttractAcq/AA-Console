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

  var host = document.createElement("div");
  host.setAttribute("data-aa-sales-agent", "");
  var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : null;
  if (!root) return;

  var style = document.createElement("style");
  style.textContent = [
    ":host{all:initial}",
    "*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}",
    ".launch{position:fixed;right:20px;bottom:20px;z-index:2147483000;border:0;border-radius:999px;",
    "padding:14px 22px;font-size:15px;font-weight:600;color:#fff;background:var(--aa-accent,#1f2937);",
    "box-shadow:0 6px 24px rgba(0,0,0,.18);cursor:pointer}",
    ".launch:focus-visible{outline:3px solid #fff;outline-offset:2px}",
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

  var cfg = { greeting: "Hello - how can we help?", widget: { label: "Chat", accent: null, title: null } };
  var open = false;
  var busy = false;
  var said = [];

  function esc(s) { return String(s == null ? "" : s); }

  function render() {
    if (cfg.widget.accent) wrap.style.setProperty("--aa-accent", cfg.widget.accent);
    if (!open) {
      wrap.innerHTML = "";
      var b = document.createElement("button");
      b.className = "launch";
      b.type = "button";
      b.textContent = cfg.widget.label || "Chat";
      b.setAttribute("aria-haspopup", "dialog");
      b.addEventListener("click", function () { open = true; render(); });
      wrap.appendChild(b);
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
          render();
          return;
        }
        if (out.body.conversation_id) {
          conversationId = out.body.conversation_id;
          try { sessionStorage.setItem(storageKey, conversationId); } catch (e) {}
        }
        said.push({ role: "assistant", content: esc(out.body.reply) });
        render();
      })
      .catch(function () {
        busy = false;
        said.push({ role: "note", content: "Could not reach us just now." });
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
        if (j.widget) cfg.widget = { label: j.widget.label || "Chat", accent: j.widget.accent, title: j.widget.title };
      }
      render();
    })
    .catch(function () { render(); });
})();
`;
