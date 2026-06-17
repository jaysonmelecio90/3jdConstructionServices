/* ============================================================
   loans.js — Loans page (worker loans + manual repayments)
   Talks to api/loans.php and api/loan-payments.php.
   A loan has a principal; repayments are entered manually and
   reduce the loan's Outstanding (= amount − repaid). Admin page.
   ============================================================ */
(function (w) {
  "use strict";
  var S = w.Shell;

  // page state
  var root, statBody, tableBody, ctrls = {};
  var query = { q: "", project_id: "", from: "", to: "" };
  var searchTimer = null;

  // caches for form selects
  var workersCache = null;   // active workers [{id,name,designation}]
  var projectsCache = null;  // [{id,name,slug}]

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    var m = await S.mount("loans", { title: "Loans" });
    if (!m) return; // redirected to login
    root = m.content;
    buildLayout();
    await reload();
  }

  /* ---------- static layout ---------- */
  function buildLayout() {
    root.appendChild(S.el("div", { class: "d-flex justify-content-between align-items-center flex-wrap gap-2 mb-3" }, [
      S.el("div", null, [
        S.el("h2", { class: "h4 fw-bold mb-0", text: "Loans" }),
        S.el("p", { class: "text-secondary small mb-0", text: "Worker loans across all projects, with manual repayments and outstanding balances." }),
      ]),
      S.el("button", { class: "btn btn-primary btn-sm", type: "button", onClick: function () { openLoanForm(null); } },
        [S.el("i", { class: "bi bi-plus-lg me-1" }), "Add loan"]),
    ]));

    statBody = S.el("div", { class: "row row-cols-1 row-cols-sm-2 row-cols-xl-4 g-3 mb-3" });
    root.appendChild(statBody);

    ctrls.search = S.el("input", {
      class: "form-control", type: "search",
      placeholder: "Search worker name…", "aria-label": "Search loans",
      onInput: function () {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(function () { query.q = ctrls.search.value.trim(); reload(); }, 260);
      },
    });
    ctrls.project = S.el("select", {
      class: "form-select", "aria-label": "Filter by project", style: "min-width:170px",
      onChange: function () { query.project_id = ctrls.project.value; reload(); },
    }, [S.el("option", { value: "" }, "All projects")]);
    ctrls.from = S.el("input", { class: "form-control", type: "date", "aria-label": "From date",
      onChange: function () { query.from = ctrls.from.value; reload(); } });
    ctrls.to = S.el("input", { class: "form-control", type: "date", "aria-label": "To date",
      onChange: function () { query.to = ctrls.to.value; reload(); } });

    root.appendChild(S.el("div", { class: "card mb-3" }, S.el("div", { class: "card-body" }, [
      S.el("div", { class: "row g-2 align-items-center" }, [
        S.el("div", { class: "col-12 col-md" }, S.el("div", { class: "input-group" }, [
          S.el("span", { class: "input-group-text" }, S.el("i", { class: "bi bi-search" })),
          ctrls.search,
        ])),
        S.el("div", { class: "col-12 col-md-auto" }, ctrls.project),
        S.el("div", { class: "col-6 col-md-auto" }, S.el("div", { class: "input-group" }, [
          S.el("span", { class: "input-group-text small", text: "From" }), ctrls.from,
        ])),
        S.el("div", { class: "col-6 col-md-auto" }, S.el("div", { class: "input-group" }, [
          S.el("span", { class: "input-group-text small", text: "To" }), ctrls.to,
        ])),
      ]),
    ])));

    tableBody = S.el("div");
    root.appendChild(S.el("div", { class: "card" }, S.el("div", { class: "card-body" }, tableBody)));

    // Populate the project filter in the background.
    ensureProjects().then(function (list) {
      (list || []).forEach(function (p) {
        ctrls.project.appendChild(S.el("option", { value: String(p.id) }, p.name));
      });
    });
  }

  /* ---------- fetch + render ---------- */
  function buildQuery() {
    var parts = [];
    if (query.q) parts.push("q=" + encodeURIComponent(query.q));
    if (query.project_id) parts.push("project_id=" + encodeURIComponent(query.project_id));
    if (query.from) parts.push("from=" + encodeURIComponent(query.from));
    if (query.to) parts.push("to=" + encodeURIComponent(query.to));
    return parts.length ? "?" + parts.join("&") : "";
  }

  async function reload() {
    tableBody.innerHTML = '<div class="text-center text-secondary py-5"><div class="spinner-border text-warning"></div></div>';
    try {
      var d = await S.api("GET", "api/loans.php" + buildQuery());
      var items = (d && d.items) || [];
      renderStats((d && d.summary) || {}, items);
      renderTable(items);
    } catch (err) {
      S.clear(statBody);
      S.emptyState(tableBody, (err && err.message) || "Could not load loans.", "exclamation-triangle");
    }
  }

  function renderStats(s, items) {
    S.clear(statBody);
    var openCount = 0;
    (items || []).forEach(function (r) { if (w.toNum(r.outstanding) > 0) openCount++; });
    S.append(statBody, [
      S.statCard({ label: "Total loaned", value: w.pesoFmt(s.total_loaned || s.total), sub: w.numFmt(s.count) + " loan" + (w.toNum(s.count) === 1 ? "" : "s"), accent: "other" }),
      S.statCard({ label: "Repaid",       value: w.pesoFmt(s.total_paid),  sub: "Manual repayments", accent: "labor" }),
      S.statCard({ label: "Outstanding",  value: w.pesoFmt(s.total_outstanding), sub: "Still owed", accent: "material" }),
      S.statCard({ label: "Open loans",   value: w.numFmt(openCount), sub: "Not yet fully paid" }),
    ]);
  }

  function renderTable(items) {
    S.renderTable(tableBody, {
      columns: [
        { label: "Date", render: function (r) { return w.fmtDate(r.loan_date, r.loan_date) || "—"; } },
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
          label: "Project",
          render: function (r) {
            if (r.project_id == null || !r.project_slug) {
              return S.el("span", { class: "text-secondary", text: "—" });
            }
            return S.el("a", { class: "link-brand fw-semibold", href: "project.html?slug=" + encodeURIComponent(r.project_slug) }, r.project_name);
          },
        },
        { label: "Loaned", num: true, render: function (r) { return S.el("span", { class: "fw-semibold", text: w.pesoFmt(r.amount) }); } },
        {
          label: "Repaid", num: true,
          render: function (r) {
            var paid = w.toNum(r.paid_total);
            var span = S.el("span", { class: paid > 0 ? "" : "text-secondary", text: w.pesoFmt(r.paid_total) });
            return span;
          },
        },
        {
          label: "Outstanding", num: true,
          render: function (r) {
            var out = w.toNum(r.outstanding);
            if (out <= 0) return S.el("span", { class: "pill pill-active", text: "Paid" });
            return S.el("span", { class: "fw-bold", text: w.pesoFmt(r.outstanding) });
          },
        },
        { label: "Note", render: function (r) { return r.note || "—"; } },
        { label: "", thCls: "text-end", cls: "text-end", render: function (r) { return rowActions(r); } },
      ],
      rows: items,
      empty: "No loans match your filters.",
      emptyIcon: "piggy-bank",
    });
  }

  function rowActions(r) {
    var pay = S.el("button", { class: "btn btn-sm btn-outline-primary me-1", type: "button", title: "Payments" }, [
      S.el("i", { class: "bi bi-cash-coin" }),
      r.payment_count > 0 ? S.el("span", { class: "badge text-bg-secondary ms-1", text: String(r.payment_count) }) : null,
    ]);
    pay.addEventListener("click", function () { openPaymentsModal(r); });
    var edit = S.el("button", { class: "btn btn-sm btn-outline-secondary me-1", type: "button", title: "Edit" }, S.el("i", { class: "bi bi-pencil" }));
    edit.addEventListener("click", function () { openLoanForm(r); });
    var del = S.el("button", { class: "btn btn-sm btn-outline-danger", type: "button", title: "Delete" }, S.el("i", { class: "bi bi-trash" }));
    del.addEventListener("click", function () { removeLoan(r); });
    return S.el("div", { class: "d-inline-flex" }, [pay, edit, del]);
  }

  /* ---------- caches ---------- */
  async function ensureWorkers() {
    if (workersCache) return workersCache;
    try {
      var res = await S.api("GET", "api/workers.php?status=active");
      workersCache = ((res && res.items) || []).map(function (x) { return { id: x.id, name: x.name, designation: x.designation }; });
    } catch (e) { workersCache = []; }
    return workersCache;
  }
  async function ensureProjects() {
    if (projectsCache) return projectsCache;
    try {
      var res = await S.api("GET", "api/projects.php");
      projectsCache = ((res && res.projects) || []).map(function (x) { return { id: x.id, name: x.name, slug: x.slug }; });
    } catch (e) { projectsCache = []; }
    return projectsCache;
  }

  /* ---------- add / edit loan ---------- */
  async function openLoanForm(existing) {
    var isEdit = !!existing;
    var workers = await ensureWorkers();
    if (!workers.length) { S.toast("No active workers. Add a worker first.", "err"); return; }
    var projects = await ensureProjects();

    var workerOpts = workers.map(function (wk) {
      return { value: wk.id, label: wk.name + (wk.designation ? " — " + wk.designation : "") };
    });
    var projectOpts = [{ value: "", label: "— No project (general) —" }].concat(projects.map(function (p) {
      return { value: p.id, label: p.name };
    }));

    var initialWorker = isEdit ? existing.worker_id : (workers[0] ? workers[0].id : "");
    var initialProject = isEdit ? (existing.project_id == null ? "" : existing.project_id) : "";

    S.openForm({
      title: isEdit ? "Edit loan" : "Add loan",
      submitLabel: isEdit ? "Save changes" : "Add loan",
      fields: [
        { name: "worker_id", label: "Worker", type: "select", options: workerOpts, value: initialWorker, required: true, col: 12 },
        { name: "project_id", label: "Project (optional)", type: "select", options: projectOpts, value: initialProject, col: 12 },
        { name: "loan_date", label: "Loan date", type: "date", value: isEdit ? (existing.loan_date || "") : "", col: 6 },
        { name: "amount", label: "Amount (₱)", type: "number", step: "0.01", min: 0, value: isEdit ? existing.amount : "", required: true, col: 6 },
        { name: "note", label: "Note", type: "text", value: isEdit ? (existing.note || "") : "", col: 12, placeholder: "Optional note" },
      ],
      onSubmit: async function (vals) {
        var payload = {
          worker_id: w.toNum(vals.worker_id),
          project_id: (vals.project_id === "" || vals.project_id == null) ? null : w.toNum(vals.project_id),
          loan_date: vals.loan_date || null,
          amount: vals.amount,
          note: vals.note || "",
        };
        if (isEdit) {
          payload.id = w.toNum(existing.id);
          await S.api("PUT", "api/loans.php", payload);
          S.toast("Loan updated.", "ok");
        } else {
          await S.api("POST", "api/loans.php", payload);
          S.toast("Loan added.", "ok");
        }
        reload();
      },
    });
  }

  async function removeLoan(row) {
    var msg = 'Delete this loan for "' + (row.worker_name || "worker") + '"?';
    if (w.toNum(row.payment_count) > 0) {
      msg += " Its " + row.payment_count + " repayment" + (row.payment_count === 1 ? "" : "s") + " will also be removed.";
    }
    var ok = await S.confirm(msg, { title: "Delete loan", danger: true, okLabel: "Delete" });
    if (!ok) return;
    try {
      await S.api("DELETE", "api/loans.php?id=" + w.toNum(row.id));
      S.toast("Loan deleted.", "ok");
      reload();
    } catch (err) {
      S.toast((err && err.message) || "Could not delete loan.", "err");
    }
  }

  /* ---------- payments modal (loan brief + list + add) ---------- */
  function openPaymentsModal(loan) {
    var host = document.getElementById("modalHost");
    var brief = S.el("div", { class: "d-flex flex-wrap gap-3 mb-3" });
    var listBody = S.el("div");
    var dirty = false;  // any payment mutation -> refresh the main grid once, on close

    // Re-render the modal's own list, and flag the main grid as needing a reload.
    function markDirty() { dirty = true; refresh(); }

    var addBtn = S.el("button", { class: "btn btn-sm btn-primary", type: "button" }, [S.el("i", { class: "bi bi-plus-lg me-1" }), "Add payment"]);
    addBtn.addEventListener("click", function () { openPaymentForm(loan.id, markDirty); });

    var modalEl = S.el("div", { class: "modal fade", tabindex: "-1" },
      S.el("div", { class: "modal-dialog modal-dialog-centered modal-lg" },
        S.el("div", { class: "modal-content" }, [
          S.el("div", { class: "modal-header" }, [
            S.el("h5", { class: "modal-title" }, [
              S.el("i", { class: "bi bi-cash-coin me-2" }),
              "Repayments — " + (loan.worker_name || "loan"),
            ]),
            S.el("button", { class: "btn-close", "data-bs-dismiss": "modal", type: "button" }),
          ]),
          S.el("div", { class: "modal-body" }, [
            brief,
            S.el("div", { class: "d-flex justify-content-end mb-2" }, addBtn),
            listBody,
          ]),
          S.el("div", { class: "modal-footer" }, S.el("button", { class: "btn btn-outline-secondary", "data-bs-dismiss": "modal", type: "button", text: "Close" })),
        ])
      )
    );
    host.appendChild(modalEl);
    var modal = new bootstrap.Modal(modalEl);
    modalEl.addEventListener("hidden.bs.modal", function () { modalEl.remove(); if (dirty) reload(); });

    function renderBrief(b) {
      S.clear(brief);
      function chip(label, value, cls) {
        return S.el("div", { class: "border rounded px-3 py-2" }, [
          S.el("div", { class: "stat-label", text: label }),
          S.el("div", { class: "fw-bold tnum " + (cls || ""), text: w.pesoFmt(value) }),
        ]);
      }
      S.append(brief, [
        chip("Loaned", b.amount),
        chip("Repaid", b.paid_total, "text-success"),
        chip("Outstanding", b.outstanding, w.toNum(b.outstanding) <= 0 ? "text-success" : ""),
      ]);
    }

    async function refresh() {
      listBody.innerHTML = '<div class="text-center text-secondary py-4"><div class="spinner-border spinner-border-sm text-warning"></div></div>';
      try {
        var res = await S.api("GET", "api/loan-payments.php?loan_id=" + w.toNum(loan.id));
        if (res && res.loan) renderBrief(res.loan);
        renderPayments(listBody, (res && res.items) || []);
      } catch (err) {
        S.emptyState(listBody, (err && err.message) || "Could not load payments.", "exclamation-triangle");
      }
    }

    function renderPayments(node, rows) {
      S.renderTable(node, {
        columns: [
          { label: "Date", render: function (r) { return w.fmtDate(r.payment_date, r.payment_date) || "—"; } },
          { label: "Amount", num: true, render: function (r) { return S.el("span", { class: "fw-semibold", text: w.pesoFmt(r.amount) }); } },
          { label: "Note", render: function (r) { return r.note || "—"; } },
          {
            label: "", thCls: "text-end", cls: "text-end",
            render: function (r) {
              var ed = S.el("button", { class: "btn btn-sm btn-outline-secondary me-1", type: "button", title: "Edit" }, S.el("i", { class: "bi bi-pencil" }));
              ed.addEventListener("click", function () { openPaymentForm(loan.id, markDirty, r); });
              var dl = S.el("button", { class: "btn btn-sm btn-outline-danger", type: "button", title: "Delete" }, S.el("i", { class: "bi bi-trash" }));
              dl.addEventListener("click", async function () {
                var ok = await S.confirm("Delete this repayment?", { title: "Delete payment", danger: true, okLabel: "Delete" });
                if (!ok) return;
                try { await S.api("DELETE", "api/loan-payments.php?id=" + w.toNum(r.id)); S.toast("Payment deleted.", "ok"); markDirty(); }
                catch (err) { S.toast((err && err.message) || "Could not delete.", "err"); }
              });
              return S.el("div", { class: "d-inline-flex" }, [ed, dl]);
            },
          },
        ],
        rows: rows,
        empty: "No repayments recorded yet.",
        emptyIcon: "wallet2",
      });
    }

    renderBrief(loan);
    modal.show();
    refresh();
  }

  function openPaymentForm(loanId, onDone, existing) {
    var isEdit = !!existing;
    S.openForm({
      title: isEdit ? "Edit payment" : "Add payment",
      submitLabel: isEdit ? "Save changes" : "Add payment",
      fields: [
        { name: "payment_date", label: "Payment date", type: "date", value: isEdit ? (existing.payment_date || "") : "", col: 6 },
        { name: "amount", label: "Amount (₱)", type: "number", step: "0.01", min: 0, value: isEdit ? existing.amount : "", required: true, col: 6 },
        { name: "note", label: "Note", type: "text", value: isEdit ? (existing.note || "") : "", col: 12, placeholder: "Optional note" },
      ],
      onSubmit: async function (vals) {
        var payload = {
          loan_id: w.toNum(loanId),
          payment_date: vals.payment_date || null,
          amount: vals.amount,
          note: vals.note || "",
        };
        if (isEdit) {
          payload.id = w.toNum(existing.id);
          await S.api("PUT", "api/loan-payments.php", payload);
          S.toast("Payment updated.", "ok");
        } else {
          await S.api("POST", "api/loan-payments.php", payload);
          S.toast("Payment added.", "ok");
        }
        if (typeof onDone === "function") onDone();
      },
    });
  }
})(window);
