import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

const root = document.getElementById("root");
const path = typeof window !== "undefined" ? window.location.pathname.replace(/\/+$/, "") || "/" : "/";

if (path === "/sandbox") {
  import("./sandbox/IndustrialAnimations.jsx").then((mod) => {
    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        <mod.default />
      </React.StrictMode>
    );
  });
} else {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

