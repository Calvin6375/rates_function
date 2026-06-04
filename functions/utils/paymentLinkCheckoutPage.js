/**
 * @fileoverview Hosted payer page for B2B payment links (GET /b2bPortal/l/:linkId).
 * Styled to match TruePay dashboard: pearl background, teal accents, responsive layout.
 */

/**
 * Shared CSS tokens aligned with the admin dashboard.
 * @returns {string}
 */
function checkoutThemeStyles() {
  return `
    :root {
      --pearl: #ebf0f0;
      --pearl-deep: #e2eaea;
      --teal: #0d9488;
      --teal-dark: #0f766e;
      --teal-light: #ccfbf1;
      --teal-ring: rgba(13, 148, 136, 0.15);
      --text: #1a2e2e;
      --text-muted: #5a6b6b;
      --border: #d8e4e4;
      --white: #ffffff;
      --radius-lg: 16px;
      --radius-md: 12px;
      --shadow: 0 4px 24px rgba(13, 148, 136, 0.08), 0 1px 3px rgba(0, 0, 0, 0.05);
      --font: "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    }
    *, *::before, *::after { box-sizing: border-box; }
    html { -webkit-text-size-adjust: 100%; }
    body {
      margin: 0;
      min-height: 100vh;
      min-height: 100dvh;
      font-family: var(--font);
      background: var(--pearl);
      color: var(--text);
      line-height: 1.5;
    }
    .page {
      min-height: 100vh;
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right))
        max(24px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
    }
    .brand {
      width: 100%;
      max-width: 480px;
      margin: 0 auto 20px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .brand-mark {
      width: 36px;
      height: 36px;
      border-radius: 10px;
      background: linear-gradient(135deg, var(--teal), var(--teal-dark));
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--white);
      font-weight: 700;
      font-size: 1.1rem;
      flex-shrink: 0;
    }
    .brand-name {
      font-size: 1.125rem;
      font-weight: 700;
      color: var(--text);
      letter-spacing: -0.02em;
    }
    .shell {
      width: 100%;
      max-width: 480px;
      margin: 0 auto;
      flex: 1;
      display: flex;
      flex-direction: column;
      justify-content: center;
    }
    .card {
      background: var(--white);
      border-radius: var(--radius-lg);
      border: 1px solid var(--border);
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    .card-head {
      padding: clamp(20px, 5vw, 28px) clamp(20px, 5vw, 28px) 0;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 12px;
      border-radius: 999px;
      background: var(--teal-light);
      color: var(--teal-dark);
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-bottom: 12px;
    }
    .badge-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--teal);
    }
    .merchant {
      margin: 0 0 4px;
      font-size: clamp(1.25rem, 4vw, 1.5rem);
      font-weight: 700;
      letter-spacing: -0.02em;
      word-break: break-word;
    }
    .subtitle {
      margin: 0;
      color: var(--text-muted);
      font-size: 0.9375rem;
    }
    .card-body {
      padding: clamp(16px, 4vw, 24px) clamp(20px, 5vw, 28px) clamp(24px, 5vw, 28px);
    }
    .amount-block {
      padding: clamp(16px, 4vw, 20px);
      margin-bottom: 20px;
      background: var(--pearl);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      text-align: center;
    }
    .amount-label {
      font-size: 0.8125rem;
      color: var(--text-muted);
      margin-bottom: 4px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      font-weight: 600;
    }
    .amount {
      font-size: clamp(1.75rem, 7vw, 2.25rem);
      font-weight: 700;
      color: var(--text);
      letter-spacing: -0.03em;
      line-height: 1.2;
      word-break: break-word;
    }
    .status {
      display: inline-block;
      margin-top: 10px;
      padding: 4px 12px;
      border-radius: 999px;
      font-size: 0.6875rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .status.active { background: #d1fae5; color: #065f46; }
    .status.expired { background: #fee2e2; color: #991b1b; }
    .status.other { background: #fef3c7; color: #92400e; }
    .details {
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      overflow: hidden;
      background: var(--white);
    }
    .row {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      font-size: 0.9375rem;
    }
    .row:last-child { border-bottom: none; }
    .label {
      color: var(--text-muted);
      font-size: 0.8125rem;
      font-weight: 500;
    }
    .value {
      color: var(--text);
      font-weight: 500;
      word-break: break-word;
    }
    @media (min-width: 420px) {
      .row {
        flex-direction: row;
        justify-content: space-between;
        align-items: baseline;
        gap: 16px;
      }
      .value { text-align: right; flex: 1; min-width: 0; }
    }
    .btn {
      display: block;
      width: 100%;
      margin-top: 24px;
      padding: 14px 20px;
      border: none;
      border-radius: var(--radius-md);
      background: var(--teal);
      color: var(--white);
      font-family: inherit;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s ease, transform 0.1s ease;
      box-shadow: 0 2px 8px var(--teal-ring);
    }
    .btn:hover:not(:disabled) { background: var(--teal-dark); }
    .btn:active:not(:disabled) { transform: scale(0.99); }
    .btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
      box-shadow: none;
    }
    .note {
      margin: 20px 0 0;
      font-size: 0.8125rem;
      color: var(--text-muted);
      text-align: center;
    }
    .loading {
      text-align: center;
      padding: clamp(40px, 10vw, 56px) 24px;
      color: var(--text-muted);
    }
    .loading-spinner {
      width: 32px;
      height: 32px;
      margin: 0 auto 12px;
      border: 3px solid var(--border);
      border-top-color: var(--teal);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .err {
      padding: clamp(20px, 5vw, 28px);
      color: #b91c1c;
    }
    .err strong { display: block; margin-bottom: 8px; font-size: 1.05rem; }
    .err p { margin: 0; color: var(--text-muted); }
    .page-foot {
      width: 100%;
      max-width: 480px;
      margin: 24px auto 0;
      text-align: center;
      font-size: 0.75rem;
      color: var(--text-muted);
    }
  `;
}

/**
 * @param {string} title
 * @param {string} message
 * @returns {string}
 */
function renderErrorHtml(title, message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
  <title>${escapeHtml(title)} — TruePay</title>
  <style>${checkoutThemeStyles()}</style>
</head>
<body>
  <div class="page">
    <div class="brand">
      <div class="brand-mark">T</div>
      <span class="brand-name">TruePay</span>
    </div>
    <div class="shell">
      <div class="card">
        <div class="err">
          <strong>${escapeHtml(title)}</strong>
          <p>${escapeHtml(message)}</p>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

/**
 * @param {string} linkId
 * @param {string} partnerId
 * @param {string} apiBasePath - e.g. /b2bPortal
 * @returns {string}
 */
function renderCheckoutHtml(linkId, partnerId, apiBasePath) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
  <meta name="theme-color" content="#ebf0f0"/>
  <title>Pay — TruePay</title>
  <style>${checkoutThemeStyles()}</style>
</head>
<body>
  <div class="page">
    <div class="brand">
      <div class="brand-mark">T</div>
      <span class="brand-name">TruePay</span>
    </div>
    <div class="shell">
      <div class="card" id="app">
        <div class="loading">
          <div class="loading-spinner"></div>
          Loading payment details…
        </div>
      </div>
    </div>
    <p class="page-foot">Powered by TruePay</p>
  </div>
  <script>
    (function () {
      var linkId = ${JSON.stringify(linkId)};
      var partnerId = ${JSON.stringify(partnerId)};
      var apiBase = ${JSON.stringify(apiBasePath.replace(/\/+$/, ""))};
      var app = document.getElementById("app");

      fetch(apiBase + "/public/payment-links/" + encodeURIComponent(linkId) +
          "?partner=" + encodeURIComponent(partnerId))
        .then(function (res) { return res.json().then(function (body) { return { res: res, body: body }; }); })
        .then(function (_ref) {
          var res = _ref.res;
          var body = _ref.body;
          if (!res.ok || !body.success) {
            var msg = (body && body.error) || "This payment link is not available.";
            app.innerHTML = '<div class="err"><strong>Unable to load link</strong><p>' + esc(msg) + '</p></div>';
            return;
          }
          render(body.data);
        })
        .catch(function () {
          app.innerHTML = '<div class="err"><strong>Connection error</strong><p>Please try again later.</p></div>';
        });

      function esc(s) {
        var d = document.createElement("div");
        d.textContent = s == null ? "" : String(s);
        return d.innerHTML;
      }

      function render(link) {
        var statusClass = link.status === "active" ? "active" :
          link.status === "expired" ? "expired" : "other";
        var canPay = link.status === "active";
        app.innerHTML =
          '<div class="card-head">' +
            '<div class="badge"><span class="badge-dot"></span>Secure payment</div>' +
            '<h1 class="merchant">' + esc(link.partnerName || "Merchant") + '</h1>' +
            '<p class="subtitle">Complete your payment securely</p>' +
          '</div>' +
          '<div class="card-body">' +
            '<div class="amount-block">' +
              '<div class="amount-label">Amount due</div>' +
              '<div class="amount">' + esc(formatAmount(link.amount)) + ' ' + esc(link.currency) + '</div>' +
              '<span class="status ' + statusClass + '">' + esc(link.status) + '</span>' +
            '</div>' +
            '<div class="details">' +
              row("Booking ref", link.bookingReference) +
              (link.guestName ? row("Guest", link.guestName) : "") +
              (link.description ? row("Description", link.description) : "") +
              (link.expiresAt ? row("Expires", formatDate(link.expiresAt)) : "") +
            '</div>' +
            '<button type="button" class="btn" id="payBtn" ' + (canPay ? "" : "disabled") + '>' +
              (canPay ? "Continue to payment" : "Link unavailable") +
            '</button>' +
          '</div>';

        if (canPay) {
          document.getElementById("payBtn").addEventListener("click", function () {
            alert("Online checkout is coming soon. Contact " + (link.partnerName || "the merchant") + " to complete payment.");
          });
        }
      }

      function row(label, value) {
        return '<div class="row"><span class="label">' + esc(label) + '</span>' +
          '<span class="value">' + esc(value) + '</span></div>';
      }

      function formatAmount(n) {
        var x = Number(n);
        return isFinite(x) ? x.toFixed(2) : "0.00";
      }

      function formatDate(iso) {
        try {
          return new Date(iso).toLocaleString(undefined, {
            dateStyle: "medium",
            timeStyle: "short"
          });
        } catch (e) {
          return iso;
        }
      }
    })();
  </script>
</body>
</html>`;
}

/**
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
  return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
}

module.exports = {
  renderCheckoutHtml,
  renderErrorHtml,
  checkoutThemeStyles,
};
