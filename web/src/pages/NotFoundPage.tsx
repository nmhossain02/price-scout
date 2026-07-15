import { Link } from "react-router-dom";
import { RadarIcon } from "../components/Icons";

export function NotFoundPage() {
  return <div className="page-state not-found"><RadarIcon /><span>404</span><h1>Signal not found</h1><p>This page isn’t on Price Scout’s radar.</p><Link to="/" className="button button-primary">Return to monitors</Link></div>;
}
