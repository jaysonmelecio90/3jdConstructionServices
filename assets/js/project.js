/* ============================================================
   project.js — Project detail page (Bootstrap shell)
   ============================================================ */
(function (w) {
  "use strict";
  var S = w.Shell;
  var charts = {};

  // Closure state shared by the tabbed Workers / Payroll / Advances / Report card.
  // (Loans live on their own dedicated page — assets/js/loans.js — not here.)
  var ctx = {
    projectId: 0,
    workersBody: null,        // pane body node for "Workers"
    payrollBody: null,        // pane body node for "Payroll" (table area)
    payrollHint: null,        // <span> in the Payroll pane header (subtotal hint)
    advancesBody: null,       // pane body node for "Cash Advances"
    advancesHint: null,       // <span> in the Cash Advances pane header (subtotal hint)
    reportBody: null,         // pane body node for "Payroll Report"
    reportStart: null,        // <input type=date> for report period start
    reportEnd: null,          // <input type=date> for report period end
    assignedWorkers: [],      // last GET items from project-workers.php
    allActiveWorkers: [],     // last GET items from workers.php?status=active
    advances: [],             // last GET items from advances.php
  };

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    var m = await S.mount("projects", { title: "Project" });
    if (!m) return;
    var root = m.content;

    var slug = readSlug();
    if (!slug) {
      noProject(root, "No project selected.");
      return;
    }

    var body = S.el("div", null);
    root.appendChild(body);
    body.innerHTML = '<div class="text-center text-secondary py-5"><div class="spinner-border text-warning"></div></div>';

    try {
      var d = await S.api("GET", "api/project.php?slug=" + encodeURIComponent(slug));
      render(body, d || {});
    } catch (err) {
      var msg = err && err.message ? err.message : "";
      if (/not found/i.test(msg) || /\(404\)/.test(msg)) {
        noProject(root, "Project not found.", body);
      } else {
        S.emptyState(body, msg || "Could not load project data.", "exclamation-triangle");
      }
    }
  }

  /* ---------- top-level render ---------- */
  function render(body, d) {
    S.clear(body);

    var project = d.project || {};
    var name = project.name || "Project";
    setTitle(name);

    var kpis = d.kpis || {};
    var grand = d.grand_total != null ? d.grand_total : kpis.grand_total;

    // Header: back link + project name + owner / location / contract meta.
    var hasContract = project.contract_price != null && w.toNum(project.contract_price) > 0;
    var meta = [];
    if (project.owner) meta.push("Owner: " + project.owner);
    if (project.location) meta.push(project.location);
    if (hasContract) meta.push("Contract " + w.pesoFmt(project.contract_price));
    meta.push(w.numFmt(kpis.expense_count) + " entries");
    body.appendChild(S.el("div", { class: "mb-3" }, [
      S.el("a", { class: "btn btn-link btn-sm px-0 text-decoration-none", href: "projects.html" }, [
        S.el("i", { class: "bi bi-arrow-left me-1" }), "Back to projects",
      ]),
      S.el("h2", { class: "h4 fw-bold mb-0", text: name }),
      S.el("p", { class: "text-secondary small mb-0", text: meta.join("  •  ") }),
    ]));

    // KPI / stat cards (Contract Price + utilization shown when a contract is set).
    var grandSub = "All categories";
    if (hasContract) {
      grandSub = (Math.round((w.toNum(grand) / w.toNum(project.contract_price)) * 1000) / 10).toFixed(1) + "% of contract";
    }
    var cards = [
      S.statCard({ label: "Grand Total", value: w.pesoFmt(grand), sub: grandSub, accent: "" }),
      S.statCard({ label: "Materials", value: w.pesoFmt(kpis.material_total), sub: pct(kpis.material_total, grand), accent: "material" }),
      S.statCard({ label: "Labor", value: w.pesoFmt(kpis.labor_total), sub: pct(kpis.labor_total, grand), accent: "labor" }),
      S.statCard({ label: "Other", value: w.pesoFmt(kpis.other_total), sub: pct(kpis.other_total, grand), accent: "other" }),
    ];
    if (hasContract) {
      cards.unshift(S.statCard({ label: "Contract Price", value: w.pesoFmt(project.contract_price), sub: "Agreed contract", accent: "labor" }));
    }
    body.appendChild(S.el("div", { class: "row row-cols-1 row-cols-sm-2 row-cols-xl-" + (hasContract ? "5" : "4") + " g-3 mb-3" }, cards));

    // Workers / Payroll / Cash Advances / Payroll Report — single tabbed card.
    ctx.projectId = w.toNum(project.id);
    body.appendChild(buildProjectTabsCard(ctx.projectId));

    // Initial fetches (don't block the render). Run in parallel so panes are populated
    // before the user clicks across tabs.
    Promise.all([
      loadAssignedWorkers(),
      loadPayroll(),
      loadAdvances(),
    ]);

    // Charts.
    var lineCanvas = S.el("canvas");
    var barCanvas = S.el("canvas");
    body.appendChild(S.el("div", { class: "row g-3 mb-3" }, [
      S.el("div", { class: "col-lg-7" }, card("Monthly Timeline", "Asia/Manila", S.el("div", { class: "chart-wrap h-line" }, lineCanvas))),
      S.el("div", { class: "col-lg-5" }, card("Top 5 Materials", "By spend", S.el("div", { class: "chart-wrap h-bar" }, barCanvas))),
    ]));

    // Materials grouped card.
    var matBody = S.el("div");
    body.appendChild(S.el("div", { class: "mb-3" }, card("Materials", "Subtotal " + w.pesoFmt(sectionTotal(d, "material")), matBody)));
    renderMaterials(matBody, d.materials_groups || []);

    // Labor + Other.
    var laborBody = S.el("div");
    var otherBody = S.el("div");
    body.appendChild(S.el("div", { class: "row g-3 mb-3" }, [
      S.el("div", { class: "col-lg-6" }, card("Labor / Payroll", "Subtotal " + w.pesoFmt(sectionTotal(d, "labor")), laborBody)),
      S.el("div", { class: "col-lg-6" }, card("Other Expenses", "Subtotal " + w.pesoFmt(sectionTotal(d, "other")), otherBody)),
    ]));
    renderSimple(laborBody, d.labor || [], "No labor entries.");
    renderSimple(otherBody, d.other || [], "No other expenses.");

    var t = S.themeColors();
    var tl = d.timeline || [];
    if (tl.length) {
      var ds = function (key, color, dash) {
        return {
          label: cap(key), data: tl.map(function (r) { return w.toNum(r[key]); }),
          borderColor: color, backgroundColor: S.hexA(color, .12), borderDash: dash || [],
          borderWidth: 2, tension: .35, pointRadius: 2.5, pointBackgroundColor: color,
        };
      };
      charts.line = S.chart(lineCanvas, "line", {
        labels: tl.map(function (r) { return w.monthLabel(r.month); }),
        datasets: [ds("material", t.material), ds("labor", t.labor, [6, 4]), ds("other", t.other, [2, 3])],
      }, { plugins: { legend: { display: true, position: "top", labels: { usePointStyle: true, padding: 14 } } } });
    } else {
      S.emptyState(lineCanvas.parentNode, "No dated expenses yet.", "calendar3");
    }

    var top = d.top_materials || [];
    if (top.length && top.some(function (x) { return w.toNum(x.total) > 0; })) {
      charts.bar = S.chart(barCanvas, "bar", {
        labels: top.map(function (x) { return x.item_name || "—"; }),
        datasets: [{ label: "Total", data: top.map(function (x) { return w.toNum(x.total); }), backgroundColor: S.hexA(t.material, .85), hoverBackgroundColor: t.material }],
      }, { indexAxis: "y", scales: { x: { ticks: { callback: function (v) { return w.pesoCompact(v); } } }, y: { grid: { display: false } } } });
    } else {
      S.emptyState(barCanvas.parentNode, "No materials yet.", "box-seam");
    }
  }

  /* ---------- materials grouped table ---------- */
  function renderMaterials(node, groups) {
    S.clear(node);
    if (!groups.length) { S.emptyState(node, "No materials yet.", "box-seam"); return; }

    var thead = S.el("thead", null, S.el("tr", null, [
      S.el("th", null, "Item / Date"),
      S.el("th", { class: "text-end" }, "Qty"),
      S.el("th", { class: "text-end" }, "Unit price"),
      S.el("th", { class: "text-end" }, "Amount"),
      S.el("th", null, "Note"),
    ]));

    var tbody = S.el("tbody");
    groups.forEach(function (g) {
      // group header row
      tbody.appendChild(S.el("tr", { class: "table-active" }, [
        S.el("td", { class: "fw-semibold", text: g.item_name || "(unnamed)" }),
        S.el("td", { class: "text-end tnum", text: w.qtyFmt(g.total_quantity) }),
        S.el("td", { class: "text-end tnum", text: g.avg_unit_price != null ? w.pesoFmt(g.avg_unit_price) : "—" }),
        S.el("td", { class: "text-end tnum" }, S.el("span", { class: "fw-bold", text: w.pesoFmt(g.subtotal) })),
        S.el("td", { class: "small text-secondary", text: w.numFmt(g.line_count) + (w.toNum(g.line_count) === 1 ? " line" : " lines") }),
      ]));
      // line rows
      (g.lines || []).forEach(function (ln) {
        tbody.appendChild(S.el("tr", null, [
          S.el("td", { class: "ps-4 small text-secondary", text: w.fmtDate(ln.entry_date_raw, ln.entry_date) || "—" }),
          S.el("td", { class: "text-end tnum", text: ln.quantity != null ? w.qtyFmt(ln.quantity) : "—" }),
          S.el("td", { class: "text-end tnum", text: ln.unit_price != null ? w.pesoFmt(ln.unit_price) : "—" }),
          S.el("td", { class: "text-end tnum", text: w.pesoFmt(ln.amount) }),
          S.el("td", { class: "small", text: ln.note || "" }),
        ]));
      });
    });

    var table = S.el("table", { class: "table table-hover align-middle mb-0" }, [thead, tbody]);
    node.appendChild(S.el("div", { class: "table-responsive" }, table));
  }

  /* ---------- labor / other simple table ---------- */
  function renderSimple(node, rows, empty) {
    S.renderTable(node, {
      columns: [
        { label: "Date", render: function (r) { return w.fmtDate(r.entry_date_raw, r.entry_date) || "—"; } },
        { label: "Payee / Item", render: function (r) { return r.payee || r.item_name || "—"; } },
        { label: "Note", render: function (r) { return r.note || ""; } },
        { label: "Amount", num: true, render: function (r) { return S.el("span", { class: "fw-semibold", text: w.pesoFmt(r.amount) }); } },
      ],
      rows: rows, empty: empty, emptyIcon: "inbox",
    });
  }

  /* ---------- helpers ---------- */
  function card(title, hint, bodyNode) {
    return S.el("div", { class: "card h-100" }, S.el("div", { class: "card-body" }, [
      S.el("div", { class: "d-flex justify-content-between align-items-center mb-3" }, [
        S.el("span", { class: "card-title mb-0", text: title }),
        hint ? S.el("span", { class: "small text-secondary", text: hint }) : null,
      ]),
      bodyNode,
    ]));
  }

  /* Card with a title + optional hint node + an action button on the right. */
  function cardWithAction(title, hintNode, actionBtn, bodyNode) {
    var right = S.el("div", { class: "d-flex align-items-center gap-2" }, [
      hintNode, actionBtn,
    ]);
    return S.el("div", { class: "card h-100" }, S.el("div", { class: "card-body" }, [
      S.el("div", { class: "d-flex justify-content-between align-items-center mb-3 gap-2 flex-wrap" }, [
        S.el("span", { class: "card-title mb-0", text: title }),
        right,
      ]),
      bodyNode,
    ]));
  }

  /* ---------- Tabbed card (Workers · Payroll · Cash Advances · Payroll Report) ---------- */
  function buildProjectTabsCard(projectId) {
    var sfx = "-" + (projectId || "0");

    // Tab body nodes (each pane's list/table area).
    var workersBody  = S.el("div", { class: "workers-list" });
    var payrollBody  = S.el("div", { class: "payroll-list" });
    var advancesBody = S.el("div", { class: "advances-list" });

    // Hint spans (subtotals).
    var payrollHint  = S.el("span", { class: "small text-secondary payroll-hint",  text: "Total payroll —" });
    var advancesHint = S.el("span", { class: "small text-secondary advances-hint", text: "Total advances —" });

    // Action buttons.
    var addWorkerBtn = S.el("button", { class: "btn btn-sm btn-outline-primary", type: "button" }, [
      S.el("i", { class: "bi bi-person-plus me-1" }), "Assign worker",
    ]);
    addWorkerBtn.addEventListener("click", openAssignWorkerForm);

    var addPayrollBtn = S.el("button", { class: "btn btn-sm btn-outline-primary", type: "button" }, [
      S.el("i", { class: "bi bi-plus-lg me-1" }), "Add payroll entry",
    ]);
    addPayrollBtn.addEventListener("click", function () { openPayrollForm(null); });

    var addAdvanceBtn = S.el("button", { class: "btn btn-sm btn-outline-primary", type: "button" }, [
      S.el("i", { class: "bi bi-plus-lg me-1" }), "Add cash advance",
    ]);
    addAdvanceBtn.addEventListener("click", function () { openAdvanceForm(null); });

    // Panes.
    var workersPane = S.el("div", { id: "pane-workers" + sfx, class: "tab-pane fade show active" }, [
      S.el("div", { class: "d-flex justify-content-end mb-2" }, addWorkerBtn),
      workersBody,
    ]);
    var payrollPane = S.el("div", { id: "pane-payroll" + sfx, class: "tab-pane fade" }, [
      S.el("div", { class: "d-flex justify-content-between align-items-center mb-2 gap-2 flex-wrap" }, [
        payrollHint, addPayrollBtn,
      ]),
      payrollBody,
    ]);
    var advancesPane = S.el("div", { id: "pane-advances" + sfx, class: "tab-pane fade" }, [
      S.el("div", { class: "d-flex justify-content-between align-items-center mb-2 gap-2 flex-wrap" }, [
        advancesHint, addAdvanceBtn,
      ]),
      advancesBody,
    ]);
    var reportPane = buildPayrollReportPane(sfx);

    // Nav tabs.
    var navTab = function (label, target, active) {
      return S.el("li", { class: "nav-item", role: "presentation" },
        S.el("button", {
          class: "nav-link" + (active ? " active" : ""),
          "data-bs-toggle": "tab",
          "data-bs-target": "#" + target,
          type: "button",
          role: "tab",
        }, label));
    };

    var nav = S.el("ul", { class: "nav nav-tabs card-header-tabs", role: "tablist" }, [
      navTab("Workers",        "pane-workers"        + sfx, true),
      navTab("Payroll",        "pane-payroll"        + sfx, false),
      navTab("Cash Advances",  "pane-advances"       + sfx, false),
      navTab("Payroll Report", "pane-payroll-report" + sfx, false),
    ]);

    // Stash on ctx for the load/render helpers.
    ctx.workersBody  = workersBody;
    ctx.payrollBody  = payrollBody;
    ctx.payrollHint  = payrollHint;
    ctx.advancesBody = advancesBody;
    ctx.advancesHint = advancesHint;

    return S.el("div", { class: "card mb-3" }, [
      S.el("div", { class: "card-header bg-transparent border-bottom-0 pt-3" }, nav),
      S.el("div", { class: "card-body" },
        S.el("div", { class: "tab-content" }, [workersPane, payrollPane, advancesPane, reportPane])),
    ]);
  }

  /* ---------- Assigned Workers ---------- */
  async function loadAssignedWorkers() {
    if (!ctx.workersBody || !ctx.projectId) return;
    S.clear(ctx.workersBody);
    ctx.workersBody.appendChild(S.el("div", { class: "py-3 text-center text-secondary" },
      S.el("div", { class: "spinner-border spinner-border-sm text-warning" })));
    try {
      var res = await S.api("GET", "api/project-workers.php?project_id=" + ctx.projectId);
      ctx.assignedWorkers = (res && res.items) || [];
      renderAssignedWorkers(ctx.workersBody, ctx.assignedWorkers);
    } catch (err) {
      S.emptyState(ctx.workersBody, (err && err.message) || "Could not load workers.", "exclamation-triangle");
    }
  }

  function renderAssignedWorkers(node, rows) {
    S.renderTable(node, {
      columns: [
        {
          label: "Name",
          render: function (r) {
            return S.el("div", null, [
              S.el("div", { class: "fw-semibold", text: r.name || "—" }),
              r.designation ? S.el("div", { class: "small text-secondary", text: r.designation }) : null,
            ]);
          },
        },
        {
          label: "Hourly", num: true,
          render: function (r) { return r.hourly_rate != null ? w.pesoFmt(r.hourly_rate) : "—"; },
        },
        {
          label: "Daily", num: true,
          render: function (r) { return r.daily_rate != null ? w.pesoFmt(r.daily_rate) : "—"; },
        },
        {
          label: "Status",
          render: function (r) { return S.pill(r.status, "status"); },
        },
        {
          label: "",
          render: function (r) {
            var btn = S.el("button", {
              class: "btn btn-sm btn-outline-danger",
              type: "button", title: "Remove worker",
            }, S.el("i", { class: "bi bi-x-lg" }));
            btn.addEventListener("click", function () { removeAssignedWorker(r); });
            return btn;
          },
          cls: "text-end",
        },
      ],
      rows: rows,
      empty: "No workers assigned to this project yet.",
      emptyIcon: "people",
    });
  }

  async function removeAssignedWorker(row) {
    var ok = await S.confirm("Remove " + (row.name || "this worker") + " from this project?", {
      title: "Remove worker", danger: true, okLabel: "Remove",
    });
    if (!ok) return;
    try {
      await S.api("DELETE", "api/project-workers.php?id=" + w.toNum(row.id));
      S.toast("Worker removed.", "ok");
      loadAssignedWorkers();
      loadPayroll();
    } catch (err) {
      S.toast((err && err.message) || "Could not remove.", "err");
    }
  }

  async function openAssignWorkerForm() {
    // Refresh the catalog of active workers each time the modal opens.
    try {
      var res = await S.api("GET", "api/workers.php?status=active");
      ctx.allActiveWorkers = (res && res.items) || [];
    } catch (err) {
      S.toast((err && err.message) || "Could not load workers.", "err");
      return;
    }

    var assignedIds = {};
    (ctx.assignedWorkers || []).forEach(function (a) { assignedIds[a.worker_id] = true; });
    var available = ctx.allActiveWorkers.filter(function (wk) { return !assignedIds[wk.id]; });

    if (!available.length) {
      S.toast("All active workers are already assigned.", "ok");
      return;
    }

    var options = available.map(function (wk) {
      var label = wk.name + (wk.designation ? " — " + wk.designation : "");
      return { value: wk.id, label: label };
    });

    S.openForm({
      title: "Assign worker to project",
      submitLabel: "Assign",
      fields: [
        { name: "worker_id", label: "Worker", type: "select", options: options, required: true, col: 12 },
      ],
      onSubmit: async function (values) {
        await S.api("POST", "api/project-workers.php", {
          project_id: ctx.projectId,
          worker_id: w.toNum(values.worker_id),
        });
        S.toast("Worker assigned.", "ok");
        loadAssignedWorkers();
      },
    });
  }

  /* ---------- Payroll ---------- */
  async function loadPayroll() {
    if (!ctx.payrollBody || !ctx.projectId) return;
    S.clear(ctx.payrollBody);
    ctx.payrollBody.appendChild(S.el("div", { class: "py-3 text-center text-secondary" },
      S.el("div", { class: "spinner-border spinner-border-sm text-warning" })));
    try {
      var res = await S.api("GET", "api/payroll.php?project_id=" + ctx.projectId);
      var items = (res && res.items) || [];
      var summary = (res && res.summary) || { total: "0.00" };
      if (ctx.payrollHint) ctx.payrollHint.textContent = "Total payroll " + w.pesoFmt(summary.total);
      renderPayroll(ctx.payrollBody, items);
    } catch (err) {
      S.emptyState(ctx.payrollBody, (err && err.message) || "Could not load payroll.", "exclamation-triangle");
    }
  }

  /* Compact "units × rate = amount" cell. Returns "—" when amount is zero. */
  function unitsRateCell(units, rate, amount, rateType) {
    var amt = w.toNum(amount);
    if (!amt) return document.createTextNode("—");
    var suffix = rateType === "hourly" ? " hr" : " d";
    var u = (units != null && units !== "") ? w.qtyFmt(units) + suffix : "—";
    var r = (rate != null && rate !== "") ? w.pesoFmt(rate) : "—";
    return S.el("div", { class: "small lh-sm" }, [
      S.el("div", { class: "text-secondary", text: u + " × " + r }),
      S.el("div", { class: "fw-bold", text: w.pesoFmt(amount) }),
    ]);
  }

  function renderPayroll(node, rows) {
    S.renderTable(node, {
      columns: [
        {
          label: "Period",
          render: function (r) {
            var start = r.period_start;
            var end = r.period_end;
            if (!start && !end) return "—";
            if (!end || end === start) return w.fmtDate(start, start) || "—";
            if (!start) return w.fmtDate(end, end) || "—";
            return (w.fmtDate(start, start) || "—") + " – " + (w.fmtDate(end, end) || "—");
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
        {
          label: "Type",
          render: function (r) {
            // Map hourly -> material color, daily -> labor color (reuse pill palette).
            var cls = "pill pill-" + (r.rate_type === "hourly" ? "material" : "labor");
            return S.el("span", { class: cls, text: r.rate_type || "—" });
          },
        },
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
        {
          label: "Note",
          render: function (r) { return r.note || "—"; },
        },
        {
          label: "",
          render: function (r) {
            var editBtn = S.el("button", {
              class: "btn btn-sm btn-outline-secondary me-1",
              type: "button", title: "Edit",
            }, S.el("i", { class: "bi bi-pencil" }));
            editBtn.addEventListener("click", function () { openPayrollForm(r); });

            var delBtn = S.el("button", {
              class: "btn btn-sm btn-outline-danger",
              type: "button", title: "Delete",
            }, S.el("i", { class: "bi bi-trash" }));
            delBtn.addEventListener("click", function () { deletePayroll(r); });

            return S.el("div", { class: "d-inline-flex" }, [editBtn, delBtn]);
          },
          cls: "text-end",
        },
      ],
      rows: rows,
      empty: "No payroll entries for this project yet.",
      emptyIcon: "cash-coin",
    });
  }

  async function deletePayroll(row) {
    var ok = await S.confirm("Delete this payroll entry?", {
      title: "Delete entry", danger: true, okLabel: "Delete",
    });
    if (!ok) return;
    try {
      await S.api("DELETE", "api/payroll.php?id=" + w.toNum(row.id));
      S.toast("Entry deleted.", "ok");
      loadPayroll();
    } catch (err) {
      S.toast((err && err.message) || "Could not delete.", "err");
    }
  }

  async function openPayrollForm(existing) {
    // Pick the worker list: assigned-to-this-project first, else all active workers.
    var pool = (ctx.assignedWorkers && ctx.assignedWorkers.length)
      ? ctx.assignedWorkers.map(function (a) {
          return { id: a.worker_id, name: a.name, designation: a.designation,
                   hourly_rate: a.hourly_rate, daily_rate: a.daily_rate };
        })
      : null;

    if (!pool) {
      try {
        var res = await S.api("GET", "api/workers.php?status=active");
        ctx.allActiveWorkers = (res && res.items) || [];
      } catch (err) {
        S.toast((err && err.message) || "Could not load workers.", "err");
        return;
      }
      pool = ctx.allActiveWorkers.map(function (wk) {
        return { id: wk.id, name: wk.name, designation: wk.designation,
                 hourly_rate: wk.hourly_rate, daily_rate: wk.daily_rate };
      });
    }

    if (!pool.length) {
      S.toast("No workers available. Add a worker first.", "err");
      return;
    }

    var workerOptions = pool.map(function (wk) {
      var label = wk.name + (wk.designation ? " — " + wk.designation : "");
      return { value: wk.id, label: label };
    });

    // Help text: show rate hints for each worker so the user can copy them into Rate.
    var hint = pool.map(function (wk) {
      var bits = [];
      if (wk.daily_rate != null)  bits.push("daily " + w.pesoFmt(wk.daily_rate));
      if (wk.hourly_rate != null) bits.push("hourly " + w.pesoFmt(wk.hourly_rate));
      return wk.name + (bits.length ? ": " + bits.join(" / ") : "");
    }).slice(0, 5).join("  •  ");

    var isEdit = !!existing;
    var initialWorkerId = existing ? existing.worker_id : (pool[0] ? pool[0].id : "");
    var initialRateType = existing ? existing.rate_type : "daily";

    S.openForm({
      title: isEdit ? "Edit payroll entry" : "Add payroll entry",
      submitLabel: isEdit ? "Save changes" : "Add entry",
      fields: [
        {
          name: "worker_id", label: "Worker", type: "select",
          options: workerOptions, value: initialWorkerId, required: true, col: 12,
        },
        {
          name: "period_start", label: "Period start", type: "date",
          value: existing ? (existing.period_start || "") : "", col: 6,
        },
        {
          name: "period_end", label: "Period end", type: "date",
          value: existing ? (existing.period_end || "") : "", col: 6,
        },
        {
          name: "rate_type", label: "Rate type", type: "select",
          options: [
            { value: "daily",  label: "Daily" },
            { value: "hourly", label: "Hourly" },
          ],
          value: initialRateType, col: 6, required: true,
        },
        {
          name: "regular_units", label: "Regular days/hours", type: "number", step: "0.01", min: 0,
          value: existing ? (existing.regular_units != null ? existing.regular_units : "") : "", col: 3,
        },
        {
          name: "regular_rate", label: "Regular rate (₱)", type: "number", step: "0.01", min: 0,
          value: existing ? (existing.regular_rate != null ? existing.regular_rate : "") : "", col: 3,
          help: hint ? "Suggested — " + hint : "",
        },
        {
          name: "overtime_units", label: "Overtime hours", type: "number", step: "0.01", min: 0,
          value: existing ? (existing.overtime_units != null ? existing.overtime_units : "") : "", col: 3,
        },
        {
          name: "overtime_rate", label: "Overtime rate (₱)", type: "number", step: "0.01", min: 0,
          value: existing ? (existing.overtime_rate != null ? existing.overtime_rate : "") : "", col: 3,
        },
        {
          name: "note", label: "Note", type: "text",
          value: existing ? (existing.note || "") : "", col: 12,
          placeholder: "Optional note",
        },
      ],
      onMount: function (inputs) {
        // Mark regular_units as user-edited the moment the user types into it,
        // so we don't clobber their value when the period dates change.
        if (inputs.regular_units) {
          // If editing an existing entry, treat the prefilled value as user-set.
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
        var payload = {
          project_id:     ctx.projectId,
          worker_id:      w.toNum(values.worker_id),
          period_start:   values.period_start || null,
          period_end:     values.period_end || null,
          rate_type:      values.rate_type || "daily",
          regular_units:  values.regular_units,
          regular_rate:   values.regular_rate,
          overtime_units: values.overtime_units,
          overtime_rate:  values.overtime_rate,
          note:           values.note || "",
        };
        if (isEdit) {
          payload.id = w.toNum(existing.id);
          await S.api("PUT", "api/payroll.php", payload);
          S.toast("Entry updated.", "ok");
        } else {
          await S.api("POST", "api/payroll.php", payload);
          S.toast("Entry added.", "ok");
        }
        loadPayroll();
      },
    });
  }

  /* ---------- Cash Advances ---------- */
  async function loadAdvances() {
    if (!ctx.advancesBody || !ctx.projectId) return;
    S.clear(ctx.advancesBody);
    ctx.advancesBody.appendChild(S.el("div", { class: "py-3 text-center text-secondary" },
      S.el("div", { class: "spinner-border spinner-border-sm text-warning" })));
    try {
      var res = await S.api("GET", "api/advances.php?project_id=" + ctx.projectId);
      ctx.advances = (res && res.items) || [];
      var summary = (res && res.summary) || { total: "0.00" };
      if (ctx.advancesHint) ctx.advancesHint.textContent = "Total advances " + w.pesoFmt(summary.total);
      renderAdvances(ctx.advancesBody, ctx.advances);
    } catch (err) {
      S.emptyState(ctx.advancesBody, (err && err.message) || "Could not load advances.", "exclamation-triangle");
    }
  }

  /* Format an advance's period as a single string (handles missing/equal endpoints). */
  function fmtAdvancePeriod(r) {
    var start = r.period_start;
    var end = r.period_end;
    if (!start && !end) return "—";
    if (!end || end === start) return w.fmtDate(start || end, start || end) || "—";
    if (!start) return w.fmtDate(end, end) || "—";
    return (w.fmtDate(start, start) || "—") + " – " + (w.fmtDate(end, end) || "—");
  }

  function renderAdvances(node, rows) {
    S.renderTable(node, {
      columns: [
        {
          label: "Period",
          render: function (r) { return fmtAdvancePeriod(r); },
        },
        {
          label: "Amount", num: true,
          render: function (r) { return S.el("span", { class: "fw-bold", text: w.pesoFmt(r.amount) }); },
        },
        {
          label: "Note",
          render: function (r) { return r.note || "—"; },
        },
        {
          label: "",
          render: function (r) {
            var editBtn = S.el("button", {
              class: "btn btn-sm btn-outline-secondary me-1",
              type: "button", title: "Edit",
            }, S.el("i", { class: "bi bi-pencil" }));
            editBtn.addEventListener("click", function () { openAdvanceForm(r); });

            var delBtn = S.el("button", {
              class: "btn btn-sm btn-outline-danger",
              type: "button", title: "Delete",
            }, S.el("i", { class: "bi bi-trash" }));
            delBtn.addEventListener("click", function () { deleteAdvance(r); });

            return S.el("div", { class: "d-inline-flex" }, [editBtn, delBtn]);
          },
          cls: "text-end",
        },
      ],
      rows: rows,
      empty: "No cash advances for this project yet.",
      emptyIcon: "wallet2",
    });
  }

  async function deleteAdvance(row) {
    var ok = await S.confirm("Delete this cash advance?", {
      title: "Delete advance", danger: true, okLabel: "Delete",
    });
    if (!ok) return;
    try {
      await S.api("DELETE", "api/advances.php?id=" + w.toNum(row.id));
      S.toast("Advance deleted.", "ok");
      loadAdvances();
    } catch (err) {
      S.toast((err && err.message) || "Could not delete.", "err");
    }
  }

  async function openAdvanceForm(existing) {
    var isEdit = !!existing;

    S.openForm({
      title: isEdit ? "Edit cash advance" : "Add cash advance",
      submitLabel: isEdit ? "Save changes" : "Add advance",
      fields: [
        {
          name: "period_start", label: "Period start", type: "date",
          value: existing ? (existing.period_start || "") : "", col: 6,
        },
        {
          name: "period_end", label: "Period end", type: "date",
          value: existing ? (existing.period_end || "") : "", col: 6,
        },
        {
          name: "amount", label: "Amount (₱)", type: "number", step: "0.01", min: 0,
          value: existing ? existing.amount : "", required: true, col: 6,
        },
        {
          name: "note", label: "Note", type: "text",
          value: existing ? (existing.note || "") : "", col: 12,
          placeholder: "What this advance covers (deducted from the period's payroll)",
        },
      ],
      onSubmit: async function (values) {
        // Per-project advance — deducted from the whole period's payroll, not a worker.
        var payload = {
          project_id:   ctx.projectId,
          worker_id:    null,
          period_start: values.period_start || null,
          period_end:   values.period_end || null,
          amount:       values.amount,
          note:         values.note || "",
        };
        if (isEdit) {
          payload.id = w.toNum(existing.id);
          await S.api("PUT", "api/advances.php", payload);
          S.toast("Advance updated.", "ok");
        } else {
          await S.api("POST", "api/advances.php", payload);
          S.toast("Advance added.", "ok");
        }
        loadAdvances();
      },
    });
  }

  /* ---------- Payroll Report (5th tab) ---------- */
  function buildPayrollReportPane(sfx) {
    var startInput = S.el("input", {
      type: "date",
      class: "form-control form-control-sm",
      "aria-label": "Period start",
    });
    var endInput = S.el("input", {
      type: "date",
      class: "form-control form-control-sm",
      "aria-label": "Period end",
    });
    var genBtn = S.el("button", {
      class: "btn btn-primary btn-sm",
      type: "button",
    }, [S.el("i", { class: "bi bi-bar-chart me-1" }), "Generate report"]);

    var pdfBtn = S.el("button", {
      class: "btn btn-outline-secondary btn-sm",
      type: "button",
      title: "Open the print dialog (choose Save as PDF as the destination)",
      disabled: "disabled",
    }, [S.el("i", { class: "bi bi-file-earmark-pdf me-1" }), "Save PDF"]);

    var reportBody = S.el("div", { class: "payroll-report-list mt-3" });

    genBtn.addEventListener("click", function () { loadPayrollReport(); });
    pdfBtn.addEventListener("click", function () { savePayrollReportPDF(); });

    var header = S.el("div", { class: "row g-2 align-items-end" }, [
      S.el("div", { class: "col-sm-4" }, [
        S.el("label", { class: "form-label small mb-1", text: "Period start" }),
        startInput,
      ]),
      S.el("div", { class: "col-sm-4" }, [
        S.el("label", { class: "form-label small mb-1", text: "Period end" }),
        endInput,
      ]),
      S.el("div", { class: "col-sm-4" }, [
        S.el("div", { class: "d-flex justify-content-end gap-2" }, [pdfBtn, genBtn]),
      ]),
    ]);

    ctx.reportStart = startInput;
    ctx.reportEnd   = endInput;
    ctx.reportBody  = reportBody;
    ctx.reportPdfBtn = pdfBtn;
    ctx.lastReport = null;

    var pane = S.el("div", { id: "pane-payroll-report" + sfx, class: "tab-pane fade" }, [
      header,
      reportBody,
    ]);

    // Initial empty hint.
    S.emptyState(reportBody, "Pick a period and click Generate report.", "bar-chart");

    return pane;
  }

  async function loadPayrollReport() {
    if (!ctx.reportBody || !ctx.projectId) return;
    var start = ctx.reportStart ? ctx.reportStart.value : "";
    var end   = ctx.reportEnd   ? ctx.reportEnd.value   : "";

    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      S.toast("Pick both period dates first.", "err");
      return;
    }
    if (Date.parse(end) < Date.parse(start)) {
      S.toast("End date must be on or after start date.", "err");
      return;
    }

    S.clear(ctx.reportBody);
    ctx.reportBody.appendChild(S.el("div", { class: "py-3 text-center text-secondary" },
      S.el("div", { class: "spinner-border spinner-border-sm text-warning" })));

    try {
      var qs = "project_id=" + ctx.projectId
             + "&period_start=" + encodeURIComponent(start)
             + "&period_end="   + encodeURIComponent(end);
      var res = await S.api("GET", "api/payroll-report.php?" + qs);
      ctx.lastReport = res || null;
      if (ctx.reportPdfBtn) {
        var hasData = !!(res && res.summary && w.toNum(res.summary.payroll_count) > 0);
        ctx.reportPdfBtn.disabled = !hasData;
      }
      renderPayrollReport(ctx.reportBody, res || {});
    } catch (err) {
      ctx.lastReport = null;
      if (ctx.reportPdfBtn) ctx.reportPdfBtn.disabled = true;
      S.emptyState(ctx.reportBody, (err && err.message) || "Could not load report.", "exclamation-triangle");
    }
  }

  /* ---------- savePayrollReportPDF ----------
     Open a clean print window with the report styled for paper, then trigger
     window.print(). Browsers expose "Save as PDF" in the print dialog, so we
     get a real, searchable PDF with zero extra dependencies. */
  function savePayrollReportPDF() {
    var data = ctx.lastReport;
    if (!data || !data.summary || w.toNum(data.summary.payroll_count) === 0) {
      S.toast("Generate a report first.", "err");
      return;
    }
    var project = data.project || {};
    var summary = data.summary || {};
    var workers = data.workers || [];
    var payroll = data.payroll_items || [];
    var advances = data.advances || [];
    var period = (summary.period || {});

    var win = window.open("", "_blank", "width=960,height=1000");
    if (!win) {
      S.toast("Pop-up blocked — allow pop-ups for this site to save the PDF.", "err");
      return;
    }

    // Build the print document.
    var esc = S.esc;
    var unitsLabel = function (u, t) { return (u == null ? "0" : String(parseFloat(u))) + " " + (t === "hourly" ? "hr" : "d"); };
    var periodCell = function (s, e) {
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
      "<title>Payroll Report — ", esc(project.name || ""), " — ", esc(period.start || ""), " to ", esc(period.end || ""), "</title>",
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
      ".kpi{display:flex;gap:12px;margin:10px 0 4px;}",
      ".kpi .card{flex:1;border:1px solid #E6EAF0;border-radius:8px;padding:11px 14px;}",
      ".kpi .label{font-size:8pt;color:#64748B;text-transform:uppercase;font-weight:700;letter-spacing:.05em;}",
      ".kpi .v{font-size:14pt;font-weight:800;margin-top:2px;font-variant-numeric:tabular-nums;}",
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
        "<div><h1>Payroll Report</h1>",
          "<div class='muted'>", esc(project.name || "Project"),
          (period.start || period.end) ? "  •  <b>" + esc(period.start || "") + "</b> to <b>" + esc(period.end || "") + "</b>" : "",
          "</div>",
        "</div>",
        "<div class='brand'>3J &amp; D Construction<small>Cost dashboard</small></div>",
      "</div>",
      "<div class='kpi'>",
        "<div class='card'><div class='label'>Gross Payroll</div><div class='v'>", w.pesoFmt(summary.gross_total), "</div><div class='sub'>", w.numFmt(summary.payroll_count), " entr", (w.toNum(summary.payroll_count) === 1 ? "y" : "ies"), "</div></div>",
        "<div class='card'><div class='label'>Less Advances</div><div class='v'>", w.pesoFmt(summary.advances_total), "</div><div class='sub'>", w.numFmt(summary.advances_count), " advance", (w.toNum(summary.advances_count) === 1 ? "" : "s"), "</div></div>",
        "<div class='card net'><div class='label'>Net Payable</div><div class='v'>", w.pesoFmt(summary.net), "</div><div class='sub'>Gross − advances</div></div>",
      "</div>",

      "<h2>Per-worker breakdown</h2>",
      "<table><thead><tr><th>Worker</th><th class='num'>Regular</th><th class='num'>Overtime</th><th class='num'>Gross</th></tr></thead><tbody>",
      workers.map(function (wk) {
        return "<tr>" +
          "<td>" + esc(wk.worker_name || "—") + (wk.designation ? "<div class='desig'>" + esc(wk.designation) + "</div>" : "") + "</td>" +
          "<td class='num'>" + w.pesoFmt(wk.regular_total) + "</td>" +
          "<td class='num'>" + w.pesoFmt(wk.overtime_total) + "</td>" +
          "<td class='num b'>" + w.pesoFmt(wk.gross_total) + "</td>" +
        "</tr>";
      }).join(""),
      "<tr class='totrow'>" +
        "<td>Gross totals</td>" +
        "<td class='num'>" + w.pesoFmt(summary.gross_regular) + "</td>" +
        "<td class='num'>" + w.pesoFmt(summary.gross_overtime) + "</td>" +
        "<td class='num'>" + w.pesoFmt(summary.gross_total) + "</td>" +
      "</tr>",
      "<tr class='totrow'>" +
        "<td>Less advances</td>" +
        "<td class='num'></td>" +
        "<td class='num'></td>" +
        "<td class='num'>− " + w.pesoFmt(summary.advances_total) + "</td>" +
      "</tr>",
      "<tr class='totrow'>" +
        "<td>Net payable</td>" +
        "<td class='num'></td>" +
        "<td class='num'></td>" +
        "<td class='num b'>" + w.pesoFmt(summary.net) + "</td>" +
      "</tr>",
      "</tbody></table>",

      "<h2>Payroll items</h2>",
      "<table><thead><tr><th>Period</th><th>Worker</th><th>Type</th><th class='num'>Regular</th><th class='num'>Overtime</th><th class='num'>Total</th></tr></thead><tbody>",
      payroll.map(function (p) {
        return "<tr>" +
          "<td>" + esc(periodCell(p.period_start, p.period_end)) + "</td>" +
          "<td>" + esc(p.worker_name || "—") + (p.designation ? "<div class='desig'>" + esc(p.designation) + "</div>" : "") + "</td>" +
          "<td>" + esc(p.rate_type || "—") + "</td>" +
          "<td class='num'>" + rateUnitAmount(p.regular_units, p.regular_rate, p.regular_amount, p.rate_type) + "</td>" +
          "<td class='num'>" + rateUnitAmount(p.overtime_units, p.overtime_rate, p.overtime_amount, "hourly") + "</td>" +
          "<td class='num b'>" + w.pesoFmt(p.amount) + "</td>" +
        "</tr>";
      }).join(""),
      "</tbody></table>",

      advances.length > 0
        ? "<h2>Cash advances</h2>" +
          "<table><thead><tr><th>Period</th><th class='num'>Amount</th><th>Note</th></tr></thead><tbody>" +
          advances.map(function (a) {
            return "<tr>" +
              "<td>" + esc(periodCell(a.period_start, a.period_end)) + "</td>" +
              "<td class='num'>" + w.pesoFmt(a.amount) + "</td>" +
              "<td>" + esc(a.note || "") + "</td>" +
            "</tr>";
          }).join("") +
          "</tbody></table>"
        : "",

      "<div class='foot'><span>Generated for 3J &amp; D Construction</span><span>", esc(project.name || ""), " · ", esc(period.start || ""), " – ", esc(period.end || ""), "</span></div>",
      "<script>window.onload=function(){setTimeout(function(){window.print();},150);};window.onafterprint=function(){setTimeout(function(){try{window.close();}catch(e){}},120);};<\/script>",
      "</body></html>",
    ].join("");

    win.document.open();
    win.document.write(html);
    win.document.close();
  }

  function renderPayrollReport(node, data) {
    S.clear(node);

    var summary  = data.summary  || {};
    var workers  = data.workers  || [];
    var payroll  = data.payroll_items || [];
    var advances = data.advances || [];

    if (w.toNum(summary.payroll_count) === 0) {
      S.emptyState(node, "No payroll entries in this period.", "calendar3");
      return;
    }

    // Stat cards.
    var stats = S.el("div", { class: "row row-cols-1 row-cols-sm-3 g-3 mb-3" }, [
      S.statCard({
        label: "Gross Payroll",
        value: w.pesoFmt(summary.gross_total),
        sub: w.numFmt(summary.payroll_count) + " entries",
        accent: "labor",
      }),
      S.statCard({
        label: "Less Advances",
        value: w.pesoFmt(summary.advances_total),
        sub: w.numFmt(summary.advances_count) + " advances",
        accent: "other",
      }),
      S.statCard({
        label: "Net Payable",
        value: w.pesoFmt(summary.net),
        sub: "Gross − advances",
        accent: "labor",
      }),
    ]);
    node.appendChild(stats);

    // Per-worker breakdown table.
    var workerBody = S.el("div");
    node.appendChild(S.el("div", { class: "mb-3" }, card(
      "Per-worker breakdown",
      w.numFmt(workers.length) + (workers.length === 1 ? " worker" : " workers"),
      workerBody
    )));
    S.renderTable(workerBody, {
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
        { label: "Regular",  num: true, render: function (r) { return w.pesoFmt(r.regular_total); } },
        { label: "Overtime", num: true, render: function (r) { return w.pesoFmt(r.overtime_total); } },
        { label: "Gross",    num: true, render: function (r) {
          return S.el("span", { class: "fw-bold", text: w.pesoFmt(r.gross_total) });
        } },
      ],
      rows: workers,
      empty: "No workers in this period.",
      emptyIcon: "people",
    });

    // Payroll items table.
    var itemsBody = S.el("div");
    node.appendChild(S.el("div", { class: "mb-3" }, card(
      "Payroll items",
      w.numFmt(payroll.length) + (payroll.length === 1 ? " entry" : " entries"),
      itemsBody
    )));
    S.renderTable(itemsBody, {
      columns: [
        {
          label: "Period",
          render: function (r) {
            var start = r.period_start;
            var end = r.period_end;
            if (!start && !end) return "—";
            if (!end || end === start) return w.fmtDate(start, start) || "—";
            if (!start) return w.fmtDate(end, end) || "—";
            return (w.fmtDate(start, start) || "—") + " – " + (w.fmtDate(end, end) || "—");
          },
        },
        { label: "Worker", render: function (r) { return r.worker_name || "—"; } },
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
      ],
      rows: payroll,
      empty: "No payroll items.",
      emptyIcon: "cash-coin",
    });

    // Advances items table.
    var advBody = S.el("div");
    node.appendChild(S.el("div", { class: "mb-0" }, card(
      "Cash advances",
      w.numFmt(advances.length) + (advances.length === 1 ? " advance" : " advances"),
      advBody
    )));
    S.renderTable(advBody, {
      columns: [
        { label: "Period", render: function (r) { return fmtAdvancePeriod(r); } },
        {
          label: "Amount", num: true,
          render: function (r) { return S.el("span", { class: "fw-semibold", text: w.pesoFmt(r.amount) }); },
        },
        { label: "Note", render: function (r) { return r.note || "—"; } },
      ],
      rows: advances,
      empty: "No advances in this period.",
      emptyIcon: "wallet2",
    });
  }

  function noProject(root, msg, body) {
    var node = body || S.el("div", null);
    if (!body) root.appendChild(node);
    S.clear(node);
    node.appendChild(S.el("div", { class: "empty-state text-center py-5" }, [
      S.el("i", { class: "bi bi-folder-x fs-1 text-secondary" }),
      S.el("p", { class: "mt-2 mb-3", text: msg }),
      S.el("a", { class: "btn btn-outline-primary btn-sm", href: "projects.html" }, [
        S.el("i", { class: "bi bi-arrow-left me-1" }), "Back to projects",
      ]),
    ]));
  }

  function setTitle(name) {
    document.title = name + " · 3J & D Construction";
    var h = document.querySelector(".topbar h1");
    if (h) h.textContent = name;
  }

  function readSlug() {
    var p = new URLSearchParams(location.search);
    var s = p.get("slug");
    return s ? s.trim() : "";
  }

  function sectionTotal(d, kind) {
    var ss = d.section_subtotals || {};
    if (ss[kind] != null) return ss[kind];
    var kpis = d.kpis || {};
    return kpis[kind + "_total"];
  }

  function pct(part, whole) {
    var tot = w.toNum(whole);
    if (tot <= 0) return "—";
    return (Math.round((w.toNum(part) / tot) * 1000) / 10).toFixed(1) + "% of total";
  }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
})(window);
