import { useEffect, useState } from "react";
import { getVendorToken, setVendorToken } from "./api";
import VendorDashboard from "./VendorDashboard";
import VendorLogin from "./VendorLogin";
import VendorOnboarding from "./VendorOnboarding";
import VendorRegistration from "./VendorRegistration";
import GuestRfqView from "./GuestRfqView";
import RfqQuoteDesk from "./RfqQuoteDesk";
import "./vendorPortal.css";

function routeFor(pathname) {
  const parts = pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts[1] === "guest") return { screen: "guest", token: parts.slice(2).join("/") };
  if (parts[1] === "register") return { screen: "register", token: parts.slice(2).join("/") };
  if (parts[1] === "internal") return { screen: "internal" };
  return { screen: "registered" };
}

export default function VendorPortalApp() {
  const [route, setRoute] = useState(() => routeFor(window.location.pathname));
  const [authScreen, setAuthScreen] = useState(() => (getVendorToken() ? "dashboard" : "login"));

  useEffect(() => {
    function onPopState() {
      const next = routeFor(window.location.pathname);
      setRoute(next);
      if (next.screen === "registered") setAuthScreen(getVendorToken() ? "dashboard" : "login");
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  function go(path, screen) {
    window.history.pushState({}, "", path);
    setRoute(routeFor(path));
    if (screen) setAuthScreen(screen);
  }

  function signOut() {
    setVendorToken("");
    go("/vendor-portal", "login");
  }

  if (route.screen === "guest") return <GuestRfqView token={route.token} onBack={() => go("/vendor-portal", getVendorToken() ? "dashboard" : "login")} />;
  if (route.screen === "register") return <VendorRegistration token={route.token} onBack={() => go("/vendor-portal", "login")} />;
  if (route.screen === "internal") return <RfqQuoteDesk onBack={() => go("/vendor-portal", getVendorToken() ? "dashboard" : "login")} />;
  if (authScreen === "onboarding") return <VendorOnboarding onBack={() => setAuthScreen("login")} />;
  if (authScreen === "dashboard") return <VendorDashboard onLogout={signOut} />;
  return <VendorLogin onAuthenticated={() => { go("/vendor-portal", "dashboard"); }} onOnboarding={() => setAuthScreen("onboarding")} />;
}
