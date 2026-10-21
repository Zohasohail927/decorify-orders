/* Decorify Orders: money and Insights calculation layer (v6).
 * Pure functions, read-only. Used by the app (Home, Orders, Insights, Customers) and by the tests in tests/.
 *
 * DEFINITIONS
 *  - Order total (net sales) = sale_price. A cancelled order's sales and cost count as 0. Money kept on a
 *    cancelled order (cancel_kept) is that order's only charge, and shows in the P&L on cancelled_on.
 *  - Direct cost = cost recorded on the order (materials + the order's delivery cost, delivery_cost). A blank cost (null) means "not entered yet" and is never treated as 0.
 *    0 means the cost was entered as zero. An order made of pieces has a cost only when EVERY piece has one.
 *  - Order profit = net sales - direct cost, before business expenses. Shown only when all costs in the group are entered;
 *    otherwise the figure for the orders that do have costs is shown separately, with its own count.
 *  - Reporting basis:
 *      booked    = orders not cancelled, grouped by order date (order_date; else local date of created_at).
 *      delivered = delivered orders, grouped by the actual delivery date (delivered_on). Orders without one are left out and counted.
 *  - Payments come from the payments ledger (voided entries ignored). Received = payments - refunds.
 *    Balance = order total - received. Negative balance = customer credit. Delivery never marks an order paid.
 *  - Customer = the linked customer record; for orders without one, the normalised phone number. Never merged by name.
 *  - Management P&L = delivered sales - matched direct costs = order profit - recorded operating expenses.
 *    Stock purchases and owner drawings are listed separately and are not expenses.
 * All money is summed in paisa (integers) to avoid floating-point drift.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DSInsights = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  function toP(v) { var n = +v; return isFinite(n) ? Math.round(n * 100) : 0; }      // rupees -> paisa
  function fromP(p) { return p / 100; }                                                // paisa -> rupees
  function blank(v) { return v === null || v === undefined || v === '' || (typeof v === 'number' && !isFinite(v)); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseDay(s) { var a = String(s).split('-'); return new Date(+a[0], +a[1] - 1, +a[2]); }
  function addDays(day, n) { var d = parseDay(day); d.setDate(d.getDate() + n); return ymd(d); }
  function monthKey(day) { return day.slice(0, 7); }
  function monthStart(key) { return key + '-01'; }
  function monthEnd(key) { var a = key.split('-'); return ymd(new Date(+a[0], +a[1], 0)); }
  function addMonths(key, n) { var a = key.split('-'); var d = new Date(+a[0], +a[1] - 1 + n, 1); return d.getFullYear() + '-' + pad(d.getMonth() + 1); }
  function monthLabel(key) { var a = key.split('-'); return MONTHS[+a[1] - 1] + ' ' + a[0]; }
  function monthShort(key) { var a = key.split('-'); return MONTHS[+a[1] - 1].slice(0, 3) + ' ' + a[0].slice(2); }
  function isDay(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '').slice(0, 10)); }

  /* ---------------- dates ---------------- */
  function orderDay(o) {
    if (o && o.order_date && isDay(o.order_date)) return String(o.order_date).slice(0, 10);
    if (o && o.created_at) { var d = new Date(o.created_at); if (!isNaN(d)) return ymd(d); }
    return null;
  }
  function deliveredDay(o) { return o && o.status === 'delivered' && isDay(o.delivered_on) ? String(o.delivered_on).slice(0, 10) : null; }

  /* ---------------- costs ---------------- */
  function lines(o) { return Array.isArray(o && o.line_items) ? o.line_items : []; }
  function costRecorded(o) { return !blank(o && o.cost); }
  /* ---- piece costing and pricing: "per unit" or "total / batch" ----
   * The same rules are used for a piece's COST and its SELLING PRICE.
   * A line keeps   cost  / price              = the amount for ONE unit (full precision, never rounded)
   *                cost_mode / price_mode     = 'unit' (default, also for older lines) or 'total'
   *                cost_total / price_total   = the exact total entered, in rupees to the paisa (total mode only)
   * The line amount is the entered total in total mode; in unit mode it is qty × unit amount,
   * multiplied BEFORE rounding to paisa, so 3 × (10 ÷ 3) is Rs 10.00 and never Rs 9.99.
   * A blank cost means "not entered" and is never treated as 0. A blank price counts as 0 in sales. */
  function round2(v) { return Math.round(+(+v * 100).toFixed(4)) / 100; }
  function lineQty(l) { var q = +(l && l.qty); return isFinite(q) ? q : 0; }
  function method(K) { // K = { v: 'cost', m: 'cost_mode', t: 'cost_total', r: '_recalc' }
    function mode(l) { return l && l[K.m] === 'total' ? 'total' : 'unit'; }
    function amountP(l) {
      if (!l) return null;
      if (mode(l) === 'total') return blank(l[K.t]) ? null : toP(l[K.t]);
      if (blank(l[K.v])) return null;
      return Math.round(+(lineQty(l) * +l[K.v] * 100).toFixed(4));
    }
    function amount(l) { var p = amountP(l); return p == null ? null : fromP(p); }
    function unit(l) {
      if (mode(l) === 'total') { var q = lineQty(l); return blank(l[K.t]) || !(q > 0) ? null : +l[K.t] / q; }
      return blank(l[K.v]) ? null : +l[K.v];
    }
    function drop(n) { delete n[K.r]; return n; }
    return {
      mode: mode, amountP: amountP, amount: amount, unit: unit,
      /* Quantity changed: keep the unit amount; in total mode the total is worked out again from it. */
      setQty: function (l, q) {
        var n = Object.assign({}, l, { qty: q }), u = blank(l[K.v]) ? null : +l[K.v];
        if (mode(l) === 'total' && u != null && +q > 0) { n[K.t] = round2(+q * u); n[K.r] = true; }
        return n;
      },
      /* Unit amount typed (per-unit mode). */
      setUnit: function (l, v) { var n = Object.assign({}, l); n[K.m] = 'unit'; n[K.v] = blank(v) ? null : +v; delete n[K.t]; return drop(n); },
      /* Total typed (total mode): the unit amount is worked out from the current quantity. */
      setTotal: function (l, v) {
        var n = drop(Object.assign({}, l)); n[K.m] = 'total';
        if (blank(v)) { n[K.t] = null; n[K.v] = null; return n; }
        n[K.t] = round2(v); var q = lineQty(l);
        n[K.v] = q > 0 ? n[K.t] / q : (blank(l[K.v]) ? null : +l[K.v]);
        return n;
      },
      /* Switching method never changes the line amount. */
      setMode: function (l, m) {
        var n = drop(Object.assign({}, l));
        if (m === mode(l)) return n;
        if (m === 'total') { n[K.m] = 'total'; n[K.t] = amount(l); }
        else { n[K.m] = 'unit'; n[K.v] = unit(l); delete n[K.t]; }
        return n;
      }
    };
  }
  var COST = method({ v: 'cost', m: 'cost_mode', t: 'cost_total', r: '_recalc' });
  var PRICE = method({ v: 'price', m: 'price_mode', t: 'price_total', r: '_recalcPrice' });
  function lineMode(l) { return COST.mode(l); }
  function lineCostP(l) { return COST.amountP(l); }
  function lineCost(l) { return COST.amount(l); }
  function lineUnitCost(l) { return COST.unit(l); }
  function linePriceMode(l) { return PRICE.mode(l); }
  function lineSaleP(l) { var p = PRICE.amountP(l); return p == null ? 0 : p; }
  function lineSale(l) { return fromP(lineSaleP(l)); }
  function lineUnitPrice(l) { return PRICE.unit(l); }
  /* State changes used by the order form. Each returns a NEW line object. */
  var costing = {
    setQty: COST.setQty, setUnit: COST.setUnit, setTotal: COST.setTotal, setMode: COST.setMode,
    /* Problems that must stop a save. */
    error: function (l) {
      var q = +(l && l.qty);
      if (!(q > 0)) return 'Enter a quantity of at least 1';
      if (!blank(l.cost) && +l.cost < 0) return "Cost can't be negative";
      if (!blank(l.cost_total) && +l.cost_total < 0) return "Cost can't be negative";
      if (!blank(l.price) && +l.price < 0) return "Price can't be negative";
      if (!blank(l.price_total) && +l.price_total < 0) return "Price can't be negative";
      return null;
    },
    /* A saved product's usual unit cost (from its batch if one was entered). */
    productUnitCost: function (p) {
      if (!p) return null;
      if (!blank(p.cost_batch_total) && +p.cost_batch_qty > 0) return +p.cost_batch_total / +p.cost_batch_qty;
      return blank(p.cost) ? null : +p.cost;
    },
    /* A saved product's usual selling price per unit (from its bulk price if one was entered). */
    productUnitPrice: function (p) {
      if (!p) return null;
      if (!blank(p.price_batch_total) && +p.price_batch_qty > 0) return +p.price_batch_total / +p.price_batch_qty;
      return blank(p.price) ? null : +p.price;
    },
    /* Quantity changed: cost AND price follow their own method. */
    setLineQty: function (l, q) { return PRICE.setQty(COST.setQty(l, q), q); }
  };
  var pricing = { setQty: PRICE.setQty, setUnit: PRICE.setUnit, setTotal: PRICE.setTotal, setMode: PRICE.setMode };
  /* Totals for a list of pieces: cost is null unless every piece has a cost. */
  function linesSummary(ls) {
    var saleP = 0, costP = 0, qty = 0, known = 0, missing = 0;
    (ls || []).forEach(function (l) {
      var q = lineQty(l); qty += q; saleP += lineSaleP(l);
      var c = lineCostP(l); if (c == null) missing++; else { known++; costP += c; }
    });
    return { sale: fromP(saleP), cost: missing === 0 && known > 0 ? fromP(costP) : null, knownCost: fromP(costP),
      qty: qty, costedLines: known, missingLines: missing, anyCost: known > 0 };
  }

  /* ---------------- payments ---------------- */
  function livePayments(pays) { return (pays || []).filter(function (p) { return p && !p.voided_at; }); }
  function groupPayments(pays) {
    var m = {}; livePayments(pays).forEach(function (p) { (m[p.order_id] || (m[p.order_id] = [])).push(p); }); return m;
  }
  /* A cancelled order's total is only the money Decorify kept as a cancellation charge (usually 0). */
  function keptP(o) { return o && o.status === 'cancelled' && o.cancel_kept != null && isFinite(+o.cancel_kept) ? Math.max(0, toP(o.cancel_kept)) : 0; }
  /* Money position of one order. pays = that order's payments (voided ones are ignored). */
  function moneyOf(o, pays) {
    var totalP = !o ? 0 : o.status !== 'cancelled' ? toP(o.sale_price) : keptP(o), inP = 0, outP = 0;
    livePayments(pays).forEach(function (p) { if (p.kind === 'refund') outP += toP(p.amount); else inP += toP(p.amount); });
    var netP = inP - outP, balP = totalP - netP;
    var status = balP < 0 ? 'credit' : balP === 0 ? (totalP === 0 && netP === 0 ? 'none' : 'paid') : netP > 0 ? 'partly' : 'unpaid';
    return { total: fromP(totalP), received: fromP(inP), refunded: fromP(outP), net: fromP(netP), balance: fromP(balP), status: status };
  }
  var PAY_LABEL = { unpaid: 'Unpaid', partly: 'Partly paid', paid: 'Paid', credit: 'Customer credit', none: 'No charge' };

  /* ---------------- customers ---------------- */
  function phoneKey(phone) {
    var d = String(phone || '').replace(/\D/g, '');
    if (d.length < 7) return null;
    if (d.indexOf('0092') === 0) d = d.slice(2);
    if (d.length === 11 && d[0] === '0') d = '92' + d.slice(1);
    return d;
  }
  function customerKey(o) {
    if (o && o.customer_id) return 'cid:' + o.customer_id;
    var k = phoneKey(o && o.phone); return k ? 'tel:' + k : null;
  }

  /* ---------------- periods ---------------- */
  function periodFor(key, today, opts) {
    opts = opts || {};
    var t = parseDay(today), y = t.getFullYear(), m = t.getMonth();
    switch (key) {
      case 'this_month': return { key: key, label: 'This month', from: ymd(new Date(y, m, 1)), to: today };
      case 'last_month': return { key: key, label: 'Last month', from: ymd(new Date(y, m - 1, 1)), to: ymd(new Date(y, m, 0)) };
      case 'this_quarter': { var q = Math.floor(m / 3) * 3; return { key: key, label: 'This quarter', from: ymd(new Date(y, q, 1)), to: today }; }
      case 'this_year': return { key: key, label: 'This year', from: ymd(new Date(y, 0, 1)), to: today };
      case 'last_year': return { key: key, label: 'Last year', from: ymd(new Date(y - 1, 0, 1)), to: ymd(new Date(y - 1, 11, 31)) };
      case 'all': return { key: key, label: 'All time', from: opts.coverageStart || today, to: today };
      case 'custom': {
        var f = opts.from || today, to = opts.to || today; if (f > to) { var s = f; f = to; to = s; }
        return { key: key, label: 'Custom range', from: f, to: to };
      }
    }
    return periodFor('this_month', today);
  }

  /* ---------------- aggregation ---------------- */
  function emptyAgg() {
    return { n: 0, salesP: 0, costP: 0, missingCostN: 0, missingSalesP: 0,
      completeN: 0, completeSalesP: 0, completeCostP: 0,
      earnedN: 0, earnedSalesP: 0, earnedProfitP: 0, earnedMissingN: 0,
      expectedN: 0, expectedSalesP: 0, expectedProfitP: 0, expectedMissingN: 0,
      units: 0, negativeN: 0, cust: {}, unidentifiedN: 0 };
  }
  function addOrder(a, o) {
    var s = toP(o.sale_price), known = costRecorded(o), c = known ? toP(o.cost) : 0, delivered = o.status === 'delivered';
    a.n++; a.salesP += s; a.costP += c; a.units += Math.max(0, +o.quantity || 0);
    if (known) { a.completeN++; a.completeSalesP += s; a.completeCostP += c; if (s - c < 0) a.negativeN++; }
    else { a.missingCostN++; a.missingSalesP += s; }
    if (delivered) { a.earnedN++; a.earnedSalesP += s; if (known) a.earnedProfitP += s - c; else a.earnedMissingN++; }
    else { a.expectedN++; a.expectedSalesP += s; if (known) a.expectedProfitP += s - c; else a.expectedMissingN++; }
    var k = customerKey(o);
    if (k) a.cust[k] = (a.cust[k] || 0) + 1; else a.unidentifiedN++;
    return a;
  }
  function finish(a) {
    var n = a.n, complete = a.missingCostN === 0;
    var custKeys = Object.keys(a.cust), repeat = custKeys.filter(function (k) { return a.cust[k] >= 2; }).length;
    var profitP = complete ? a.salesP - a.costP : null;
    var subsetProfitP = a.completeSalesP - a.completeCostP;
    return {
      orders: n,
      sales: fromP(a.salesP),
      costRecorded: fromP(a.costP),
      costComplete: complete,
      missingCostOrders: a.missingCostN,
      missingCostSales: fromP(a.missingSalesP),
      cost: complete ? fromP(a.costP) : null,
      profit: profitP == null ? null : fromP(profitP),
      completeSubset: { orders: a.completeN, sales: fromP(a.completeSalesP), cost: fromP(a.completeCostP), profit: fromP(subsetProfitP),
        margin: a.completeSalesP > 0 ? subsetProfitP / a.completeSalesP * 100 : null,
        avgCost: a.completeN ? fromP(a.completeCostP) / a.completeN : null,
        avgProfit: a.completeN ? fromP(subsetProfitP) / a.completeN : null },
      margin: complete && a.salesP > 0 ? (a.salesP - a.costP) / a.salesP * 100 : null,
      aov: n ? fromP(a.salesP) / n : null,
      avgCost: complete && n ? fromP(a.costP) / n : null,
      avgProfit: complete && n ? fromP(a.salesP - a.costP) / n : null,
      units: a.units, avgUnits: n ? a.units / n : null,
      earned: { orders: a.earnedN, sales: fromP(a.earnedSalesP), profit: fromP(a.earnedProfitP), missingCostOrders: a.earnedMissingN },
      expected: { orders: a.expectedN, sales: fromP(a.expectedSalesP), profit: fromP(a.expectedProfitP), missingCostOrders: a.expectedMissingN },
      negativeProfitOrders: a.negativeN,
      customers: custKeys.length, repeatCustomers: repeat,
      repeatRate: custKeys.length ? repeat / custKeys.length * 100 : null,
      unidentifiedOrders: a.unidentifiedN
    };
  }
  function aggregate(list) { var a = emptyAgg(); for (var i = 0; i < list.length; i++) addOrder(a, list[i]); return finish(a); }

  function ties(arr, pick, best) {
    if (!arr.length) return [];
    var v = arr.reduce(function (m, x) { var y = pick(x); return best ? Math.max(m, y) : Math.min(m, y); }, best ? -Infinity : Infinity);
    return arr.filter(function (x) { return pick(x) === v; });
  }

  /* ---------------- money owed (as of today, all orders) ---------------- */
  function receivables(allOrders, payments) {
    var g = groupPayments(payments), owedP = 0, owedN = 0, owedDeliveredP = 0, owedDeliveredN = 0, creditP = 0, creditN = 0, byCust = {};
    (allOrders || []).forEach(function (o) {
      if (!o || o.deleted_at) return;
      var m = moneyOf(o, g[o.id]), b = toP(m.balance), k = customerKey(o) || ('order:' + o.id);
      if (b > 0) { owedP += b; owedN++; if (o.status === 'delivered') { owedDeliveredP += b; owedDeliveredN++; } }
      if (b < 0) { creditP += -b; creditN++; }
      if (b !== 0) { var c = byCust[k] || (byCust[k] = { key: k, name: o.customer_name || '', phone: o.phone || '', customerId: o.customer_id || null, balanceP: 0, orders: 0, last: '' });
        c.balanceP += b; c.orders++; var d = orderDay(o) || ''; if (d >= c.last) { c.last = d; c.name = o.customer_name || c.name; c.phone = o.phone || c.phone; } }
    });
    var list = Object.keys(byCust).map(function (k) { var c = byCust[k]; return { key: k, name: c.name, phone: c.phone, customerId: c.customerId, balance: fromP(c.balanceP), orders: c.orders }; });
    return { owed: fromP(owedP), owedOrders: owedN, owedDelivered: fromP(owedDeliveredP), owedDeliveredOrders: owedDeliveredN,
      credit: fromP(creditP), creditOrders: creditN,
      owing: list.filter(function (c) { return c.balance > 0; }).sort(function (a, b) { return b.balance - a.balance || a.name.localeCompare(b.name); }),
      credits: list.filter(function (c) { return c.balance < 0; }).sort(function (a, b) { return a.balance - b.balance; }) };
  }

  /* ---------------- management P&L for a period (delivery-date basis) ---------------- */
  var EXPENSE_KIND = { packaging: 'operating', delivery: 'operating', marketing: 'operating', utilities: 'operating', equipment: 'operating',
    admin: 'operating', other: 'operating', stock: 'stock', drawings: 'drawings' };
  var EXPENSE_LABEL = { packaging: 'Packaging supplies', delivery: 'Delivery & courier', marketing: 'Marketing & ads', utilities: 'Utilities',
    equipment: 'Tools & equipment', admin: 'Admin & other costs', other: 'Other business expenses', stock: 'Stock / materials bought', drawings: 'Owner drawings' };
  function pnl(allOrders, expenses, from, to) {
    var delivered = [], undated = 0;
    (allOrders || []).forEach(function (o) {
      if (!o || o.deleted_at || o.status !== 'delivered') return;
      var d = deliveredDay(o); if (!d) { undated++; return; }
      if (d >= from && d <= to) delivered.push(o);
    });
    var agg = aggregate(delivered), cats = {}, opP = 0, stockP = 0, drawP = 0, count = 0;
    var deliveryP = delivered.reduce(function (s, o) { return s + toP(o.delivery_cost); }, 0);
    (expenses || []).forEach(function (e) {
      if (!e || e.voided_at || !isDay(e.spent_on)) return; var d = String(e.spent_on).slice(0, 10); if (d < from || d > to) return;
      var a = toP(e.amount), kind = EXPENSE_KIND[e.category] || 'operating'; count++;
      if (kind === 'stock') stockP += a; else if (kind === 'drawings') drawP += a; else { opP += a; cats[e.category] = (cats[e.category] || 0) + a; }
    });
    var keptTotP = 0, keptN = 0;
    (allOrders || []).forEach(function (o) {
      if (!o || o.deleted_at || o.status !== 'cancelled') return; var k = keptP(o); if (!k) return;
      var d = isDay(o.cancelled_on) ? String(o.cancelled_on).slice(0, 10) : null; if (!d || d < from || d > to) return;
      keptTotP += k; keptN++;
    });
    var orderProfit = agg.profit;
    return {
      from: from, to: to, deliveredOrders: agg.orders, sales: agg.sales,
      directCost: agg.cost, directCostRecorded: agg.costRecorded, deliveryCost: fromP(deliveryP), costComplete: agg.costComplete, missingCostOrders: agg.missingCostOrders,
      orderProfit: orderProfit, subset: agg.completeSubset,
      operatingExpenses: fromP(opP),
      expenseLines: Object.keys(cats).map(function (k) { return { category: k, label: EXPENSE_LABEL[k] || k, amount: fromP(cats[k]) }; }).sort(function (a, b) { return b.amount - a.amount; }),
      cancelKept: fromP(keptTotP), cancelKeptOrders: keptN,
      operatingProfit: orderProfit == null ? null : fromP(toP(orderProfit) + keptTotP - opP),
      stockPurchases: fromP(stockP), ownerDrawings: fromP(drawP), expenseEntries: count,
      deliveredWithoutDate: undated
    };
  }

  /* ---------------- main ---------------- */
  function compute(allOrders, opts) {
    opts = opts || {};
    var today = opts.today, basis = opts.basis === 'delivered' ? 'delivered' : 'booked';
    var dayOf = basis === 'delivered' ? deliveredDay : orderDay;
    var live = (allOrders || []).filter(function (o) { return o && !o.deleted_at; });
    var eligible = live.filter(function (o) { return o.status !== 'cancelled' && !!dayOf(o); });
    var upToToday = eligible.filter(function (o) { return dayOf(o) <= today; });
    var futureDated = eligible.length - upToToday.length;
    var firstDay = upToToday.reduce(function (m, o) { var d = dayOf(o); return !m || d < m ? d : m; }, null);
    var coverageStart = firstDay ? monthStart(monthKey(firstDay)) : null;
    var period = opts.period || periodFor('this_month', today);
    if (period.key === 'all') period = periodFor('all', today, { coverageStart: coverageStart || today });
    var from = period.from, to = period.to;
    var inRange = eligible.filter(function (o) { var d = dayOf(o); return d >= from && d <= to; });

    var totals = aggregate(inRange);
    var lifetime = aggregate(upToToday);
    lifetime.through = today;
    lifetime.coverageStart = coverageStart;

    var months = [];
    if (coverageStart) {
      var startKey = monthKey(from > coverageStart ? from : coverageStart), endKey = monthKey(to < today ? to : today);
      if (startKey <= endKey) {
        for (var k = startKey; k <= endKey; k = addMonths(k, 1)) {
          var ms = monthStart(k), me = monthEnd(k);
          var lo = ms > from ? ms : from, hi = me < to ? me : to;
          var mOrders = inRange.filter(function (o) { var d = dayOf(o); return d >= lo && d <= hi; });
          var agg = aggregate(mOrders);
          var isCurrent = k === monthKey(today);
          var complete = ms >= from && me <= to && me < today && ms >= coverageStart;
          months.push({ key: k, label: monthLabel(k), short: monthShort(k), from: lo, to: hi,
            complete: complete, current: isCurrent, partial: !complete,
            partialReason: complete ? null : (isCurrent ? 'This month so far' : 'Partly outside the selected dates'),
            orders: agg.orders, sales: agg.sales, cost: agg.cost, costRecorded: agg.costRecorded,
            profit: agg.profit, margin: agg.margin, aov: agg.aov, customers: agg.customers,
            unidentifiedOrders: agg.unidentifiedOrders, missingCostOrders: agg.missingCostOrders });
        }
      }
    }

    var cm = months.filter(function (m) { return m.complete; });
    var M = cm.length, monthly = null;
    if (M) {
      var cmOrders = inRange.filter(function (o) { var d = dayOf(o); return cm.some(function (m) { return d >= m.from && d <= m.to; }); });
      var ca = aggregate(cmOrders);
      var sumSalesP = cm.reduce(function (s, m) { return s + toP(m.sales); }, 0);
      monthly = {
        months: M, firstMonth: cm[0].label, lastMonth: cm[M - 1].label,
        avgSales: fromP(sumSalesP) / M,
        avgProfit: ca.profit == null ? null : ca.profit / M,
        avgProfitSubsetNote: ca.profit == null ? ca.missingCostOrders : 0,
        avgOrders: ca.orders / M,
        highest: ties(cm, function (m) { return toP(m.sales); }, true),
        lowest: ties(cm, function (m) { return toP(m.sales); }, false),
        zeroMonths: cm.filter(function (m) { return m.orders === 0; }).length
      };
    }

    var comparison = null;
    if (M >= 1) {
      var last = cm[M - 1], prevKey = addMonths(last.key, -1);
      var prev = months.filter(function (m) { return m.key === prevKey && m.complete; })[0];
      if (!prev && coverageStart && monthStart(prevKey) >= coverageStart) {
        var pOrders = upToToday.filter(function (o) { return monthKey(dayOf(o)) === prevKey; });
        var pa = aggregate(pOrders); prev = { key: prevKey, label: monthLabel(prevKey), sales: pa.sales, orders: pa.orders, aov: pa.aov };
      }
      if (prev) comparison = { current: { label: last.label, sales: last.sales, orders: last.orders, aov: last.aov }, previous: { label: prev.label, sales: prev.sales, orders: prev.orders, aov: prev.aov },
        changePct: toP(prev.sales) > 0 ? (toP(last.sales) - toP(prev.sales)) / toP(prev.sales) * 100 : null };
    }

    // customers in period, with each customer's balance today (all their orders)
    var payByOrder = groupPayments(opts.payments), balances = {};
    live.forEach(function (o) { var k = customerKey(o); if (!k) return; balances[k] = (balances[k] || 0) + toP(moneyOf(o, payByOrder[o.id]).balance); });
    var custMap = {};
    inRange.forEach(function (o) {
      var k = customerKey(o); if (!k) return;
      var c = custMap[k] || (custMap[k] = { key: k, customerId: o.customer_id || null, name: '', phone: o.phone, orders: 0, salesP: 0, lastDay: '' });
      c.orders++; c.salesP += toP(o.sale_price);
      var d = dayOf(o); if (d >= c.lastDay) { c.lastDay = d; c.name = o.customer_name || c.name; c.phone = o.phone || c.phone; }
    });
    var topCustomers = Object.keys(custMap).map(function (k) { var c = custMap[k];
      return { key: k, customerId: c.customerId, name: c.name, phone: c.phone, orders: c.orders, sales: fromP(c.salesP), aov: fromP(c.salesP) / c.orders, currentBalance: fromP(balances[k] || 0) }; })
      .sort(function (a, b) { return b.sales - a.sales || b.orders - a.orders || a.name.localeCompare(b.name); });

    // products (from pieces). Order-level costs are never spread over products.
    var prod = {}, unitemisedN = 0, unitemisedP = 0;
    inRange.forEach(function (o) {
      var ls = lines(o);
      if (!ls.length) { unitemisedN++; unitemisedP += toP(o.sale_price); return; }
      ls.forEach(function (l) {
        var name = String(l.name || '').trim(); if (!name) return;
        var key = l.product_id ? 'id:' + l.product_id : 'name:' + name.toLowerCase();
        var p = prod[key] || (prod[key] = { key: key, productId: l.product_id || null, name: name, custom: !l.product_id, qty: 0, salesP: 0, costP: 0, costMissingLines: 0, orders: {} });
        var q = +l.qty || 0;
        p.qty += q; p.salesP += lineSaleP(l); p.orders[o.id] = 1;
        var lc = lineCostP(l); if (lc == null) p.costMissingLines++; else p.costP += lc;
        p.name = name;
      });
    });
    var products = Object.keys(prod).map(function (k) { var p = prod[k]; var complete = p.costMissingLines === 0;
      return { key: k, productId: p.productId, name: p.name, custom: p.custom, qty: p.qty, orders: Object.keys(p.orders).length, sales: fromP(p.salesP),
        costComplete: complete, cost: complete ? fromP(p.costP) : null, profit: complete ? fromP(p.salesP - p.costP) : null,
        margin: complete && p.salesP > 0 ? (p.salesP - p.costP) / p.salesP * 100 : null }; })
      .sort(function (a, b) { return b.sales - a.sales || b.qty - a.qty || a.name.localeCompare(b.name); });
    var withProfit = products.filter(function (p) { return p.profit != null; });

    var res = {
      basis: basis,
      basisLabel: basis === 'delivered' ? 'Delivered orders, grouped by delivery date' : 'Booked orders (not cancelled), grouped by order date',
      today: today, period: period, coverageStart: coverageStart, futureDatedOrders: futureDated,
      hasAnyOrders: upToToday.length > 0,
      deliveredWithoutDate: live.filter(function (o) { return o.status === 'delivered' && !deliveredDay(o); }).length,
      totals: totals, lifetime: lifetime, months: months, monthly: monthly, comparison: comparison,
      customers: { inPeriod: totals.customers, repeat: totals.repeatCustomers, repeatRate: totals.repeatRate, toDate: lifetime.customers,
        unidentifiedInPeriod: totals.unidentifiedOrders, unidentifiedToDate: lifetime.unidentifiedOrders, top: topCustomers },
      products: { list: products, unitemisedOrders: unitemisedN, unitemisedSales: fromP(unitemisedP),
        bestBySales: ties(products, function (p) { return Math.round(p.sales * 100); }, true),
        bestByQty: ties(products, function (p) { return p.qty; }, true),
        mostProfitable: ties(withProfit, function (p) { return Math.round(p.profit * 100); }, true),
        categoriesAvailable: false },
      receivables: receivables(live, opts.payments),
      pnl: pnl(live, opts.expenses, from, to < today ? to : today)
    };
    res.statements = statements(res);
    return res;
  }

  /* ---------------- plain-language statements (rule-based, from the data only) ---------------- */
  function names(arr, f) { var n = arr.map(f); return n.length <= 1 ? n.join('') : n.slice(0, -1).join(', ') + ' and ' + n[n.length - 1]; }
  function statements(r) {
    var out = [], t = r.totals, mo = r.monthly;
    if (!r.hasAnyOrders) return out;
    if (!t.orders) { out.push({ kind: 'info', key: 'none', data: {} }); }
    else {
      if (mo) {
        out.push({ kind: 'best', key: 'highest', data: { months: mo.highest.map(function (m) { return m.label; }), sales: mo.highest[0].sales, tie: mo.highest.length > 1, count: mo.months } });
        if (mo.months > 1) out.push({ kind: 'low', key: 'lowest', data: { months: mo.lowest.map(function (m) { return m.label; }), sales: mo.lowest[0].sales, tie: mo.lowest.length > 1, zero: mo.lowest[0].sales === 0 } });
      }
      out.push({ kind: 'info', key: 'aov', data: { aov: t.aov, orders: t.orders } });
      if (r.products.bestBySales.length) out.push({ kind: 'best', key: 'topProduct', data: { names: r.products.bestBySales.map(function (p) { return p.name; }), sales: r.products.bestBySales[0].sales } });
      if (t.repeatCustomers > 0) out.push({ kind: 'info', key: 'repeat', data: { n: t.repeatCustomers } });
      if (r.comparison) out.push({ kind: 'compare', key: 'compare', data: r.comparison });
      if (r.comparison && r.comparison.current.aov != null && r.comparison.previous.aov != null && toP(r.comparison.previous.aov) > 0 && toP(r.comparison.current.aov) !== toP(r.comparison.previous.aov))
        out.push({ kind: 'compare', key: 'aovChange', data: r.comparison });
      if (t.negativeProfitOrders > 0) out.push({ kind: 'attention', key: 'negative', data: { n: t.negativeProfitOrders } });
      if (t.missingCostOrders > 0) out.push({ kind: 'attention', key: 'missingCost', data: { n: t.missingCostOrders, of: t.orders } });
      if (t.expected.orders > 0 && t.costComplete) out.push({ kind: 'info', key: 'expected', data: { n: t.expected.orders, profit: t.expected.profit } });
    }
    if (r.receivables && r.receivables.owedOrders > 0) out.push({ kind: 'attention', key: 'owed', data: { owed: r.receivables.owed, n: r.receivables.owedOrders, delivered: r.receivables.owedDelivered, deliveredN: r.receivables.owedDeliveredOrders } });
    return out;
  }

  return { compute: compute, aggregate: aggregate, periodFor: periodFor, orderDay: orderDay, deliveredDay: deliveredDay,
    customerKey: customerKey, phoneKey: phoneKey, costRecorded: costRecorded, linesSummary: linesSummary, blank: blank,
    lineCost: lineCost, lineUnitCost: lineUnitCost, lineMode: lineMode, costing: costing, round2: round2,
    pricing: pricing, linePriceMode: linePriceMode, lineSale: lineSale, lineUnitPrice: lineUnitPrice,
    moneyOf: moneyOf, groupPayments: groupPayments, receivables: receivables, pnl: pnl, PAY_LABEL: PAY_LABEL,
    EXPENSE_KIND: EXPENSE_KIND, EXPENSE_LABEL: EXPENSE_LABEL,
    monthLabel: monthLabel, monthKey: monthKey, monthEnd: monthEnd, addDays: addDays, ymd: ymd, toP: toP, fromP: fromP, names: names };
});
