/* ============================================================
   settings.js — Settings page (Bootstrap shell)
   (a) Company profile — bound to api/settings.php (PUT for admins)
   (b) Users — list / add / delete via api/users.php (admin only)
   ============================================================ */
(function (w) {
  "use strict";
  var S = w.Shell;

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    var m = await S.mount("settings", { title: "Settings" });
    if (!m) return;
    var root = m.content;
    var isAdmin = m.user && m.user.role === "admin";

    root.appendChild(S.el("div", { class: "mb-3" }, [
      S.el("h2", { class: "h4 fw-bold mb-0", text: "Settings" }),
      S.el("p", { class: "text-secondary small mb-0", text: "Company profile and user accounts." }),
    ]));

    var companyHost = S.el("div", { class: "mb-4" });
    root.appendChild(companyHost);
    renderCompanyCard(companyHost, isAdmin);

    if (isAdmin) {
      var usersHost = S.el("div");
      root.appendChild(usersHost);
      renderUsersCard(usersHost, m.user);
    }
  }

  /* ============================================================
     (a) Company profile
     ============================================================ */
  function renderCompanyCard(host, isAdmin) {
    S.clear(host);
    var body = S.el("div");
    host.appendChild(card("Company profile", isAdmin ? "Editable by admins" : "Read only", body));
    body.innerHTML = '<div class="text-center text-secondary py-4"><div class="spinner-border text-warning"></div></div>';

    S.api("GET", "api/settings.php").then(function (d) {
      renderCompanyForm(body, (d && d.settings) || {}, isAdmin);
    }).catch(function (err) {
      S.emptyState(body, (err && err.message) || "Could not load the company profile.", "exclamation-triangle");
    });
  }

  function renderCompanyForm(body, s, isAdmin) {
    S.clear(body);

    if (!isAdmin) {
      body.appendChild(S.el("div", { class: "alert alert-secondary d-flex align-items-center gap-2 py-2" }, [
        S.el("i", { class: "bi bi-lock" }),
        S.el("span", { text: "Only administrators can edit the company profile." }),
      ]));
    }

    var inputs = {};
    var ro = !isAdmin;

    function fieldCol(name, label, opts) {
      opts = opts || {};
      var input = S.el("input", {
        class: "form-control",
        type: opts.type || "text",
        value: s[name] != null ? String(s[name]) : "",
        placeholder: opts.placeholder || "",
      });
      if (ro) { input.setAttribute("disabled", "disabled"); input.classList.add("bg-body-secondary"); }
      inputs[name] = input;
      return S.el("div", { class: "col-md-" + (opts.col || 6) }, [
        S.el("label", { class: "form-label small text-secondary mb-1", text: label }),
        input,
      ]);
    }

    var grid = S.el("div", { class: "row g-3" }, [
      fieldCol("company_name", "Company name *", { placeholder: "3J & D Construction" }),
      fieldCol("legal_name", "Legal name", { placeholder: "Registered business name" }),
      fieldCol("tagline", "Tagline", { col: 12, placeholder: "Short slogan" }),
      fieldCol("address", "Address", { col: 12, placeholder: "Street, City, Province" }),
      fieldCol("phone", "Phone", { type: "tel", placeholder: "+63 ..." }),
      fieldCol("email", "Email", { type: "email", placeholder: "info@example.com" }),
      fieldCol("currency", "Currency", { placeholder: "PHP" }),
    ]);
    body.appendChild(grid);

    if (isAdmin) {
      var saveBtn = S.el("button", { class: "btn btn-primary", type: "button" }, [
        S.el("i", { class: "bi bi-check2 me-1" }), "Save",
      ]);
      body.appendChild(S.el("div", { class: "mt-3 d-flex justify-content-end" }, saveBtn));

      saveBtn.addEventListener("click", async function () {
        var payload = {
          company_name: inputs.company_name.value.trim(),
          legal_name: inputs.legal_name.value.trim(),
          tagline: inputs.tagline.value.trim(),
          address: inputs.address.value.trim(),
          phone: inputs.phone.value.trim(),
          email: inputs.email.value.trim(),
          currency: inputs.currency.value.trim(),
        };
        if (!payload.company_name) {
          S.toast("Company name is required.", "err");
          inputs.company_name.focus();
          return;
        }
        saveBtn.disabled = true;
        var orig = saveBtn.innerHTML;
        saveBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Saving…';
        try {
          var res = await S.api("PUT", "api/settings.php", payload);
          if (res && res.settings) renderCompanyForm(body, res.settings, isAdmin);
          S.toast("Company profile saved.", "ok");
        } catch (err) {
          S.toast((err && err.message) || "Could not save.", "err");
          saveBtn.disabled = false;
          saveBtn.innerHTML = orig;
        }
      });
    }
  }

  /* ============================================================
     (b) Users
     ============================================================ */
  function renderUsersCard(host, me) {
    S.clear(host);
    var addBtn = S.el("button", { class: "btn btn-primary btn-sm", type: "button" }, [
      S.el("i", { class: "bi bi-plus-lg me-1" }), "Add user",
    ]);
    var body = S.el("div");
    var head = S.el("div", { class: "d-flex justify-content-between align-items-center mb-3" }, [
      S.el("span", { class: "card-title mb-0", text: "Users" }),
      addBtn,
    ]);
    host.appendChild(S.el("div", { class: "card" }, S.el("div", { class: "card-body" }, [head, body])));

    addBtn.addEventListener("click", function () { openAddUser(body, me); });
    loadUsers(body, me);
  }

  function loadUsers(body, me) {
    body.innerHTML = '<div class="text-center text-secondary py-4"><div class="spinner-border text-warning"></div></div>';
    S.api("GET", "api/users.php").then(function (d) {
      renderUsersTable(body, (d && d.users) || [], me);
    }).catch(function (err) {
      if (err && /forbidden/i.test(err.message || "")) {
        S.emptyState(body, "You do not have permission to manage users.", "shield-lock");
      } else {
        S.emptyState(body, (err && err.message) || "Could not load users.", "exclamation-triangle");
      }
    });
  }

  function renderUsersTable(body, users, me) {
    S.clear(body);
    var myId = me ? me.id : 0;
    S.renderTable(body, {
      columns: [
        { label: "Name", render: function (u) { return S.el("span", { class: "fw-semibold", text: u.name || "—" }); } },
        { label: "Email", render: function (u) { return u.email || "—"; } },
        { label: "Role", render: function (u) {
            var p = S.pill(u.role, "status");
            // Give admin an amber accent (staff keeps the neutral pill).
            p.classList.add(u.role === "admin" ? "pill-material" : "pill-not_active");
            return p;
          } },
        { label: "Created", render: function (u) { return w.fmtDate(u.created_at, u.created_at); } },
        { label: "", thCls: "text-end", cls: "text-end", render: function (u) {
            if (u.id === myId) return S.el("span", { class: "small text-secondary", text: "You" });
            var del = S.el("button", { class: "btn btn-sm btn-outline-danger", type: "button", title: "Delete user" },
              S.el("i", { class: "bi bi-trash" }));
            del.addEventListener("click", function () { removeUser(u, body, me); });
            return del;
          } },
      ],
      rows: users,
      empty: "No users yet.",
      emptyIcon: "people",
    });
  }

  function openAddUser(body, me) {
    S.openForm({
      title: "Add user",
      submitLabel: "Create user",
      fields: [
        { name: "name", label: "Name", type: "text", required: true, col: 6 },
        { name: "email", label: "Email", type: "email", required: true, col: 6 },
        { name: "password", label: "Password", type: "password", required: true, col: 6, help: "At least 6 characters." },
        { name: "role", label: "Role", type: "select", value: "staff", col: 6, options: [
            { value: "staff", label: "Staff" },
            { value: "admin", label: "Admin" },
        ] },
      ],
      onSubmit: async function (v) {
        var payload = {
          name: (v.name || "").trim(),
          email: (v.email || "").trim(),
          password: v.password || "",
          role: v.role || "staff",
        };
        if (!payload.name) throw new Error("Name is required.");
        if (!payload.email) throw new Error("Email is required.");
        if ((payload.password || "").length < 6) throw new Error("Password must be at least 6 characters.");
        await S.api("POST", "api/users.php", payload);
        S.toast("User “" + payload.name + "” created.", "ok");
        loadUsers(body, me);
      },
    });
  }

  async function removeUser(u, body, me) {
    var ok = await S.confirm("Delete user “" + (u.name || u.email) + "”? This cannot be undone.", {
      title: "Delete user", danger: true, okLabel: "Delete",
    });
    if (!ok) return;
    try {
      await S.api("DELETE", "api/users.php", { id: u.id });
      S.toast("User “" + (u.name || u.email) + "” deleted.", "ok");
      loadUsers(body, me);
    } catch (err) {
      S.toast((err && err.message) || "Could not delete user.", "err");
    }
  }

  /* ---------- shared card helper ---------- */
  function card(title, hint, bodyNode) {
    return S.el("div", { class: "card" }, S.el("div", { class: "card-body" }, [
      S.el("div", { class: "d-flex justify-content-between align-items-center mb-3" }, [
        S.el("span", { class: "card-title mb-0", text: title }),
        hint ? S.el("span", { class: "small text-secondary", text: hint }) : null,
      ]),
      bodyNode,
    ]));
  }
})(window);
