/* ============================================================
   clients.js — Clients page (client directory + CRUD)
   ============================================================ */
(function (w) {
  "use strict";
  var S = w.Shell;

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    var m = await S.mount("clients", { title: "Clients" });
    if (!m) return;
    var root = m.content;

    // Header + add button.
    root.appendChild(S.el("div", { class: "d-flex justify-content-between align-items-center flex-wrap gap-2 mb-3" }, [
      S.el("div", null, [
        S.el("h2", { class: "h4 fw-bold mb-0", text: "Clients" }),
        S.el("p", { class: "text-secondary small mb-0", text: "Client directory — contact details and linked projects." }),
      ]),
      S.el("button", { class: "btn btn-primary btn-sm", onClick: function () { openForm(null); } }, [
        S.el("i", { class: "bi bi-plus-lg me-1" }), "Add client",
      ]),
    ]));

    var statsHost = S.el("div", { class: "mb-3" });
    root.appendChild(statsHost);

    var body = S.el("div");
    root.appendChild(body);

    load();

    async function load() {
      body.innerHTML = '<div class="text-center text-secondary py-5"><div class="spinner-border text-warning"></div></div>';
      S.clear(statsHost);
      try {
        var d = await S.api("GET", "api/clients.php");
        var items = (d && d.items) || [];
        renderStats(statsHost, items);
        renderTable(body, items);
      } catch (err) {
        S.clear(statsHost);
        S.emptyState(body, err.message || "Could not load clients.", "exclamation-triangle");
      }
    }

    function renderStats(node, items) {
      var total = items.length;
      var active = items.filter(function (c) { return c.status === "active"; }).length;
      node.appendChild(S.el("div", { class: "row row-cols-1 row-cols-sm-2 g-3" }, [
        S.statCard({ label: "Total clients", value: w.numFmt(total), sub: "In directory" }),
        S.statCard({ label: "Active clients", value: w.numFmt(active), sub: total ? Math.round((active / total) * 100) + "% of total" : "—", accent: "labor" }),
      ]));
    }

    function renderTable(node, items) {
      S.clear(node);
      var cardBody = S.el("div");
      node.appendChild(S.el("div", { class: "card" }, S.el("div", { class: "card-body" }, cardBody)));

      S.renderTable(cardBody, {
        columns: [
          {
            label: "Name",
            render: function (c) {
              var kids = [S.el("div", { class: "fw-semibold", text: c.name })];
              if (c.company) kids.push(S.el("div", { class: "small text-secondary", text: c.company }));
              return S.el("div", null, kids);
            },
          },
          { label: "Phone", render: function (c) { return c.phone || "—"; } },
          {
            label: "Email",
            render: function (c) {
              if (!c.email) return "—";
              return S.el("a", { class: "link-brand", href: "mailto:" + c.email, text: c.email });
            },
          },
          { label: "Projects", num: true, render: function (c) { return w.numFmt(c.project_count); } },
          { label: "Status", render: function (c) { return S.pill(c.status, "status"); } },
          {
            label: "",
            thCls: "text-end",
            cls: "text-end",
            render: function (c) {
              return S.el("div", { class: "btn-group btn-group-sm" }, [
                S.el("button", { class: "btn btn-outline-secondary", title: "Edit", onClick: function () { openForm(c); } },
                  S.el("i", { class: "bi bi-pencil" })),
                S.el("button", { class: "btn btn-outline-danger", title: "Delete", onClick: function () { remove(c); } },
                  S.el("i", { class: "bi bi-trash" })),
              ]);
            },
          },
        ],
        rows: items,
        empty: "No clients yet. Add your first client to get started.",
        emptyIcon: "people",
      });
    }

    async function openForm(client) {
      var isEdit = !!client;
      var c = client || {};
      var saved = await S.openForm({
        title: isEdit ? "Edit client" : "Add client",
        submitLabel: isEdit ? "Save changes" : "Add client",
        fields: [
          { name: "name", label: "Name", type: "text", value: c.name || "", required: true, col: 6 },
          { name: "company", label: "Company", type: "text", value: c.company || "", col: 6 },
          { name: "phone", label: "Phone", type: "tel", value: c.phone || "", col: 6 },
          { name: "email", label: "Email", type: "email", value: c.email || "", col: 6 },
          { name: "address", label: "Address", type: "text", value: c.address || "", col: 12 },
          { name: "notes", label: "Notes", type: "textarea", value: c.notes || "", col: 12, rows: 3 },
          {
            name: "status", label: "Status", type: "select", col: 6,
            value: c.status || "active",
            options: [
              { value: "active", label: "Active" },
              { value: "inactive", label: "Inactive" },
            ],
          },
        ],
        onSubmit: async function (values) {
          var payload = {
            name: (values.name || "").trim(),
            company: (values.company || "").trim(),
            phone: (values.phone || "").trim(),
            email: (values.email || "").trim(),
            address: (values.address || "").trim(),
            notes: (values.notes || "").trim(),
            status: values.status || "active",
          };
          if (!payload.name) throw new Error("Name is required.");
          if (isEdit) {
            payload.id = c.id;
            await S.api("PUT", "api/clients.php", payload);
          } else {
            await S.api("POST", "api/clients.php", payload);
          }
        },
      });
      if (saved) {
        S.toast(isEdit ? "Client updated." : "Client added.", "ok");
        load();
      }
    }

    async function remove(client) {
      var msg = 'Delete "' + client.name + '"?';
      if (client.project_count > 0) {
        msg += " Its " + client.project_count + " linked project" + (client.project_count === 1 ? "" : "s") +
          " will be detached (kept, but with no client).";
      }
      var ok = await S.confirm(msg, { title: "Delete client", danger: true, okLabel: "Delete" });
      if (!ok) return;
      try {
        await S.api("DELETE", "api/clients.php?id=" + encodeURIComponent(client.id));
        S.toast("Client deleted.", "ok");
        load();
      } catch (err) {
        S.toast(err.message || "Could not delete client.", "err");
      }
    }
  }
})(window);
