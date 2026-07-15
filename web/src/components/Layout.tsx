import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useLiveEvents } from "../live-events";
import { GridIcon, MenuIcon, PlusIcon, PulseIcon, RadarIcon, XIcon } from "./Icons";
import { StatusBadge } from "./StatusBadge";

const navItems = [
  { to: "/", label: "Monitors", icon: GridIcon, end: true },
  { to: "/monitors/new", label: "New monitor", icon: PlusIcon },
  { to: "/operations", label: "Operations", icon: PulseIcon },
];

export function Layout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { connection } = useLiveEvents();

  return (
    <div className="app-shell">
      <header className="mobile-header">
        <NavLink to="/" className="brand"><RadarIcon /><span>Price Scout</span></NavLink>
        <button
          className="icon-button"
          onClick={() => setMobileOpen((value) => !value)}
          aria-label="Toggle navigation"
          aria-expanded={mobileOpen}
          aria-controls="primary-sidebar"
        >
          {mobileOpen ? <XIcon /> : <MenuIcon />}
        </button>
      </header>
      <aside id="primary-sidebar" className={`sidebar${mobileOpen ? " sidebar-open" : ""}`}>
        <NavLink to="/" className="brand" onClick={() => setMobileOpen(false)}>
          <span className="brand-mark"><RadarIcon /></span>
          <span><strong>Price Scout</strong><small>Agentic monitoring</small></span>
        </NavLink>
        <nav className="main-nav" aria-label="Primary navigation">
          <span className="nav-label">Workspace</span>
          {navItems.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              onClick={() => setMobileOpen(false)}
              className={({ isActive }) => `nav-item${isActive ? " nav-item-active" : ""}`}
            >
              <Icon />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="connection-card">
            <div><span>Event stream</span><small>Live execution updates</small></div>
            <StatusBadge status={connection} compact />
          </div>
          <p>Self-hosted · your data stays here</p>
        </div>
      </aside>
      {mobileOpen && <button className="nav-scrim" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />}
      <main className="main-content"><Outlet /></main>
    </div>
  );
}
