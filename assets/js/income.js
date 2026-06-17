/* ============================================================
   income.js — Income ledger (Bootstrap shell)
   Company-wide receipts: list/filter/search + full CRUD against
   api/incomes.php via the Shell API.
   ============================================================ */
(function (w) {
  "use strict";
  var S = w.Shell;
  var ENDPOINT = "api/incomes.php";

  var METHODS = ["Bank", "Cash", "Cheque", "GCash", "Maya", "Bank Transfer"];

  var state = {
    projects: [],                                  // [{id,name,slug}]
    filters: { project_id: "", q: "", from: "", to: "" },
    items: [],
    summary: { count: 0, total: "0.00" },
  };
  var searchTimer = null;

  // UI nodes captured at build time so reloads only repaint data.
  var ui = {
    searchInput: null,
    projectFilter: null,
    fromInput: null,
    toInput: null,
    kpis: null,
    table: null,
  };

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    var m = await S.mount("income", { title: "Income" });
    if (!m) return;                                // null = redirected to login
    var root = m.content;

    // Header + primary action.
    root.appendChild(S.el("div", { class: "d-flex justify-content-between align-items-center flex-wrap gap-2 mb-3" }, [
      S.el("div", null, [
        S.el("h2", { class: "h4 fw-bold mb-0", text: "Income Ledger" }),
        S.el("p", { class: "text-secondary small mb-0", text: "Every receipt — client payments, refunds, and other money in." }),
      ]),
      S.el("button", { class: "btn btn-primary btn-sm", type: "button", onClick: function () { openForm(null); } },
        [S.el("i", { class: "bi bi-plus-lg me-1" }), "Record income"]),
    ]));

    root.appendChild(buildToolbar());

    // KPI row + table card.
    ui.kpis = S.el("div", { class: "row row-cols-1 row-cols-sm-2 row-cols-xl-4 g-3 mb-3" });
    root.appendChild(ui.kpis);

    ui.table = S.el("div");
    root.appendChild(S.el("div", { class: "card" }, S.el("div", { class: "card-body" }, ui.table)));

    await loadProjects();
    await reload();
  }

  /* ---------- toolbar (filters + search) ---------- */
  function buildToolbar() {
    ui.projectFilter = S.el("select", { class: "form-select form-select-sm",
      onChange: function () { state.filters.project_id = this.value; reload(); } },
      S.el("option", { value: "" }, "All projects"));

    ui.fromInput = S.el("input", { class: "form-control form-control-sm", type: "date",
      onChange: function () { state.filters.from = this.value; reload(); } });

    ui.toInput = S.el("input", { class: "form-control form-control-sm", type: "date",
      onChange: function () { state.filters.to = this.value; reload(); } });

    ui.searchInput = S.el("input", { class: "form-control", type: "search", placeholder: "Search payer, reference or note…",
      onInput: function () {
        var v = this.value;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(function () { state.filters.q = v.trim(); reload(); }, 260);
      } });

    return S.el("div", { class: "card mb-3" }, S.el("div", { class: "card-body" },
      S.el("div", { class: "row g-2 align-items-end" }, [
        S.el("div", { class: "col-12 col-md-4" }, [
          S.el("label", { class: "form-label small fw-semibold text-secondary mb-1", text: "Project" }),
          ui.projectFilter,
        ]),
        S.el("div", { class: "col-6 col-md-2" }, [
          S.el("label", { class: "form-label small fw-semibold text-secondary mb-1", text: "From" }),
          ui.fromInput,
        ]),
        S.el("div", { class: "col-6 col-md-2" }, [
          S.el("label", { class: "form-label small fw-semibold text-secondary mb-1", text: "To" }),
          ui.toInput,
        ]),
        S.el("div", { class: "col-12 col-md-4" }, [
          S.el("label", { class: "form-label small fw-semibold text-secondary mb-1", text: "Search" }),
          S.el("div", { class: "input-group input-group-sm" }, [
            S.el("span", { class: "input-group-text" }, S.el("i", { class: "bi bi-search" })),
            ui.searchInput,
          ]),
        ]),
      ])
    ));
  }

  /* ---------- projects (filter + form dropdown) ---------- */
  async function loadProjects() {
    try {
      var data = await S.api("GET", "api/projects.php");
      state.projects = ((data && data.projects) || []).map(function (p) {
        return { id: p.id, name: p.name, slug: p.slug };
      });
    } catch (e) {
      state.projects = [];
    }
    var sel = ui.projectFilter;
    S.clear(sel);
    sel.appendChild(S.el("option", { value: "" }, "All projects"));
    state.projects.forEach(function (p) {
      sel.appendChild(S.el("option", { value: String(p.id) }, p.name));
    });
    sel.value = state.filters.project_id || "";
  }

  /* ---------- load + render ---------- */
  async function reload() {
    ui.table.innerHTML = '<div class="text-center text-secondary py-5"><div class="spinner-border text-warning"></div></div>';
    try {
      var qs = buildQuery(state.filters);
      var data = await S.api("GET", ENDPOINT + (qs ? "?" + qs : ""));
      state.items = (data && data.items) || [];
      state.summary = (data && data.summary) || { count: 0, total: "0.00" };
      renderSummary(state.summary, state.items);
      renderTable(state.items);
    } catch (err) {
      S.clear(ui.kpis);
      S.emptyState(ui.table, (err && err.message) || "Could not load incomes.", "exclamation-triangle");
    }
  }

  function buildQuery(f) {
    var parts = [];
    if (f.project_id) parts.push("project_id=" + encodeURIComponent(f.project_id));
    if (f.q)          parts.push("q="          + encodeURIComponent(f.q));
    if (f.from)       parts.push("from="       + encodeURIComponent(f.from));
    if (f.to)         parts.push("to="         + encodeURIComponent(f.to));
    return parts.join("&");
  }

  /* ---------- summary KPIs ---------- */
  function thisMonthTotal(items) {
    var d = new Date();
    var ym = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
    var sum = 0;
    items.forEach(function (r) {
      if (r.income_date && String(r.income_date).indexOf(ym) === 0) {
        sum += w.toNum(r.amount);
      }
    });
    return sum;
  }

  function mostRecent(items) {
    // Items are sorted (date desc, id desc). Find first one with a date; else first.
    for (var i = 0; i < items.length; i++) {
      if (items[i].income_date) return items[i];
    }
    return items[0] || null;
  }

  function renderSummary(s, items) {
    S.clear(ui.kpis);
    var latest = mostRecent(items);
    var latestSub = "—";
    if (latest) {
      latestSub = latest.payer || latest.project_name || latest.reference || "Receipt";
    }
    S.append(ui.kpis, [
      S.statCard({ label: "Total Receipts", value: w.numFmt(s.count || 0), sub: "In current view" }),
      S.statCard({ label: "Total Received", value: w.pesoFmt(s.total), sub: "Sum of view", accent: "labor" }),
      S.statCard({ label: "This Month", value: w.pesoFmt(thisMonthTotal(items)), sub: w.monthLabel(new Date().toISOString().slice(0, 7)), accent: "labor" }),
      S.statCard({ label: "Last Receipt", value: latest ? w.fmtDate(latest.income_date, latest.income_date) : "—", sub: latestSub }),
    ]);
  }

  /* ---------- table ---------- */
  function renderTable(items) {
    S.renderTable(ui.table, {
      columns: [
        { label: "Date", render: function (r) { return w.fmtDate(r.income_date, r.income_date); } },
        { label: "Project", render: function (r) {
            if (r.project_slug) {
              return S.el("a", { class: "link-brand",
                href: "project.php?slug=" + encodeURIComponent(r.project_slug) },
                r.project_name || "—");
            }
            return S.el("span", { class: "text-secondary", text: "—" });
          } },
        { label: "Payer", render: function (r) {
            return S.el("span", { text: r.payer || "—" });
          } },
        { label: "Method", render: function (r) {
            return S.el("span", { text: r.method || "—" });
          } },
        { label: "Reference", render: function (r) {
            return S.el("span", { text: r.reference || "—" });
          } },
        { label: "Amount", num: true, render: function (r) {
            return S.el("span", { class: "fw-bold text-success", text: w.pesoFmt(r.amount) });
          } },
        { label: "Note", render: function (r) {
            if (!r.note) return S.el("span", { class: "text-secondary", text: "—" });
            return S.el("span", { class: "d-inline-block text-truncate", style: "max-width:240px",
              title: r.note, text: r.note });
          } },
        { label: "", thCls: "text-end", cls: "text-end", render: function (r) { return rowActions(r); } },
      ],
      rows: items,
      empty: "No incomes match this view. Use “Record income” to add one.",
      emptyIcon: "cash-coin",
    });
  }

  function rowActions(r) {
    var edit = S.el("button", { class: "btn btn-sm btn-outline-secondary me-1", type: "button", title: "Edit",
      onClick: function () { openForm(r); } }, S.el("i", { class: "bi bi-pencil" }));
    var del = S.el("button", { class: "btn btn-sm btn-outline-danger", type: "button", title: "Delete",
      onClick: function () { remove(r); } }, S.el("i", { class: "bi bi-trash" }));
    return S.el("span", { class: "text-nowrap" }, [edit, del]);
  }

  /* ---------- add / edit ---------- */
  function projectOptions() {
    var opts = [{ value: "", label: "— None —" }];
    state.projects.forEach(function (p) {
      opts.push({ value: p.id, label: p.name });
    });
    return opts;
  }

  function methodOptions() {
    var opts = [{ value: "", label: "—" }];
    METHODS.forEach(function (m) { opts.push({ value: m, label: m }); });
    return opts;
  }

  async function openForm(item) {
    var isEdit = !!item;
    var saved = await S.openForm({
      title: isEdit ? "Edit income" : "Record income",
      submitLabel: isEdit ? "Save changes" : "Record income",
      fields: [
        { name: "project_id", label: "Project", type: "select", col: 6,
          options: projectOptions(), value: item && item.project_id != null ? item.project_id : "" },
        { name: "income_date", label: "Date", type: "date", col: 6,
          value: item ? (item.income_date || "") : "" },
        { name: "amount", label: "Amount (₱)", type: "number", step: "0.01", required: true, col: 6,
          placeholder: "0.00", value: item && item.amount != null ? item.amount : "" },
        { name: "method", label: "Method", type: "select", col: 6,
          options: methodOptions(), value: item ? (item.method || "") : "" },
        { name: "payer", label: "Payer", type: "text", col: 6, placeholder: "Client / source",
          value: item ? (item.payer || "") : "" },
        { name: "reference", label: "Reference", type: "text", col: 6, placeholder: "Cheque # / TXN ref",
          value: item ? (item.reference || "") : "" },
        { name: "note", label: "Note", type: "text", col: 12, placeholder: "Optional remarks",
          value: item ? (item.note || "") : "" },
      ],
      onSubmit: async function (v) {
        if (v.amount === "" || isNaN(parseFloat(v.amount))) throw new Error("Enter a valid amount.");
        if (parseFloat(v.amount) < 0) throw new Error("Amount cannot be negative.");

        var payload = {
          project_id: v.project_id === "" ? null : (parseInt(v.project_id, 10) || null),
          income_date: v.income_date || null,
          amount: v.amount,
          payer: v.payer || null,
          method: v.method || null,
          reference: v.reference || null,
          note: v.note || null,
        };
        if (isEdit) {
          payload.id = item.id;
          await S.api("PUT", ENDPOINT, payload);
        } else {
          await S.api("POST", ENDPOINT, payload);
        }
      },
    });

    if (saved) {
      S.toast(isEdit ? "Income updated." : "Income recorded.", "ok");
      await reload();
    }
  }

  /* ---------- delete ---------- */
  async function remove(r) {
    var label = r.payer || r.reference || r.note || "this income";
    var ok = await S.confirm(
      "Delete “" + label + "” (" + w.pesoFmt(r.amount) + ")?",
      { title: "Delete income", danger: true, okLabel: "Delete" }
    );
    if (!ok) return;
    try {
      await S.api("DELETE", ENDPOINT, { id: r.id });
      S.toast("Income deleted.", "ok");
      await reload();
    } catch (err) {
      S.toast((err && err.message) || "Could not delete the income.", "err");
    }
  }
})(window);
