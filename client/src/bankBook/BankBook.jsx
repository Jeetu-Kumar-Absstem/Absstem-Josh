import { useEffect, useMemo, useState } from "react";

async function apiFetch(path, options) {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error("Request failed");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function fmtDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString();
}

function fmtMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(2);
}

function getApiErrorMessage(error, fallback) {
  if (typeof error?.data?.detail === "string" && error.data.detail.trim()) return error.data.detail.trim();
  if (typeof error?.data?.error === "string" && error.data.error.trim()) return error.data.error.trim();
  return fallback;
}

function bucketButtonStyle(active) {
  return {
    all: "unset",
    cursor: "pointer",
    border: `1px solid ${active ? "#cfe0ff" : "#e6ebf3"}`,
    background: active ? "#eef4ff" : "#ffffff",
    borderRadius: 18,
    padding: 14,
    display: "grid",
    gap: 6,
    boxShadow: active ? "0 10px 24px rgba(35, 74, 143, 0.10)" : "0 6px 18px rgba(26, 35, 53, 0.04)",
  };
}

function queueActionButtonStyle() {
  return {
    border: "1px solid #d4dbeb",
    background: "#ffffff",
    borderRadius: 10,
    padding: "8px 12px",
    cursor: "pointer",
  };
}

function emptyBook() {
  return {
    id: null,
    book_code: "",
    book_name: "",
    book_type: "bank",
    opening_balance: "0",
    account_name: "",
    account_no: "",
    ifsc: "",
    bank_name: "",
    branch_name: "",
    is_active: true,
  };
}

function emptyEntry(bookId = "") {
  return {
    id: null,
    finance_book_id: bookId,
    entry_status: "draft",
    entry_date: "",
    entry_type: "receipt",
    amount: "0",
    counterparty_name: "",
    reference_no: "",
    remarks: "",
  };
}

export default function BankBook({ launch, onConsumeLaunch, onOpenReceipt, onOpenVendorPayment }) {
  const [view, setView] = useState({ type: "list" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [books, setBooks] = useState([]);
  const [bookForm, setBookForm] = useState(emptyBook());
  const [savingBook, setSavingBook] = useState(false);
  const [reconSummary, setReconSummary] = useState(null);
  const [reconRows, setReconRows] = useState([]);
  const [reconBucket, setReconBucket] = useState("unbooked_receipts");
  const [reconQuery, setReconQuery] = useState("");
  const [reconLoading, setReconLoading] = useState(false);
  const [reconError, setReconError] = useState("");

  async function loadList() {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch("/bank-book");
      setBooks(Array.isArray(data?.books) ? data.books : []);
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to load bank / cash book."));
    } finally {
      setLoading(false);
    }
  }

  async function loadReconciliationSummary() {
    try {
      const data = await apiFetch("/bank-book/reconciliation-summary");
      setReconSummary(data?.summary || null);
    } catch (e) {
      setReconSummary(null);
      setReconError(getApiErrorMessage(e, "Failed to load bank reconciliation summary."));
    }
  }

  async function loadReconciliationQueue({ bucket = reconBucket, q = reconQuery } = {}) {
    setReconLoading(true);
    setReconError("");
    try {
      const params = new URLSearchParams();
      if (bucket) params.set("bucket", bucket);
      if (q) params.set("q", q);
      const query = params.toString();
      const data = await apiFetch(`/bank-book/reconciliation-queue${query ? `?${query}` : ""}`);
      setReconRows(Array.isArray(data?.rows) ? data.rows : []);
    } catch (e) {
      setReconRows([]);
      setReconError(getApiErrorMessage(e, "Failed to load bank reconciliation queue."));
    } finally {
      setReconLoading(false);
    }
  }

  useEffect(() => {
    if (view.type === "list") {
      loadList();
      loadReconciliationSummary().catch(() => {});
      loadReconciliationQueue().catch(() => {});
    }
  }, [view.type]);

  useEffect(() => {
    if (view.type !== "list") return;
    loadReconciliationQueue({ bucket: reconBucket }).catch(() => {});
  }, [reconBucket]);

  useEffect(() => {
    if (!launch || typeof launch !== "object") return;
    const nextBucket = typeof launch.recon_bucket === "string" ? launch.recon_bucket : reconBucket;
    const nextQuery = typeof launch.recon_q === "string" ? launch.recon_q : "";
    const nextBookId = Number(launch.book_id);
    if (Number.isFinite(nextBookId) && nextBookId > 0) {
      setView({ type: "detail", id: nextBookId });
    } else if (view.type !== "list") {
      setView({ type: "list" });
    }
    setReconBucket(nextBucket);
    setReconQuery(nextQuery);
    loadReconciliationSummary().catch(() => {});
    loadReconciliationQueue({ bucket: nextBucket, q: nextQuery }).catch(() => {});
    if (typeof onConsumeLaunch === "function") onConsumeLaunch();
  }, [launch]);

  async function saveBook() {
    setSavingBook(true);
    setError("");
    setNotice("");
    try {
      const payload = {
        ...bookForm,
        opening_balance: Number(bookForm.opening_balance || 0),
      };
      if (bookForm.id) {
        await apiFetch(`/bank-book/books/${bookForm.id}`, { method: "PUT", body: JSON.stringify(payload) });
        setNotice("Book updated.");
      } else {
        await apiFetch("/bank-book/books", { method: "POST", body: JSON.stringify(payload) });
        setNotice("Book created.");
      }
      setBookForm(emptyBook());
      await loadList();
      await loadReconciliationSummary().catch(() => {});
      await loadReconciliationQueue().catch(() => {});
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to save book."));
    } finally {
      setSavingBook(false);
    }
  }

  if (view.type === "detail") {
    return <BankBookDetail id={view.id} onBack={() => setView({ type: "list" })} onNotice={(msg) => setNotice(msg)} />;
  }

  const heroMetrics = [
    { label: "Unbooked receipts", value: reconSummary?.unbooked_receipts_count ?? 0, amount: reconSummary?.unbooked_receipts_amount || 0, tone: "#143d7a" },
    { label: "Unbooked payments", value: reconSummary?.unbooked_payments_count ?? 0, amount: reconSummary?.unbooked_payments_amount || 0, tone: "#8b5a00" },
    { label: "Draft vouchers", value: reconSummary?.draft_entry_count ?? 0, amount: reconSummary?.draft_entry_amount || 0, tone: "#7b4ad8" },
    { label: "Negative books", value: reconSummary?.negative_book_count ?? 0, amount: reconSummary?.negative_book_amount || 0, tone: "#9f2042" },
  ];

  const bucketCards = [
    { key: "unbooked_receipts", label: "Posted receipts missing book", count: Number(reconSummary?.unbooked_receipts_count || 0), amount: Number(reconSummary?.unbooked_receipts_amount || 0), tone: "#143d7a" },
    { key: "unbooked_payments", label: "Posted payments missing book", count: Number(reconSummary?.unbooked_payments_count || 0), amount: Number(reconSummary?.unbooked_payments_amount || 0), tone: "#8b5a00" },
    { key: "draft_entries", label: "Draft treasury vouchers", count: Number(reconSummary?.draft_entry_count || 0), amount: Number(reconSummary?.draft_entry_amount || 0), tone: "#7b4ad8" },
    { key: "stale_manual", label: "Old posted manual entries", count: Number(reconSummary?.stale_manual_count || 0), amount: Number(reconSummary?.stale_manual_amount || 0), tone: "#58627a" },
    { key: "recent_movements", label: "Recent movements to verify", count: Number(reconSummary?.recent_movement_book_count || 0), amount: Number(reconSummary?.recent_movement_amount || 0), tone: "#0a7a35" },
    { key: "negative_books", label: "Negative books", count: Number(reconSummary?.negative_book_count || 0), amount: Number(reconSummary?.negative_book_amount || 0), tone: "#9f2042" },
  ];

  return (
    <div style={{ maxWidth: 1380 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, opacity: 0.72, textTransform: "uppercase", letterSpacing: "0.08em" }}>Treasury Control Desk</div>
          <h2 style={{ margin: "4px 0 0 0", flex: 1 }}>Bank / Cash Book</h2>
        </div>
        <button
          onClick={() => {
            loadList();
            loadReconciliationSummary().catch(() => {});
            loadReconciliationQueue().catch(() => {});
          }}
          disabled={loading || reconLoading}
        >
          {loading || reconLoading ? "Refreshing..." : "Refresh"}
        </button>
      </div>
      {error ? <div style={{ color: "#b00020", marginTop: 12 }}>{error}</div> : null}
      {notice ? <div style={{ color: "#0a7a35", marginTop: 12 }}>{notice}</div> : null}

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12 }}>
        {heroMetrics.map((item) => (
          <SummaryCard key={item.label} label={item.label} value={item.value} note={fmtMoney(item.amount)} tone={item.tone} />
        ))}
      </div>

      <div style={{ marginTop: 16, border: "1px solid #e7ebf3", borderRadius: 18, background: "#ffffff", padding: 16, boxShadow: "0 6px 18px rgba(26, 35, 53, 0.04)" }}>
        <div style={{ display: "grid", gap: 14 }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 18 }}>Bank Reconciliation Command Desk</div>
            <div style={{ marginTop: 4, fontSize: 13, color: "#58627a", lineHeight: 1.6 }}>
              Work the treasury gaps already visible in Josh: posted receipts and payments still missing a book, draft or stale manual vouchers, recent movements that need statement check, and books that have gone negative.
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
            {bucketCards.map((card) => (
              <button key={card.key} onClick={() => setReconBucket(card.key)} style={bucketButtonStyle(reconBucket === card.key)}>
                <div style={{ fontSize: 12, opacity: 0.68 }}>{card.label}</div>
                <div style={{ fontSize: 24, fontWeight: 800, color: card.tone }}>{card.count}</div>
                <div style={{ fontSize: 12, opacity: 0.74 }}>{card.amount > 0 ? fmtMoney(card.amount) : "Open queue"}</div>
              </button>
            ))}
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <input
              value={reconQuery}
              onChange={(e) => setReconQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") loadReconciliationQueue({ q: reconQuery }).catch(() => {});
              }}
              placeholder="Search document, counterparty, or book"
              style={{ height: 38, minWidth: 260, flex: "1 1 260px", borderRadius: 10, border: "1px solid #d4dbeb", padding: "0 12px" }}
            />
            <button onClick={() => loadReconciliationQueue({ q: reconQuery })} disabled={reconLoading}>
              {reconLoading ? "Refreshing..." : "Refresh Queue"}
            </button>
            <div style={{ fontSize: 12, color: "#58627a" }}>
              Recent movements: {reconSummary?.recent_movement_count || 0} docs across {reconSummary?.recent_movement_book_count || 0} books
            </div>
          </div>

          {reconError ? <div style={{ color: "#b00020", fontSize: 13 }}>{reconError}</div> : null}

          {reconLoading ? (
            <div>Loading treasury queue…</div>
          ) : reconRows.length ? (
            <div style={{ display: "grid", gap: 12 }}>
              {reconBucket === "unbooked_receipts"
                ? reconRows.map((row) => (
                    <div key={row.id} style={queueCardStyle()}>
                      <div style={queueHeaderStyle()}>
                        <div>
                          <div style={{ fontWeight: 800, fontSize: 16 }}>{row.receipt_number}</div>
                          <div style={{ fontSize: 12, color: "#58627a", marginTop: 4 }}>{row.customer_name} • {fmtDate(row.receipt_date)}</div>
                        </div>
                        <div style={{ fontWeight: 800 }}>{fmtMoney(row.receipt_amount_invoice)}</div>
                      </div>
                      <div style={{ fontSize: 13, color: "#58627a" }}>
                        Mode: {row.payment_mode || "—"} • Unallocated: {fmtMoney(row.unallocated_amount_invoice)}
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {typeof onOpenReceipt === "function" ? (
                          <button onClick={() => onOpenReceipt(Number(row.id))} style={queueActionButtonStyle()}>
                            Open Receipt
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ))
                : reconBucket === "unbooked_payments"
                  ? reconRows.map((row) => (
                      <div key={row.id} style={queueCardStyle()}>
                        <div style={queueHeaderStyle()}>
                          <div>
                            <div style={{ fontWeight: 800, fontSize: 16 }}>{row.payment_number}</div>
                            <div style={{ fontSize: 12, color: "#58627a", marginTop: 4 }}>{row.vendor_name} • {fmtDate(row.payment_date)}</div>
                          </div>
                          <div style={{ fontWeight: 800 }}>{fmtMoney(row.net_payment_amount || row.payment_amount)}</div>
                        </div>
                        <div style={{ fontSize: 13, color: "#58627a" }}>
                          Mode: {row.payment_mode || "—"} • TDS: {fmtMoney(row.tds_amount)}
                        </div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          {typeof onOpenVendorPayment === "function" ? (
                            <button onClick={() => onOpenVendorPayment(Number(row.id))} style={queueActionButtonStyle()}>
                              Open Payment
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ))
                  : reconBucket === "draft_entries" || reconBucket === "stale_manual"
                    ? reconRows.map((row) => (
                        <div key={row.id} style={queueCardStyle()}>
                          <div style={queueHeaderStyle()}>
                            <div>
                              <div style={{ fontWeight: 800, fontSize: 16 }}>{row.entry_number}</div>
                              <div style={{ fontSize: 12, color: "#58627a", marginTop: 4 }}>{row.book_name} • {fmtDate(row.entry_date)}</div>
                            </div>
                            <div style={{ fontWeight: 800 }}>{fmtMoney(row.amount)}</div>
                          </div>
                          <div style={{ fontSize: 13, color: "#58627a" }}>
                            {row.entry_type} • {row.entry_status} • {row.counterparty_name || "No counterparty"} • Ref {row.reference_no || "—"}
                          </div>
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                            <button onClick={() => setView({ type: "detail", id: Number(row.finance_book_id) })} style={queueActionButtonStyle()}>
                              Open Book
                            </button>
                          </div>
                        </div>
                      ))
                    : reconRows.map((row) => (
                        <div key={row.book_id} style={queueCardStyle()}>
                          <div style={queueHeaderStyle()}>
                            <div>
                              <div style={{ fontWeight: 800, fontSize: 16 }}>{row.book_name}</div>
                              <div style={{ fontSize: 12, color: "#58627a", marginTop: 4 }}>
                                {row.book_type} {row.bank_name ? `• ${row.bank_name}` : ""} {row.last_txn_date ? `• last ${fmtDate(row.last_txn_date)}` : ""}
                              </div>
                            </div>
                            <div style={{ fontWeight: 800 }}>{fmtMoney(row.closing_balance)}</div>
                          </div>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
                            <MiniMetric label="Recent txns" value={row.recent_txn_count || 0} />
                            <MiniMetric label="Recent receipts" value={fmtMoney(row.recent_receipts_amount || 0)} />
                            <MiniMetric label="Recent payments" value={fmtMoney(row.recent_payments_amount || 0)} />
                            <MiniMetric label="Manual docs" value={row.recent_manual_count || 0} />
                          </div>
                          {(row.total_receipts !== undefined || row.total_payments !== undefined) ? (
                            <div style={{ fontSize: 13, color: "#58627a" }}>
                              Opening {fmtMoney(row.opening_balance)} • Receipts {fmtMoney(row.total_receipts || 0)} • Payments {fmtMoney(row.total_payments || 0)}
                            </div>
                          ) : null}
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                            <button onClick={() => setView({ type: "detail", id: Number(row.book_id) })} style={queueActionButtonStyle()}>
                              Open Book
                            </button>
                          </div>
                        </div>
                      ))}
            </div>
          ) : (
            <div style={{ padding: 18, borderRadius: 16, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
              No treasury rows in this bucket right now.
            </div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "0.95fr 1.05fr", gap: 16 }}>
        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Book Master</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Book Code"><input value={bookForm.book_code} onChange={(e) => setBookForm((p) => ({ ...p, book_code: e.target.value }))} /></Field>
            <Field label="Book Name"><input value={bookForm.book_name} onChange={(e) => setBookForm((p) => ({ ...p, book_name: e.target.value }))} /></Field>
            <Field label="Type">
              <select value={bookForm.book_type} onChange={(e) => setBookForm((p) => ({ ...p, book_type: e.target.value }))}>
                <option value="bank">Bank</option>
                <option value="cash">Cash</option>
              </select>
            </Field>
            <Field label="Opening Balance"><input value={bookForm.opening_balance} onChange={(e) => setBookForm((p) => ({ ...p, opening_balance: e.target.value }))} /></Field>
            <Field label="Account Name"><input value={bookForm.account_name} onChange={(e) => setBookForm((p) => ({ ...p, account_name: e.target.value }))} /></Field>
            <Field label="Account No"><input value={bookForm.account_no} onChange={(e) => setBookForm((p) => ({ ...p, account_no: e.target.value }))} /></Field>
            <Field label="IFSC"><input value={bookForm.ifsc} onChange={(e) => setBookForm((p) => ({ ...p, ifsc: e.target.value }))} /></Field>
            <Field label="Bank Name"><input value={bookForm.bank_name} onChange={(e) => setBookForm((p) => ({ ...p, bank_name: e.target.value }))} /></Field>
          </div>
          <Field label="Branch"><input value={bookForm.branch_name} onChange={(e) => setBookForm((p) => ({ ...p, branch_name: e.target.value }))} /></Field>
          <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <input type="checkbox" checked={bookForm.is_active} onChange={(e) => setBookForm((p) => ({ ...p, is_active: e.target.checked }))} />
            Active
          </label>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <button onClick={() => setBookForm(emptyBook())}>Reset</button>
            <button onClick={saveBook} disabled={savingBook}>{savingBook ? "Saving..." : (bookForm.id ? "Update Book" : "Create Book")}</button>
          </div>
        </div>

        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, overflow: "hidden" }}>
          <div style={{ padding: 12, borderBottom: "1px solid #e5e5e5", fontWeight: 700 }}>Books</div>
          <div style={{ display: "grid", gridTemplateColumns: "120px 1fr 100px 120px 120px", gap: 8, padding: 12, fontSize: 12, opacity: 0.8, borderBottom: "1px solid #e5e5e5" }}>
            <div>Code</div><div>Name</div><div>Type</div><div>Opening</div><div>Closing</div>
          </div>
          {books.map((book) => (
            <button
              key={book.id}
              onClick={() => setView({ type: "detail", id: book.id })}
              onContextMenu={(e) => {
                e.preventDefault();
                setBookForm({
                  id: book.id,
                  book_code: book.book_code || "",
                  book_name: book.book_name || "",
                  book_type: book.book_type || "bank",
                  opening_balance: String(book.opening_balance ?? 0),
                  account_name: book.account_name || "",
                  account_no: book.account_no || "",
                  ifsc: book.ifsc || "",
                  bank_name: book.bank_name || "",
                  branch_name: book.branch_name || "",
                  is_active: book.is_active !== false,
                });
              }}
              style={{ all: "unset", cursor: "pointer", display: "grid", gridTemplateColumns: "120px 1fr 100px 120px 120px", gap: 8, padding: 12, borderBottom: "1px solid #f2f2f2" }}
            >
              <div>{book.book_code || "—"}</div>
              <div>{book.book_name}</div>
              <div style={{ textTransform: "capitalize" }}>{book.book_type}</div>
              <div>{fmtMoney(book.opening_balance)}</div>
              <div>{fmtMoney(book.closing_balance)}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function BankBookDetail({ id, onBack, onNotice }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [book, setBook] = useState(null);
  const [statementRows, setStatementRows] = useState([]);
  const [summary, setSummary] = useState({ opening_balance: 0, total_receipts: 0, total_payments: 0, closing_balance: 0 });
  const [entries, setEntries] = useState([]);
  const [entryForm, setEntryForm] = useState(emptyEntry());
  const [saving, setSaving] = useState(false);

  async function loadDetail() {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch(`/bank-book/book/${id}`);
      setBook(data?.book || null);
      setStatementRows(Array.isArray(data?.statementRows) ? data.statementRows : []);
      setSummary(data?.summary || { opening_balance: 0, total_receipts: 0, total_payments: 0, closing_balance: 0 });
      setEntries(Array.isArray(data?.manual_entries) ? data.manual_entries : []);
      setEntryForm(emptyEntry(String(data?.book?.id || "")));
    } catch (e) {
      setError(e?.data?.error || "Failed to load book.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadDetail();
  }, [id]);

  const sortedEntries = useMemo(() => entries.slice(), [entries]);

  async function saveEntry() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const payload = {
        ...entryForm,
        finance_book_id: Number(book.id),
        amount: Number(entryForm.amount || 0),
      };
      if (entryForm.id) {
        await apiFetch(`/bank-book/entries/${entryForm.id}`, { method: "PUT", body: JSON.stringify(payload) });
        setNotice("Entry updated.");
      } else {
        await apiFetch("/bank-book/entries", { method: "POST", body: JSON.stringify(payload) });
        setNotice("Entry created.");
      }
      await loadDetail();
      onNotice?.("Book entry saved.");
    } catch (e) {
      setError(e?.data?.error || "Failed to save entry.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div>Loading book…</div>;
  if (!book) {
    return (
      <div>
        <button onClick={onBack}>Back</button>
        <div style={{ color: "#b00020", marginTop: 12 }}>{error || "Book not found."}</div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1250 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <button onClick={onBack}>Back</button>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0 }}>{book.book_name}</h2>
          <div style={{ fontSize: 12, opacity: 0.75 }}>{book.book_type} • Closing {fmtMoney(summary.closing_balance)}</div>
        </div>
        <button onClick={loadDetail}>Refresh</button>
      </div>
      {error ? <div style={{ color: "#b00020", marginTop: 12 }}>{error}</div> : null}
      {notice ? <div style={{ color: "#0a7a35", marginTop: 12 }}>{notice}</div> : null}

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 }}>
        <SummaryCard label="Opening" value={fmtMoney(summary.opening_balance)} />
        <SummaryCard label="Receipts" value={fmtMoney(summary.total_receipts)} />
        <SummaryCard label="Payments" value={fmtMoney(summary.total_payments)} />
        <SummaryCard label="Closing" value={fmtMoney(summary.closing_balance)} />
      </div>

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "0.9fr 1.1fr", gap: 16 }}>
        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Manual Entry</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Status">
              <select value={entryForm.entry_status} onChange={(e) => setEntryForm((p) => ({ ...p, entry_status: e.target.value }))}>
                <option value="draft">Draft</option>
                <option value="posted">Posted</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </Field>
            <Field label="Date">
              <input type="date" value={entryForm.entry_date} onChange={(e) => setEntryForm((p) => ({ ...p, entry_date: e.target.value }))} />
            </Field>
            <Field label="Type">
              <select value={entryForm.entry_type} onChange={(e) => setEntryForm((p) => ({ ...p, entry_type: e.target.value }))}>
                <option value="receipt">Receipt</option>
                <option value="payment">Payment</option>
              </select>
            </Field>
            <Field label="Amount">
              <input value={entryForm.amount} onChange={(e) => setEntryForm((p) => ({ ...p, amount: e.target.value }))} />
            </Field>
            <Field label="Counterparty">
              <input value={entryForm.counterparty_name} onChange={(e) => setEntryForm((p) => ({ ...p, counterparty_name: e.target.value }))} />
            </Field>
            <Field label="Reference No">
              <input value={entryForm.reference_no} onChange={(e) => setEntryForm((p) => ({ ...p, reference_no: e.target.value }))} />
            </Field>
          </div>
          <Field label="Remarks">
            <textarea rows={3} style={{ width: "100%" }} value={entryForm.remarks} onChange={(e) => setEntryForm((p) => ({ ...p, remarks: e.target.value }))} />
          </Field>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <button onClick={() => setEntryForm(emptyEntry(String(book.id)))}>Reset</button>
            <button onClick={saveEntry} disabled={saving}>{saving ? "Saving..." : (entryForm.id ? "Update Entry" : "Create Entry")}</button>
          </div>

          <div style={{ marginTop: 16 }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>Manual Entries</div>
            {sortedEntries.length ? sortedEntries.map((entry) => (
              <button
                key={entry.id}
                onClick={() => setEntryForm({
                  id: entry.id,
                  finance_book_id: String(entry.finance_book_id),
                  entry_status: entry.entry_status || "draft",
                  entry_date: entry.entry_date ? String(entry.entry_date).slice(0, 10) : "",
                  entry_type: entry.entry_type || "receipt",
                  amount: String(entry.amount ?? 0),
                  counterparty_name: entry.counterparty_name || "",
                  reference_no: entry.reference_no || "",
                  remarks: entry.remarks || "",
                })}
                style={{ all: "unset", display: "block", cursor: "pointer", border: "1px solid #eee", borderRadius: 8, padding: 10, marginBottom: 8 }}
              >
                {entry.entry_number} • {entry.entry_type} • {fmtMoney(entry.amount)}
              </button>
            )) : <div style={{ opacity: 0.72 }}>No manual entries yet.</div>}
          </div>
        </div>

        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, overflow: "hidden" }}>
          <div style={{ padding: 12, borderBottom: "1px solid #e5e5e5", fontWeight: 700 }}>Book Statement</div>
          <div style={{ display: "grid", gridTemplateColumns: "110px 140px 140px 1fr 110px 110px 110px", gap: 8, padding: 12, fontSize: 12, opacity: 0.8, borderBottom: "1px solid #e5e5e5" }}>
            <div>Date</div><div>Type</div><div>Reference</div><div>Description</div><div>Debit</div><div>Credit</div><div>Balance</div>
          </div>
          {statementRows.length ? statementRows.map((row, idx) => (
            <div key={`${row.reference_no}-${idx}`} style={{ display: "grid", gridTemplateColumns: "110px 140px 140px 1fr 110px 110px 110px", gap: 8, padding: 12, borderBottom: "1px solid #f2f2f2" }}>
              <div>{fmtDate(row.txn_date)}</div>
              <div>{row.txn_type}</div>
              <div>{row.reference_no}</div>
              <div>{row.description}</div>
              <div>{row.debit ? fmtMoney(row.debit) : "—"}</div>
              <div>{row.credit ? fmtMoney(row.credit) : "—"}</div>
              <div>{fmtMoney(row.running_balance)}</div>
            </div>
          )) : <div style={{ padding: 12, opacity: 0.72 }}>No statement rows yet.</div>}
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ label, value, note = "", tone = null }) {
  return (
    <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
      <div style={{ fontSize: 12, opacity: 0.72 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: tone || "inherit" }}>{value}</div>
      {note ? <div style={{ fontSize: 12, color: "#58627a", marginTop: 4 }}>{note}</div> : null}
    </div>
  );
}

function MiniMetric({ label, value }) {
  return (
    <div style={{ border: "1px solid #e7ebf3", borderRadius: 12, padding: 10, background: "#fafbff" }}>
      <div style={{ fontSize: 12, opacity: 0.68 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 800 }}>{value}</div>
    </div>
  );
}

function queueCardStyle() {
  return {
    border: "1px solid #e7ebf3",
    borderRadius: 18,
    padding: 14,
    background: "#ffffff",
    boxShadow: "0 6px 18px rgba(26, 35, 53, 0.04)",
    display: "grid",
    gap: 12,
  };
}

function queueHeaderStyle() {
  return {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    flexWrap: "wrap",
    alignItems: "flex-start",
  };
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}
