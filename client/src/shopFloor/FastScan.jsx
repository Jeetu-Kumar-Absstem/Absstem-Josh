import { useState } from "react";

export default function FastScan({ onScan, placeholder = "Scan Bin or Component Barcode..." }) {
  const [value, setValue] = useState("");

  function handleSubmit(e) {
    e.preventDefault();
    if (!value.trim()) return;
    onScan(value.trim());
    setValue("");
  }

  return (
    <form className="sf-scan-strip" onSubmit={handleSubmit}>
      <span style={{ fontSize: 16 }}>🔍</span>
      <input
        className="sf-scan-input"
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        autoFocus
      />
      <button className="sf-btn small" type="submit">
        Scan / Enter
      </button>
    </form>
  );
}
