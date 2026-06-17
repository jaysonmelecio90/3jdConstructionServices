/* ============================================================
   workers.js — Workers page (worker directory + CRUD)
   Talks to api/workers.php. Search + status filter + add/edit/delete.
   ============================================================ */
(function (w) {
  "use strict";
  var S = w.Shell;

  var STATUS_OPTS = [
    { value: "active", label: "Active" },
    { value: "inactive", label: "Inactive" },
  ];
  var TYPE_OPTS = [
    { value: "field", label: "Field worker" },
    { value: "admin", label: "Admin / Overhead" },
  ];

  // page state
  var root;
  var statBody;
  var tableBody;
  var ctrls = {};                       // { search, status, type }
  var query = { q: "", status: "", type: "" };
  var searchTimer = null;

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    var m = await S.mount("workers", { title: "Workers" });
    if (!m) return; // redirected to login
    root = m.content;

    buildLayout();
    await reload();
  }

  /* ---------- static layout ---------- */
  function buildLayout() {
    // header + primary action
    root.appendChild(S.el("div", { class: "d-flex justify-content-between align-items-center flex-wrap gap-2 mb-3" }, [
      S.el("div", null, [
        S.el("h2", { class: "h4 fw-bold mb-0", text: "Workers" }),
        S.el("p", { class: "text-secondary small mb-0", text: "Worker directory — designations, pay rates, and project assignments." }),
      ]),
      S.el("button", { class: "btn btn-primary btn-sm", type: "button", onClick: function () { openForm(null); } },
        [S.el("i", { class: "bi bi-plus-lg me-1" }), "Add worker"]),
    ]));

    // stat cards (5 cards now: + Admin staff)
    statBody = S.el("div", { class: "row row-cols-1 row-cols-sm-2 row-cols-xl-5 g-3 mb-3" });
    root.appendChild(statBody);

    // toolbar: search + status filter + type filter
    ctrls.search = S.el("input", {
      class: "form-control",
      type: "search",
      placeholder: "Search name, designation, phone, email…",
      "aria-label": "Search workers",
      onInput: function () {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(function () { query.q = ctrls.search.value.trim(); reload(); }, 260);
      },
    });
    ctrls.status = S.el("select", {
      class: "form-select",
      "aria-label": "Filter by status",
      style: "min-width:150px",
      onChange: function () { query.status = ctrls.status.value; reload(); },
    }, [
      S.el("option", { value: "" }, "All statuses"),
      S.el("option", { value: "active" }, "Active"),
      S.el("option", { value: "inactive" }, "Inactive"),
    ]);
    ctrls.type = S.el("select", {
      class: "form-select",
      "aria-label": "Filter by type",
      style: "min-width:150px",
      onChange: function () { query.type = ctrls.type.value; reload(); },
    }, [
      S.el("option", { value: "" }, "All types"),
      S.el("option", { value: "field" }, "Field"),
      S.el("option", { value: "admin" }, "Admin"),
    ]);

    root.appendChild(S.el("div", { class: "card mb-3" }, S.el("div", { class: "card-body" }, [
      S.el("div", { class: "row g-2 align-items-center" }, [
        S.el("div", { class: "col-12 col-md" }, S.el("div", { class: "input-group" }, [
          S.el("span", { class: "input-group-text" }, S.el("i", { class: "bi bi-search" })),
          ctrls.search,
        ])),
        S.el("div", { class: "col-6 col-md-auto" }, ctrls.type),
        S.el("div", { class: "col-6 col-md-auto" }, ctrls.status),
      ]),
    ])));

    // table card
    tableBody = S.el("div");
    root.appendChild(S.el("div", { class: "card" }, S.el("div", { class: "card-body" }, tableBody)));
  }

  /* ---------- fetch + render ---------- */
  function buildQuery() {
    var parts = [];
    if (query.q) parts.push("q=" + encodeURIComponent(query.q));
    if (query.status) parts.push("status=" + encodeURIComponent(query.status));
    if (query.type) parts.push("type=" + encodeURIComponent(query.type));
    return parts.length ? "?" + parts.join("&") : "";
  }

  async function reload() {
    tableBody.innerHTML = '<div class="text-center text-secondary py-5"><div class="spinner-border text-warning"></div></div>';
    try {
      var d = await S.api("GET", "api/workers.php" + buildQuery());
      var items = (d && d.items) || [];
      renderStats((d && d.summary) || {}, items);
      renderTable(items);
    } catch (err) {
      S.clear(statBody);
      S.emptyState(tableBody, err.message || "Could not load workers.", "exclamation-triangle");
    }
  }

  function renderStats(s, items) {
    S.clear(statBody);
    var assigned = 0;
    for (var i = 0; i < items.length; i++) {
      if ((items[i].project_count | 0) > 0) assigned++;
    }
    S.append(statBody, [
      S.statCard({ label: "Total workers", value: w.numFmt(s.count), sub: "In directory" }),
      S.statCard({ label: "Active",        value: w.numFmt(s.active_count), sub: "Working", accent: "labor" }),
      S.statCard({ label: "Admin staff",   value: w.numFmt(s.admin_count), sub: "Overhead / office", accent: "material" }),
      S.statCard({ label: "Inactive",      value: w.numFmt(s.inactive_count), sub: "Not working" }),
      S.statCard({ label: "Assigned",      value: w.numFmt(assigned), sub: "On a project" }),
    ]);
  }

  function renderTable(items) {
    S.renderTable(tableBody, {
      columns: [
        {
          label: "Name",
          render: function (r) {
            var kids = [S.el("div", { class: "fw-semibold", text: r.name || "—" })];
            if (r.designation) {
              kids.push(S.el("div", { class: "small text-secondary", text: r.designation }));
            }
            return S.el("div", null, kids);
          },
        },
        { label: "Designation", render: function (r) { return r.designation || "—"; } },
        {
          label: "Type",
          render: function (r) {
            var t = (r.type || "field").toLowerCase();
            var cls = t === "admin" ? "pill pill-material" : "pill pill-labor";
            var label = t === "admin" ? "Admin" : "Field";
            return S.el("span", { class: cls, text: label });
          },
        },
        {
          label: "Hourly", num: true,
          render: function (r) {
            return r.hourly_rate === null || r.hourly_rate === undefined || r.hourly_rate === ""
              ? "—" : w.pesoFmt(r.hourly_rate);
          },
        },
        {
          label: "Daily", num: true,
          render: function (r) {
            return r.daily_rate === null || r.daily_rate === undefined || r.daily_rate === ""
              ? "—" : w.pesoFmt(r.daily_rate);
          },
        },
        { label: "Phone", render: function (r) { return r.phone || "—"; } },
        { label: "Projects", num: true, render: function (r) { return w.numFmt(r.project_count); } },
        { label: "Status", render: function (r) { return S.pill(r.status, "status"); } },
        {
          label: "",
          thCls: "text-end",
          cls: "text-end",
          render: function (r) { return rowActions(r); },
        },
      ],
      rows: items,
      empty: "No workers match your filters.",
      emptyIcon: "people",
    });
  }

  function rowActions(r) {
    var edit = S.el("button", { class: "btn btn-sm btn-outline-secondary me-1", type: "button", title: "Edit" },
      S.el("i", { class: "bi bi-pencil" }));
    edit.addEventListener("click", function () { openForm(r); });
    var del = S.el("button", { class: "btn btn-sm btn-outline-danger", type: "button", title: "Delete" },
      S.el("i", { class: "bi bi-trash" }));
    del.addEventListener("click", function () { removeItem(r); });
    return S.el("div", { class: "d-inline-flex" }, [edit, del]);
  }

  /* ---------- add / edit ---------- */
  function openForm(r) {
    var isEdit = !!r;
    var w0 = r || {};
    S.openForm({
      title: isEdit ? "Edit worker" : "Add worker",
      submitLabel: isEdit ? "Save changes" : "Add worker",
      fields: [
        { name: "name", label: "Name", type: "text", required: true, col: 12,
          value: isEdit ? (w0.name || "") : "", placeholder: "e.g. Juan Dela Cruz" },
        { name: "designation", label: "Designation", type: "text", col: 6,
          value: isEdit ? (w0.designation || "") : "", placeholder: "e.g. Mason, Carpenter" },
        { name: "type", label: "Type", type: "select", col: 6,
          options: TYPE_OPTS, value: isEdit ? (w0.type || "field") : "field" },
        { name: "hourly_rate", label: "Hourly rate (₱)", type: "number", step: "0.01", min: "0", col: 6,
          value: isEdit && w0.hourly_rate !== null && w0.hourly_rate !== undefined ? w0.hourly_rate : "",
          placeholder: "0.00" },
        { name: "daily_rate", label: "Daily rate (₱)", type: "number", step: "0.01", min: "0", col: 6,
          value: isEdit && w0.daily_rate !== null && w0.daily_rate !== undefined ? w0.daily_rate : "",
          placeholder: "0.00" },
        { name: "phone", label: "Phone", type: "tel", col: 6,
          value: isEdit ? (w0.phone || "") : "" },
        { name: "email", label: "Email", type: "email", col: 12,
          value: isEdit ? (w0.email || "") : "" },
        { name: "status", label: "Status", type: "select", col: 6,
          options: STATUS_OPTS, value: isEdit ? (w0.status || "active") : "active" },
      ],
      onSubmit: async function (vals) {
        var name = (vals.name || "").trim();
        if (!name) throw new Error("Name is required.");
        var payload = {
          name: name,
          designation: (vals.designation || "").trim() || null,
          hourly_rate: vals.hourly_rate === "" || vals.hourly_rate === undefined || vals.hourly_rate === null
            ? null : vals.hourly_rate,
          daily_rate: vals.daily_rate === "" || vals.daily_rate === undefined || vals.daily_rate === null
            ? null : vals.daily_rate,
          phone: (vals.phone || "").trim() || null,
          email: (vals.email || "").trim() || null,
          status: vals.status || "active",
          type: vals.type || "field",
        };
        if (isEdit) {
          payload.id = w0.id;
          await S.api("PUT", "api/workers.php", payload);
        } else {
          await S.api("POST", "api/workers.php", payload);
        }
        S.toast(isEdit ? "Worker updated." : "Worker added.", "ok");
        reload();
      },
    });
  }

  /* ---------- delete ---------- */
  async function removeItem(r) {
    var msg = 'Delete "' + (r.name || "this worker") + '"?';
    if ((r.project_count | 0) > 0) {
      msg += " They will be unassigned from " + r.project_count +
        " project" + (r.project_count === 1 ? "" : "s") + ".";
    }
    var ok = await S.confirm(msg, { title: "Delete worker", danger: true, okLabel: "Delete" });
    if (!ok) return;
    try {
      await S.api("DELETE", "api/workers.php?id=" + encodeURIComponent(r.id));
      S.toast("Worker deleted.", "ok");
      reload();
    } catch (err) {
      S.toast(err.message || "Could not delete worker.", "err");
    }
  }
})(window);
