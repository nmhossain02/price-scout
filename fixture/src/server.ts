import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

export interface FixtureState {
  version: 1 | 2;
  basePriceMinor: number;
  inStock: boolean;
  deployment: number;
}

export interface FixtureOptions {
  controlToken?: string;
}

const initialState = (): FixtureState => ({
  version: 1,
  basePriceMinor: 109_900,
  inStock: true,
  deployment: 1,
});

export function createFixtureServer(options: FixtureOptions = {}) {
  let state = initialState();
  const controlToken = options.controlToken ?? process.env.FIXTURE_CONTROL_TOKEN ?? "development-fixture-token";

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      setHeaders(response);

      if (request.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/readyz")) {
        return json(response, 200, { status: "ok", version: state.version, deployment: state.deployment });
      }
      if (request.method === "GET" && url.pathname === "/__control/state") {
        return json(response, 200, state);
      }
      if (request.method === "GET" && url.pathname === "/") {
        return html(response, 200, landingPage(state));
      }
      if (request.method === "GET" && url.pathname === "/products/atlas-headphones") {
        return html(response, 200, productPage(state));
      }
      if (request.method === "POST" && url.pathname.startsWith("/__control/")) {
        if (request.headers["x-fixture-token"] !== controlToken) {
          return json(response, 401, { error: "invalid fixture control token" });
        }
        const body = await readJson(request);
        if (url.pathname === "/__control/deploy") {
          if (state.version !== 2) state = { ...state, version: 2, deployment: state.deployment + 1 };
          return json(response, 200, state);
        }
        if (url.pathname === "/__control/reset") {
          state = initialState();
          return json(response, 200, state);
        }
        if (url.pathname === "/__control/price") {
          const value = Number(body.priceMinor);
          if (!Number.isSafeInteger(value) || value <= 0 || value > 100_000_000) {
            return json(response, 400, { error: "priceMinor must be a positive integer" });
          }
          state = { ...state, basePriceMinor: value };
          return json(response, 200, state);
        }
        if (url.pathname === "/__control/stock") {
          if (typeof body.inStock !== "boolean") return json(response, 400, { error: "inStock must be boolean" });
          state = { ...state, inStock: body.inStock };
          return json(response, 200, state);
        }
      }
      return json(response, 404, { error: "not found" });
    } catch (error) {
      return json(response, 500, { error: error instanceof Error ? error.message : "internal error" });
    }
  });
}

function productPage(state: FixtureState): string {
  const price = money(state.basePriceMinor);
  const structuredData = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Product",
    name: "Atlas Studio Headphones",
    sku: "ASH-100",
    brand: { "@type": "Brand", name: "Price Scout Fixture Store" },
    offers: {
      "@type": "Offer",
      price: (state.basePriceMinor / 100).toFixed(2),
      priceCurrency: "USD",
      availability: state.inStock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
    },
  }).replace(/</g, "\\u003c");
  const controls = state.version === 1 ? v1Controls(state) : v2Controls(state);
  return pageShell(
    `Atlas Studio Headphones · Price Scout Fixture Store`,
    `<header class="site-header">
      <a class="brand" href="/">PRICE SCOUT<span>fixture</span></a>
      <nav aria-label="Main navigation"><a href="#details">Details</a><a href="#support">Support</a><button class="bag">Bag · 0</button></nav>
    </header>
    <main class="product-layout">
      <section class="product-visual" aria-label="Product gallery">
        <div class="visual-glow"></div><div class="headphones" aria-hidden="true"><div class="band"></div><div class="cup left"></div><div class="cup right"></div></div>
        <span class="gallery-label">Studio reference · Wireless</span>
      </section>
      <section class="product-copy">
        <p class="eyebrow">Synthetic fixture · ASH-100</p>
        ${state.version === 1 ? `<h1 id="product-title">Atlas Studio Headphones</h1><span id="product-sku" class="sr-only">ASH-100</span>` : `<div class="title-cluster"><h1 data-ui="product-name">Atlas Studio Headphones</h1><span data-ui="product-sku" class="sr-only">ASH-100</span></div>`}
        <p class="lede">Precision planar sound, adaptive isolation, and 60 hours of listening—built for work that deserves your full attention.</p>
        <div class="rating"><span aria-label="4.8 out of 5 stars">4.8 / 5</span> <a href="#reviews">218 reviews</a></div>
        ${controls}
        <div class="purchase-row">
          ${state.version === 1 ? `<div><span id="current-price" class="price">${price}</span><span id="price-currency" class="currency">USD</span></div><p id="stock-status" class="stock ${state.inStock ? "yes" : "no"}">${state.inStock ? "In stock — ships tomorrow" : "Out of stock"}</p>` : `<div class="price-stack"><span data-ui="offer-price" class="price">${price}</span><span data-ui="price-currency" class="currency">USD</span></div><div data-component="inventory-pill"><p data-ui="inventory-status" class="stock ${state.inStock ? "yes" : "no"}">${state.inStock ? "In stock — ships tomorrow" : "Out of stock"}</p></div>`}
        </div>
        <button class="primary" ${state.inStock ? "" : "disabled"}>Add to bag</button>
        <div class="assurances"><span>30-day returns</span><span>2-year warranty</span><span>Carbon-neutral delivery</span></div>
      </section>
    </main>
    <section id="details" class="details"><p class="eyebrow">Designed around the way you listen</p><h2>Every detail, without distraction.</h2><div class="feature-grid"><article><b>60h</b><span>battery life</span></article><article><b>24-bit</b><span>lossless wireless</span></article><article><b>252g</b><span>all-day comfort</span></article></div></section>
    <aside class="deploy-badge" title="Synthetic test fixture">Fixture UI · v${state.version} · deploy ${state.deployment}</aside>
    <script type="application/ld+json">${structuredData}</script>
    <script>${clientScript(state)}</script>`,
  );
}

function v1Controls(_state: FixtureState): string {
  return `<div class="legacy-configurator" aria-label="Product options">
    <div class="legacy-heading">Finish <strong id="selected-color">black</strong></div>
    <div class="legacy-buttons" data-legacy-group="color"><button type="button" id="legacy-color-black" data-legacy-value="black" aria-pressed="true">Midnight black</button><button type="button" id="legacy-color-silver" data-legacy-value="silver" aria-pressed="false">Arctic silver</button></div>
    <div class="legacy-heading">Storage <strong id="selected-capacity">1tb</strong></div>
    <div class="legacy-buttons" data-legacy-group="capacity"><button type="button" id="legacy-capacity-1tb" data-legacy-value="1tb" aria-pressed="true">1 TB</button><button type="button" id="legacy-capacity-2tb" data-legacy-value="2tb" aria-pressed="false">2 TB</button></div>
  </div>`;
}

function v2Controls(_state: FixtureState): string {
  return `<div data-component="option-picker" class="option-picker" aria-label="Product options">
    <fieldset data-variant-group="color"><legend>Finish <strong data-selected-variant="color">black</strong></legend><div class="choice-row"><button type="button" data-value="black" aria-pressed="true"><i class="swatch black"></i>Midnight black</button><button type="button" data-value="silver" aria-pressed="false"><i class="swatch silver"></i>Arctic silver</button></div></fieldset>
    <fieldset data-variant-group="capacity"><legend>Storage <strong data-selected-variant="capacity">1tb</strong></legend><div class="choice-row"><button type="button" data-value="1tb" aria-pressed="true">1 TB</button><button type="button" data-value="2tb" aria-pressed="false">2 TB</button></div></fieldset>
  </div>`;
}

function clientScript(state: FixtureState): string {
  return `(() => {
    const base = ${state.basePriceMinor};
    const selected = { color: 'black', capacity: '1tb' };
    const priceNode = document.querySelector(${JSON.stringify(state.version === 1 ? "#current-price" : "[data-ui='offer-price']")});
    const format = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value / 100);
    const render = () => {
      const total = base + (selected.color === 'silver' ? 2000 : 0) + (selected.capacity === '2tb' ? 15000 : 0);
      if (priceNode) priceNode.textContent = format(total);
      for (const [key, value] of Object.entries(selected)) {
        const label = document.querySelector('[data-selected-variant="' + key + '"]');
        if (label) label.textContent = value;
        document.querySelectorAll('[data-variant-group="' + key + '"] [data-value]').forEach(node => node.setAttribute('aria-pressed', String(node.dataset.value === value)));
      }
    };
    document.querySelectorAll('[data-legacy-group] [data-legacy-value]').forEach(node => node.addEventListener('click', () => {
      const key = node.closest('[data-legacy-group]').dataset.legacyGroup;
      selected[key] = node.dataset.legacyValue;
      document.getElementById('selected-' + key).textContent = selected[key];
      document.querySelectorAll('[data-legacy-group="' + key + '"] [data-legacy-value]').forEach(item => item.setAttribute('aria-pressed', String(item.dataset.legacyValue === selected[key])));
      render();
    }));
    document.querySelectorAll('[data-variant-group] [data-value]').forEach(node => node.addEventListener('click', () => { selected[node.closest('[data-variant-group]').dataset.variantGroup] = node.dataset.value; render(); }));
    render();
  })();`;
}

function landingPage(state: FixtureState): string {
  return pageShell("Price Scout Fixture Control", `<main class="landing"><p class="eyebrow">Price Scout deterministic retailer</p><h1>Synthetic fixture store</h1><p>The stable product URL is backed by controllable state and two structurally different frontend deployments.</p><a class="primary link" href="/products/atlas-headphones">Open Atlas product page</a><pre>Version: v${state.version}\nDeployment: ${state.deployment}\nBase price: ${money(state.basePriceMinor)}\nStock: ${state.inStock ? "in stock" : "out of stock"}</pre></main>`);
}

function pageShell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${styles}</style></head><body>${body}</body></html>`;
}

const styles = `
  .legacy-heading{display:flex;justify-content:space-between;font-weight:700;margin:10px 0 7px}.legacy-heading strong{color:var(--muted);font-weight:500}.legacy-buttons{display:flex;gap:8px;margin-bottom:15px}.legacy-buttons button{font:inherit;padding:11px 15px;border:1px solid #aaa;background:white;border-radius:4px}.legacy-buttons button[aria-pressed=true]{outline:2px solid var(--ink);outline-offset:-2px}
  :root{color-scheme:light;--ink:#151515;--muted:#686864;--paper:#f5f3ed;--accent:#ee5a35;--line:#d9d6cd}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.site-header{height:76px;padding:0 4vw;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line)}.brand{font-weight:900;letter-spacing:.12em;text-decoration:none;color:var(--ink)}.brand span{font-weight:400;letter-spacing:0;margin-left:4px}.site-header nav{display:flex;gap:26px;align-items:center}.site-header nav a{color:var(--muted);text-decoration:none}.bag{border:1px solid var(--ink);padding:9px 16px;border-radius:99px;background:transparent}.product-layout{display:grid;grid-template-columns:1.08fr .92fr;min-height:720px}.product-visual{position:relative;overflow:hidden;background:#dad9d3;display:grid;place-items:center}.visual-glow{position:absolute;width:65%;aspect-ratio:1;border-radius:50%;background:#ffb59f;filter:blur(55px);opacity:.55}.headphones{position:relative;width:330px;height:390px}.band{position:absolute;left:58px;top:20px;width:215px;height:300px;border:32px solid #242424;border-bottom:0;border-radius:150px 150px 0 0}.cup{position:absolute;top:245px;width:112px;height:150px;border-radius:45px;background:linear-gradient(145deg,#343434,#0c0c0c);box-shadow:0 20px 40px #0004}.cup.left{left:8px}.cup.right{right:8px}.gallery-label{position:absolute;left:28px;bottom:24px;color:#555}.product-copy{padding:72px 7vw 50px}.eyebrow{text-transform:uppercase;letter-spacing:.13em;font-size:12px;font-weight:800;color:var(--accent)}h1{font-family:Georgia,serif;font-size:clamp(40px,4.4vw,68px);line-height:1.02;margin:14px 0 20px;letter-spacing:-.04em}.lede{font-size:18px;max-width:600px;color:#4c4c47}.rating{margin:18px 0 32px}.rating span{color:#e55230;letter-spacing:2px}.rating a{color:var(--muted);margin-left:8px}.legacy-configurator,.option-picker{padding:24px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.legacy-configurator{display:grid;grid-template-columns:100px 1fr;gap:14px;align-items:center}.legacy-configurator label,legend{font-weight:700}.legacy-configurator select{font:inherit;padding:12px;border:1px solid #aaa;background:white;border-radius:4px}.option-picker fieldset{border:0;padding:0;margin:0 0 18px}.option-picker legend{width:100%;display:flex;justify-content:space-between;margin-bottom:9px}.option-picker legend strong{color:var(--muted);font-weight:500}.choice-row{display:flex;gap:8px}.choice-row button{background:white;border:1px solid #aaa;border-radius:8px;padding:11px 15px;font:inherit}.choice-row button[aria-pressed=true]{border:2px solid var(--ink);padding:10px 14px}.swatch{display:inline-block;width:13px;height:13px;border-radius:50%;margin-right:7px;vertical-align:-1px}.swatch.black{background:#202020}.swatch.silver{background:#d3d3cf;border:1px solid #aaa}.purchase-row{display:flex;justify-content:space-between;align-items:end;margin:28px 0 16px}.price{font-family:Georgia,serif;font-size:34px}.currency{font-size:12px;margin-left:6px;color:var(--muted)}.stock{margin:0;font-weight:700}.stock.yes{color:#287344}.stock.no{color:#a02e22}.primary{width:100%;border:0;background:var(--ink);color:white;border-radius:3px;padding:17px;font:700 15px inherit}.primary:disabled{opacity:.45}.primary.link{display:inline-block;width:auto;text-decoration:none;padding:14px 22px}.assurances{display:flex;flex-wrap:wrap;gap:14px;margin-top:19px;font-size:12px;color:var(--muted)}.details{text-align:center;padding:90px 5vw;background:#181818;color:white}.details h2{font:44px Georgia,serif;margin:10px}.feature-grid{display:flex;justify-content:center;gap:80px;margin-top:50px}.feature-grid article{display:flex;flex-direction:column}.feature-grid b{font:42px Georgia,serif}.feature-grid span{color:#aaa}.deploy-badge{position:fixed;right:14px;bottom:14px;padding:8px 11px;border-radius:5px;background:#151515;color:white;font:11px ui-monospace,monospace;opacity:.8}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}.landing{max-width:760px;margin:12vh auto;padding:50px}.landing pre{margin-top:32px;background:#20201e;color:#eee;padding:22px;border-radius:7px}@media(max-width:850px){.product-layout{grid-template-columns:1fr}.product-visual{min-height:480px}.site-header nav a{display:none}.product-copy{padding:48px 7vw}.feature-grid{gap:25px}}
`;

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 16_384) throw new Error("request body too large");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required");
  return value as Record<string, unknown>;
}

function setHeaders(response: ServerResponse): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'");
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function html(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  response.end(body);
}

function money(minor: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(minor / 100);
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const port = Number(process.env.PORT ?? 4173);
  createFixtureServer().listen(port, "0.0.0.0", () => {
    console.log(JSON.stringify({ level: "info", service: "fixture", port }));
  });
}
