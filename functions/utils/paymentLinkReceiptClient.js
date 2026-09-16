/**
 * @fileoverview Client JS for downloading a PNG payment-link receipt.
 * Layout matches the TruePay transaction receipt card (watermark + labeled rows).
 */

/**
 * @param {string} watermarkUrl
 * @returns {string}
 */
function receiptClientJs(watermarkUrl) {
  return `
      var receiptWatermarkUrl = ${JSON.stringify(watermarkUrl)};

      function receiptPaidAt(link) {
        return link.paidAt || link.lastPaidAt || link.completedAt || null;
      }

      function receiptPayerName(link) {
        return link.payerName || link.lastPayerName || "";
      }

      function formatReceiptDate(iso) {
        var d = iso ? new Date(iso) : new Date();
        if (isNaN(d.getTime())) {
          return String(iso || "");
        }
        var y = d.getFullYear();
        var m = String(d.getMonth() + 1).padStart(2, "0");
        var day = String(d.getDate()).padStart(2, "0");
        var hh = String(d.getHours()).padStart(2, "0");
        var mm = String(d.getMinutes()).padStart(2, "0");
        return y + "-" + m + "-" + day + " · " + hh + ":" + mm;
      }

      function receiptRows(link) {
        var currency = String(link.currency || "KES").toUpperCase();
        var reference = link.transactionId || link.invoiceId || link.checkoutId ||
          link.bookingReference || link.linkId || "";
        return [
          ["Reference", reference],
          ["Type", "product payment"],
          ["Direction", "Debit (outgoing)"],
          ["Date & time", formatReceiptDate(receiptPaidAt(link))],
          ["Status", "Completed"],
          ["Currency", currency],
          ["Product ref", link.bookingReference || "—"],
          ["Product", link.description || "—"],
          ["Paid by", receiptPayerName(link) || "—"],
          ["Merchant name", link.partnerName || "Merchant"]
        ].filter(function (row) {
          return row[1] != null && String(row[1]).trim() !== "";
        });
      }

      function loadReceiptImage(src) {
        return new Promise(function (resolve, reject) {
          var img = new Image();
          img.onload = function () { resolve(img); };
          img.onerror = function () { reject(new Error("watermark")); };
          img.src = src;
        });
      }

      function roundRectPath(ctx, x, y, w, h, r) {
        var radius = Math.min(r, w / 2, h / 2);
        ctx.beginPath();
        ctx.moveTo(x + radius, y);
        ctx.arcTo(x + w, y, x + w, y + h, radius);
        ctx.arcTo(x + w, y + h, x, y + h, radius);
        ctx.arcTo(x, y + h, x, y, radius);
        ctx.arcTo(x, y, x + w, y, radius);
        ctx.closePath();
      }

      function wrapReceiptValue(ctx, text, maxWidth) {
        var words = String(text || "").split(/\\s+/);
        var lines = [];
        var current = "";
        for (var i = 0; i < words.length; i++) {
          var trial = current ? current + " " + words[i] : words[i];
          if (ctx.measureText(trial).width <= maxWidth) {
            current = trial;
          } else {
            if (current) {
              lines.push(current);
            }
            current = words[i];
          }
        }
        if (current) {
          lines.push(current);
        }
        return lines.length ? lines : [""];
      }

      function drawReceiptCanvas(link, watermark) {
        var width = 1080;
        var padX = 72;
        var padTop = 80;
        var rows = receiptRows(link);
        var currency = String(link.currency || "KES").toUpperCase();
        var amountText = "-" + currency + " " + formatAmount(link.amount);
        var measure = document.createElement("canvas").getContext("2d");
        measure.font = "600 30px Inter, system-ui, sans-serif";
        var valueMax = 520;
        var rowHeights = rows.map(function (row) {
          var lines = wrapReceiptValue(measure, row[1], valueMax);
          return Math.max(76, 28 + lines.length * 36);
        });
        var rowsH = 0;
        for (var h = 0; h < rowHeights.length; h++) {
          rowsH += rowHeights[h];
        }
        var height = padTop + 168 + rowsH + 80;
        var dpr = 2;
        var canvas = document.createElement("canvas");
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        var ctx = canvas.getContext("2d");
        ctx.scale(dpr, dpr);

        ctx.fillStyle = "#f4f6f8";
        ctx.fillRect(0, 0, width, height);
        roundRectPath(ctx, 24, 24, width - 48, height - 48, 36);
        ctx.fillStyle = "#ffffff";
        ctx.fill();

        if (watermark) {
          ctx.save();
          ctx.globalAlpha = 0.09;
          var wmW = 560;
          var wmH = wmW * (watermark.height / Math.max(watermark.width, 1));
          ctx.drawImage(watermark, (width - wmW) / 2, (height - wmH) / 2 - 20, wmW, wmH);
          ctx.restore();
        }

        ctx.fillStyle = "#8b95a1";
        ctx.font = "500 28px Inter, system-ui, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
        ctx.fillText("Total amount", padX, padTop + 28);

        ctx.fillStyle = "#111827";
        ctx.font = "700 64px Inter, system-ui, sans-serif";
        ctx.fillText(amountText, padX, padTop + 108);

        var y = padTop + 188;
        for (var i = 0; i < rows.length; i++) {
          var label = rows[i][0];
          var value = String(rows[i][1]);
          ctx.font = "500 28px Inter, system-ui, sans-serif";
          ctx.fillStyle = "#8b95a1";
          ctx.textAlign = "left";
          ctx.fillText(label, padX, y);
          ctx.fillStyle = "#111827";
          ctx.font = "600 30px Inter, system-ui, sans-serif";
          ctx.textAlign = "right";
          var lines = wrapReceiptValue(ctx, value, valueMax);
          for (var li = 0; li < lines.length; li++) {
            ctx.fillText(lines[li], width - padX, y + li * 36);
          }
          y += rowHeights[i];
        }
        return canvas;
      }

      function downloadReceiptPng(link) {
        if (typeof paidRedirectTimer !== "undefined" && paidRedirectTimer) {
          window.clearInterval(paidRedirectTimer);
          var secsEl = document.getElementById("redirectSecs");
          var note = document.getElementById("redirectNote");
          if (secsEl) {
            secsEl.textContent = "paused";
          }
          if (note) {
            note.innerHTML = 'Receipt ready. <a class="note-link" href="#" id="redirectNow">Continue</a>';
            var cont = document.getElementById("redirectNow");
            if (cont) {
              cont.addEventListener("click", function (ev) {
                ev.preventDefault();
                window.location.replace(resolvePaidRedirectUrl(link));
              });
            }
          }
        }
        var btn = document.getElementById("downloadReceiptBtn");
        if (btn) {
          btn.disabled = true;
          btn.textContent = "Preparing receipt…";
        }
        return loadReceiptImage(receiptWatermarkUrl)
          .catch(function () { return null; })
          .then(function (watermark) {
            var canvas = drawReceiptCanvas(link, watermark);
            return new Promise(function (resolve, reject) {
              canvas.toBlob(function (blob) {
                if (!blob) {
                  reject(new Error("Could not create receipt image"));
                  return;
                }
                var url = URL.createObjectURL(blob);
                var a = document.createElement("a");
                var ref = link.bookingReference || link.checkoutId || link.linkId || "payment";
                a.href = url;
                a.download = "truepay-receipt-" + String(ref).replace(/[^a-zA-Z0-9_-]+/g, "-") + ".png";
                document.body.appendChild(a);
                a.click();
                a.remove();
                window.setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
                resolve();
              }, "image/png");
            });
          })
          .then(function () {
            if (btn) {
              btn.disabled = false;
              btn.textContent = "Download receipt";
            }
          })
          .catch(function () {
            if (btn) {
              btn.disabled = false;
              btn.textContent = "Download receipt";
            }
          });
      }

      function bindPaidReceipt(link) {
        var btn = document.getElementById("downloadReceiptBtn");
        if (!btn) {
          return;
        }
        btn.addEventListener("click", function (ev) {
          ev.preventDefault();
          downloadReceiptPng(link);
        });
      }

      function paidReceiptButtonHtml() {
        return '<button type="button" class="btn" id="downloadReceiptBtn">Download receipt</button>';
      }
`;
}

module.exports = {
  receiptClientJs,
};
