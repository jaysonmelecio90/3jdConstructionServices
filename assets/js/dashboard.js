/* ============================================================
   dashboard.js — Dashboard page (Bootstrap shell)
   ============================================================ */
(function (w) {
  "use strict";
  var S = w.Shell;
  var charts = {};

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    var m = await S.mount("dashboard", { title: "Dashboard" });
    if (!m) return;
    var root = m.content;
    root.appendChild(S.el("div", { class: "d-flex justify-content-between align-items-center flex-wrap gap-2 mb-3" }, [
      S.el("div", null, [
        S.el("h2", { class: "h4 fw-bold mb-0", text: "Company Overview" }),
        S.el("p", { class: "text-secondary small mb-0", text: "Materials, labor and other spend across all projects." }),
      ]),
      S.el("a", { class: "btn btn-outline-primary btn-sm", href: "reports.html" }, [S.el("i", { class: "bi bi-graph-up-arrow me-1" }), "Reports"]),
    ]));
    var body = S.el("div", null);
    root.appendChild(body);
    body.innerHTML = '<div class="text-center text-secondary py-5"><div class="spinner-border text-warning"></div></div>';

    try {
      var d = await S.api("GET", "api/summary.php");
      render(body, d || {});
    } catch (err) {
      S.emptyState(body, err.message || "Could not load dashboard data.", "exclamation-triangle");
    }
  }

  function render(root, d) {
    S.clear(root);
    var split = d.category_split || {};

    // Bank / Account Balance hero row
    var bankNum = w.toNum(d.bank_balance);
    var bankSub = bankNum > 0 ? "In the green" : (bankNum === 0 ? "—" : "Cash deficit");
    var bankCard = S.statCard({ label: "Bank Balance", value: w.pesoFmt(d.bank_balance), sub: bankSub, accent: "" });
    if (bankNum < 0) {
      var vEl = bankCard.querySelector(".stat-value");
      if (vEl) vEl.style.color = "#DC2626";
    }
    var bankRow = S.el("div", { class: "row row-cols-1 row-cols-md-3 g-3 mb-3" }, [
      bankCard,
      S.statCard({ label: "Money In", value: w.pesoFmt(d.total_in), sub: "Income recorded", accent: "labor" }),
      S.statCard({ label: "Money Out", value: w.pesoFmt(d.total_out), sub: "Expenses + payroll + loans + advances", accent: "material" }),
    ]);
    root.appendChild(bankRow);

    // Cashflow row: Cash Movement bar + Recent Income feed
    var cashCanvas = S.el("canvas");
    var recentIncomeBody = S.el("div");
    root.appendChild(S.el("div", { class: "row g-3 mb-3" }, [
      S.el("div", { class: "col-lg-6" }, card("Cash Movement", "All time", S.el("div", { class: "chart-wrap h-bar" }, cashCanvas))),
      S.el("div", { class: "col-lg-6" }, card("Recent Income", "Latest 10", recentIncomeBody)),
    ]));

    // KPI cards
    var kpis = S.el("div", { class: "row row-cols-1 row-cols-sm-2 row-cols-xl-5 g-3 mb-3" }, [
      S.statCard({ label: "Total Spend", value: w.pesoFmt(d.grand_total), sub: "All projects", accent: "" }),
      S.statCard({ label: "Materials", value: w.pesoFmt(split.material), sub: pct(split.material, d.grand_total), accent: "material" }),
      S.statCard({ label: "Labor", value: w.pesoFmt(split.labor), sub: pct(split.labor, d.grand_total), accent: "labor" }),
      S.statCard({ label: "Other", value: w.pesoFmt(split.other), sub: pct(split.other, d.grand_total), accent: "other" }),
      S.statCard({ label: "Projects", value: w.numFmt(d.project_count), sub: (d.active_projects || 0) + " active" }),
    ]);
    root.appendChild(kpis);

    // charts row
    var barCanvas = S.el("canvas");
    var donutCanvas = S.el("canvas");
    root.appendChild(S.el("div", { class: "row g-3 mb-3" }, [
      S.el("div", { class: "col-lg-7" }, card("Spend by Project", "Top 10", S.el("div", { class: "chart-wrap h-bar" }, barCanvas))),
      S.el("div", { class: "col-lg-5" }, card("Cost Breakdown", "By category", S.el("div", { class: "chart-wrap h-donut" }, donutCanvas))),
    ]));

    var lineCanvas = S.el("canvas");
    root.appendChild(S.el("div", { class: "mb-3" }, card("Monthly Cashflow", "In vs Out, by month", S.el("div", { class: "chart-wrap h-line" }, lineCanvas))));

    // recent + lists
    var recentBody = S.el("div");
    var topMatBody = S.el("div");
    var topPayBody = S.el("div");
    root.appendChild(S.el("div", { class: "row g-3 mb-3" }, [
      S.el("div", { class: "col-lg-6" }, card("Recent Expenses", "Latest 10", recentBody)),
      S.el("div", { class: "col-lg-3 col-md-6" }, card("Top Materials", "By spend", topMatBody)),
      S.el("div", { class: "col-lg-3 col-md-6" }, card("Top Payees", "Labor & other", topPayBody)),
    ]));

    // projects table
    var tableBody = S.el("div");
    root.appendChild(card("Projects", "Sorted by total spend", tableBody));

    var t = S.themeColors();

    // Cash Movement bar chart
    var inNum = w.toNum(d.total_in);
    var outNum = w.toNum(d.total_out);
    if (inNum + outNum > 0) {
      charts.cash = S.chart(cashCanvas, "bar", {
        labels: ["Money In", "Money Out"],
        datasets: [{
          data: [inNum, outNum],
          backgroundColor: [S.hexA(t.labor, .85), S.hexA(t.brand, .85)],
          hoverBackgroundColor: [t.labor, t.brand],
          borderWidth: 0,
        }],
      }, { plugins: { legend: { display: false } } });
    } else {
      S.emptyState(cashCanvas.parentNode, "No cash movement yet.", "bank");
    }

    // Recent Income feed
    renderRecentIncome(recentIncomeBody, d.recent_incomes || []);

    var top = (d.projects || []).slice(0, 10);
    if (top.length) charts.bar = S.chart(barCanvas, "bar", { labels: top.map(function (p) { return p.name; }), datasets: [{ label: "Total", data: top.map(function (p) { return w.toNum(p.grand_total); }), backgroundColor: S.hexA(t.brand, .85), hoverBackgroundColor: t.brand }] });

    var dv = [w.toNum(split.material), w.toNum(split.labor), w.toNum(split.other)];
    if (dv[0] + dv[1] + dv[2] > 0) charts.donut = S.chart(donutCanvas, "doughnut", { labels: ["Material", "Labor", "Other"], datasets: [{ data: dv, backgroundColor: [t.material, t.labor, t.other], borderColor: t.surface, borderWidth: 3, hoverOffset: 6 }] }, { cutout: "64%", plugins: { legend: { display: true, position: "bottom", labels: { usePointStyle: true, padding: 14 } } }, tooltip: { callbacks: { label: function (c) { return "  " + c.label + ": " + w.pesoFmt(c.parsed); } } } });

    // Monthly chart with income overlay
    var tl = d.timeline || [];
    var inTl = d.income_timeline || [];
    if (tl.length || inTl.length) {
      // Build month union
      var spendMap = {};
      tl.forEach(function (r) { spendMap[r.month] = r; });
      var incomeMap = {};
      inTl.forEach(function (r) { incomeMap[r.month] = r; });
      var monthSet = {};
      tl.forEach(function (r) { monthSet[r.month] = 1; });
      inTl.forEach(function (r) { monthSet[r.month] = 1; });
      var months = Object.keys(monthSet).sort();
      var matArr = months.map(function (m) { return spendMap[m] ? w.toNum(spendMap[m].material) : 0; });
      var labArr = months.map(function (m) { return spendMap[m] ? w.toNum(spendMap[m].labor) : 0; });
      var othArr = months.map(function (m) { return spendMap[m] ? w.toNum(spendMap[m].other) : 0; });
      var incArr = months.map(function (m) { return incomeMap[m] ? w.toNum(incomeMap[m].total) : 0; });
      var labels = months.map(function (m) { return w.monthLabel(m); });
      var datasets = [
        { label: "Material", data: matArr, borderColor: t.material, backgroundColor: S.hexA(t.material, .12), borderWidth: 2, tension: .35, pointRadius: 2.5, pointBackgroundColor: t.material },
        { label: "Labor", data: labArr, borderColor: t.labor, backgroundColor: S.hexA(t.labor, .12), borderDash: [6, 4], borderWidth: 2, tension: .35, pointRadius: 2.5, pointBackgroundColor: t.labor },
        { label: "Other", data: othArr, borderColor: t.other, backgroundColor: S.hexA(t.other, .12), borderDash: [2, 3], borderWidth: 2, tension: .35, pointRadius: 2.5, pointBackgroundColor: t.other },
        { label: "Income", data: incArr, borderColor: t.labor, backgroundColor: S.hexA(t.labor, .18), borderWidth: 2, tension: .35, pointRadius: 2.5, pointBackgroundColor: t.labor, fill: true },
      ];
      charts.line = S.chart(lineCanvas, "line", { labels: labels, datasets: datasets }, { plugins: { legend: { display: true, position: "top", labels: { usePointStyle: true, padding: 14 } } } });
    } else {
      S.emptyState(lineCanvas.parentNode, "No dated expenses yet.", "calendar3");
    }

    renderRecent(recentBody, d.recent || []);
    renderRank(topMatBody, (d.top_materials || []).map(function (x) { return { name: x.item_name, total: x.total }; }), "material");
    renderRank(topPayBody, (d.top_payees || []).map(function (x) { return { name: x.payee, total: x.total }; }), "payee");
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

  function renderRecent(node, recent) {
    if (!recent.length) { S.emptyState(node, "No expenses yet.", "inbox"); return; }
    var feed = S.el("div");
    recent.forEach(function (r) {
      var cat = (r.category || "other").toLowerCase();
      feed.appendChild(S.el("div", { class: "feed-item" }, [
        S.el("div", { class: "feed-ico " + cat }, S.el("i", { class: "bi bi-" + (cat === "material" ? "box-seam" : cat === "labor" ? "person-workspace" : "receipt") })),
        S.el("div", { class: "feed-main" }, [
          S.el("div", { class: "feed-title", text: r.item_name || r.payee || r.note || "Expense" }),
          S.el("div", { class: "feed-meta", text: [r.project_name, w.fmtDate(r.entry_date_raw, r.entry_date)].filter(Boolean).join(" · ") }),
        ]),
        S.el("div", { class: "fw-bold tnum", text: w.pesoFmt(r.amount) }),
      ]));
    });
    node.appendChild(feed);
  }

  function renderRecentIncome(node, incomes) {
    if (!incomes.length) { S.emptyState(node, "No income recorded yet.", "bank"); return; }
    var feed = S.el("div");
    incomes.slice(0, 10).forEach(function (r) {
      var ico = S.el("div", { class: "feed-ico labor" }, S.el("i", { class: "bi bi-arrow-down-circle" }));
      var amt = S.el("div", { class: "fw-bold tnum", text: w.pesoFmt(r.amount) });
      amt.style.color = "#16A34A";
      feed.appendChild(S.el("div", { class: "feed-item" }, [
        ico,
        S.el("div", { class: "feed-main" }, [
          S.el("div", { class: "feed-title", text: r.payer || "Income" }),
          S.el("div", { class: "feed-meta", text: [r.project_name, w.fmtDate(r.income_date_raw, r.income_date)].filter(Boolean).join(" · ") }),
        ]),
        amt,
      ]));
    });
    node.appendChild(feed);
  }

  function renderRank(node, items, kind) {
    if (!items.length) { S.emptyState(node, "No data.", "bar-chart"); return; }
    var max = items.reduce(function (m, it) { return Math.max(m, w.toNum(it.total)); }, 0) || 1;
    var list = S.el("div", { class: "ranklist" });
    items.forEach(function (it) {
      var pw = Math.max(3, Math.round((w.toNum(it.total) / max) * 100));
      list.appendChild(S.el("div", { class: "rank" }, [
        S.el("div", { class: "rank-name", text: it.name || "—" }),
        S.el("div", { class: "rank-val tnum", text: w.pesoFmt(it.total) }),
        S.el("div", { class: "rank-bar" }, S.el("div", { class: "rank-fill " + kind, style: "width:" + pw + "%" })),
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
        { label: "Entries", num: true, render: function (p) { return w.numFmt(p.expense_count); } },
        { label: "Total", num: true, render: function (p) { return S.el("span", { class: "fw-bold", text: w.pesoFmt(p.grand_total) }); } },
      ],
      rows: projects, empty: "No projects yet.",
    });
  }

  function pct(part, whole) { var tot = w.toNum(whole); if (tot <= 0) return "—"; return (Math.round((w.toNum(part) / tot) * 1000) / 10).toFixed(1) + "% of total"; }
})(window);
