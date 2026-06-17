/* ============================================================
   payroll.js — Company-wide Payroll (admin only)
   Aggregates payroll_entries + cash_advances across ALL projects
   via api/payroll-all.php. Adds/edits/deletes entries through
   api/payroll.php and offers a print-styled PDF export.
   ============================================================ */
(function (w) {
  "use strict";
  var S = w.Shell;
  var LIST_ENDPOINT  = "api/payroll-all.php";
  var WRITE_ENDPOINT = "api/payroll.php";

  var state = {
    projects: null,                                // cached [{id,name,slug}]
    workers:  null,                                // cached [{id,name,designation,hourly_rate,daily_rate}]
    filters:  { q: "", project_id: "", worker_id: "", period_start: "", period_end: "", scope: "" },
    last:     null,                                // last successful response
  };
  var searchTimer = null;

  // UI nodes captured at build time so reloads only repaint data.
  var ui = {
    searchInput: null, projectFilter: null, workerFilter: null,
    periodStart: null, periodEnd: null,
    statsRow: null, breakdownProjectBody: null, breakdownWorkerBody: null,
    itemsBody: null, itemsHint: null,
    pdfBtn: null,
  };

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    var m = await S.mount("payroll", { title: "Payroll" });
    if (!m) return;                                // null = redirected to login
    var root = m.content;

    // Lock the page if a non-admin user landed here directly.
    if (!m.user || m.user.role !== "admin") {
      S.emptyState(root, "Admin access required to view company payroll.", "shield-lock");
      return;
    }

    // Pre-warm caches in parallel so the form / filters open instantly.
    await Promise.all([loadProjects(), loadWorkers()]);

    // Header — title + Save PDF + Add entry.
    ui.pdfBtn = S.el("button", {
      class: "btn btn-outline-secondary btn-sm",
      type: "button", disabled: "disabled", title: "Generate a printable PDF",
      onClick: function () { savePayrollPDF(); },
    }, [S.el("i", { class: "bi bi-filetype-pdf me-1" }), "Save PDF"]);

    var addBtn = S.el("button", {
      class: "btn btn-primary btn-sm",
      type: "button",
      onClick: function () { openForm(null); },
    }, [S.el("i", { class: "bi bi-plus-lg me-1" }), "Add payroll entry"]);

    root.appendChild(S.el("div", { class: "d-flex justify-content-between align-items-center flex-wrap gap-2 mb-3" }, [
      S.el("div", null, [
        S.el("h2", { class: "h4 fw-bold mb-0", text: "Company Payroll" }),
        S.el("p", { class: "text-secondary small mb-0", text: "Every payroll entry across all projects, with cash-advance netting." }),
      ]),
      S.el("div", { class: "d-flex gap-2" }, [ui.pdfBtn, addBtn]),
    ]));

    // Toolbar.
    root.appendChild(buildToolbar());

    // Stat cards row.
    ui.statsRow = S.el("div", { class: "row row-cols-2 row-cols-md-3 row-cols-xl-7 g-3 mb-3" });
    root.appendChild(ui.statsRow);

    // Breakdown (tabbed By project / By worker).
    root.appendChild(buildBreakdownCard());

    // Items card.
    ui.itemsHint = S.el("span", { class: "small text-secondary", text: "" });
    ui.itemsBody = S.el("div");
    root.appendChild(S.el("div", { class: "card" }, S.el("div", { class: "card-body" }, [
      S.el("div", { class: "d-flex justify-content-between align-items-center mb-3 gap-2 flex-wrap" }, [
        S.el("span", { class: "card-title mb-0", text: "Payroll entries" }),
        ui.itemsHint,
      ]),
      ui.itemsBody,
    ])));

    await reload();
  }

  /* ---------- toolbar (filters + search) ---------- */
  function buildToolbar() {
    ui.searchInput = S.el("input", {
      class: "form-control", type: "search",
      placeholder: "Search worker, project or note…",
      onInput: function () {
        var v = this.value;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(function () { state.filters.q = v.trim(); reload(); }, 260);
      },
    });

    ui.projectFilter = S.el("select", {
      class: "form-select form-select-sm",
      onChange: function () { state.filters.project_id = this.value; reload(); },
    }, S.el("option", { value: "" }, "All projects"));
    (state.projects || []).forEach(function (p) {
      ui.projectFilter.appendChild(S.el("option", { value: String(p.id) }, p.name));
    });

    ui.workerFilter = S.el("select", {
      class: "form-select form-select-sm",
      onChange: function () { state.filters.worker_id = this.value; reload(); },
    }, S.el("option", { value: "" }, "All workers"));
    (state.workers || []).forEach(function (wk) {
      var label = wk.name + (wk.designation ? " — " + wk.designation : "");
      ui.workerFilter.appendChild(S.el("option", { value: String(wk.id) }, label));
    });

    ui.periodStart = S.el("input", {
      class: "form-control form-control-sm", type: "date",
      onChange: function () { state.filters.period_start = this.value; reload(); },
    });
    ui.periodEnd = S.el("input", {
      class: "form-control form-control-sm", type: "date",
      onChange: function () { state.filters.period_end = this.value; reload(); },
    });

    ui.scopeFilter = S.el("select", {
      class: "form-select form-select-sm",
      onChange: function () { state.filters.scope = this.value; reload(); },
    }, [
      S.el("option", { value: "" }, "All payroll"),
      S.el("option", { value: "project" }, "Project payroll only"),
      S.el("option", { value: "admin" }, "Admin / Overhead only"),
    ]);

    return S.el("div", { class: "card mb-3" }, S.el("div", { class: "card-body" },
      S.el("div", { class: "row g-2 align-items-end" }, [
        S.el("div", { class: "col-12 col-md-4" }, [
          S.el("label", { class: "form-label small fw-semibold text-secondary mb-1", text: "Search" }),
          S.el("div", { class: "input-group input-group-sm" }, [
            S.el("span", { class: "input-group-text" }, S.el("i", { class: "bi bi-search" })),
            ui.searchInput,
          ]),
        ]),
        S.el("div", { class: "col-6 col-md-2" }, [
          S.el("label", { class: "form-label small fw-semibold text-secondary mb-1", text: "Project" }),
          ui.projectFilter,
        ]),
        S.el("div", { class: "col-6 col-md-2" }, [
          S.el("label", { class: "form-label small fw-semibold text-secondary mb-1", text: "Worker" }),
          ui.workerFilter,
        ]),
        S.el("div", { class: "col-6 col-md-2" }, [
          S.el("label", { class: "form-label small fw-semibold text-secondary mb-1", text: "Period start" }),
          ui.periodStart,
        ]),
        S.el("div", { class: "col-6 col-md-2" }, [
          S.el("label", { class: "form-label small fw-semibold text-secondary mb-1", text: "Period end" }),
          ui.periodEnd,
        ]),
        S.el("div", { class: "col-12 col-md-3" }, [
          S.el("label", { class: "form-label small fw-semibold text-secondary mb-1", text: "Scope" }),
          ui.scopeFilter,
        ]),
      ])
    ));
  }

  /* ---------- breakdown card (tabbed) ---------- */
  function buildBreakdownCard() {
    ui.breakdownProjectBody = S.el("div");
    ui.breakdownWorkerBody  = S.el("div");

    var tabs = S.el("ul", { class: "nav nav-tabs card-header-tabs", role: "tablist" }, [
      S.el("li", { class: "nav-item", role: "presentation" },
        S.el("button", {
          class: "nav-link active", type: "button", role: "tab",
          "data-bs-toggle": "tab", "data-bs-target": "#pane-breakdown-project",
        }, "By project")),
      S.el("li", { class: "nav-item", role: "presentation" },
        S.el("button", {
          class: "nav-link", type: "button", role: "tab",
          "data-bs-toggle": "tab", "data-bs-target": "#pane-breakdown-worker",
        }, "By worker")),
    ]);

    var panes = S.el("div", { class: "tab-content pt-3" }, [
      S.el("div", { id: "pane-breakdown-project", class: "tab-pane fade show active", role: "tabpanel" },
        ui.breakdownProjectBody),
      S.el("div", { id: "pane-breakdown-worker", class: "tab-pane fade", role: "tabpanel" },
        ui.breakdownWorkerBody),
    ]);

    return S.el("div", { class: "card mb-3" }, [
      S.el("div", { class: "card-header bg-transparent border-0 pb-0" }, [
        S.el("div", { class: "d-flex justify-content-between align-items-center mb-2" }, [
          S.el("span", { class: "card-title mb-0", text: "Breakdown" }),
        ]),
        tabs,
      ]),
      S.el("div", { class: "card-body" }, panes),
    ]);
  }

  /* ---------- projects + workers caches ---------- */
  async function loadProjects() {
    if (state.projects) return state.projects;
    try {
      var data = await S.api("GET", "api/projects.php");
      state.projects = ((data && data.projects) || []).map(function (p) {
        return { id: p.id, name: p.name, slug: p.slug };
      });
    } catch (e) {
      state.projects = [];
    }
    return state.projects;
  }

  async function loadWorkers() {
    if (state.workers) return state.workers;
    try {
      var data = await S.api("GET", "api/workers.php?status=active");
      state.workers = ((data && data.items) || []).map(function (wk) {
        return {
          id: wk.id, name: wk.name, designation: wk.designation,
          hourly_rate: wk.hourly_rate, daily_rate: wk.daily_rate,
        };
      });
    } catch (e) {
      state.workers = [];
    }
    return state.workers;
  }

  /* ---------- load + render ---------- */
  function buildQuery(f) {
    var parts = [];
    if (f.q) parts.push("q=" + encodeURIComponent(f.q));
    if (f.project_id)   parts.push("project_id="   + encodeURIComponent(f.project_id));
    if (f.worker_id)    parts.push("worker_id="    + encodeURIComponent(f.worker_id));
    if (f.period_start) parts.push("period_start=" + encodeURIComponent(f.period_start));
    if (f.period_end)   parts.push("period_end="   + encodeURIComponent(f.period_end));
    if (f.scope === "admin") parts.push("admin_only=1");
    return parts.join("&");
  }

  async function reload() {
    if (ui.pdfBtn) ui.pdfBtn.disabled = true;
    if (ui.itemsBody) {
      ui.itemsBody.innerHTML =
        '<div class="text-center text-secondary py-5"><div class="spinner-border text-warning"></div></div>';
    }
    if (ui.breakdownProjectBody) ui.breakdownProjectBody.innerHTML = "";
    if (ui.breakdownWorkerBody)  ui.breakdownWorkerBody.innerHTML  = "";
    try {
      var qs = buildQuery(state.filters);
      var data = await S.api("GET", LIST_ENDPOINT + (qs ? "?" + qs : ""));

      // Client-side scope='project' filter (the API only supports admin_only=1).
      if (state.filters.scope === "project" && data) {
        data = Object.assign({}, data, {
          items:      (data.items      || []).filter(function (r) { return r.project_id != null; }),
          by_project: (data.by_project || []).filter(function (r) { return r.project_id != null; }),
        });
      }
      state.last = data;
      renderStats((data && data.summary) || {});
      renderByProject((data && data.by_project) || []);
      renderByWorker((data && data.by_worker)  || []);
      renderItems((data && data.items) || []);
      if (ui.pdfBtn && data && data.items && data.items.length > 0) {
        ui.pdfBtn.disabled = false;
      }
    } catch (err) {
      state.last = null;
      S.clear(ui.statsRow);
      if (ui.breakdownProjectBody) S.emptyState(ui.breakdownProjectBody, "Could not load breakdown.", "exclamation-triangle");
      if (ui.breakdownWorkerBody)  S.emptyState(ui.breakdownWorkerBody,  "Could not load breakdown.", "exclamation-triangle");
      S.emptyState(ui.itemsBody, (err && err.message) || "Could not load payroll.", "exclamation-triangle");
      S.toast((err && err.message) || "Could not load payroll.", "err");
    }
  }

  /* ---------- stats ---------- */
  function renderStats(s) {
    S.clear(ui.statsRow);
    S.append(ui.statsRow, [
      S.statCard({ label: "Entries",       value: w.numFmt(s.count || 0),       sub: "In current view" }),
      S.statCard({ label: "Workers",       value: w.numFmt(s.worker_count || 0), sub: "Distinct" }),
      S.statCard({ label: "Gross Regular", value: w.pesoFmt(s.gross_regular),    sub: "Regular pay",    accent: "labor" }),
      S.statCard({ label: "Gross Overtime",value: w.pesoFmt(s.gross_overtime),   sub: "Overtime pay",   accent: "material" }),
      grossTotalCard(s.gross_total),
      S.statCard({ label: "Advances",      value: w.pesoFmt(s.advances_total),   sub: "Cash advances",  accent: "other" }),
      S.statCard({ label: "Net Payable",   value: w.pesoFmt(s.net),              sub: "Gross − advances", accent: "labor" }),
    ]);
  }

  // The "Gross Total" card is rendered bold to make the headline number pop.
  function grossTotalCard(value) {
    return S.el("div", { class: "col" }, S.el("div", { class: "card h-100 stat-card accent-labor" },
      S.el("div", { class: "card-body" }, [
        S.el("div", { class: "stat-label", text: "Gross Total" }),
        S.el("div", { class: "stat-value tnum mt-1 fw-bold", text: w.pesoFmt(value) }),
        S.el("div", { class: "stat-sub", text: "Regular + Overtime" }),
      ])
    ));
  }

  /* ---------- by_project / by_worker tables ---------- */
  function renderByProject(rows) {
    S.renderTable(ui.breakdownProjectBody, {
      columns: [
        {
          label: "Project",
          render: function (r) {
            if (r.project_id == null || !r.project_slug) {
              return S.el("span", { class: "text-secondary fst-italic fw-semibold", text: r.project_name || "Admin / Overhead" });
            }
            return S.el("a", {
              class: "link-brand fw-semibold",
              href: "project.html?slug=" + encodeURIComponent(r.project_slug),
            }, r.project_name);
          },
        },
        { label: "Entries",  num: true, render: function (r) { return w.numFmt(r.entry_count); } },
        { label: "Regular",  num: true, render: function (r) { return w.pesoFmt(r.gross_regular); } },
        { label: "Overtime", num: true, render: function (r) { return w.pesoFmt(r.gross_overtime); } },
        { label: "Gross",    num: true,
          render: function (r) { return S.el("span", { class: "fw-semibold", text: w.pesoFmt(r.gross_total) }); } },
        { label: "Advances", num: true, render: function (r) { return w.pesoFmt(r.advances_total); } },
        { label: "Net",      num: true,
          render: function (r) { return S.el("span", { class: "fw-bold", text: w.pesoFmt(r.net) }); } },
      ],
      rows: rows,
      empty: "No payroll grouped by project yet.",
      emptyIcon: "folder2-open",
    });
  }

  function renderByWorker(rows) {
    S.renderTable(ui.breakdownWorkerBody, {
      columns: [
        {
          label: "Worker",
          render: function (r) {
            return S.el("div", null, [
              S.el("div", { class: "fw-semibold", text: r.worker_name || "—" }),
              r.designation ? S.el("div", { class: "small text-secondary", text: r.designation }) : null,
            ]);
          },
        },
        { label: "Entries",  num: true, render: function (r) { return w.numFmt(r.entry_count); } },
        { label: "Projects", num: true, render: function (r) { return w.numFmt(r.project_count); } },
        { label: "Regular",  num: true, render: function (r) { return w.pesoFmt(r.gross_regular); } },
        { label: "Overtime", num: true, render: function (r) { return w.pesoFmt(r.gross_overtime); } },
        { label: "Gross",    num: true,
          render: function (r) { return S.el("span", { class: "fw-bold", text: w.pesoFmt(r.gross_total) }); } },
      ],
      rows: rows,
      empty: "No payroll grouped by worker yet.",
      emptyIcon: "person-badge",
    });
  }

  /* ---------- items table ---------- */
  function periodCell(start, end) {
    if (!start && !end) return "—";
    if (!end || end === start) return w.fmtDate(start, start) || "—";
    if (!start) return w.fmtDate(end, end) || "—";
    return (w.fmtDate(start, start) || "—") + " – " + (w.fmtDate(end, end) || "—");
  }

  // Compact "units × rate = amount" cell with em dash when no amount.
  function unitsRateCell(units, rate, amount, rateType) {
    var amt = w.toNum(amount);
    if (!amt) return document.createTextNode("—");
    var suffix = rateType === "hourly" ? " hr" : " d";
    var u = (units != null && units !== "") ? w.qtyFmt(units) + suffix : "—";
    var r = (rate  != null && rate  !== "") ? w.pesoFmt(rate) : "—";
    return S.el("div", { class: "small lh-sm" }, [
      S.el("div", { class: "text-secondary", text: u + " × " + r }),
      S.el("div", { class: "fw-bold", text: w.pesoFmt(amount) }),
    ]);
  }

  function renderItems(items) {
    if (ui.itemsHint) {
      ui.itemsHint.textContent = items.length === 1
        ? "1 entry" : (w.numFmt(items.length) + " entries");
    }
    if (!items.length) {
      S.emptyState(ui.itemsBody, "No payroll entries for this filter", "calendar3");
      return;
    }
    S.renderTable(ui.itemsBody, {
      columns: [
        { label: "Period", render: function (r) { return periodCell(r.period_start, r.period_end); } },
        {
          label: "Project",
          render: function (r) {
            if (r.project_id == null || !r.project_slug) {
              return S.el("span", { class: "text-secondary fst-italic", text: "Admin / Overhead" });
            }
            return S.el("a", {
              class: "link-brand",
              href: "project.html?slug=" + encodeURIComponent(r.project_slug),
            }, r.project_name || "—");
          },
        },
        {
          label: "Worker",
          render: function (r) {
            return S.el("div", null, [
              S.el("div", { class: "fw-semibold", text: r.worker_name || "—" }),
              r.designation ? S.el("div", { class: "small text-secondary", text: r.designation }) : null,
            ]);
          },
        },
        { label: "Type", render: function (r) { return r.rate_type || "—"; } },
        {
          label: "Regular", num: true,
          render: function (r) {
            return unitsRateCell(r.regular_units, r.regular_rate, r.regular_amount, r.rate_type);
          },
        },
        {
          label: "Overtime", num: true,
          render: function (r) {
            return unitsRateCell(r.overtime_units, r.overtime_rate, r.overtime_amount, "hourly");
          },
        },
        {
          label: "Total", num: true,
          render: function (r) { return S.el("span", { class: "fw-bold", text: w.pesoFmt(r.amount) }); },
        },
        { label: "Note", render: function (r) { return r.note || "—"; } },
        {
          label: "", thCls: "text-end", cls: "text-end",
          render: function (r) { return rowActions(r); },
        },
      ],
      rows: items,
      empty: "No payroll entries for this filter",
      emptyIcon: "calendar3",
    });
  }

  function rowActions(r) {
    var edit = S.el("button", {
      class: "btn btn-sm btn-outline-secondary me-1",
      type: "button", title: "Edit",
      onClick: function () { openForm(r); },
    }, S.el("i", { class: "bi bi-pencil" }));
    var del = S.el("button", {
      class: "btn btn-sm btn-outline-danger",
      type: "button", title: "Delete",
      onClick: function () { removeEntry(r); },
    }, S.el("i", { class: "bi bi-trash" }));
    return S.el("span", { class: "text-nowrap" }, [edit, del]);
  }

  async function removeEntry(row) {
    var ok = await S.confirm("Delete this payroll entry?", {
      title: "Delete payroll entry", danger: true, okLabel: "Delete",
    });
    if (!ok) return;
    try {
      await S.api("DELETE", WRITE_ENDPOINT + "?id=" + w.toNum(row.id));
      S.toast("Entry deleted.", "ok");
      reload();
    } catch (err) {
      S.toast((err && err.message) || "Could not delete.", "err");
    }
  }

  /* ---------- add / edit form ---------- */
  function projectOptions() {
    var opts = [{ value: "", label: "— Admin / Overhead (no project) —" }];
    (state.projects || []).forEach(function (p) { opts.push({ value: p.id, label: p.name }); });
    return opts;
  }
  function workerOptions() {
    return (state.workers || []).map(function (wk) {
      var label = wk.name + (wk.designation ? " — " + wk.designation : "");
      return { value: wk.id, label: label };
    });
  }

  async function openForm(existing) {
    await Promise.all([loadProjects(), loadWorkers()]);
    if (!(state.projects && state.projects.length)) {
      S.toast("No projects available. Add a project first.", "err");
      return;
    }
    if (!(state.workers && state.workers.length)) {
      S.toast("No active workers available. Add a worker first.", "err");
      return;
    }

    var isEdit = !!existing;
    var initialProjectId = existing
      ? (existing.project_id == null ? "" : existing.project_id)
      : (state.projects[0] ? state.projects[0].id : "");
    var initialWorkerId  = existing ? existing.worker_id  : (state.workers[0]  ? state.workers[0].id  : "");
    var initialRateType  = existing ? (existing.rate_type || "daily") : "daily";

    await S.openForm({
      title: isEdit ? "Edit payroll entry" : "Add payroll entry",
      submitLabel: isEdit ? "Save changes" : "Add entry",
      fields: [
        {
          name: "project_id", label: "Project", type: "select", required: true, col: 12,
          options: projectOptions(), value: initialProjectId,
        },
        {
          name: "worker_id", label: "Worker", type: "select", required: true, col: 12,
          options: workerOptions(), value: initialWorkerId,
        },
        {
          name: "period_start", label: "Period start", type: "date", col: 6,
          value: existing ? (existing.period_start || "") : "",
        },
        {
          name: "period_end", label: "Period end", type: "date", col: 6,
          value: existing ? (existing.period_end || "") : "",
        },
        {
          name: "rate_type", label: "Rate type", type: "select", col: 6, required: true,
          options: [
            { value: "daily",  label: "Daily" },
            { value: "hourly", label: "Hourly" },
          ],
          value: initialRateType,
        },
        {
          name: "regular_units", label: "Regular days/hours", type: "number",
          step: "0.01", min: 0, col: 3,
          value: existing && existing.regular_units != null ? existing.regular_units : "",
        },
        {
          name: "regular_rate", label: "Regular rate (₱)", type: "number",
          step: "0.01", min: 0, col: 3,
          value: existing && existing.regular_rate != null ? existing.regular_rate : "",
        },
        {
          name: "overtime_units", label: "Overtime hours", type: "number",
          step: "0.01", min: 0, col: 3,
          value: existing && existing.overtime_units != null ? existing.overtime_units : "",
        },
        {
          name: "overtime_rate", label: "Overtime rate (₱)", type: "number",
          step: "0.01", min: 0, col: 3,
          value: existing && existing.overtime_rate != null ? existing.overtime_rate : "",
        },
        {
          name: "note", label: "Note", type: "text", col: 12,
          value: existing ? (existing.note || "") : "",
          placeholder: "Optional note",
        },
      ],
      onMount: function (inputs) {
        // Mark regular_units as user-edited so date changes never clobber a typed value.
        if (inputs.regular_units) {
          if (isEdit && existing && existing.regular_units != null && String(existing.regular_units) !== "") {
            inputs.regular_units.dataset.userEdited = "true";
          }
          inputs.regular_units.addEventListener("input", function () {
            inputs.regular_units.dataset.userEdited = "true";
          });
        }
        function autofillDays() {
          if (!inputs.period_start || !inputs.period_end || !inputs.regular_units) return;
          var s = inputs.period_start.value;
          var e = inputs.period_end.value;
          if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !/^\d{4}-\d{2}-\d{2}$/.test(e)) return;
          var sp = Date.parse(s);
          var ep = Date.parse(e);
          if (!isFinite(sp) || !isFinite(ep)) return;
          var days = Math.floor((ep - sp) / 86400000) + 1;
          if (days > 0 && inputs.regular_units.dataset.userEdited !== "true") {
            inputs.regular_units.value = String(days);
          }
        }
        if (inputs.period_start) inputs.period_start.addEventListener("change", autofillDays);
        if (inputs.period_end)   inputs.period_end.addEventListener("change", autofillDays);
      },
      onSubmit: async function (values) {
        var rawProj   = values.project_id;
        var projectId = (rawProj === "" || rawProj == null) ? null : w.toNum(rawProj);
        var workerId  = w.toNum(values.worker_id);
        if (!workerId)  throw new Error("Please choose a worker.");

        var payload = {
          project_id:     projectId,
          worker_id:      workerId,
          period_start:   values.period_start || null,
          period_end:     values.period_end   || null,
          rate_type:      values.rate_type    || "daily",
          regular_units:  values.regular_units,
          regular_rate:   values.regular_rate,
          overtime_units: values.overtime_units,
          overtime_rate:  values.overtime_rate,
          note:           values.note || "",
        };
        if (isEdit) {
          payload.id = w.toNum(existing.id);
          await S.api("PUT", WRITE_ENDPOINT, payload);
          S.toast("Entry updated.", "ok");
        } else {
          await S.api("POST", WRITE_ENDPOINT, payload);
          S.toast("Entry added.", "ok");
        }
        reload();
      },
    });
  }

  /* ---------- Save PDF (print-styled new window) ---------- */
  function savePayrollPDF() {
    var data = state.last;
    if (!data || !data.items || data.items.length === 0) {
      S.toast("Nothing to print — adjust filters first.", "err");
      return;
    }
    var summary    = data.summary || {};
    var byProject  = data.by_project || [];
    var byWorker   = data.by_worker  || [];
    var items      = data.items      || [];
    var filters    = data.filters    || {};

    var win = window.open("", "_blank", "width=960,height=1000");
    if (!win) {
      S.toast("Pop-up blocked — allow pop-ups for this site to save the PDF.", "err");
      return;
    }

    var esc = S.esc;
    var periodLine = (function () {
      var s = filters.period_start || "";
      var e = filters.period_end   || "";
      if (s && e) return s + " to " + e;
      if (s) return "From " + s;
      if (e) return "Through " + e;
      return "All periods";
    })();

    // Pretty filter chips for the header (project / worker / search).
    var filterChips = [];
    if (filters.project_id) {
      var p = (state.projects || []).filter(function (x) { return String(x.id) === String(filters.project_id); })[0];
      if (p) filterChips.push("Project: " + p.name);
    }
    if (filters.worker_id) {
      var wk = (state.workers || []).filter(function (x) { return String(x.id) === String(filters.worker_id); })[0];
      if (wk) filterChips.push("Worker: " + wk.name);
    }
    if (filters.q) filterChips.push("Search: " + filters.q);
    var filterLine = filterChips.length ? filterChips.join("  ·  ") : "No filters applied";

    var unitsLabel = function (u, t) { return (u == null ? "0" : String(parseFloat(u))) + " " + (t === "hourly" ? "hr" : "d"); };
    var periodCellStr = function (s, e) {
      if (!s && !e) return "—";
      if (s && e && s !== e) return w.fmtDate(s, s) + " – " + w.fmtDate(e, e);
      return w.fmtDate(s || e, s || e);
    };
    var rateUnitAmount = function (units, rate, amount, t) {
      if (w.toNum(amount) <= 0) return "—";
      return esc(unitsLabel(units, t)) + " × " + w.pesoFmt(rate) + " = <span class='b'>" + w.pesoFmt(amount) + "</span>";
    };

    var html = [
      "<!DOCTYPE html><html lang='en'><head><meta charset='utf-8' />",
      "<title>Company Payroll — ", esc(periodLine), "</title>",
      "<style>",
      "*{box-sizing:border-box;}",
      "body{font-family:Inter,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#0F172A;margin:22px;background:#fff;line-height:1.45;}",
      "h1{font-size:18pt;margin:0 0 2px 0;letter-spacing:-.01em;}",
      "h2{font-size:11pt;margin:18px 0 8px 0;color:#0F172A;}",
      ".muted{color:#64748B;font-size:9pt;}",
      ".b{font-weight:700;}",
      ".head{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #F59E0B;padding-bottom:10px;margin-bottom:14px;}",
      ".brand{font-weight:800;color:#D97706;font-size:13pt;letter-spacing:-.01em;text-align:right;}",
      ".brand small{display:block;font-size:8pt;color:#64748B;font-weight:600;letter-spacing:.06em;text-transform:uppercase;}",
      ".kpi{display:flex;gap:10px;margin:10px 0 4px;flex-wrap:wrap;}",
      ".kpi .card{flex:1 1 130px;border:1px solid #E6EAF0;border-radius:8px;padding:9px 12px;}",
      ".kpi .label{font-size:7.5pt;color:#64748B;text-transform:uppercase;font-weight:700;letter-spacing:.05em;}",
      ".kpi .v{font-size:12pt;font-weight:800;margin-top:2px;font-variant-numeric:tabular-nums;}",
      ".kpi .sub{font-size:8pt;color:#64748B;margin-top:1px;}",
      ".kpi .net .v{color:#10B981;}",
      "table{width:100%;border-collapse:collapse;font-size:9pt;margin:6px 0 14px;}",
      "thead th{text-align:left;background:#F4F6FA;border-bottom:1px solid #E6EAF0;padding:7px 9px;font-size:7.5pt;text-transform:uppercase;color:#64748B;font-weight:700;letter-spacing:.04em;}",
      "tbody td{padding:7px 9px;border-bottom:1px solid #EFF1F5;vertical-align:top;}",
      ".num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;}",
      ".totrow td{font-weight:700;background:#FBFCFE;border-top:1px solid #CBD5E1;}",
      ".desig{font-size:8pt;color:#64748B;}",
      ".foot{margin-top:18px;border-top:1px solid #E6EAF0;padding-top:8px;display:flex;justify-content:space-between;font-size:8pt;color:#64748B;}",
      "@page{size:A4;margin:14mm;}",
      "@media print{body{margin:0;}}",
      "</style></head><body>",
      "<div class='head'>",
        "<div><h1>Company Payroll</h1>",
          "<div class='muted'>", esc(periodLine), "  ·  ", esc(filterLine), "</div>",
        "</div>",
        "<div class='brand'>3J &amp; D Construction<small>Payroll report</small></div>",
      "</div>",

      "<div class='kpi'>",
        "<div class='card'><div class='label'>Entries</div><div class='v'>", w.numFmt(summary.count || 0), "</div><div class='sub'>In current view</div></div>",
        "<div class='card'><div class='label'>Workers</div><div class='v'>", w.numFmt(summary.worker_count || 0), "</div><div class='sub'>Distinct</div></div>",
        "<div class='card'><div class='label'>Gross Regular</div><div class='v'>", w.pesoFmt(summary.gross_regular), "</div><div class='sub'>Regular pay</div></div>",
        "<div class='card'><div class='label'>Gross Overtime</div><div class='v'>", w.pesoFmt(summary.gross_overtime), "</div><div class='sub'>Overtime pay</div></div>",
        "<div class='card'><div class='label'>Gross Total</div><div class='v'>", w.pesoFmt(summary.gross_total), "</div><div class='sub'>Regular + Overtime</div></div>",
        "<div class='card'><div class='label'>Advances</div><div class='v'>", w.pesoFmt(summary.advances_total), "</div><div class='sub'>Cash advances</div></div>",
        "<div class='card net'><div class='label'>Net Payable</div><div class='v'>", w.pesoFmt(summary.net), "</div><div class='sub'>Gross − advances</div></div>",
      "</div>",

      "<h2>By project</h2>",
      "<table><thead><tr><th>Project</th><th class='num'>Entries</th><th class='num'>Regular</th><th class='num'>Overtime</th><th class='num'>Gross</th><th class='num'>Advances</th><th class='num'>Net</th></tr></thead><tbody>",
      byProject.map(function (r) {
        return "<tr>" +
          "<td>" + esc(r.project_name || "—") + "</td>" +
          "<td class='num'>" + w.numFmt(r.entry_count) + "</td>" +
          "<td class='num'>" + w.pesoFmt(r.gross_regular) + "</td>" +
          "<td class='num'>" + w.pesoFmt(r.gross_overtime) + "</td>" +
          "<td class='num b'>" + w.pesoFmt(r.gross_total) + "</td>" +
          "<td class='num'>" + w.pesoFmt(r.advances_total) + "</td>" +
          "<td class='num b'>" + w.pesoFmt(r.net) + "</td>" +
        "</tr>";
      }).join(""),
      "<tr class='totrow'>" +
        "<td>Totals</td>" +
        "<td class='num'>" + w.numFmt(summary.count || 0) + "</td>" +
        "<td class='num'>" + w.pesoFmt(summary.gross_regular) + "</td>" +
        "<td class='num'>" + w.pesoFmt(summary.gross_overtime) + "</td>" +
        "<td class='num'>" + w.pesoFmt(summary.gross_total) + "</td>" +
        "<td class='num'>" + w.pesoFmt(summary.advances_total) + "</td>" +
        "<td class='num'>" + w.pesoFmt(summary.net) + "</td>" +
      "</tr>",
      "</tbody></table>",

      "<h2>By worker</h2>",
      "<table><thead><tr><th>Worker</th><th class='num'>Entries</th><th class='num'>Projects</th><th class='num'>Regular</th><th class='num'>Overtime</th><th class='num'>Gross</th></tr></thead><tbody>",
      byWorker.map(function (r) {
        return "<tr>" +
          "<td>" + esc(r.worker_name || "—") + (r.designation ? "<div class='desig'>" + esc(r.designation) + "</div>" : "") + "</td>" +
          "<td class='num'>" + w.numFmt(r.entry_count) + "</td>" +
          "<td class='num'>" + w.numFmt(r.project_count) + "</td>" +
          "<td class='num'>" + w.pesoFmt(r.gross_regular) + "</td>" +
          "<td class='num'>" + w.pesoFmt(r.gross_overtime) + "</td>" +
          "<td class='num b'>" + w.pesoFmt(r.gross_total) + "</td>" +
        "</tr>";
      }).join(""),
      "</tbody></table>",

      "<h2>Payroll entries</h2>",
      "<table><thead><tr><th>Period</th><th>Project</th><th>Worker</th><th>Type</th><th class='num'>Regular</th><th class='num'>Overtime</th><th class='num'>Total</th><th>Note</th></tr></thead><tbody>",
      items.map(function (p) {
        return "<tr>" +
          "<td>" + esc(periodCellStr(p.period_start, p.period_end)) + "</td>" +
          "<td>" + esc(p.project_name || "—") + "</td>" +
          "<td>" + esc(p.worker_name  || "—") + (p.designation ? "<div class='desig'>" + esc(p.designation) + "</div>" : "") + "</td>" +
          "<td>" + esc(p.rate_type || "—") + "</td>" +
          "<td class='num'>" + rateUnitAmount(p.regular_units, p.regular_rate, p.regular_amount, p.rate_type) + "</td>" +
          "<td class='num'>" + rateUnitAmount(p.overtime_units, p.overtime_rate, p.overtime_amount, "hourly") + "</td>" +
          "<td class='num b'>" + w.pesoFmt(p.amount) + "</td>" +
          "<td>" + esc(p.note || "") + "</td>" +
        "</tr>";
      }).join(""),
      "</tbody></table>",

      "<div class='foot'><span>Generated for 3J &amp; D Construction</span><span>", esc(periodLine), "</span></div>",
      "<script>window.onload=function(){setTimeout(function(){window.print();},150);};window.onafterprint=function(){setTimeout(function(){try{window.close();}catch(e){}},120);};<\/script>",
      "</body></html>",
    ].join("");

    win.document.open();
    win.document.write(html);
    win.document.close();
  }
})(window);
