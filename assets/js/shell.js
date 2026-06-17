/* ============================================================
   shell.js — 3J & D Construction SaaS app shell
   Auth guard + sidebar/topbar layout + shared UI helpers.
   Depends on Bootstrap 5 (global `bootstrap`), Bootstrap Icons,
   and api.js formatters (pesoFmt, numFmt, fmtDate, monthLabel).
   ============================================================ */
(function (w) {
  "use strict";

  var NAV = [
    { key: "dashboard", label: "Dashboard", icon: "speedometer2", href: "index.php" },
    { key: "projects", label: "Projects", icon: "folder2-open", href: "projects.php" },
    { key: "income", label: "Income", icon: "bank", href: "income.php" },
    { key: "expenses", label: "Expenses", icon: "cash-stack", href: "expenses.php" },
    { key: "materials", label: "Materials", icon: "box-seam", href: "materials.php" },
    { key: "workers", label: "Workers", icon: "person-badge", href: "workers.php" },
    { key: "payroll", label: "Payroll", icon: "cash-coin", href: "payroll.php", admin: true },
    { key: "loans", label: "Loans", icon: "piggy-bank", href: "loans.php", admin: true },
    { key: "clients", label: "Clients", icon: "people", href: "clients.php" },
    { key: "reports", label: "Reports", icon: "graph-up-arrow", href: "reports.php" },
    { key: "settings", label: "Settings", icon: "gear", href: "settings.php" },
  ];

  var LOGO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 18h14"/><path d="M7 18V8l5-3v13"/><path d="M17 18v-7l-5-3"/></svg>';

  /* ---------- DOM helper ---------- */
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === "class") n.className = v;
        else if (k === "html") n.innerHTML = v;
        else if (k === "text") n.textContent = v;
        else if (k.slice(0, 2) === "on" && typeof v === "function") n.addEventListener(k.slice(2).toLowerCase(), v);
        else n.setAttribute(k, v);
      }
    }
    append(n, children);
    return n;
  }
  function append(n, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { append(n, x); }); }
    else if (c instanceof Node) { n.appendChild(c); }
    else { n.appendChild(document.createTextNode(String(c))); }
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (m) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]; }); }

  /* ---------- theme ---------- */
  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem("tjd-theme"); } catch (e) {}
    var theme = saved || (w.matchMedia && w.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.setAttribute("data-bs-theme", theme);
    return theme;
  }
  function toggleTheme() {
    var cur = document.documentElement.getAttribute("data-bs-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-bs-theme", cur);
    try { localStorage.setItem("tjd-theme", cur); } catch (e) {}
    var ic = document.getElementById("themeIcon");
    if (ic) ic.className = "bi bi-" + (cur === "dark" ? "sun" : "moon-stars");
  }

  /* ---------- auth guard ---------- */
  function meRequest() {
    return fetch("api/auth.php?action=me", { headers: { Accept: "application/json" }, credentials: "same-origin" });
  }
  async function logout() {
    try { await fetch("api/auth.php?action=logout", { credentials: "same-origin" }); } catch (e) {}
    location.href = "login.php";
  }

  /* ---------- mount the shell ---------- */
  async function mount(activeKey, opts) {
    opts = opts || {};
    initTheme();

    var me;
    try {
      var res = await meRequest();
      if (res.status === 401) { location.replace("login.php?next=" + encodeURIComponent(location.pathname.split("/").pop() + location.search)); return null; }
      var data = await res.json();
      me = data.user;
    } catch (e) {
      location.replace("login.php");
      return null;
    }

    var content = el("main", { class: "app-content", id: "app-content" });

    var sidebar = el("aside", { class: "sidebar offcanvas-lg offcanvas-start", tabindex: "-1", id: "appSidebar" }, [
      el("div", { class: "brand" }, [
        el("span", { class: "brand-logo", html: LOGO }),
        el("div", null, [
          el("div", { class: "brand-name", text: "3J & D" }),
          el("div", { class: "brand-sub", text: "Construction" }),
        ]),
        el("button", { class: "btn-close ms-auto d-lg-none", type: "button", "data-bs-dismiss": "offcanvas", "data-bs-target": "#appSidebar", "aria-label": "Close" }),
      ]),
      el("nav", { class: "side-nav" }, [
        el("div", { class: "nav-label", text: "Menu" }),
        NAV.filter(function (item) { return !item.admin || me.role === "admin"; }).map(function (item) {
          return el("a", { class: "side-link" + (item.key === activeKey ? " active" : ""), href: item.href }, [
            el("i", { class: "bi bi-" + item.icon }),
            el("span", { text: item.label }),
          ]);
        }),
      ]),
    ]);

    var userMenu = el("div", { class: "dropdown ms-auto" }, [
      el("button", { class: "btn btn-sm dropdown-toggle d-flex align-items-center gap-2", "data-bs-toggle": "dropdown", "aria-expanded": "false" }, [
        el("span", { class: "rounded-circle d-grid", style: "width:30px;height:30px;background:var(--brand);color:var(--brand-ink);font-weight:700;place-items:center", text: (me.name || "?").charAt(0).toUpperCase() }),
        el("span", { class: "d-none d-sm-inline small fw-semibold", text: me.name || me.email }),
      ]),
      el("ul", { class: "dropdown-menu dropdown-menu-end" }, [
        el("li", null, el("span", { class: "dropdown-item-text small text-secondary", text: me.email + " · " + me.role })),
        el("li", null, el("hr", { class: "dropdown-divider" })),
        el("li", null, el("a", { class: "dropdown-item", href: "settings.php" }, [el("i", { class: "bi bi-gear me-2" }), "Settings"])),
        el("li", null, el("button", { class: "dropdown-item text-danger", type: "button", onClick: logout }, [el("i", { class: "bi bi-box-arrow-right me-2" }), "Sign out"])),
      ]),
    ]);

    var topbar = el("header", { class: "topbar" }, [
      el("button", { class: "btn btn-sm btn-outline-secondary d-lg-none", type: "button", "data-bs-toggle": "offcanvas", "data-bs-target": "#appSidebar", "aria-label": "Menu" }, el("i", { class: "bi bi-list" })),
      el("h1", { text: opts.title || "" }),
      el("button", { class: "btn btn-sm btn-outline-secondary ms-auto", type: "button", title: "Toggle theme", onClick: toggleTheme },
        el("i", { id: "themeIcon", class: "bi bi-" + (document.documentElement.getAttribute("data-bs-theme") === "dark" ? "sun" : "moon-stars") })),
      userMenu,
    ]);

    var shell = el("div", { class: "app-shell" }, [
      sidebar,
      el("div", { class: "app-main" }, [topbar, content]),
    ]);

    clear(document.body);
    document.body.appendChild(shell);
    if (!document.getElementById("toastHost")) document.body.appendChild(el("div", { class: "toast-container position-fixed bottom-0 end-0 p-3", id: "toastHost", style: "z-index:1090" }));
    if (!document.getElementById("modalHost")) document.body.appendChild(el("div", { id: "modalHost" }));

    return { user: me, content: content };
  }

  /* ---------- toast ---------- */
  function toast(msg, kind) {
    var host = document.getElementById("toastHost");
    if (!host) return;
    var cls = kind === "err" ? "text-bg-danger" : kind === "ok" ? "text-bg-success" : "text-bg-dark";
    var t = el("div", { class: "toast align-items-center border-0 " + cls, role: "alert" }, [
      el("div", { class: "d-flex" }, [
        el("div", { class: "toast-body fw-semibold", text: msg }),
        el("button", { class: "btn-close btn-close-white me-2 m-auto", type: "button", "data-bs-dismiss": "toast" }),
      ]),
    ]);
    host.appendChild(t);
    var inst = new bootstrap.Toast(t, { delay: 2800 });
    t.addEventListener("hidden.bs.toast", function () { t.remove(); });
    inst.show();
  }

  /* ---------- confirm dialog ---------- */
  function confirmDialog(message, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var host = document.getElementById("modalHost");
      var okBtn = el("button", { class: "btn " + (opts.danger ? "btn-danger" : "btn-primary"), type: "button", text: opts.okLabel || (opts.danger ? "Remove" : "Confirm") });
      var modalEl = el("div", { class: "modal fade", tabindex: "-1" },
        el("div", { class: "modal-dialog modal-dialog-centered" },
          el("div", { class: "modal-content" }, [
            el("div", { class: "modal-header" }, [el("h5", { class: "modal-title", text: opts.title || "Please confirm" }), el("button", { class: "btn-close", "data-bs-dismiss": "modal" })]),
            el("div", { class: "modal-body" }, el("p", { class: "mb-0", text: message })),
            el("div", { class: "modal-footer" }, [el("button", { class: "btn btn-outline-secondary", "data-bs-dismiss": "modal", type: "button", text: "Cancel" }), okBtn]),
          ])
        )
      );
      host.appendChild(modalEl);
      var modal = new bootstrap.Modal(modalEl);
      var done = false;
      okBtn.addEventListener("click", function () { done = true; modal.hide(); resolve(true); });
      modalEl.addEventListener("hidden.bs.modal", function () { modalEl.remove(); if (!done) resolve(false); });
      modal.show();
    });
  }

  /* ---------- generic form modal ----------
     openForm({ title, submitLabel, fields:[{name,label,type,options,value,required,col,step,placeholder,help}], onSubmit(values) })
     onSubmit may throw an Error(message) to keep the modal open and show the message. */
  function openForm(cfg) {
    cfg = cfg || {};
    return new Promise(function (resolve) {
      var host = document.getElementById("modalHost");
      var inputs = {};
      var grid = el("div", { class: "row g-3" });

      (cfg.fields || []).forEach(function (f) {
        var id = "fld_" + f.name;
        var ctrl;
        if (f.type === "select") {
          ctrl = el("select", { class: "form-select", id: id }, (f.options || []).map(function (o) {
            return el("option", { value: String(o.value), selected: String(f.value) === String(o.value) ? "selected" : null }, o.label);
          }));
        } else if (f.type === "textarea") {
          ctrl = el("textarea", { class: "form-control", id: id, rows: f.rows || 2, placeholder: f.placeholder || "" }, f.value != null ? String(f.value) : "");
        } else {
          ctrl = el("input", { class: "form-control", id: id, type: f.type || "text", step: f.step || null, min: f.min != null ? f.min : null, placeholder: f.placeholder || "", value: f.value != null ? String(f.value) : "" });
        }
        inputs[f.name] = ctrl;
        grid.appendChild(el("div", { class: "col-" + (f.col || 12) }, [
          el("label", { class: "form-label small fw-semibold text-secondary", for: id, text: f.label }),
          ctrl,
          f.help ? el("div", { class: "form-text", text: f.help }) : null,
        ]));
      });

      var errBox = el("div", { class: "text-danger small fw-medium mt-2", style: "min-height:0" });
      var submitBtn = el("button", { class: "btn btn-primary", type: "submit", text: cfg.submitLabel || "Save" });

      var form = el("form", { class: "modal-content" }, [
        el("div", { class: "modal-header" }, [el("h5", { class: "modal-title", text: cfg.title || "Form" }), el("button", { class: "btn-close", type: "button", "data-bs-dismiss": "modal" })]),
        el("div", { class: "modal-body" }, [grid, errBox]),
        el("div", { class: "modal-footer" }, [el("button", { class: "btn btn-outline-secondary", type: "button", "data-bs-dismiss": "modal", text: "Cancel" }), submitBtn]),
      ]);
      var modalEl = el("div", { class: "modal fade", tabindex: "-1" }, el("div", { class: "modal-dialog modal-dialog-centered" }, form));
      host.appendChild(modalEl);
      var modal = new bootstrap.Modal(modalEl);
      var saved = false;

      form.addEventListener("submit", async function (e) {
        e.preventDefault();
        errBox.textContent = "";
        var values = {};
        var bad = null;
        (cfg.fields || []).forEach(function (f) {
          var val = inputs[f.name].value;
          if (typeof val === "string") val = val.trim();
          if (f.required && (val === "" || val == null) && !bad) bad = f.label + " is required.";
          values[f.name] = val;
        });
        if (bad) { errBox.textContent = bad; return; }
        submitBtn.disabled = true;
        var orig = submitBtn.textContent; submitBtn.textContent = "Saving…";
        try {
          if (cfg.onSubmit) await cfg.onSubmit(values);
          saved = true; modal.hide(); resolve(true);
        } catch (err) {
          errBox.textContent = (err && err.message) || "Could not save.";
          submitBtn.disabled = false; submitBtn.textContent = orig;
        }
      });
      modalEl.addEventListener("hidden.bs.modal", function () { modalEl.remove(); if (!saved) resolve(false); });
      modal.show();
      setTimeout(function () {
        var first = grid.querySelector("input,select,textarea"); if (first) first.focus();
        if (typeof cfg.onMount === "function") cfg.onMount(inputs);
      }, 200);
    });
  }

  /* ---------- table renderer (Bootstrap) ----------
     renderTable(container, { columns:[{label, key|render(row), num, cls, thCls}], rows, empty, responsive }) */
  function renderTable(container, cfg) {
    cfg = cfg || {};
    var cols = cfg.columns || [];
    var rows = cfg.rows || [];
    clear(container);
    if (!rows.length) { emptyState(container, cfg.empty || "No records yet.", cfg.emptyIcon || "inbox"); return; }

    var thead = el("thead", null, el("tr", null, cols.map(function (c) {
      return el("th", { class: (c.num ? "text-end " : "") + (c.thCls || "") }, c.label);
    })));
    var tbody = el("tbody", null, rows.map(function (row, i) {
      return el("tr", null, cols.map(function (c) {
        var td = el("td", { class: (c.num ? "text-end tnum " : "") + (c.cls || "") });
        if (typeof c.render === "function") append(td, c.render(row, i));
        else td.textContent = row[c.key] != null ? row[c.key] : "";
        return td;
      }));
    }));
    var table = el("table", { class: "table table-hover align-middle mb-0" }, [thead, tbody]);
    container.appendChild(el("div", { class: cfg.responsive === false ? "" : "table-responsive" }, table));
  }

  function emptyState(container, msg, icon) {
    clear(container);
    container.appendChild(el("div", { class: "empty-state" }, [
      el("i", { class: "bi bi-" + (icon || "inbox") }),
      el("p", { class: "mt-2 mb-0", text: msg }),
    ]));
  }

  /* ---------- skeleton rows ---------- */
  function skeletonRows(n) {
    var f = document.createDocumentFragment();
    for (var i = 0; i < (n || 4); i++) f.appendChild(el("div", { class: "skel skel-row" }));
    return f;
  }

  /* ---------- pills ---------- */
  function pill(value, kind) {
    var v = String(value || "").toLowerCase();
    var label = kind === "status" ? (v === "active" ? "Active" : v === "not_active" || v === "inactive" ? "Not active" : value) : v.charAt(0).toUpperCase() + v.slice(1);
    return el("span", { class: "pill pill-" + v, text: label });
  }

  /* ---------- Chart.js factory (theme-aware) ---------- */
  function themeColors() {
    var cs = getComputedStyle(document.documentElement);
    var g = function (n, fb) { var x = cs.getPropertyValue(n).trim(); return x || fb; };
    return {
      ink: g("--bs-body-color", "#0F172A"),
      muted: g("--bs-secondary-color", "#64748B"),
      line: g("--bs-border-color", "#E2E8F0"),
      surface: g("--bs-body-bg", "#fff"),
      brand: g("--brand", "#F59E0B"),
      material: g("--c-material", "#2563EB"),
      labor: g("--c-labor", "#10B981"),
      other: g("--c-other", "#8B5CF6"),
    };
  }
  function hexA(hex, a) {
    var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec((hex || "").trim());
    if (!m) return hex;
    return "rgba(" + parseInt(m[1], 16) + "," + parseInt(m[2], 16) + "," + parseInt(m[3], 16) + "," + a + ")";
  }
  function chart(canvas, type, data, opts) {
    if (typeof Chart === "undefined" || !canvas) return null;
    var t = themeColors();
    var reduce = w.matchMedia && w.matchMedia("(prefers-reduced-motion: reduce)").matches;
    Chart.defaults.font.family = "Inter, system-ui, sans-serif";
    Chart.defaults.color = t.muted;
    var base = {
      responsive: true, maintainAspectRatio: false,
      animation: reduce ? false : { duration: 600 },
      interaction: { intersect: false, mode: "index" },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: t.ink, titleColor: t.surface, bodyColor: t.surface,
          borderColor: hexA(t.line, .6), borderWidth: 1, padding: 11, cornerRadius: 10, boxPadding: 5, usePointStyle: true,
          callbacks: { label: function (c) { var l = c.dataset.label ? c.dataset.label + ": " : ""; var v = c.parsed.y != null ? c.parsed.y : c.parsed; return "  " + l + w.pesoFmt(v); } },
        },
      },
      scales: undefined,
    };
    if (type !== "doughnut" && type !== "pie") {
      base.scales = {
        x: { grid: { display: false }, ticks: { color: t.muted, maxRotation: 0, autoSkipPadding: 14 }, border: { display: false } },
        y: { beginAtZero: true, grid: { color: hexA(t.line, .7) }, border: { display: false }, ticks: { color: t.muted, callback: function (v) { return w.pesoCompact(v); } } },
      };
    }
    if (type === "bar") { base.borderRadius = 8; base.borderSkipped = false; base.maxBarThickness = 54; }
    return new Chart(canvas.getContext("2d"), { type: type, data: data, options: deepMerge(base, opts || {}) });
  }
  function deepMerge(a, b) {
    var out = Array.isArray(a) ? a.slice() : Object.assign({}, a);
    for (var k in b) { if (!Object.prototype.hasOwnProperty.call(b, k)) continue; var bv = b[k];
      if (bv && typeof bv === "object" && !Array.isArray(bv) && out[k] && typeof out[k] === "object") out[k] = deepMerge(out[k], bv); else out[k] = bv; }
    return out;
  }

  /* ---------- stat card ---------- */
  function statCard(o) {
    o = o || {};
    return el("div", { class: "col" }, el("div", { class: "card h-100 stat-card" + (o.accent ? " accent-" + o.accent : "") }, el("div", { class: "card-body" }, [
      el("div", { class: "stat-label", text: o.label || "" }),
      el("div", { class: "stat-value tnum mt-1", text: o.value != null ? o.value : "—" }),
      o.sub ? el("div", { class: "stat-sub", text: o.sub }) : null,
    ])));
  }

  /* ---------- write helper (POST/PUT/DELETE JSON with session) ---------- */
  async function api(method, path, body) {
    var opts = { method: method, credentials: "same-origin", headers: { Accept: "application/json" } };
    if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
    var res = await fetch(path, opts);
    if (res.status === 401) { location.replace("login.php"); throw new Error("Session expired."); }
    var txt = await res.text();
    var data = txt ? JSON.parse(txt) : null;
    if (!res.ok) throw new Error((data && (data.error || data.message)) || ("Request failed (" + res.status + ")."));
    return data;
  }

  w.Shell = {
    mount: mount, NAV: NAV, logout: logout, toggleTheme: toggleTheme,
    el: el, append: append, clear: clear, esc: esc,
    toast: toast, confirm: confirmDialog, openForm: openForm,
    renderTable: renderTable, emptyState: emptyState, skeletonRows: skeletonRows,
    pill: pill, chart: chart, themeColors: themeColors, hexA: hexA, statCard: statCard,
    api: api,
  };
})(window);
