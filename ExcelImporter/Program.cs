using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using ClosedXML.Excel;

namespace ExcelImporter
{
    // ------------------------------------------------------------------
    // DTOs - shapes match the cross-file contract EXACTLY.
    // Money/qty are decimals; serialized as numeric strings to never lose
    // decimals. entry_date is "yyyy-MM-dd" or null.
    // ------------------------------------------------------------------
    public sealed class ExpenseDto
    {
        public string category;             // "material" | "labor" | "other"
        public string entry_date_raw;       // string or null
        public string entry_date;           // "yyyy-MM-dd" or null
        public string item_name;            // string or null
        public string payee;                // string or null
        public string quantity;             // numeric string or null
        public string unit_price;           // numeric string or null
        public string amount;               // numeric string, REQUIRED
        public string note;                 // string or null
        public string source_sheet;         // sheet name
        public int source_row;              // 1-based excel row
    }

    public sealed class ProjectDto
    {
        public string name;
        public string slug;
        public List<ExpenseDto> expenses = new List<ExpenseDto>();
    }

    public sealed class ImportBody
    {
        public List<ProjectDto> projects = new List<ProjectDto>();
    }

    public static class Program
    {
        private static readonly CultureInfo EnUs = CultureInfo.GetCultureInfo("en-US");
        private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

        // Second-block skip keywords (matched against col G or col H, case-insensitive, contains)
        private static readonly string[] SecondBlockSkip =
        {
            "TOTAL", "OVERALL", "CASH REMAIN", "NATAPAL", "EXPENSES FOR"
        };

        public static int Main(string[] args)
        {
            try
            {
                string workbookPath = args.Length > 0 && !string.IsNullOrWhiteSpace(args[0])
                    ? args[0]
                    : "Labor and Materials expenses- 05-16-26.xlsx";
                string apiBase = args.Length > 1 ? (args[1] ?? "").TrimEnd('/') : "";
                string token = args.Length > 2 && !string.IsNullOrWhiteSpace(args[2])
                    ? args[2]
                    : Environment.GetEnvironmentVariable("CDENG_IMPORT_TOKEN");

                if (!File.Exists(workbookPath))
                {
                    // Try the underscored variant as a fallback.
                    string alt = workbookPath.Replace(' ', '_');
                    if (File.Exists(alt)) workbookPath = alt;
                }

                if (!File.Exists(workbookPath))
                {
                    Console.Error.WriteLine("ERROR: workbook not found: " + workbookPath);
                    return 2;
                }

                List<ProjectDto> projects;
                try
                {
                    projects = ParseWorkbook(workbookPath);
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine("ERROR loading/parsing workbook: " + ex.Message);
                    Console.Error.WriteLine(ex.StackTrace);
                    return 3;
                }

                PrintSummary(projects);

                if (string.IsNullOrWhiteSpace(apiBase))
                {
                    Console.WriteLine();
                    Console.WriteLine("No API base URL supplied (arg[1]). Parse-only run complete; skipping POST.");
                    return 0;
                }
                if (string.IsNullOrWhiteSpace(token))
                {
                    Console.Error.WriteLine("ERROR: no import token (arg[2] or env CDENG_IMPORT_TOKEN).");
                    return 4;
                }

                var body = new ImportBody { projects = projects };
                string json = SerializeBody(body);

                try
                {
                    PostImport(apiBase, token, json);
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine("ERROR during HTTP POST: " + ex.Message);
                    return 5;
                }

                return 0;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("FATAL: " + ex.Message);
                Console.Error.WriteLine(ex.StackTrace);
                return 1;
            }
        }

        // ==================================================================
        // SLUGIFY - byte-identical to the contract rule.
        //  1) lowercase 2) non [a-z0-9] -> '-' 3) collapse '-' runs 4) trim '-'
        // ==================================================================
        public static string Slugify(string input)
        {
            if (input == null) return "";
            string lower = input.ToLowerInvariant();
            var sb = new StringBuilder(lower.Length);
            foreach (char c in lower)
            {
                if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) sb.Append(c);
                else sb.Append('-');
            }
            string s = sb.ToString();
            s = Regex.Replace(s, "-+", "-");
            s = s.Trim('-');
            return s;
        }

        // ==================================================================
        // LENIENT DATE PARSER. Returns DateTime? (null on failure).
        // Raw text is kept separately by callers.
        // ==================================================================
        public static DateTime? LenientDate(string raw)
        {
            if (string.IsNullOrWhiteSpace(raw)) return null;

            string s = raw.Trim();

            // Normalize en/em dashes to '-'
            s = s.Replace('–', '-').Replace('—', '-');

            // If contains '(' -> cut there (text annotations make it unparseable-ish)
            int paren = s.IndexOf('(');
            if (paren >= 0) s = s.Substring(0, paren).Trim();

            if (s.Length == 0) return null;

            // Normalize abbreviated month "Mon." -> "Mon" (strip dots after letters)
            // Collapse a day range "<d>-<d>" to the first "<d>".
            s = Regex.Replace(s, @"(\d{1,2})\s*-\s*\d{1,2}", "$1");

            // Strip stray dots (e.g. "Oct." -> "Oct", trailing "." )
            s = s.Replace(".", " ");

            // Collapse multiple spaces.
            s = Regex.Replace(s, @"\s+", " ").Trim();

            if (s.Length == 0) return null;

            string[] formats =
            {
                "MMMM d, yyyy", "MMM d, yyyy",
                "MMMM d yyyy", "MMM d yyyy"
            };

            DateTime dt;
            if (DateTime.TryParseExact(s, formats, EnUs,
                    DateTimeStyles.AllowWhiteSpaces, out dt))
                return dt;

            if (DateTime.TryParse(s, EnUs, DateTimeStyles.AllowWhiteSpaces, out dt))
                return dt;

            return null;
        }

        // ==================================================================
        // WORKBOOK PARSING
        // ==================================================================
        private static List<ProjectDto> ParseWorkbook(string path)
        {
            var result = new List<ProjectDto>();

            using (var wb = new XLWorkbook(path))
            {
                foreach (var ws in wb.Worksheets)
                {
                    string sheetName = ws.Name == null ? "" : ws.Name.Trim();
                    var proj = new ProjectDto
                    {
                        name = sheetName,
                        slug = Slugify(sheetName)
                    };

                    bool isMarker = sheetName.IndexOf("MARKER", StringComparison.OrdinalIgnoreCase) >= 0;

                    int lastRow = LastUsedRow(ws);

                    ParseMaterials(ws, sheetName, isMarker, lastRow, proj.expenses);
                    ParseSecondBlock(ws, sheetName, lastRow, proj.expenses);
                    if (isMarker)
                        ParseMarkerKL(ws, sheetName, lastRow, proj.expenses);

                    result.Add(proj);
                }
            }

            return result;
        }

        private static int LastUsedRow(IXLWorksheet ws)
        {
            try
            {
                var range = ws.RangeUsed();
                if (range != null) return range.LastRow().RowNumber();
            }
            catch { /* fall through */ }
            try { return ws.LastRowUsed().RowNumber(); }
            catch { return 1; }
        }

        // ------------------------------------------------------------------
        // MATERIALS BLOCK: cols A(1)=Date B(2)=Materials C(3)=Qty D(4)=Price E(5)=Total
        // ------------------------------------------------------------------
        private static void ParseMaterials(IXLWorksheet ws, string sheet, bool isMarker,
            int lastRow, List<ExpenseDto> sink)
        {
            string carryItem = null;     // item_name carries down
            string markerNote = null;    // MARKER "Expenses c/o ..." sub-block note

            for (int row = 2; row <= lastRow; row++)
            {
                string aText = GetText(ws, row, 1);
                string bText = GetText(ws, row, 2);
                string dText = GetText(ws, row, 4);

                decimal? cVal = GetNumber(ws, row, 3);
                decimal? dVal = GetNumber(ws, row, 4);
                decimal? eVal = GetNumber(ws, row, 5);

                // MARKER: a col-A cell starting "Expenses c/o" is a sub-block label, not a date.
                // The row may STILL carry a real material line (e.g. "...|Materyales|1|9700|9700"),
                // so we only suppress the date and tag the note - we do NOT skip the row.
                bool aIsLabel = false;
                if (isMarker && !string.IsNullOrWhiteSpace(aText) &&
                    aText.TrimStart().StartsWith("Expenses c/o", StringComparison.OrdinalIgnoreCase))
                {
                    string remainder = aText.Trim().Substring("Expenses c/o".Length).Trim();
                    if (!string.IsNullOrEmpty(remainder)) markerNote = "c/o " + remainder;
                    aIsLabel = true;
                }

                // Carry item name down: a non-blank B starts/continues a group.
                if (!string.IsNullOrWhiteSpace(bText))
                    carryItem = bText.Trim();

                // SUBTOTAL row: col D text == "TOTAL" (case-insensitive). Skip.
                if (!string.IsNullOrWhiteSpace(dText) &&
                    dText.Trim().Equals("TOTAL", StringComparison.OrdinalIgnoreCase))
                    continue;

                // KEEP rule: E numeric AND D not "TOTAL" AND
                //   at least one of (A non-empty, B non-empty, C non-empty, D numeric)
                bool anyContent = !string.IsNullOrWhiteSpace(aText)
                                  || !string.IsNullOrWhiteSpace(bText)
                                  || !string.IsNullOrWhiteSpace(GetText(ws, row, 3))
                                  || dVal.HasValue;

                if (!eVal.HasValue || !anyContent)
                    continue;

                string rawDate = (aIsLabel || string.IsNullOrWhiteSpace(aText)) ? null : aText.Trim();
                DateTime? parsed = LenientDate(rawDate);

                var exp = new ExpenseDto
                {
                    category = "material",
                    entry_date_raw = rawDate,
                    entry_date = parsed.HasValue ? parsed.Value.ToString("yyyy-MM-dd", Inv) : null,
                    item_name = string.IsNullOrWhiteSpace(carryItem) ? null : carryItem,
                    payee = null,
                    quantity = FormatDecimal(cVal),
                    unit_price = FormatDecimal(dVal),
                    amount = FormatDecimal(eVal) ?? "0.00",
                    note = markerNote,
                    source_sheet = sheet,
                    source_row = row
                };
                sink.Add(exp);
            }
        }

        // ------------------------------------------------------------------
        // SECOND BLOCK: cols G(7) header/desc, H(8) data, I(9) amount.
        // current_section toggled by "Labor Expenses"/"Other Expenses" in col G.
        // ------------------------------------------------------------------
        private static void ParseSecondBlock(IXLWorksheet ws, string sheet, int lastRow,
            List<ExpenseDto> sink)
        {
            // Initial section from row 1 col G header.
            string g1 = GetText(ws, 1, 7);
            string currentSection = SectionFromHeader(g1) ?? "labor";

            string lastDateRaw = null;
            bool sectionOpen = true;   // open until the section's TOTAL subtotal is hit
            decimal runningSum = 0m;   // sum of the current sub-block, for subtotal detection

            for (int row = 2; row <= lastRow; row++)
            {
                string gText = GetText(ws, row, 7);
                string hText = GetText(ws, row, 8);

                // Section header switch (skip the header row itself); reopens collection.
                string maybeSection = SectionFromHeader(gText);
                if (maybeSection != null)
                {
                    currentSection = maybeSection;
                    sectionOpen = true;
                    runningSum = 0m;
                    lastDateRaw = null;
                    continue;
                }

                // Skip-keyword rows are subtotals/totals. They CLOSE the section so any
                // trailing stray amounts (dumped below the section TOTAL, e.g. CHA2x) are
                // not mistaken for line items.
                if (ContainsSkipKeyword(gText) || ContainsSkipKeyword(hText))
                {
                    sectionOpen = false;
                    runningSum = 0m;
                    continue;
                }

                decimal? iVal = GetNumber(ws, row, 9);
                if (!iVal.HasValue)
                    continue;

                bool gEmpty = string.IsNullOrWhiteSpace(gText);
                bool hEmpty = string.IsNullOrWhiteSpace(hText);

                // A bare row (no date, no payee) is valid only as a continuation while the
                // section is open (real continuation payrolls in DAUIS look like this). A bare
                // amount equal to the running sub-block sum is an inline subtotal -> skip it.
                if (gEmpty && hEmpty)
                {
                    if (!sectionOpen)
                        continue;
                    if (runningSum > 0m && Math.Abs(iVal.Value - runningSum) < 0.5m)
                    {
                        runningSum = 0m;
                        continue;
                    }
                }

                string payee;
                string entryDateRaw;
                DateTime? entryDate;

                DateTime? gAsDate = gEmpty ? (DateTime?)null : LenientDate(gText);

                if (gAsDate.HasValue)
                {
                    // col G is a date.
                    entryDate = gAsDate;
                    entryDateRaw = gText.Trim();
                    lastDateRaw = entryDateRaw;
                    payee = hEmpty ? null : hText.Trim();
                }
                else if (!gEmpty)
                {
                    // description style (SUPPLY): payee = G (+ " - " + H if present)
                    payee = gText.Trim();
                    if (!hEmpty) payee = payee + " - " + hText.Trim();
                    entryDate = null;
                    entryDateRaw = gText.Trim();
                }
                else
                {
                    // G empty -> carry last date, payee = H
                    entryDateRaw = lastDateRaw;
                    entryDate = LenientDate(lastDateRaw);
                    payee = hEmpty ? null : hText.Trim();
                }

                // labor: blank payee defaults to "Payroll". other: leave null.
                if (currentSection == "labor" && string.IsNullOrWhiteSpace(payee))
                    payee = "Payroll";

                var exp = new ExpenseDto
                {
                    category = currentSection,
                    entry_date_raw = string.IsNullOrWhiteSpace(entryDateRaw) ? null : entryDateRaw,
                    entry_date = entryDate.HasValue ? entryDate.Value.ToString("yyyy-MM-dd", Inv) : null,
                    item_name = null,
                    payee = string.IsNullOrWhiteSpace(payee) ? null : payee,
                    quantity = null,
                    unit_price = null,
                    amount = FormatDecimal(iVal) ?? "0.00",
                    note = null,
                    source_sheet = sheet,
                    source_row = row
                };
                sink.Add(exp);
                runningSum += iVal.Value;
            }
        }

        // ------------------------------------------------------------------
        // MARKER K/L TAGGED EXTRAS: col K(11) amount, col L(12) tag -> 'other'.
        // ------------------------------------------------------------------
        private static void ParseMarkerKL(IXLWorksheet ws, string sheet, int lastRow,
            List<ExpenseDto> sink)
        {
            for (int row = 2; row <= lastRow; row++)
            {
                decimal? kVal = GetNumber(ws, row, 11);
                string lText = GetText(ws, row, 12);

                if (!kVal.HasValue) continue;
                if (string.IsNullOrWhiteSpace(lText)) continue;          // skip lone K total
                if (lText.IndexOf("TOTAL", StringComparison.OrdinalIgnoreCase) >= 0) continue;

                string gText = GetText(ws, row, 7);
                DateTime? gDate = LenientDate(gText);

                var exp = new ExpenseDto
                {
                    category = "other",
                    entry_date_raw = gDate.HasValue ? gText.Trim() : null,
                    entry_date = gDate.HasValue ? gDate.Value.ToString("yyyy-MM-dd", Inv) : null,
                    item_name = null,
                    payee = lText.Trim(),
                    quantity = null,
                    unit_price = null,
                    amount = FormatDecimal(kVal) ?? "0.00",
                    note = "shared/reimbursed",
                    source_sheet = sheet,
                    source_row = row
                };
                sink.Add(exp);
            }
        }

        private static string SectionFromHeader(string g)
        {
            if (string.IsNullOrWhiteSpace(g)) return null;
            string t = g.Trim();
            if (t.Equals("Labor Expenses", StringComparison.OrdinalIgnoreCase)) return "labor";
            if (t.Equals("Other Expenses", StringComparison.OrdinalIgnoreCase)) return "other";
            return null;
        }

        private static bool ContainsSkipKeyword(string text)
        {
            if (string.IsNullOrWhiteSpace(text)) return false;
            string up = text.ToUpperInvariant();
            for (int i = 0; i < SecondBlockSkip.Length; i++)
                if (up.IndexOf(SecondBlockSkip[i], StringComparison.Ordinal) >= 0)
                    return true;
            return false;
        }

        // ==================================================================
        // CELL HELPERS - defensive read.
        // ==================================================================
        private static string GetText(IXLWorksheet ws, int row, int col)
        {
            try
            {
                var cell = ws.Cell(row, col);
                if (cell == null || cell.IsEmpty()) return null;
                string s = cell.GetString();
                if (s == null) return null;
                s = s.Trim();
                return s.Length == 0 ? null : s;
            }
            catch
            {
                return null;
            }
        }

        private static decimal? GetNumber(IXLWorksheet ws, int row, int col)
        {
            try
            {
                var cell = ws.Cell(row, col);
                if (cell == null || cell.IsEmpty()) return null;

                if (cell.DataType == XLDataType.Number)
                {
                    return Convert.ToDecimal(cell.GetDouble(), Inv);
                }

                // Try to coerce a numeric-looking string (strip commas, currency, spaces).
                string s = cell.GetString();
                if (string.IsNullOrWhiteSpace(s)) return null;
                string cleaned = s.Trim()
                    .Replace(",", "")
                    .Replace("₱", "")   // peso sign
                    .Replace("PHP", "")  // net472: no 3-arg Replace overload, strip literal casings
                    .Replace("Php", "")
                    .Replace("php", "")
                    .Trim();
                decimal d;
                if (decimal.TryParse(cleaned, NumberStyles.Any, Inv, out d))
                    return d;
                return null;
            }
            catch
            {
                return null;
            }
        }

        // Format a decimal as a plain (non-scientific) numeric string, or null.
        private static string FormatDecimal(decimal? v)
        {
            if (!v.HasValue) return null;
            // "0.###############" preserves up to 15 fractional digits without exponent.
            // Use a culture-invariant fixed representation; G29 avoids trailing noise.
            decimal d = v.Value;
            return d.ToString("0.############", Inv);
        }

        // ==================================================================
        // JSON SERIALIZATION
        // Amounts/qty are already strings on the DTO -> JS serializer emits
        // them as JSON strings, preserving decimals. Nulls emit as null.
        // ==================================================================
        private static string SerializeBody(ImportBody body)
        {
            var ser = new JavaScriptSerializer();
            ser.MaxJsonLength = int.MaxValue;

            // Build plain dictionaries to control field order/null emission.
            var projList = new List<object>();
            foreach (var p in body.projects)
            {
                var expList = new List<object>();
                foreach (var e in p.expenses)
                {
                    var d = new Dictionary<string, object>
                    {
                        { "category", e.category },
                        { "entry_date_raw", e.entry_date_raw },
                        { "entry_date", e.entry_date },
                        { "item_name", e.item_name },
                        { "payee", e.payee },
                        { "quantity", e.quantity },
                        { "unit_price", e.unit_price },
                        { "amount", e.amount },
                        { "note", e.note },
                        { "source_sheet", e.source_sheet },
                        { "source_row", e.source_row }
                    };
                    expList.Add(d);
                }
                var pd = new Dictionary<string, object>
                {
                    { "name", p.name },
                    { "slug", p.slug },
                    { "expenses", expList }
                };
                projList.Add(pd);
            }

            var root = new Dictionary<string, object> { { "projects", projList } };
            return ser.Serialize(root);
        }

        // ==================================================================
        // HTTP POST
        // ==================================================================
        private static void PostImport(string apiBase, string token, string json)
        {
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;

            string url = apiBase + "/api/import.php";
            Console.WriteLine();
            Console.WriteLine("POST " + url);

            using (var client = new HttpClient())
            {
                client.Timeout = TimeSpan.FromMinutes(5);
                var req = new HttpRequestMessage(HttpMethod.Post, url);
                req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
                req.Content = new StringContent(json, Encoding.UTF8, "application/json");

                var resp = client.SendAsync(req).GetAwaiter().GetResult();
                string respBody = resp.Content.ReadAsStringAsync().GetAwaiter().GetResult();

                Console.WriteLine("HTTP " + (int)resp.StatusCode + " " + resp.StatusCode);
                Console.WriteLine(respBody);

                if (!resp.IsSuccessStatusCode)
                    throw new Exception("Import endpoint returned non-success status " + (int)resp.StatusCode);
            }
        }

        // ==================================================================
        // CONSOLE SUMMARY
        // ==================================================================
        private static void PrintSummary(List<ProjectDto> projects)
        {
            Console.WriteLine("=== Parse Summary ===");
            decimal grand = 0m;
            int grandRows = 0;
            foreach (var p in projects)
            {
                decimal mat = SumCategory(p, "material");
                decimal lab = SumCategory(p, "labor");
                decimal oth = SumCategory(p, "other");
                decimal sub = mat + lab + oth;
                grand += sub;
                grandRows += p.expenses.Count;

                Console.WriteLine(string.Format(Inv,
                    "{0,-22} slug={1,-18} rows={2,4}  material={3,14:N2}  labor={4,14:N2}  other={5,14:N2}  total={6,14:N2}",
                    Truncate(p.name, 22), Truncate(p.slug, 18), p.expenses.Count, mat, lab, oth, sub));
            }
            Console.WriteLine(new string('-', 120));
            Console.WriteLine(string.Format(Inv,
                "{0,-22} {1,-18} rows={2,4}  GRAND TOTAL = {3:N2}",
                "ALL", "", grandRows, grand));
        }

        private static decimal SumCategory(ProjectDto p, string cat)
        {
            decimal sum = 0m;
            foreach (var e in p.expenses)
            {
                if (e.category != cat) continue;
                decimal d;
                if (e.amount != null && decimal.TryParse(e.amount, NumberStyles.Any, Inv, out d))
                    sum += d;
            }
            return sum;
        }

        private static string Truncate(string s, int max)
        {
            if (string.IsNullOrEmpty(s)) return "";
            return s.Length <= max ? s : s.Substring(0, max);
        }
    }
}
