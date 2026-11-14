import type { PaymentGateway } from "../adapters/payments.js";

export const escape = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** For JSON inside a script tag. */
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

export const htmlPage = (title: string, body: string, script = "") => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${escape(title)} · Ruxstar</title>
<style>
:root{color-scheme:light dark;--bg:#f6f5fb;--card:#fff;--ink:#14121f;--ink2:#5d5a6e;--line:#e4e1ef;--accent:#6c4cf5}
@media (prefers-color-scheme:dark){:root{--bg:#0e0d14;--card:#191723;--ink:#f3f1fa;--ink2:#a7a3b8;--line:#2b2838}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:24px}
main{width:100%;max-width:420px;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:28px}
h1{font-size:20px;margin:0 0 4px}p{margin:0 0 16px;color:var(--ink2)}.total{font-size:32px;font-weight:700;margin:8px 0 20px;color:var(--ink)}
button,a.btn{display:block;width:100%;border:0;border-radius:14px;padding:14px;font:600 16px system-ui,sans-serif;text-align:center;text-decoration:none;cursor:pointer}
button{background:var(--accent);color:#fff}button:disabled{opacity:.6}a.btn{margin-top:10px;color:var(--ink2);background:transparent}
.err{color:#d6455d;min-height:24px;margin:12px 0 0;font-size:14px}.brand{font-weight:800;letter-spacing:.5px;color:var(--accent);margin-bottom:16px}
</style></head><body><main><div class="brand">RUXSTAR</div>${body}</main>${script}</body></html>`;

/**
 * The pay button: Cashfree's checkout opens at once, or a test button with the fake gateway. `check` is asked once it closes
 * and answers where to go next; `test` marks a fake payment paid.
 */
export function payPage(
  gateway: PaymentGateway,
  o: { heading: string; detail: string; amount: string; session: string; check: string; test: string; next: string },
): string {
  const fake = gateway.checkout === "fake";
  const config = { mode: gateway.checkout === "cashfree-production" ? "production" : "sandbox", fake, session: o.session, check: o.check, test: o.test, next: o.next };
  const body = `<h1>${escape(o.heading)}</h1><p>${escape(o.detail)}</p>
<div class="total">${escape(o.amount)}</div>
<button id="pay">${fake ? "Pay (test, no money moves)" : "Pay securely"}</button>
<a class="btn" href="${escape(o.next)}">Not now</a><div class="err" id="err" role="alert"></div>`;
  const script = `${fake ? "" : '<script src="https://sdk.cashfree.com/js/v3/cashfree.js"></script>'}
<script id="cfg" type="application/json">${scriptJson(config)}</script>
<script>
const cfg = JSON.parse(document.getElementById("cfg").textContent);
const btn = document.getElementById("pay"), err = document.getElementById("err");
async function done() {
  const r = await fetch(cfg.check, { method: "POST" }).catch(() => null);
  const j = r ? await r.json().catch(() => ({})) : {};
  location.replace(j.next || cfg.next);
}
async function pay() {
  btn.disabled = true; err.textContent = "";
  try {
    if (cfg.fake) { await fetch(cfg.test, { method: "POST" }); return done(); }
    const result = await Cashfree({ mode: cfg.mode }).checkout({ paymentSessionId: cfg.session, redirectTarget: "_modal" });
    if (result && result.error) { err.textContent = result.error.message || "Payment didn't go through. Try again."; btn.disabled = false; return; }
    return done();
  } catch (e) { err.textContent = "Payment didn't open. Check your connection and try again."; btn.disabled = false; }
}
btn.addEventListener("click", pay);
if (!cfg.fake) pay();
</script>`;
  return htmlPage("Payment", body, script);
}

export const NO_STORE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" };
