import { useState } from "react";
import {
  formatProposalProfileLabel,
  toNumber,
} from "./quoteBuilderHelpers";
import { resolvePriceTypeKey } from "./quoteShared";

export function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 12, minWidth: 0 }}>
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

export function CustomerChip({ label, tone = "#eef4ff", color = "#2354d5", borderColor = "rgba(35,84,213,0.14)" }) {
  if (!label) return null;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 10px",
        borderRadius: 999,
        background: tone,
        color,
        border: `1px solid ${borderColor}`,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.01em",
      }}
    >
      {label}
    </span>
  );
}

export function CustomerStatCard({ label, value, accent = "#2354d5" }) {
  const isAffirmative = String(value).toLowerCase() === "yes";
  return (
    <div
      style={{
        border: "1px solid rgba(152,174,219,0.28)",
        borderRadius: 14,
        padding: 12,
        background: "linear-gradient(180deg, rgba(255,255,255,0.96) 0%, rgba(245,248,255,0.94) 100%)",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.82)",
        transition: "transform 160ms ease, box-shadow 160ms ease",
      }}
    >
      <div style={{ fontSize: 11, opacity: 0.58, textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</div>
      <div style={{ marginTop: 8, fontSize: 20, fontWeight: 800, color: accent }}>{value}</div>
      {label === "Mail Ready" ? (
        <div style={{ marginTop: 6, fontSize: 11, opacity: 0.64 }}>{isAffirmative ? "Recipient flow looks ready" : "Recipient email still needed"}</div>
      ) : null}
    </div>
  );
}

export function DraftLineCard({
  line,
  isAdvancedOpen,
  onToggleAdvanced,
  onMove,
  onDuplicate,
  onRemove,
  onChange,
  lineTotal,
  priceTypeOptions,
  priceHint = null,
  floorHint = null,
}) {
  return (
    <div style={{ border: "1px solid #efefef", borderRadius: 12, padding: 12, background: "#fff" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "start" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {line.item_name || "Manual Item"}
          </div>
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4, lineHeight: 1.5 }}>
            {[
              line.item_code || "Manual",
              line.hsn_no ? `HSN ${line.hsn_no}` : null,
              `GST ${toNumber(line.gst_pct, 0).toFixed(2)}%`,
              { included: "Included", client_scope: "Client Scope", quoted_separately: "Quoted Separately" }[line.scope_type || "included"] ||
                line.scope_type,
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" onClick={() => onMove("up")}>
            Up
          </button>
          <button type="button" onClick={() => onMove("down")}>
            Down
          </button>
          <button type="button" onClick={onDuplicate}>
            Duplicate
          </button>
          <button type="button" onClick={onToggleAdvanced}>
            {isAdvancedOpen ? "Hide Advanced" : "Advanced Settings"}
          </button>
          <button type="button" onClick={onRemove}>
            Remove
          </button>
        </div>
      </div>

      <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
        <Field label="Qty">
          <input
            type="number"
            value={line.qty}
            onChange={(e) => onChange({ qty: e.target.value }, "disc_pct")}
            min={1}
            step={1}
            style={{ width: "100%" }}
          />
        </Field>
        <Field label="Scope">
          <select value={line.scope_type} onChange={(e) => onChange({ scope_type: e.target.value })} style={{ width: "100%" }}>
            <option value="included">Included</option>
            <option value="client_scope">Client Scope</option>
            <option value="quoted_separately">Quoted Separately</option>
          </select>
          {line.scope_type === "client_scope" || line.scope_type === "quoted_separately" ? (
            <div style={{ marginTop: 6, fontSize: 11, lineHeight: 1.5, color: "#9a5a00" }}>
              {line.scope_type === "client_scope"
                ? "Client supplies this. Shown in Scope of Supply, not priced or totalled."
                : "Shown as an optional item with its own price, not in the total."}
            </div>
          ) : null}
        </Field>
        <Field label="Net Unit">
          <input
            type="number"
            value={line.unit_price_quote}
            min={0}
            step={0.01}
            readOnly
            style={{ width: "100%", background: "#f5f7fb", color: "#5f6f8f" }}
          />
          {priceHint ? (
            <div style={{ marginTop: 6, fontSize: 11, lineHeight: 1.55, opacity: 0.8 }}>
              <div>
                {priceHint.last_quoted_unit != null
                  ? `Last quoted ${Number(priceHint.last_quoted_unit).toFixed(2)}${
                      priceHint.last_quoted_number ? ` (${priceHint.last_quoted_number})` : ""
                    }${priceHint.last_quoted_at ? ` · ${String(priceHint.last_quoted_at).slice(0, 10)}` : ""}`
                  : "No prior quote"}
              </div>
              {priceHint.last_sold_unit != null ? (
                <div>
                  Last sold {Number(priceHint.last_sold_unit).toFixed(2)}
                  {priceHint.last_sold_number ? ` (${priceHint.last_sold_number})` : ""}
                  {priceHint.last_sold_at ? ` · ${String(priceHint.last_sold_at).slice(0, 10)}` : ""}
                </div>
              ) : null}
            </div>
          ) : null}
          {floorHint ? (
            <div
              style={{
                marginTop: 6,
                fontSize: 11,
                lineHeight: 1.5,
                color: floorHint.breached ? "#9f2042" : "#31539d",
                opacity: 0.9,
              }}
            >
              Floor {Number(floorHint.floor).toFixed(2)} ({Number(floorHint.minPct).toFixed(0)}% of list)
              {floorHint.breached ? " — below company floor" : ""}
            </div>
          ) : null}
        </Field>
        <Field label="Line Total">
          <div style={{ padding: "10px 0", fontWeight: 700 }}>{lineTotal}</div>
        </Field>
      </div>

      <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, alignItems: "end" }}>
        <Field label="Customer Part Code">
          <input
            value={line.customer_item_code || ""}
            onChange={(e) => onChange({ customer_item_code: e.target.value })}
            placeholder="SAP / customer item code"
            style={{ width: "100%" }}
          />
        </Field>
        <Field label="Customer Part Description">
          <input
            value={line.customer_item_description || ""}
            onChange={(e) => onChange({ customer_item_description: e.target.value })}
            placeholder="Customer material description"
            style={{ width: "100%" }}
          />
        </Field>
        <Field label="Remarks">
          <input
            value={line.remarks}
            onChange={(e) => onChange({ remarks: e.target.value })}
            placeholder="Line remarks or commercial note"
            style={{ width: "100%" }}
          />
        </Field>
      </div>

      {isAdvancedOpen ? (
        <div style={{ marginTop: 10, border: "1px solid rgba(214,224,244,0.92)", borderRadius: 14, padding: 12, background: "#f8fbff" }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: "#2354d5" }}>Manual Override</div>
          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.72, lineHeight: 1.6 }}>
            Use only when you need an exception to the standard recommended pricing flow.
          </div>
          <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
            <Field label="Gross Unit">
              <input
                type="number"
                value={line.gross_unit_price_quote}
                min={0}
                step={0.01}
                readOnly
                style={{ width: "100%", background: "#f5f7fb", color: "#5f6f8f" }}
              />
            </Field>
            <Field label="Disc %">
              <input
                type="number"
                value={line.discount_pct}
                onChange={(e) => onChange({ discount_pct: e.target.value, discount_amt: "" }, "disc_pct")}
                min={0}
                step={0.01}
                style={{ width: "100%" }}
              />
            </Field>
            <Field label="Disc Amt">
              <input
                type="number"
                value={line.discount_amt}
                min={0}
                step={0.01}
                readOnly
                style={{ width: "100%", background: "#f5f7fb", color: "#5f6f8f" }}
              />
            </Field>
            <Field label="GST%">
              <input
                type="number"
                value={line.gst_pct}
                onChange={(e) => onChange({ gst_pct: e.target.value })}
                min={0}
                max={100}
                step={0.01}
                style={{ width: "100%" }}
              />
            </Field>
            <Field label="Price List">
              <select value={resolvePriceTypeKey(priceTypeOptions, line.price_list)} onChange={(e) => onChange({ price_list: e.target.value })} style={{ width: "100%" }}>
                {priceTypeOptions.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function SidebarMetricCard({ label, value, note, accent = "#2354d5" }) {
  return (
    <div
      style={{
        border: "1px solid rgba(166,185,224,0.35)",
        borderRadius: 16,
        padding: 12,
        color: "#1a2b4a",
        background: "linear-gradient(180deg, #ffffff 0%, #f3f7ff 100%)",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.9)",
      }}
    >
      <div style={{ fontSize: 11, color: "#5a6b86", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>
        {label}
      </div>
      <div style={{ marginTop: 8, fontSize: 18, fontWeight: 800, color: accent }}>{value}</div>
      {note ? <div style={{ marginTop: 6, fontSize: 11, color: "#4d5f7a", lineHeight: 1.5 }}>{note}</div> : null}
    </div>
  );
}

export function SidebarKeyValueRow({ label, value, emphasis = false }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 0.9fr) minmax(0, 1.1fr)",
        gap: 12,
        alignItems: "start",
        padding: "8px 0",
        borderBottom: "1px solid rgba(223,229,241,0.78)",
      }}
    >
      <div style={{ fontSize: 11, opacity: 0.6, textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</div>
      <div style={{ fontSize: emphasis ? 14 : 12, fontWeight: emphasis ? 800 : 600, textAlign: "right", lineHeight: 1.45 }}>{value}</div>
    </div>
  );
}

export function HistoryTable({ headers, columns, rows, loading, loadingLabel, emptyLabel }) {
  return (
    <div style={{ border: "1px solid rgba(225,231,242,0.96)", borderRadius: 16, overflow: "hidden", background: "#fff", boxShadow: "0 12px 30px rgba(22,36,70,0.04)" }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: columns,
          gap: 12,
          padding: "12px 14px",
          fontSize: 11,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "#5c6881",
          background: "linear-gradient(180deg, #f8fbff 0%, #f3f7fd 100%)",
          borderBottom: "1px solid rgba(225,231,242,0.96)",
        }}
      >
        {headers.map((header) => (
          <div key={header}>{header}</div>
        ))}
      </div>
      {loading ? (
        <div style={{ padding: "14px 16px", fontSize: 12, opacity: 0.7 }}>{loadingLabel}</div>
      ) : rows.length ? (
        rows.map((row, rowIndex) => (
          <div
            key={row.id}
            style={{
              display: "grid",
              gridTemplateColumns: columns,
              gap: 12,
              padding: "13px 14px",
              borderBottom: rowIndex === rows.length - 1 ? "none" : "1px solid rgba(236,240,247,0.96)",
              fontSize: 12,
              alignItems: "start",
              background: rowIndex % 2 ? "rgba(249,251,255,0.68)" : "#fff",
            }}
          >
            {row.cells.map((cell, cellIndex) => (
              <div key={`${row.id}-${cellIndex}`} style={{ minWidth: 0, lineHeight: 1.55 }}>
                {cell}
              </div>
            ))}
          </div>
        ))
      ) : (
        <div style={{ padding: "14px 16px", fontSize: 12, opacity: 0.72 }}>{emptyLabel}</div>
      )}
    </div>
  );
}

export function CustomerResultCard({ customer, onSelect }) {
  const [hovered, setHovered] = useState(false);
  const location = [customer?.city, customer?.state].filter(Boolean).join(", ");
  return (
    <div
      role="option"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => onSelect?.(customer)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect?.(customer);
        }
      }}
      tabIndex={0}
      style={{
        border: hovered ? "1px solid rgba(94,133,225,0.7)" : "1px solid rgba(214,224,244,0.92)",
        background: "#fff",
        borderRadius: 12,
        padding: "10px 12px",
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) auto",
        gap: 12,
        alignItems: "center",
        cursor: "pointer",
        boxShadow: hovered ? "0 8px 18px rgba(61,88,142,0.08)" : "none",
        transition: "box-shadow 140ms ease, border-color 140ms ease",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 750, fontSize: 14, lineHeight: 1.35, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {customer?.customer_name}
          {customer?.customer_code ? (
            <span style={{ marginLeft: 8, fontWeight: 600, fontSize: 12, opacity: 0.62 }}>{customer.customer_code}</span>
          ) : null}
        </div>
        <div style={{ marginTop: 4, fontSize: 12, opacity: 0.72, lineHeight: 1.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {[location || null, customer?.gstin || null].filter(Boolean).join(" · ") || "No city / GSTIN on file"}
        </div>
      </div>
      <button
        type="button"
        className="button-primary"
        onClick={(e) => {
          e.stopPropagation();
          onSelect?.(customer);
        }}
        style={{ flexShrink: 0, padding: "8px 14px", fontWeight: 700 }}
      >
        Select
      </button>
    </div>
  );
}

export function SelectedCustomerCard({ customer, contactCount, siteCount, onChange }) {
  if (!customer) return null;
  const location = [customer.city, customer.state].filter(Boolean).join(", ");
  return (
    <div
      style={{
        border: "1px solid rgba(173,198,255,0.84)",
        borderRadius: 14,
        padding: 14,
        background: "linear-gradient(135deg, #edf4ff 0%, #ffffff 100%)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12, letterSpacing: "0.06em", textTransform: "uppercase", opacity: 0.58 }}>Selected customer</div>
          <div style={{ marginTop: 6, fontSize: 18, fontWeight: 800, lineHeight: 1.2 }}>{customer.customer_name}</div>
          <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
            {customer.customer_code ? <CustomerChip label={customer.customer_code} tone="#f8fbff" color="#31539d" borderColor="rgba(49,83,157,0.12)" /> : null}
            {location ? <CustomerChip label={location} tone="#f7f9fd" color="#46536b" borderColor="rgba(70,83,107,0.12)" /> : null}
            {customer.gstin ? <CustomerChip label={customer.gstin} tone="#f3fbf5" color="#1a7f47" borderColor="rgba(26,127,71,0.14)" /> : null}
          </div>
          <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
            {contactCount} contact{contactCount === 1 ? "" : "s"} · {siteCount} quote site{siteCount === 1 ? "" : "s"}
          </div>
        </div>
        {onChange ? (
          <button type="button" onClick={onChange}>
            Change Customer
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function DuplicateWarningBanner({
  duplicates,
  allowDuplicate,
  onAllowChange,
  onUseExisting,
  disabled,
  title = "Possible duplicates found",
  requireAllow = true,
  advisoryOnly = false,
}) {
  if (!Array.isArray(duplicates) || !duplicates.length) return null;
  return (
    <div
      style={{
        border: advisoryOnly ? "1px solid rgba(154,90,0,0.28)" : "1px solid #f0d6db",
        borderRadius: 14,
        padding: 14,
        background: advisoryOnly
          ? "linear-gradient(180deg, #fffaf0 0%, #fffdf8 100%)"
          : "linear-gradient(180deg, #fff8fa 0%, #fffdfd 100%)",
      }}
    >
      <div style={{ fontWeight: 800, marginBottom: 8 }}>{title}</div>
      {advisoryOnly ? (
        <div style={{ fontSize: 12, opacity: 0.78, marginBottom: 10, lineHeight: 1.6 }}>
          This is advisory only and does not block starting the draft.
        </div>
      ) : null}
      <div style={{ display: "grid", gap: 10 }}>
        {duplicates.map((dup) => (
          <div
            key={dup.id}
            style={{
              display: "flex",
              gap: 10,
              justifyContent: "space-between",
              alignItems: "flex-start",
              border: "1px solid rgba(240,214,219,0.9)",
              borderRadius: 12,
              padding: 12,
              background: "#fff",
            }}
          >
            <div style={{ fontSize: 13, opacity: 0.86, lineHeight: 1.6, minWidth: 0 }}>
              <div style={{ fontWeight: 700 }}>{dup.customer_name}</div>
              <div style={{ marginTop: 4, fontSize: 12, opacity: 0.75 }}>
                {[dup.customer_code, dup.city, dup.state, dup.gstin].filter(Boolean).join(" · ")}
              </div>
              <div style={{ fontSize: 12, color: advisoryOnly ? "#9a5a00" : "#9f2042" }}>
                {(dup.reasons || []).join(", ") || dup.duplicate_confidence?.label || "Possible overlap"}
              </div>
            </div>
            {onUseExisting ? (
              <button type="button" onClick={() => onUseExisting?.(dup)} disabled={disabled}>
                Use Existing
              </button>
            ) : null}
          </div>
        ))}
      </div>
      {requireAllow && !advisoryOnly ? (
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, marginTop: 12 }}>
          <input type="checkbox" checked={allowDuplicate === true} onChange={(e) => onAllowChange?.(e.target.checked)} disabled={disabled} />
          Create anyway, this is a genuinely new customer
        </label>
      ) : null}
    </div>
  );
}

export function ProductResultCard({ product, selected, onClick }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        all: "unset",
        cursor: "pointer",
        display: "block",
        padding: 14,
        borderRadius: 16,
        border: selected ? "1px solid #2354d5" : hovered ? "1px solid rgba(94,133,225,0.72)" : "1px solid rgba(223,229,241,0.95)",
        background: selected
          ? "linear-gradient(135deg, rgba(235,243,255,0.98) 0%, rgba(255,255,255,0.98) 100%)"
          : "linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(249,251,255,0.98) 100%)",
        boxShadow: selected ? "0 16px 34px rgba(35,84,213,0.12)" : hovered ? "0 14px 28px rgba(31,41,55,0.08)" : "0 8px 18px rgba(31,41,55,0.04)",
        transform: hovered && !selected ? "translateY(-2px)" : "translateY(0)",
        transition: "transform 160ms ease, box-shadow 160ms ease, border-color 160ms ease, background 160ms ease",
      }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 12, alignItems: "start" }}>
        <div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ fontWeight: 800, fontSize: 14 }}>{product.item_name}</div>
            {selected ? <CustomerChip label="Selected" tone="#2354d5" color="#fff" borderColor="rgba(35,84,213,0.18)" /> : null}
          </div>
          <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
            {product.item_code ? <CustomerChip label={product.item_code} tone="#f7f9fd" color="#46536b" borderColor="rgba(70,83,107,0.12)" /> : null}
            {product.group_name ? <CustomerChip label={product.group_name} tone="#f7f9fd" color="#46536b" borderColor="rgba(70,83,107,0.12)" /> : null}
            {product.category_name ? <CustomerChip label={product.category_name} tone="#f7f9fd" color="#46536b" borderColor="rgba(70,83,107,0.12)" /> : null}
          </div>
        </div>
        <div
          style={{
            minWidth: 150,
            border: "1px solid rgba(219,228,244,0.9)",
            borderRadius: 14,
            padding: "10px 12px",
            background: "rgba(255,255,255,0.82)",
            fontSize: 12,
            lineHeight: 1.75,
            textAlign: "right",
            color: "#56657f",
          }}
        >
          <div>GST {toNumber(product.gst_pct, 0).toFixed(2)}%</div>
          <div>List {toNumber(product.list_price, 0).toFixed(2)}</div>
          <div>{product.uom || "No UOM"}</div>
        </div>
      </div>
    </button>
  );
}

export function ConfiguratorFamilyCard({ family, selected, onClick }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        all: "unset",
        cursor: "pointer",
        textAlign: "left",
        border: selected ? "1px solid #2354d5" : hovered ? "1px solid rgba(94,133,225,0.72)" : "1px solid rgba(214,224,244,0.92)",
        background: selected
          ? "radial-gradient(circle at top right, rgba(141,180,255,0.2), transparent 34%), linear-gradient(135deg, rgba(235,243,255,0.98) 0%, rgba(255,255,255,0.98) 100%)"
          : "linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(249,251,255,0.98) 100%)",
        borderRadius: 18,
        padding: 14,
        display: "block",
        boxShadow: selected ? "0 18px 36px rgba(35,84,213,0.14)" : hovered ? "0 16px 30px rgba(31,41,55,0.08)" : "0 8px 18px rgba(31,41,55,0.04)",
        transform: hovered && !selected ? "translateY(-2px)" : "translateY(0)",
        transition: "transform 160ms ease, box-shadow 160ms ease, border-color 160ms ease, background 160ms ease",
        minHeight: 332,
      }}
    >
      <div
        style={{
          position: "relative",
          height: 152,
          borderRadius: 16,
          overflow: "hidden",
          background: family.image_url
            ? `linear-gradient(180deg, rgba(11,24,46,0.08) 0%, rgba(11,24,46,0.42) 100%), url(${family.image_url}) center/cover no-repeat`
            : "linear-gradient(135deg, rgba(226,236,255,0.9) 0%, rgba(245,248,255,1) 100%)",
          boxShadow: selected ? "0 16px 30px rgba(16,38,79,0.14)" : "0 10px 22px rgba(16,38,79,0.08)",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: selected
              ? "linear-gradient(180deg, rgba(12,24,49,0.02) 0%, rgba(17,40,84,0.42) 100%)"
              : "linear-gradient(180deg, rgba(19,42,88,0.02) 0%, rgba(19,42,88,0.34) 100%)",
          }}
        />
        <div
          style={{
            position: "absolute",
            inset: "auto auto 12px 12px",
            width: 88,
            height: 88,
            borderRadius: 999,
            background: selected ? "radial-gradient(circle, rgba(87,131,255,0.32) 0%, rgba(87,131,255,0) 72%)" : "radial-gradient(circle, rgba(255,255,255,0.24) 0%, rgba(255,255,255,0) 72%)",
            filter: "blur(2px)",
          }}
        />
        <div style={{ position: "relative", zIndex: 1, display: "flex", justifyContent: "space-between", gap: 10, alignItems: "start", padding: 14 }}>
          <CustomerChip
            label={family.company}
            tone={selected ? "rgba(35,84,213,0.92)" : "rgba(255,255,255,0.84)"}
            color={selected ? "#fff" : "#31539d"}
            borderColor={selected ? "rgba(35,84,213,0.22)" : "rgba(255,255,255,0.18)"}
          />
          {selected ? <CustomerChip label="Selected" tone="rgba(18,107,60,0.92)" color="#fff" borderColor="rgba(18,107,60,0.22)" /> : null}
        </div>
        <div style={{ position: "absolute", left: 14, right: 14, bottom: 14, zIndex: 1 }}>
          <div style={{ fontWeight: 800, fontSize: 20, color: "#ffffff", textShadow: "0 2px 10px rgba(0,0,0,0.24)" }}>{family.label}</div>
          <div style={{ marginTop: 6, fontSize: 12, color: "rgba(255,255,255,0.92)", lineHeight: 1.5, textShadow: "0 1px 6px rgba(0,0,0,0.24)" }}>{family.title}</div>
        </div>
      </div>

      <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <CustomerChip
          label={formatProposalProfileLabel(family.proposalProfileKey)}
          tone={selected ? "#eef4ff" : "#f7f9fd"}
          color={selected ? "#2354d5" : "#4d5b73"}
          borderColor={selected ? "rgba(35,84,213,0.14)" : "rgba(70,83,107,0.12)"}
        />
      </div>
      <div style={{ marginTop: 12, fontSize: 14, fontWeight: 700, color: "#24324a", lineHeight: 1.55 }}>{family.packageHint}</div>
      <div style={{ fontSize: 11, opacity: 0.66, marginTop: 8, lineHeight: 1.7 }}>{family.note}</div>
    </button>
  );
}

export function ConfiguratorOptionCard({ option, selected, onClick, familyLabel, familyKey, proposalProfileKey, variantLabel }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        all: "unset",
        cursor: "pointer",
        border: selected ? "1px solid #2354d5" : hovered ? "1px solid rgba(94,133,225,0.72)" : "1px solid rgba(214,224,244,0.92)",
        background: selected
          ? "radial-gradient(circle at top right, rgba(141,180,255,0.18), transparent 34%), linear-gradient(135deg, rgba(235,243,255,0.98) 0%, rgba(255,255,255,0.98) 100%)"
          : "linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(249,251,255,0.98) 100%)",
        borderRadius: 16,
        padding: 14,
        display: "block",
        boxShadow: selected ? "0 16px 34px rgba(35,84,213,0.12)" : hovered ? "0 14px 28px rgba(31,41,55,0.08)" : "0 8px 18px rgba(31,41,55,0.04)",
        transform: hovered && !selected ? "translateY(-2px)" : "translateY(0)",
        transition: "transform 160ms ease, box-shadow 160ms ease, border-color 160ms ease, background 160ms ease",
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ fontWeight: 800, fontSize: 15 }}>{option.model}</div>
        {selected ? <CustomerChip label="Selected" tone="#2354d5" color="#fff" borderColor="rgba(35,84,213,0.18)" /> : null}
      </div>
      <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <CustomerChip label={familyLabel} tone="#f8fbff" color="#31539d" borderColor="rgba(49,83,157,0.12)" />
        {familyKey === "NGEN" && variantLabel ? <CustomerChip label={variantLabel} tone="#fff7ea" color="#9a5a00" borderColor="rgba(154,90,0,0.12)" /> : null}
        <CustomerChip label={proposalProfileKey} tone="#f7f9fd" color="#46536b" borderColor="rgba(70,83,107,0.12)" />
      </div>
      <div style={{ marginTop: 10, fontSize: 12, opacity: 0.8, lineHeight: 1.7 }}>
        Flow {option.flow} • Air {option.airRequirement ?? "—"} CFM • Storage {option.storageVolume ?? "—"} L
      </div>
      <div style={{ marginTop: 8, fontSize: 11, opacity: 0.68 }}>{selected ? "Selected model for application" : "Use this as nearest alternative"}</div>
    </button>
  );
}

export function StepBadge({ index, item, currentStepIndex, onSelect }) {
  const active = index === currentStepIndex;
  const complete = index < currentStepIndex;
  return (
    <button
      type="button"
      onClick={() => onSelect?.(index)}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        width: "100%",
        padding: "12px 14px",
        borderRadius: 16,
        border: `1px solid ${active ? "#2354d5" : "#dcdcdc"}`,
        background: active ? "#edf3ff" : complete ? "#f6faf6" : "#fff",
        color: active ? "#143f9f" : "#333",
        minWidth: 0,
        boxShadow: active ? "0 12px 30px rgba(35,84,213,0.10)" : "none",
        textAlign: "left",
      }}
    >
      <div
        style={{
          width: 26,
          height: 26,
          borderRadius: 999,
          display: "grid",
          placeItems: "center",
          background: active ? "#2354d5" : complete ? "#0b6b38" : "#e8e8e8",
          color: active || complete ? "#fff" : "#555",
          fontSize: 12,
          fontWeight: 700,
        }}
      >
        {complete ? "✓" : index + 1}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, opacity: 0.7 }}>Step {index + 1}</div>
        <div style={{ fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.label}</div>
        <div style={{ fontSize: 11, opacity: 0.68, marginTop: 2 }}>{item.hint}</div>
      </div>
    </button>
  );
}

