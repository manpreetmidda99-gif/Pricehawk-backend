// Price-drop emails via the Resend HTTP API.
// https://resend.com/docs/api-reference/emails/send-email
// If RESEND_API_KEY is not set, emails are logged to the console
// instead of sent (dev mode) so nothing breaks without a key.
import { config } from "../config.js";

export interface PriceDropEmail {
  to: string;
  query: string;
  currentPrice: number;
  currentCurrency: string;
  previousPrice: number | null;
  targetPrice: number;
  targetCurrency: string;
  retailer: string;
}

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function renderHtml(e: PriceDropEmail): string {
  const site = "https://pricehawk-api.onrender.com";
  const drop = e.previousPrice !== null && e.previousPrice > e.currentPrice
    ? `<p style="margin:0 0 12px">Previously spotted at <strong>${money(e.previousPrice, e.currentCurrency)}</strong>.</p>`
    : "";
  return `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
<h2 style="margin:0 0 8px">🦅 Price drop alert</h2>
<p style="margin:0 0 12px"><strong>${escapeHtml(e.query)}</strong> is now <strong>${money(e.currentPrice, e.currentCurrency)}</strong> at ${escapeHtml(e.retailer)} — at or below your target of ${money(e.targetPrice, e.targetCurrency)}.</p>
${drop}
<a href="${site}" style="display:inline-block;background:#111;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600">Open PriceHawk</a>
<p style="margin:16px 0 0;font-size:12px;color:#666">You're receiving this because you set a price alert on PriceHawk.</p>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
  );
}

export async function sendPriceDropEmail(e: PriceDropEmail): Promise<void> {
  const subject = `Price drop: ${e.query} now ${money(e.currentPrice, e.currentCurrency)}`;

  if (!config.resendApiKey) {
    console.log(`[email:dev-mode] to=${e.to} subject=${subject}`);
    console.log(renderHtml(e));
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: config.emailFrom,
      to: e.to,
      subject,
      html: renderHtml(e),
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Resend API error ${res.status}: ${text.slice(0, 200)}`);
  }
  console.log(`[email] price-drop alert sent to ${e.to} for "${e.query}"`);
}
