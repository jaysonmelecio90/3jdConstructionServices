/* ============================================================
   projects.js — Projects page (Bootstrap shell)
   List + full CRUD against api/projects.php. Each project links
   to its detail page (project.html?slug=). Optional client.
   ============================================================ */
(function (w) {
  "use strict";
  var S = w.Shell;

  var state = {
    projects: [],   // [{id,name,slug,material_total,...,client_id,client_name}]
    clients: [],    // [{id,name}]
    body: null,     // table/stat container
  };

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    var m = await S.mount("projects", { title: "Projects" });
    if (!m) return;
    var root = m.content;

    // Page header + "New project" action.
    root.appendChild(S.el("div", { class: "d-flex justify-content-between align-items-center flex-wrap gap-2 mb-3" }, [
      S.el("div", null, [
        S.el("h2", { class: "h4 fw-bold mb-0", text: "Projects" }),
        S.el("p", { class: "text-secondary small mb-0", text: "Every job, its client, and what it has cost so far." }),
      ]),
      S.el("button", { class: "btn btn-primary", type: "button", onClick: function () { openCreate(); } },
        [S.el("i", { class: "bi bi-plus-lg me-1" }), "New project"]),
    ]));

    state.body = S.el("div", null);
    root.appendChild(state.body);
    state.body.innerHTML = '<div class="text-center text-secondary py-5"><div class="spinner-border text-warning"></div></div>';

    await loadClients();   // best-effort; select still works without it
    await load();
  }

  /* ---------- data ---------- */
  async function loadClients() {
    try {
      var data = await S.api("GET", "api/clients.php");
      var items = (data && (data.items || data.clients)) || [];
      state.clients = items.map(function (c) { return { id: c.id, name: c.name }; });
    } catch (_) {
      state.clients = [];   // offer the "— None —" option only
    }
  }

  async function load() {
    try {
      var data = await S.api("GET", "api/projects.php");
      state.projects = (data && data.projects) || [];
      render();
    } catch (err) {
      S.emptyState(state.body, (err && err.message) || "Could not load projects.", "exclamation-triangle");
    }
  }

  /* ---------- render ---------- */
  function render() {
    S.clear(state.body);

    var projects = state.projects;
    var totalSpend = projects.reduce(function (sum, p) { return sum + w.toNum(p.grand_total); }, 0);
    var totalCost  = projects.reduce(function (sum, p) { return sum + w.toNum(p.project_total); }, 0);
    var clientIds = {};
    projects.forEach(function (p) { if (p.client_id != null) clientIds[p.client_id] = true; });
    var activeClients = Object.keys(clientIds).length;

    // Stat cards row.
    state.body.appendChild(S.el("div", { class: "row row-cols-sm-2 row-cols-xl-4 g-3 mb-3" }, [
      S.statCard({ label: "Total Projects", value: w.numFmt(projects.length), sub: "All jobs" }),
      S.statCard({ label: "Total Spend", value: w.pesoFmt(totalSpend), sub: "Expenses only", accent: "material" }),
      S.statCard({ label: "Total Cost", value: w.pesoFmt(totalCost), sub: "Expenses + payroll", accent: "other" }),
      S.statCard({ label: "Assigned Clients", value: w.numFmt(activeClients), sub: "Projects with a client" }),
    ]));

    // Projects table.
    var tableBody = S.el("div");
    state.body.appendChild(S.el("div", { class: "card" }, S.el("div", { class: "card-body" }, [
      S.el("div", { class: "d-flex justify-content-between align-items-center mb-3" }, [
        S.el("span", { class: "card-title mb-0", text: "All Projects" }),
        S.el("span", { class: "small text-secondary", text: "Sorted by total spend" }),
      ]),
      tableBody,
    ])));

    S.renderTable(tableBody, {
      columns: [
        { label: "Project", render: function (p) {
            return S.el("a", { class: "link-brand", href: "project.html?slug=" + encodeURIComponent(p.slug) }, p.name);
          } },
        { label: "Client", render: function (p) {
            return p.client_name
              ? S.el("span", { text: p.client_name })
              : S.el("span", { class: "text-secondary", text: "—" });
          } },
        { label: "Owner", render: function (p) {
            return p.owner
              ? S.el("span", { text: p.owner })
              : S.el("span", { class: "text-secondary", text: "—" });
          } },
        { label: "Material", num: true, render: function (p) { return w.pesoFmt(p.material_total); } },
        { label: "Labor", num: true, render: function (p) { return w.pesoFmt(p.labor_total); } },
        { label: "Other", num: true, render: function (p) { return w.pesoFmt(p.other_total); } },
        { label: "Contract", num: true, render: function (p) {
            return p.contract_price != null
              ? S.el("span", { class: "text-secondary", text: w.pesoFmt(p.contract_price) })
              : S.el("span", { class: "text-secondary", text: "—" });
          } },
        { label: "Remaining", num: true, render: function (p) {
            if (p.remaining == null) {
              return S.el("span", { class: "text-secondary", text: "—" });
            }
            var n = w.toNum(p.remaining);
            var attrs = n < 0 ? { style: "color:#DC2626" } : null;
            return S.el("span", attrs, w.pesoFmt(p.remaining));
          } },
        { label: "Total", num: true, render: function (p) { return S.el("span", { class: "fw-bold", text: w.pesoFmt(p.project_total) }); } },
        { label: "Entries", num: true, render: function (p) { return w.numFmt(p.expense_count); } },
        { label: "", render: function (p) { return rowActions(p); } },
      ],
      rows: projects,
      empty: "No projects yet. Use “New project” to add one.",
      emptyIcon: "folder2-open",
    });
  }

  function rowActions(p) {
    var edit = S.el("button", { class: "btn btn-sm btn-outline-secondary", type: "button", title: "Edit",
      onClick: function () { openEdit(p); } }, S.el("i", { class: "bi bi-pencil" }));
    var del = S.el("button", { class: "btn btn-sm btn-outline-danger", type: "button", title: "Delete",
      onClick: function () { remove(p); } }, S.el("i", { class: "bi bi-trash" }));
    return S.el("div", { class: "d-flex gap-1 justify-content-end" }, [edit, del]);
  }

  /* ---------- client <select> options (incl. "— None —") ---------- */
  function clientOptions(selectedId) {
    var opts = [{ value: "", label: "— None —" }];
    state.clients.forEach(function (c) { opts.push({ value: String(c.id), label: c.name }); });
    return opts;
  }

  /* ---------- create ---------- */
  function openCreate() {
    S.openForm({
      title: "New project",
      submitLabel: "Create project",
      fields: [
        { name: "name", label: "Project name", type: "text", required: true, placeholder: "e.g. Dauis Residence", col: 12 },
        { name: "location", label: "Location", type: "text", placeholder: "e.g. Dauis, Bohol", col: 6 },
        { name: "owner", label: "Owner", type: "text", placeholder: "Project owner", col: 6 },
        { name: "contract_price", label: "Contract price (₱)", type: "number", step: "0.01", min: 0, placeholder: "0.00", col: 6 },
        { name: "client_id", label: "Client", type: "select", options: clientOptions(""), value: "", col: 6,
          help: state.clients.length ? null : "No clients available yet." },
      ],
      onSubmit: async function (v) {
        var res = await S.api("POST", "api/projects.php", {
          name: v.name,
          location: v.location,
          owner: v.owner,
          contract_price: v.contract_price === "" ? null : v.contract_price,
          client_id: v.client_id === "" ? null : v.client_id,
        });
        S.toast("Created “" + ((res && res.project && res.project.name) || v.name) + "”.", "ok");
        await load();
      },
    });
  }

  /* ---------- edit ---------- */
  function openEdit(p) {
    S.openForm({
      title: "Edit project",
      submitLabel: "Save changes",
      fields: [
        { name: "name", label: "Project name", type: "text", required: true, value: p.name, col: 12 },
        { name: "location", label: "Location", type: "text", value: p.location || "", col: 6 },
        { name: "owner", label: "Owner", type: "text", value: p.owner || "", col: 6 },
        { name: "contract_price", label: "Contract price (₱)", type: "number", step: "0.01", min: 0,
          value: p.contract_price != null ? p.contract_price : "", col: 6 },
        { name: "client_id", label: "Client", type: "select", options: clientOptions(p.client_id),
          value: p.client_id != null ? String(p.client_id) : "", col: 6,
          help: state.clients.length ? null : "No clients available yet." },
      ],
      onSubmit: async function (v) {
        await S.api("PUT", "api/projects.php", {
          id: p.id,
          name: v.name,
          location: v.location,
          owner: v.owner,
          contract_price: v.contract_price === "" ? null : v.contract_price,
          client_id: v.client_id === "" ? null : v.client_id,
        });
        S.toast("Saved “" + v.name + "”.", "ok");
        await load();
      },
    });
  }

  /* ---------- delete ---------- */
  async function remove(p) {
    var ok = await S.confirm(
      "Delete “" + p.name + "”? This also removes its expenses and material items. This cannot be undone.",
      { title: "Delete project", danger: true, okLabel: "Delete" }
    );
    if (!ok) return;
    try {
      await S.api("DELETE", "api/projects.php", { id: p.id });
      S.toast("Deleted “" + p.name + "”.", "ok");
      await load();
    } catch (err) {
      S.toast((err && err.message) || "Could not delete project.", "err");
    }
  }
})(window);
