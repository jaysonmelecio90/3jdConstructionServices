/* ============================================================
   reports.js — Reports page: company view + CSV export
   ============================================================ */
(function (w) {
  "use strict";
  var S = w.Shell;
  var charts = {};

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    var m = await S.mount("reports", { title: "Reports" });
    if (!m) return;
    var root = m.content;

    // Header with three export buttons.
    root.appendChild(S.el("div", { class: "d-flex justify-content-between align-items-center flex-wrap gap-2 mb-3" }, [
      S.el("div", null, [
        S.el("h2", { class: "h4 fw-bold mb-0", text: "Company Reports" }),
        S.el("p", { class: "text-secondary small mb-0", text: "Spend across all projects, with CSV exports for Excel." }),
      ]),
      S.el("div", { class: "d-flex flex-wrap gap-2" }, [
        exportBtn("Export expenses", "box-arrow-down", "expenses"),
        exportBtn("Export materials", "box-arrow-down", "materials"),
        exportBtn("Export projects", "box-arrow-down", "projects"),
      ]),
    ]));

    var body = S.el("div");
    root.appendChild(body);
    body.innerHTML = '<div class="text-center text-secondary py-5"><div class="spinner-border text-warning"></div></div>';

    try {
      var d = await S.api("GET", "api/summary.php");
      render(body, d || {});
    } catch (err) {
      S.emptyState(body, err.message || "Could not load report data.", "exclamation-triangle");
    }
  }

  function exportBtn(label, icon, type) {
    return S.el("button", {
      class: "btn btn-outline-primary btn-sm",
      type: "button",
      onClick: function () { download(type); },
    }, [S.el("i", { class: "bi bi-" + icon + " me-1" }), label]);
  }

  // Cookies are sent on a same-origin navigation, so this triggers a file download.
  function download(type, slug) {
    var url = "api/export.php?type=" + encodeURIComponent(type);
    if (slug) url += "&project_slug=" + encodeURIComponent(slug);
    w.location = url;
  }

  function render(root, d) {
    S.clear(root);
    var split = d.category_split || {};

    // Stat-card row: company Total, Material, Labor, Other.
    root.appendChild(S.el("div", { class: "row row-cols-1 row-cols-sm-2 row-cols-xl-4 g-3 mb-3" }, [
      S.statCard({ label: "Total Spend", value: w.pesoFmt(d.grand_total), sub: "All projects", accent: "" }),
      S.statCard({ label: "Materials", value: w.pesoFmt(split.material), sub: pct(split.material, d.grand_total), accent: "material" }),
      S.statCard({ label: "Labor", value: w.pesoFmt(split.labor), sub: pct(split.labor, d.grand_total), accent: "labor" }),
      S.statCard({ label: "Other", value: w.pesoFmt(split.other), sub: pct(split.other, d.grand_total), accent: "other" }),
    ]));

    // Monthly spend line chart + Top payees list.
    var lineCanvas = S.el("canvas");
    var topPayBody = S.el("div");
    root.appendChild(S.el("div", { class: "row g-3 mb-3" }, [
      S.el("div", { class: "col-lg-8" }, card("Monthly Spend", "Asia/Manila", S.el("div", { class: "chart-wrap h-line" }, lineCanvas))),
      S.el("div", { class: "col-lg-4" }, card("Top Payees", "Labor & other", topPayBody)),
    ]));

    // Per-project breakdown table.
    var tableBody = S.el("div");
    root.appendChild(card("Per-project breakdown", "Sorted by total spend", tableBody));

    // Monthly spend chart.
    var t = S.themeColors();
    var tl = d.timeline || [];
    if (tl.length) {
      var ds = function (k, c, dash) {
        return {
          label: cap(k),
          data: tl.map(function (r) { return w.toNum(r[k]); }),
          borderColor: c,
          backgroundColor: S.hexA(c, 0.12),
          borderDash: dash || [],
          borderWidth: 2,
          tension: 0.35,
          pointRadius: 2.5,
          pointBackgroundColor: c,
        };
      };
      charts.line = S.chart(lineCanvas, "line", {
        labels: tl.map(function (r) { return w.monthLabel(r.month); }),
        datasets: [ds("total", t.brand), ds("material", t.material, [6, 4]), ds("labor", t.labor, [2, 3])],
      }, { plugins: { legend: { display: true, position: "top", labels: { usePointStyle: true, padding: 14 } } } });
    } else {
      S.emptyState(lineCanvas.parentNode, "No dated expenses yet.", "calendar3");
    }

    renderTopPayees(topPayBody, d.top_payees || []);
    renderProjects(tableBody, d.projects || []);
  }

  function card(title, hint, bodyNode) {
    return S.el("div", { class: "card h-100" }, S.el("div", { class: "card-body" }, [
      S.el("div", { class: "d-flex justify-content-between align-items-center mb-3" }, [
        S.el("span", { class: "card-title mb-0", text: title }),
        hint ? S.el("span", { class: "small text-secondary", text: hint }) : null,
      ]),
      bodyNode,
    ]));
  }

  function renderTopPayees(node, payees) {
    if (!payees.length) { S.emptyState(node, "No payees yet.", "people"); return; }
    var max = payees.reduce(function (mx, it) { return Math.max(mx, w.toNum(it.total)); }, 0) || 1;
    var list = S.el("div", { class: "ranklist" });
    payees.forEach(function (it) {
      var pw = Math.max(3, Math.round((w.toNum(it.total) / max) * 100));
      list.appendChild(S.el("div", { class: "rank" }, [
        S.el("div", { class: "rank-name", text: it.payee || "—" }),
        S.el("div", { class: "rank-val tnum", text: w.pesoFmt(it.total) }),
        S.el("div", { class: "rank-bar" }, S.el("div", { class: "rank-fill payee", style: "width:" + pw + "%" })),
      ]));
    });
    node.appendChild(list);
  }

  function renderProjects(node, projects) {
    S.renderTable(node, {
      columns: [
        { label: "Project", render: function (p) { return S.el("a", { class: "link-brand", href: "project.html?slug=" + encodeURIComponent(p.slug) }, p.name); } },
        { label: "Material", num: true, render: function (p) { return w.pesoFmt(p.material_total); } },
        { label: "Labor", num: true, render: function (p) { return w.pesoFmt(p.labor_total); } },
        { label: "Other", num: true, render: function (p) { return w.pesoFmt(p.other_total); } },
        { label: "Total", num: true, render: function (p) { return S.el("span", { class: "fw-bold", text: w.pesoFmt(p.grand_total) }); } },
        { label: "Entries", num: true, render: function (p) { return w.numFmt(p.expense_count); } },
        {
          label: "CSV", num: true, render: function (p) {
            return S.el("a", {
              class: "link-brand",
              href: "api/export.php?type=expenses&project_slug=" + encodeURIComponent(p.slug),
              title: "Export this project's expenses",
            }, [S.el("i", { class: "bi bi-filetype-csv" })]);
          },
        },
      ],
      rows: projects, empty: "No projects yet.", emptyIcon: "folder",
    });
  }

  function pct(part, whole) {
    var tot = w.toNum(whole);
    if (tot <= 0) return "—";
    return (Math.round((w.toNum(part) / tot) * 1000) / 10).toFixed(1) + "% of total";
  }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
})(window);
