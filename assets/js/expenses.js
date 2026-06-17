/* ============================================================
   expenses.js — Expenses ledger (Bootstrap shell)
   Company-wide expense ledger: list/filter/search + full CRUD
   against api/expenses.php via the Shell API.
   ============================================================ */
(function (w) {
  "use strict";
  var S = w.Shell;
  var ENDPOINT = "api/expenses.php";

  var state = {
    projects: [],                                  // [{id,name,slug}]
    filters: { project_id: "", category: "", q: "" },
    items: [],
  };
  var searchTimer = null;

  // UI nodes captured at build time so reloads only repaint data.
  var ui = { searchInput: null, kpis: null, table: null };

  // Material-list suggestions: autocomplete for Item/Payee + unit-price memory,
  // shared with the Material List page via api/materials.php?suggest=1.
  var suggest = { hardware: [], suppliers: [], priceMap: {}, payeeByItem: {} };
  function suggestKey(item, payee) {
    return JSON.stringify([String(item || "").trim().toLowerCase(), String(payee || "").trim().toLowerCase()]);
  }
  function itemKey(item) { return String(item || "").trim().toLowerCase(); }
  async function loadSuggest() {
    try {
      var d = await S.api("GET", "api/materials.php?suggest=1");
      suggest.hardware = (d && d.hardware) || [];
      suggest.suppliers = (d && d.suppliers) || [];
      var map = {};
      ((d && d.latest) || []).forEach(function (x) { map[suggestKey(x.hardware, x.location)] = x.price; });
      suggest.priceMap = map;
      var pmap = {};
      ((d && d.item_supplier) || []).forEach(function (x) { pmap[itemKey(x.hardware)] = x.location; });
      suggest.payeeByItem = pmap;
    } catch (e) { /* non-fatal — the form still works without suggestions */ }
  }
  function attachList(input, values, id) {
    if (!input || !values || !values.length) return;
    var dl = document.createElement("datalist");
    dl.id = id;
    values.forEach(function (v) { var o = document.createElement("option"); o.value = v; dl.appendChild(o); });
    input.parentNode.appendChild(dl);
    input.setAttribute("list", id);
    input.setAttribute("autocomplete", "off");
  }

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    var m = await S.mount("expenses", { title: "Expenses" });
    if (!m) return;                                // null = redirected to login
    var root = m.content;

    // Header + toolbar.
    root.appendChild(S.el("div", { class: "d-flex justify-content-between align-items-center flex-wrap gap-2 mb-3" }, [
      S.el("div", null, [
        S.el("h2", { class: "h4 fw-bold mb-0", text: "Expense Ledger" }),
        S.el("p", { class: "text-secondary small mb-0", text: "Every recorded material, labor and other cost across all projects." }),
      ]),
      S.el("button", { class: "btn btn-primary btn-sm", type: "button", onClick: function () { openForm(null); } },
        [S.el("i", { class: "bi bi-plus-lg me-1" }), "Add expense"]),
    ]));

    root.appendChild(buildToolbar());

    // KPI row + table card.
    ui.kpis = S.el("div", { class: "row row-cols-1 row-cols-sm-2 row-cols-xl-5 g-3 mb-3" });
    root.appendChild(ui.kpis);

    ui.table = S.el("div");
    root.appendChild(S.el("div", { class: "card" }, S.el("div", { class: "card-body" }, ui.table)));

    await loadProjects();
    loadSuggest();          // item/payee autocomplete + unit-price memory
    await reload();
  }

  /* ---------- toolbar (filters + search) ---------- */
  function buildToolbar() {
    var projectSel = S.el("select", { class: "form-select form-select-sm", id: "expProjectFilter",
      onChange: function () { state.filters.project_id = this.value; reload(); } },
      S.el("option", { value: "" }, "All projects"));
    ui.projectFilter = projectSel;

    var categorySel = S.el("select", { class: "form-select form-select-sm",
      onChange: function () { state.filters.category = this.value; reload(); } }, [
      S.el("option", { value: "" }, "All categories"),
      S.el("option", { value: "material" }, "Material"),
      S.el("option", { value: "labor" }, "Labor"),
      S.el("option", { value: "other" }, "Other"),
      S.el("option", { value: "family" }, "Family"),
      S.el("option", { value: "health" }, "Health"),
    ]);

    ui.searchInput = S.el("input", { class: "form-control", type: "search", placeholder: "Search item, payee or note…",
      onInput: function () {
        var v = this.value;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(function () { state.filters.q = v.trim(); reload(); }, 260);
      } });

    return S.el("div", { class: "card mb-3" }, S.el("div", { class: "card-body" },
      S.el("div", { class: "row g-2 align-items-end" }, [
        S.el("div", { class: "col-12 col-md-4" }, [
          S.el("label", { class: "form-label small fw-semibold text-secondary mb-1", text: "Project" }),
          projectSel,
        ]),
        S.el("div", { class: "col-6 col-md-3" }, [
          S.el("label", { class: "form-label small fw-semibold text-secondary mb-1", text: "Category" }),
          categorySel,
        ]),
        S.el("div", { class: "col-6 col-md-5" }, [
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
      renderSummary((data && data.summary) || {});
      renderTable(state.items);
    } catch (err) {
      S.clear(ui.kpis);
      S.emptyState(ui.table, (err && err.message) || "Could not load expenses.", "exclamation-triangle");
    }
  }

  function buildQuery(f) {
    var parts = [];
    if (f.project_id) parts.push("project_id=" + encodeURIComponent(f.project_id));
    if (f.category) parts.push("category=" + encodeURIComponent(f.category));
    if (f.q) parts.push("q=" + encodeURIComponent(f.q));
    return parts.join("&");
  }

  /* ---------- summary KPIs ---------- */
  function renderSummary(s) {
    S.clear(ui.kpis);
    S.append(ui.kpis, [
      S.statCard({ label: "Total Entries", value: w.numFmt(s.count || 0), sub: "In current view" }),
      S.statCard({ label: "Total Amount", value: w.pesoFmt(s.total), sub: "Sum of view" }),
      S.statCard({ label: "Material", value: w.pesoFmt(s.material), sub: "Material spend", accent: "material" }),
      S.statCard({ label: "Labor", value: w.pesoFmt(s.labor), sub: "Labor spend", accent: "labor" }),
      S.statCard({ label: "Other", value: w.pesoFmt(s.other), sub: "Other spend", accent: "other" }),
      S.statCard({ label: "Family", value: w.pesoFmt(s.family), sub: "Family spend", accent: "family" }),
      S.statCard({ label: "Health", value: w.pesoFmt(s.health), sub: "Health spend", accent: "health" }),
    ]);
  }

  /* ---------- table ---------- */
  function renderTable(items) {
    S.renderTable(ui.table, {
      columns: [
        { label: "Date", render: function (r) { return w.fmtDate(r.entry_date_raw, r.entry_date); } },
        { label: "Project", render: function (r) {
            return S.el("a", { class: "link-brand", href: "project.php?slug=" + encodeURIComponent(r.project_slug || "") }, r.project_name || "—");
          } },
        { label: "Category", render: function (r) { return S.pill(r.category, "category"); } },
        { label: "Item / Payee", render: function (r) {
            return S.el("span", { text: r.item_name || r.payee || r.note || "—" });
          } },
        { label: "Qty", num: true, render: function (r) { return w.qtyFmt(r.quantity); } },
        { label: "Amount", num: true, render: function (r) {
            return S.el("span", { class: "fw-bold", text: w.pesoFmt(r.amount) });
          } },
        { label: "", thCls: "text-end", cls: "text-end", render: function (r) { return rowActions(r); } },
      ],
      rows: items,
      empty: "No expenses match this view. Use “Add expense” to record one.",
      emptyIcon: "cash-stack",
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
    return state.projects.map(function (p) { return { value: p.id, label: p.name }; });
  }

  async function openForm(item) {
    var isEdit = !!item;
    var saved = await S.openForm({
      title: isEdit ? "Edit expense" : "Add expense",
      submitLabel: isEdit ? "Save changes" : "Add expense",
      fields: [
        { name: "project_id", label: "Project", type: "select", required: true, col: 6,
          options: projectOptions(), value: item ? item.project_id : "" },
        { name: "category", label: "Category", type: "select", required: true, col: 6,
          options: [
            { value: "material", label: "Material" },
            { value: "labor", label: "Labor" },
            { value: "other", label: "Other" },
            { value: "family", label: "Family" },
            { value: "health", label: "Health" },
          ], value: item ? item.category : "material" },
        { name: "entry_date", label: "Date", type: "date", col: 6, value: item ? (item.entry_date || "") : "" },
        { name: "item_name", label: "Item name", type: "text", col: 6, placeholder: "e.g. Portland Cement",
          value: item ? (item.item_name || "") : "" },
        { name: "payee", label: "Payee", type: "text", col: 6, placeholder: "Supplier / worker",
          value: item ? (item.payee || "") : "" },
        { name: "quantity", label: "Quantity", type: "number", step: "0.001", col: 6,
          value: item && item.quantity != null ? item.quantity : "" },
        { name: "unit_price", label: "Unit price (₱)", type: "number", step: "0.01", col: 6,
          value: item && item.unit_price != null ? item.unit_price : "" },
        { name: "amount", label: "Amount (₱)", type: "number", step: "0.01", required: true, col: 6,
          placeholder: "0.00", value: item && item.amount != null ? item.amount : "" },
        { name: "note", label: "Note", type: "text", col: 12, placeholder: "Optional remarks",
          value: item ? (item.note || "") : "" },
      ],
      onMount: function (inputs) {
        // Autocomplete Item / Payee from the material list (hardware / suppliers).
        attachList(inputs.item_name, suggest.hardware, "dl-exp-item");
        attachList(inputs.payee, suggest.suppliers, "dl-exp-payee");

        // Treat existing values (when editing) or anything the user types as
        // user-set, so prediction / auto-calc never clobbers them.
        if (inputs.payee && isEdit && item && item.payee != null && String(item.payee) !== "") inputs.payee.dataset.userEdited = "true";
        if (inputs.unit_price && isEdit && item && item.unit_price != null && String(item.unit_price) !== "") inputs.unit_price.dataset.userEdited = "true";
        if (inputs.amount && isEdit && item && item.amount != null && String(item.amount) !== "") inputs.amount.dataset.userEdited = "true";
        if (inputs.payee) inputs.payee.addEventListener("input", function () { inputs.payee.dataset.userEdited = "true"; });
        if (inputs.unit_price) inputs.unit_price.addEventListener("input", function () { inputs.unit_price.dataset.userEdited = "true"; recalcAmount(); });
        if (inputs.amount) inputs.amount.addEventListener("input", function () { inputs.amount.dataset.userEdited = "true"; });

        // Predict the payee (supplier) from the item name, using the material list.
        function predictPayee() {
          if (!inputs.payee || inputs.payee.dataset.userEdited === "true") return;
          var it = inputs.item_name ? inputs.item_name.value : "";
          if (!String(it).trim()) return;
          var sup = suggest.payeeByItem[itemKey(it)];
          if (sup != null && sup !== "") inputs.payee.value = sup;
        }
        // Predict the unit price from the latest material price for Item + Payee.
        function predictUnitPrice() {
          if (!inputs.unit_price || inputs.unit_price.dataset.userEdited === "true") return;
          var it = inputs.item_name ? inputs.item_name.value : "";
          if (!String(it).trim()) return;
          var price = suggest.priceMap[suggestKey(it, inputs.payee ? inputs.payee.value : "")];
          if (price != null) { inputs.unit_price.value = price; recalcAmount(); }
        }
        // Amount = quantity x unit price (unless the user typed their own amount).
        function recalcAmount() {
          if (!inputs.amount || inputs.amount.dataset.userEdited === "true") return;
          var q = parseFloat(inputs.quantity ? inputs.quantity.value : "");
          var u = parseFloat(inputs.unit_price ? inputs.unit_price.value : "");
          if (isFinite(q) && isFinite(u)) inputs.amount.value = (Math.round(q * u * 100) / 100).toFixed(2);
        }
        // Item change: fill the payee from the item, then predict the unit price.
        function onItemChange() { predictPayee(); predictUnitPrice(); }
        ["change", "input"].forEach(function (ev) {
          if (inputs.item_name) inputs.item_name.addEventListener(ev, onItemChange);
          if (inputs.payee) inputs.payee.addEventListener(ev, predictUnitPrice);
          if (inputs.quantity) inputs.quantity.addEventListener(ev, recalcAmount);
        });
      },
      onSubmit: async function (v) {
        var projectId = parseInt(v.project_id, 10) || 0;
        if (!projectId) throw new Error("Please choose a project.");
        if (["material", "labor", "other", "family", "health"].indexOf(v.category) < 0) throw new Error("Please choose a category.");
        if (v.amount === "" || isNaN(parseFloat(v.amount))) throw new Error("Enter a valid amount.");
        if (parseFloat(v.amount) < 0) throw new Error("Amount cannot be negative.");

        var payload = {
          project_id: projectId,
          category: v.category,
          entry_date: v.entry_date || null,
          item_name: v.item_name || null,
          payee: v.payee || null,
          quantity: v.quantity === "" ? null : v.quantity,
          unit_price: v.unit_price === "" ? null : v.unit_price,
          amount: v.amount,
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
      S.toast(isEdit ? "Expense updated." : "Expense added.", "ok");
      loadSuggest();   // a material expense may have added a new item/price
      await reload();
    }
  }

  /* ---------- delete ---------- */
  async function remove(r) {
    var label = r.item_name || r.payee || r.note || "this expense";
    var ok = await S.confirm(
      "Delete “" + label + "” (" + w.pesoFmt(r.amount) + ") from " + (r.project_name || "the project") + "?",
      { title: "Delete expense", danger: true, okLabel: "Delete" }
    );
    if (!ok) return;
    try {
      await S.api("DELETE", ENDPOINT, { id: r.id });
      S.toast("Expense deleted.", "ok");
      await reload();
    } catch (err) {
      S.toast((err && err.message) || "Could not delete the expense.", "err");
    }
  }
})(window);
