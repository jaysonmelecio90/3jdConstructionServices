/* ============================================================
   materials.js — Material List page (Bootstrap shell)
   Per-project hardware / procurement list: search, filter, CRUD,
   inline status toggle. Talks to api/materials.php + api/projects.php.
   ============================================================ */
(function (w) {
  "use strict";
  var S = w.Shell;

  var STATUS_OPTS = [
    { value: "active", label: "Active" },
    { value: "not_active", label: "Not active" },
  ];

  // page state
  var root;            // content area
  var projects = [];   // [{id,name,slug}, ...] for the filter + form select
  var statBody;        // stat-card row container
  var tableBody;       // table container
  var ctrls = {};      // { search, project, status } inputs
  var query = { q: "", project_id: "", status: "" };
  var searchTimer = null;

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    var m = await S.mount("materials", { title: "Material List" });
    if (!m) return; // redirected to login
    root = m.content;

    buildLayout();

    // Load projects (for filter + form), then the first page of items.
    try {
      var pr = await S.api("GET", "api/projects.php");
      projects = (pr && pr.projects) || [];
    } catch (err) {
      projects = []; // non-fatal — the list can still load/filter by status & search
    }
    fillProjectFilter();
    await reload();
  }

  /* ---------- static layout (header + toolbar + shells) ---------- */
  function buildLayout() {
    // page header + primary action
    root.appendChild(S.el("div", { class: "d-flex justify-content-between align-items-center flex-wrap gap-2 mb-3" }, [
      S.el("div", null, [
        S.el("h2", { class: "h4 fw-bold mb-0", text: "Material List" }),
        S.el("p", { class: "text-secondary small mb-0", text: "Per-project hardware & material procurement list." }),
      ]),
      S.el("button", { class: "btn btn-primary btn-sm", type: "button", onClick: function () { openForm(null); } },
        [S.el("i", { class: "bi bi-plus-lg me-1" }), "Add material"]),
    ]));

    // stat cards
    statBody = S.el("div", { class: "row row-cols-1 row-cols-sm-2 row-cols-xl-4 g-3 mb-3" });
    root.appendChild(statBody);

    // toolbar: search + project filter + status filter
    ctrls.search = S.el("input", {
      class: "form-control", type: "search", placeholder: "Search hardware or location…", "aria-label": "Search materials",
      onInput: function () {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(function () { query.q = ctrls.search.value.trim(); reload(); }, 300);
      },
    });
    ctrls.project = S.el("select", { class: "form-select", "aria-label": "Filter by project", style: "min-width:180px",
      onChange: function () { query.project_id = ctrls.project.value; reload(); } });
    ctrls.status = S.el("select", { class: "form-select", "aria-label": "Filter by status", style: "min-width:160px",
      onChange: function () { query.status = ctrls.status.value; reload(); } }, [
      S.el("option", { value: "" }, "All statuses"),
      S.el("option", { value: "active" }, "Active"),
      S.el("option", { value: "not_active" }, "Not active"),
    ]);

    root.appendChild(S.el("div", { class: "card mb-3" }, S.el("div", { class: "card-body" }, [
      S.el("div", { class: "row g-2 align-items-center" }, [
        S.el("div", { class: "col-12 col-md" }, S.el("div", { class: "input-group" }, [
          S.el("span", { class: "input-group-text" }, S.el("i", { class: "bi bi-search" })),
          ctrls.search,
        ])),
        S.el("div", { class: "col-6 col-md-auto" }, ctrls.project),
        S.el("div", { class: "col-6 col-md-auto" }, ctrls.status),
      ]),
    ])));

    // table card
    tableBody = S.el("div");
    root.appendChild(S.el("div", { class: "card" }, S.el("div", { class: "card-body" }, tableBody)));
  }

  function fillProjectFilter() {
    // reset to just "All projects" then append loaded projects
    S.clear(ctrls.project);
    ctrls.project.appendChild(S.el("option", { value: "" }, "All projects"));
    projects.forEach(function (p) {
      ctrls.project.appendChild(S.el("option", { value: String(p.id) }, p.name));
    });
    ctrls.project.value = query.project_id;
  }

  /* ---------- fetch + render ---------- */
  function buildQuery() {
    var parts = [];
    if (query.project_id) parts.push("project_id=" + encodeURIComponent(query.project_id));
    if (query.status) parts.push("status=" + encodeURIComponent(query.status));
    if (query.q) parts.push("q=" + encodeURIComponent(query.q));
    return parts.length ? "?" + parts.join("&") : "";
  }

  async function reload() {
    tableBody.innerHTML = '<div class="text-center text-secondary py-5"><div class="spinner-border text-warning"></div></div>';
    try {
      var d = await S.api("GET", "api/materials.php" + buildQuery());
      renderStats((d && d.summary) || {});
      renderTable((d && d.items) || []);
    } catch (err) {
      S.clear(statBody);
      S.emptyState(tableBody, err.message || "Could not load materials.", "exclamation-triangle");
    }
  }

  function renderStats(s) {
    S.clear(statBody);
    S.append(statBody, [
      S.statCard({ label: "Total items", value: w.numFmt(s.count), sub: "All statuses" }),
      S.statCard({ label: "Active items", value: w.numFmt(s.active_count), sub: "In progress", accent: "labor" }),
      S.statCard({ label: "Active value", value: w.pesoFmt(s.active_total), sub: "Active items only", accent: "material" }),
      S.statCard({ label: "Total value", value: w.pesoFmt(s.total_price), sub: "All items" }),
    ]);
  }

  function renderTable(items) {
    S.renderTable(tableBody, {
      columns: [
        { label: "Hardware", render: function (r) { return S.el("span", { class: "fw-semibold", text: r.hardware || "—" }); } },
        { label: "Project", render: function (r) {
            if (!r.project_slug) return S.el("span", { class: "text-secondary", text: r.project_name || "—" });
            return S.el("a", { class: "link-brand", href: "project.html?slug=" + encodeURIComponent(r.project_slug), text: r.project_name || "—" });
          } },
        { label: "Location", render: function (r) { return r.location ? r.location : S.el("span", { class: "text-secondary", text: "—" }); } },
        { label: "Date", render: function (r) { return w.fmtDate(r.item_date, r.item_date); } },
        { label: "Price", num: true, render: function (r) { return S.el("span", { class: "fw-bold", text: w.pesoFmt(r.price) }); } },
        { label: "Status", render: function (r) { return statusToggle(r); } },
        { label: "", thCls: "text-end", cls: "text-end", render: function (r) { return rowActions(r); } },
      ],
      rows: items,
      empty: "No materials match your filters.",
      emptyIcon: "box-seam",
    });
  }

  function statusToggle(r) {
    var v = String(r.status || "").toLowerCase();
    var label = v === "active" ? "Active" : "Not active";
    var btn = S.el("button", {
      class: "pill pill-" + v + " status-toggle",
      type: "button",
      title: "Click to toggle status",
      text: label,
    });
    btn.addEventListener("click", function () { toggleStatus(r, btn); });
    return btn;
  }

  async function toggleStatus(r, btn) {
    var next = r.status === "active" ? "not_active" : "active";
    btn.disabled = true;
    try {
      await S.api("PUT", "api/materials.php", { id: r.id, status: next });
      S.toast("Status updated.", "ok");
      reload();
    } catch (err) {
      btn.disabled = false;
      S.toast(err.message || "Could not update status.", "err");
    }
  }

  function rowActions(r) {
    var edit = S.el("button", { class: "btn btn-sm btn-outline-secondary me-1", type: "button", title: "Edit" },
      S.el("i", { class: "bi bi-pencil" }));
    edit.addEventListener("click", function () { openForm(r); });
    var del = S.el("button", { class: "btn btn-sm btn-outline-danger", type: "button", title: "Remove" },
      S.el("i", { class: "bi bi-trash" }));
    del.addEventListener("click", function () { removeItem(r); });
    return S.el("div", { class: "d-inline-flex" }, [edit, del]);
  }

  /* ---------- add / edit ---------- */
  function openForm(r) {
    var isEdit = !!r;
    if (!projects.length) { S.toast("No projects available — create a project first.", "err"); return; }

    S.openForm({
      title: isEdit ? "Edit material" : "Add material",
      submitLabel: isEdit ? "Save changes" : "Add material",
      fields: [
        { name: "project_id", label: "Project", type: "select", required: true, col: 12,
          options: projects.map(function (p) { return { value: String(p.id), label: p.name }; }),
          value: isEdit ? String(r.project_id) : (query.project_id || String(projects[0].id)) },
        { name: "hardware", label: "Hardware / item", type: "text", required: true, col: 12,
          value: isEdit ? r.hardware : "", placeholder: "e.g. 4mm plywood" },
        { name: "price", label: "Price (₱)", type: "number", step: "0.01", min: "0", col: 6,
          value: isEdit ? r.price : "", placeholder: "0.00" },
        { name: "item_date", label: "Date", type: "date", col: 6, value: isEdit ? r.item_date : "" },
        { name: "location", label: "Location / supplier", type: "text", col: 12,
          value: isEdit ? r.location : "", placeholder: "e.g. Citi Hardware" },
        { name: "status", label: "Status", type: "select", col: 12,
          options: STATUS_OPTS, value: isEdit ? r.status : "active" },
      ],
      onSubmit: async function (vals) {
        var payload = {
          project_id: parseInt(vals.project_id, 10),
          hardware: vals.hardware,
          price: vals.price === "" ? 0 : vals.price,
          location: vals.location || null,
          item_date: vals.item_date || null,
          status: vals.status,
        };
        if (isEdit) {
          payload.id = r.id;
          await S.api("PUT", "api/materials.php", payload);
        } else {
          await S.api("POST", "api/materials.php", payload);
        }
        S.toast(isEdit ? "Material updated." : "Material added.", "ok");
        reload();
      },
    });
  }

  /* ---------- delete ---------- */
  async function removeItem(r) {
    var ok = await S.confirm('Remove "' + (r.hardware || "this item") + '"? This cannot be undone.',
      { title: "Remove material", danger: true, okLabel: "Remove" });
    if (!ok) return;
    try {
      await S.api("DELETE", "api/materials.php?id=" + encodeURIComponent(r.id));
      S.toast("Material removed.", "ok");
      reload();
    } catch (err) {
      S.toast(err.message || "Could not remove material.", "err");
    }
  }
})(window);
