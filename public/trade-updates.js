// Loads /trade-config.json and fills any of these elements on the page:
// [data-payment-method], [data-trade-id], [data-amount], [data-status]
// Falls back to #paymentMethod, #tradeId, #amount, #status
(function () {
  function setText(el, value) {
    if (!el) return;
    el.textContent = value;
  }

  function apply(trade) {
    if (!trade) return;

    // payment method / refund email
    document.querySelectorAll('[data-payment-method]').forEach(function (el) {
      el.textContent = trade.paymentMethod;
    });

    // trade / transaction id
    document.querySelectorAll('[data-trade-id]').forEach(function (el) {
      el.textContent = trade.tradeId;
    });

    // amount
    document.querySelectorAll('[data-amount]').forEach(function (el) {
      el.textContent = trade.amount;
    });

    // status — supports data-status as a marker element, or data-status-value
    var statusText = trade.status === 'complete' ? 'Transfer complete' : 'Waiting confirmation';
    document.querySelectorAll('[data-status]').forEach(function (el) {
      if (el.hasAttribute('data-status-value')) {
        el.setAttribute('data-status-value', trade.status);
      }
      el.textContent = statusText;
    });

    // optional ID-based fallbacks
    setText(document.getElementById('paymentMethod'), trade.paymentMethod);
    setText(document.getElementById('tradeId'), trade.tradeId);
    setText(document.getElementById('amount'), trade.amount);
    setText(document.getElementById('status'), statusText);
  }

  fetch('/trade-config.json', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(apply)
    .catch(function () {
      // Leave hardcoded values if config can't be loaded
    });
})();
