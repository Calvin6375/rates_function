/**
 * @fileoverview Hosted HTML page after Paystack redirect (external browser / in-app browser).
 * Deep-links back to the Flutter app — no WebView required.
 */

/**
 * @param {Object} params
 * @param {string|null} params.reference
 * @param {string} params.deepLink
 * @param {string} params.statusUrl
 * @returns {string}
 */
function renderFundingPaymentReturnHtml(params) {
  const { reference, deepLink, statusUrl } = params;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
  <meta name="theme-color" content="#0f172a"/>
  <title>Payment — TruePay</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: linear-gradient(160deg, #0f172a 0%, #1e293b 100%);
      color: #f8fafc;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: #fff;
      color: #0f172a;
      border-radius: 16px;
      padding: 32px 28px;
      max-width: 420px;
      width: 100%;
      text-align: center;
      box-shadow: 0 20px 50px rgba(0,0,0,.35);
    }
    .logo {
      width: 48px;
      height: 48px;
      border-radius: 12px;
      background: #0ea5e9;
      color: #fff;
      font-weight: 700;
      font-size: 22px;
      line-height: 48px;
      margin: 0 auto 16px;
    }
    h1 { font-size: 22px; margin: 0 0 8px; }
    p { margin: 0 0 20px; color: #475569; line-height: 1.5; }
    .spinner {
      width: 36px;
      height: 36px;
      border: 3px solid #e2e8f0;
      border-top-color: #0ea5e9;
      border-radius: 50%;
      animation: spin .8s linear infinite;
      margin: 0 auto 16px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .btn {
      display: inline-block;
      background: #0ea5e9;
      color: #fff;
      text-decoration: none;
      padding: 14px 24px;
      border-radius: 10px;
      font-weight: 600;
      font-size: 16px;
    }
    .ref { font-size: 12px; color: #94a3b8; word-break: break-all; margin-top: 16px; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">T</div>
    <div id="pending">
      <div class="spinner"></div>
      <h1>Confirming payment</h1>
      <p>Your wallet will update shortly. Returning you to TruePay…</p>
    </div>
    <div id="done" class="hidden">
      <h1 id="done-title">Payment received</h1>
      <p id="done-msg">Tap below if TruePay did not open automatically.</p>
      <a class="btn" id="open-app" href="#">Open TruePay</a>
    </div>
    <p class="ref" id="ref-line"></p>
  </div>
  <script>
    (function () {
      var reference = ${JSON.stringify(reference || "")};
      var deepLink = ${JSON.stringify(deepLink)};
      var statusUrl = ${JSON.stringify(statusUrl)};
      var storageKey = reference ? "truepay_return_" + reference : "truepay_return_opened";
      var pending = document.getElementById("pending");
      var done = document.getElementById("done");
      var openApp = document.getElementById("open-app");
      var refLine = document.getElementById("ref-line");
      var pollTimer = null;

      if (reference) {
        refLine.textContent = "Reference: " + reference;
      }

      openApp.href = deepLink;

      function alreadyAttemptedDeepLink() {
        try {
          return sessionStorage.getItem(storageKey) === "1";
        } catch (e) {
          return false;
        }
      }

      function markDeepLinkAttempted() {
        try {
          sessionStorage.setItem(storageKey, "1");
        } catch (e) {
          /* private mode / blocked storage */
        }
      }

      function showDone(title, msg) {
        pending.classList.add("hidden");
        done.classList.remove("hidden");
        document.getElementById("done-title").textContent = title;
        document.getElementById("done-msg").textContent = msg;
      }

      /** Auto deep-link at most once per reference per browser tab session. */
      function tryOpenAppOnce() {
        if (alreadyAttemptedDeepLink()) {
          return false;
        }
        markDeepLinkAttempted();
        window.location.href = deepLink;
        return true;
      }

      function finishStatus(title, msg) {
        if (pollTimer) {
          clearTimeout(pollTimer);
          pollTimer = null;
        }
        showDone(title, msg);
      }

      function pollStatus(attempt) {
        if (!reference || !statusUrl || attempt > 12) {
          finishStatus(
            "Payment submitted",
            "Tap below if TruePay did not open automatically."
          );
          return;
        }
        fetch(statusUrl + "?reference=" + encodeURIComponent(reference))
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data.status === "completed") {
              finishStatus(
                "Payment successful",
                "Tap below if TruePay did not open automatically."
              );
            } else if (data.status === "failed") {
              finishStatus(
                "Payment failed",
                "Tap below to return to TruePay and try again."
              );
            } else {
              pollTimer = setTimeout(function () { pollStatus(attempt + 1); }, 2000);
            }
          })
          .catch(function () {
            pollTimer = setTimeout(function () { pollStatus(attempt + 1); }, 2000);
          });
      }

      if (alreadyAttemptedDeepLink()) {
        showDone(
          "Returning to TruePay",
          "Tap below to open the app."
        );
        pollStatus(0);
      } else {
        tryOpenAppOnce();
        pollTimer = setTimeout(function () { pollStatus(0); }, 1500);
      }
    })();
  </script>
</body>
</html>`;
}

module.exports = {
  renderFundingPaymentReturnHtml,
};
