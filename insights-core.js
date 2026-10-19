/* Decorify Orders: Insights calculation layer.
 * Pure functions, read-only. Used by the Insights page and by tests/insights.test.js.
 *
 * REPORTING DEFINITIONS (match the existing Dashboard):
 *  - Eligible order: status is not "cancelled".
 *  - Grouped by ORDER DATE (order_date; if missing, the local date of created_at).
 *    The app stores no completion timestamp, so a "completed date" basis is not available.
 *  - Net sales = sale_price (the stored order total; there are no discount/refund fields).
 *  - Direct cost = cost (recorded against the order when it was saved; never recomputed from today's product prices).
 *  - A cost of 0 on an order with a sale price is treated as "cost not recorded", because the form saves a blank cost as 0.
 *  - Order profit = net sales - direct cost, before business expenses. Shown only for orders whose cost is recorded.
 *    Earned = delivered orders; expected = orders not yet delivered.
 *  - Payments (advance_paid) never change sales or profit; they are used only for current balances.
 *  - Customer = normalised phone number. Orders without a usable phone are "unidentified" and are not merged by name.
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

  function orderDay(o) {
    if (o && o.order_date) { var s = String(o.order_date).slice(0, 10); if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s; }
    if (o && o.created_at) { var d = new Date(o.created_at); if (!isNaN(d)) return ymd(d); }
    return null;
  }
  function isEligible(o) { return !!o && o.status !== 'cancelled' && !!orderDay(o); }
  function costRecorded(o) { return toP(o.cost) !== 0 || toP(o.sale_price) === 0; }
  function customerKey(o) {
    var d = String((o && o.phone) || '').replace(/\D/g, '');
    if (d.length < 7) return null;
    if (d.indexOf('0092') === 0) d = d.slice(2);
    if (d.length === 11 && d[0] === '0') d = '92' + d.slice(1);
    return 'tel:' + d;
  }
  function lines(o) { return Array.isArray(o && o.line_items) ? o.line_items : []; }

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
    var s = toP(o.sale_price), c = toP(o.cost), known = costRecorded(o), delivered = o.status === 'delivered';
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

  /* ---------------- main ---------------- */
  function compute(allOrders, opts) {
    var today = opts.today;
    var eligible = (allOrders || []).filter(isEligible);
    var upToToday = eligible.filter(function (o) { return orderDay(o) <= today; });
    var futureDated = eligible.length - upToToday.length;
    var firstDay = upToToday.reduce(function (m, o) { var d = orderDay(o); return !m || d < m ? d : m; }, null);
    var coverageStart = firstDay ? monthStart(monthKey(firstDay)) : null;
    var period = opts.period || periodFor('this_month', today);
    if (period.key === 'all') period = periodFor('all', today, { coverageStart: coverageStart || today });
    var from = period.from, to = period.to;
    var inRange = eligible.filter(function (o) { var d = orderDay(o); return d >= from && d <= to; });

    var totals = aggregate(inRange);
    var lifetime = aggregate(upToToday);
    lifetime.through = today;
    lifetime.coverageStart = coverageStart;

    // months in range (only from the start of coverage; months before it are not invented)
    var months = [];
    if (coverageStart) {
      var startKey = monthKey(from > coverageStart ? from : coverageStart), endKey = monthKey(to < today ? to : today);
      if (startKey <= endKey) {
        for (var k = startKey; k <= endKey; k = addMonths(k, 1)) {
          var ms = monthStart(k), me = monthEnd(k);
          var lo = ms > from ? ms : from, hi = me < to ? me : to;
          var mOrders = inRange.filter(function (o) { var d = orderDay(o); return d >= lo && d <= hi; });
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

    // complete-month statistics: numerators and denominators use the same complete months
    var cm = months.filter(function (m) { return m.complete; });
    var M = cm.length, monthly = null;
    if (M) {
      var cmOrders = inRange.filter(function (o) { var d = orderDay(o); return cm.some(function (m) { return d >= m.from && d <= m.to; }); });
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

    // comparison: latest complete month vs the month before it, if that is also complete and covered
    var comparison = null;
    if (M >= 1) {
      var last = cm[M - 1], prevKey = addMonths(last.key, -1);
      var prevInRange = months.filter(function (m) { return m.key === prevKey && m.complete; })[0];
      var prev = prevInRange;
      if (!prev && coverageStart && monthStart(prevKey) >= coverageStart) {
        var pOrders = upToToday.filter(function (o) { return monthKey(orderDay(o)) === prevKey; });
        var pa = aggregate(pOrders); prev = { key: prevKey, label: monthLabel(prevKey), sales: pa.sales, orders: pa.orders };
      }
      if (prev) comparison = { current: { label: last.label, sales: last.sales, orders: last.orders }, previous: { label: prev.label, sales: prev.sales, orders: prev.orders },
        changePct: toP(prev.sales) > 0 ? (toP(last.sales) - toP(prev.sales)) / toP(prev.sales) * 100 : null };
    }

    // customers in period (top) + current balances across all eligible orders
    var custMap = {};
    inRange.forEach(function (o) {
      var k = customerKey(o); if (!k) return;
      var c = custMap[k] || (custMap[k] = { key: k, name: '', phone: o.phone, orders: 0, salesP: 0, lastDay: '' });
      c.orders++; c.salesP += toP(o.sale_price);
      var d = orderDay(o); if (d >= c.lastDay) { c.lastDay = d; c.name = o.customer_name || c.name; c.phone = o.phone || c.phone; }
    });
    var balances = {};
    eligible.forEach(function (o) { var k = customerKey(o); if (!k) return; var due = Math.max(0, toP(o.sale_price) - toP(o.advance_paid)); balances[k] = (balances[k] || 0) + due; });
    var topCustomers = Object.keys(custMap).map(function (k) { var c = custMap[k];
      return { key: k, name: c.name, phone: c.phone, orders: c.orders, sales: fromP(c.salesP), aov: fromP(c.salesP) / c.orders, currentBalance: fromP(balances[k] || 0) }; })
      .sort(function (a, b) { return b.sales - a.sales || b.orders - a.orders || a.name.localeCompare(b.name); });

    // products (from line items)
    var prod = {}, unitemisedN = 0, unitemisedP = 0;
    inRange.forEach(function (o) {
      var ls = lines(o);
      if (!ls.length) { unitemisedN++; unitemisedP += toP(o.sale_price); return; }
      ls.forEach(function (l) {
        var name = String(l.name || '').trim(); if (!name) return;
        var key = l.product_id ? 'id:' + l.product_id : 'name:' + name.toLowerCase();
        var p = prod[key] || (prod[key] = { key: key, productId: l.product_id || null, name: name, custom: !l.product_id, qty: 0, salesP: 0, costP: 0, costMissingLines: 0, orders: {} });
        var q = +l.qty || 0, lineSale = Math.round(q * toP(l.price)), lineCost = Math.round(q * toP(l.cost));
        p.qty += q; p.salesP += lineSale; p.orders[o.id] = 1;
        if (toP(l.cost) !== 0 || toP(l.price) === 0) p.costP += lineCost; else p.costMissingLines++;
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
      basis: 'Booked orders (not cancelled), grouped by order date',
      today: today, period: period, coverageStart: coverageStart, futureDatedOrders: futureDated,
      hasAnyOrders: upToToday.length > 0,
      totals: totals, lifetime: lifetime, months: months, monthly: monthly, comparison: comparison,
      customers: { inPeriod: totals.customers, repeat: totals.repeatCustomers, repeatRate: totals.repeatRate, toDate: lifetime.customers,
        unidentifiedInPeriod: totals.unidentifiedOrders, unidentifiedToDate: lifetime.unidentifiedOrders, top: topCustomers },
      products: { list: products, unitemisedOrders: unitemisedN, unitemisedSales: fromP(unitemisedP),
        bestBySales: ties(products, function (p) { return Math.round(p.sales * 100); }, true),
        bestByQty: ties(products, function (p) { return p.qty; }, true),
        mostProfitable: ties(withProfit, function (p) { return Math.round(p.profit * 100); }, true),
        categoriesAvailable: false }
    };
    res.statements = statements(res);
    return res;
  }

  /* ---------------- plain-language statements (local, rule-based) ---------------- */
  function names(arr, f) { var n = arr.map(f); return n.length <= 1 ? n.join('') : n.slice(0, -1).join(', ') + ' and ' + n[n.length - 1]; }
  function statements(r) {
    var out = [], t = r.totals, mo = r.monthly;
    if (!r.hasAnyOrders) return out;
    if (!t.orders) { out.push({ kind: 'info', key: 'none', data: {} }); return out; }
    if (mo) {
      out.push({ kind: 'best', key: 'highest', data: { months: mo.highest.map(function (m) { return m.label; }), sales: mo.highest[0].sales, tie: mo.highest.length > 1, count: mo.months } });
      if (mo.months > 1) out.push({ kind: 'low', key: 'lowest', data: { months: mo.lowest.map(function (m) { return m.label; }), sales: mo.lowest[0].sales, tie: mo.lowest.length > 1, zero: mo.lowest[0].sales === 0 } });
    }
    out.push({ kind: 'info', key: 'aov', data: { aov: t.aov, orders: t.orders } });
    if (r.products.bestBySales.length) out.push({ kind: 'best', key: 'topProduct', data: { names: r.products.bestBySales.map(function (p) { return p.name; }), sales: r.products.bestBySales[0].sales } });
    if (t.repeatCustomers > 0) out.push({ kind: 'info', key: 'repeat', data: { n: t.repeatCustomers } });
    if (r.comparison) out.push({ kind: 'compare', key: 'compare', data: r.comparison });
    if (t.negativeProfitOrders > 0) out.push({ kind: 'attention', key: 'negative', data: { n: t.negativeProfitOrders } });
    if (t.missingCostOrders > 0) out.push({ kind: 'attention', key: 'missingCost', data: { n: t.missingCostOrders, of: t.orders } });
    if (t.expected.orders > 0 && t.costComplete) out.push({ kind: 'info', key: 'expected', data: { n: t.expected.orders, profit: t.expected.profit } });
    return out;
  }

  return { compute: compute, aggregate: aggregate, periodFor: periodFor, orderDay: orderDay, customerKey: customerKey, costRecorded: costRecorded,
    monthLabel: monthLabel, monthKey: monthKey, monthEnd: monthEnd, addDays: addDays, ymd: ymd, toP: toP, fromP: fromP, names: names };
});
