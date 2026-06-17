/* ============================================================
   api.js — fetch layer + formatters (no modules, no deps)
   Money & qty arrive as STRINGS. Parse only for display.
   ============================================================ */
(function (w) {
  "use strict";

  const API = ""; // same-origin; endpoints are relative: 'api/summary.php' etc.

  /* ---------- low level fetch ---------- */
  async function apiFetch(path, options) {
    const url = API + path;
    let res;
    try {
      res = await fetch(url, Object.assign({ headers: { Accept: "application/json" } }, options || {}));
    } catch (networkErr) {
      throw new ApiError("Network error — could not reach the server.", 0, networkErr);
    }

    let body = null;
    const text = await res.text();
    if (text) {
      try { body = JSON.parse(text); } catch (_) { body = null; }
    }

    if (!res.ok) {
      const msg =
        (body && (body.error || body.message)) ||
        (res.status === 404 ? "Not found." : "Request failed (" + res.status + ").");
      throw new ApiError(msg, res.status, body);
    }
    return body;
  }

  async function apiGet(path) {
    return apiFetch(path, { method: "GET" });
  }

  function ApiError(message, status, detail) {
    this.name = "ApiError";
    this.message = message;
    this.status = status || 0;
    this.detail = detail || null;
  }
  ApiError.prototype = Object.create(Error.prototype);
  ApiError.prototype.constructor = ApiError;

  /* ---------- number helpers ---------- */
  // Safely coerce a wire value (string | number | null | "") to a finite Number.
  function toNum(v) {
    if (v === null || v === undefined || v === "") return 0;
    if (typeof v === "number") return isFinite(v) ? v : 0;
    const n = parseFloat(String(v).replace(/,/g, ""));
    return isFinite(n) ? n : 0;
  }

  const _peso = new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const _pesoCompact = new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
    notation: "compact",
    maximumFractionDigits: 1,
  });
  const _num = new Intl.NumberFormat("en-PH", { maximumFractionDigits: 2 });
  const _qty = new Intl.NumberFormat("en-PH", { minimumFractionDigits: 0, maximumFractionDigits: 3 });

  // ₱0.00 for null/empty; full grouped peso otherwise.
  function pesoFmt(v) {
    return _peso.format(toNum(v));
  }
  // Compact peso for axis ticks / tight chips, e.g. ₱1.2M
  function pesoCompact(v) {
    return _pesoCompact.format(toNum(v));
  }
  function numFmt(v) {
    return _num.format(toNum(v));
  }
  // Quantity: blank input -> '—', otherwise up to 3 decimals, trailing zeros trimmed by formatter.
  function qtyFmt(v) {
    if (v === null || v === undefined || v === "") return "—";
    return _qty.format(toNum(v));
  }

  /* ---------- dates ---------- */
  const _dateFmt = new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  // Prefer the ISO date (formatted en-PH, Asia/Manila). Fall back to the raw string, else em dash.
  function fmtDate(raw, iso) {
    if (iso) {
      // Anchor at midday UTC so timezone shifts never roll the calendar day.
      const d = new Date(iso + "T12:00:00Z");
      if (!isNaN(d.getTime())) return _dateFmt.format(d);
    }
    if (raw) return String(raw);
    return "—";
  }

  const _MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  // '2025-06' -> 'Jun 2025'
  function monthLabel(ym) {
    if (!ym || typeof ym !== "string") return "—";
    const parts = ym.split("-");
    if (parts.length < 2) return ym;
    const y = parts[0];
    const m = parseInt(parts[1], 10);
    if (!m || m < 1 || m > 12) return ym;
    return _MON[m - 1] + " " + y;
  }

  /* ---------- expose ---------- */
  w.API = API;
  w.apiGet = apiGet;
  w.apiFetch = apiFetch;
  w.ApiError = ApiError;
  w.toNum = toNum;
  w.pesoFmt = pesoFmt;
  w.pesoCompact = pesoCompact;
  w.numFmt = numFmt;
  w.qtyFmt = qtyFmt;
  w.fmtDate = fmtDate;
  w.monthLabel = monthLabel;
})(window);
