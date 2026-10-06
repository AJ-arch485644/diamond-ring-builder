(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DiyonaCartShareContract = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var SENTINEL = '51975403077948';
  var NON_TRANSFERABLE_ATTRIBUTES = ['_utm_source', '_utm_medium', '_utm_campaign', '_utm_content', '_landing_url', '_referrer', '_first_touch_ts', '_visitor_id', '_last_source', '_last_medium', '_last_content', '_ad_id', '_last_ad_id', '_fbp', '_fbc', '_tt_page', '_tt_webview', '_tt_applepay', '_tt_wallet_drawn'];
  function isNonTransferableAttribute(key) { return NON_TRANSFERABLE_ATTRIBUTES.indexOf(key) !== -1; }
  var SEMANTIC = ['Ring Size', '_needs_ring_size', 'Diamond', 'Certificate', 'Paired Setting', '_ring_builder', '_ring_type', '_diamond_sku', 'Paired Diamond', 'Diamond SKU', 'Custom Engraving', 'Engraving Text', 'Chain', 'Chain Length', 'Pendant Chain', '_pending_loose'];
  var TRANSIENT = ['_diy_operation_v1', '_diy_share_import_v1', '_diy_share_line_v1', '_idempotency_key', '_optimistic_swapped', '_real_price', '_display_price', '_display_currency', '_display_country', '_display_price_source', '_display_price_version', 'Ship by', 'Ship By', 'Arrives by', '_image_url', '_shape', '_carat', '_color', '_clarity', '_cut', '_lab', '_certificate_number', '_max_delivery_days', '_engraving'];
  function ShareCartError(code, status) { this.name = 'ShareCartError'; this.message = code; this.code = code; this.status = status || 400; }
  ShareCartError.prototype = Object.create(Error.prototype);
  function fail(code, status) { throw new ShareCartError(code, status); }
  function own(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
  function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
  function text(value, max, empty) { if (typeof value !== 'string' || value.length > max || (!empty && !value.length) || /[<>"&`\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || /\/uploads\//i.test(value)) fail('INVALID_TEXT'); return value; }
  function id(value) { if (typeof value === 'number' && !Number.isSafeInteger(value)) fail('INVALID_VARIANT'); var s = String(value); if (!/^[1-9]\d{0,15}$/.test(s) || !Number.isSafeInteger(Number(s))) fail('INVALID_VARIANT'); return s; }
  function validRingSize(value) {
    if (value === '') return true;
    var match = /^(?:US )?(\d{1,2}(?:\.\d{1,2})?)([¼½¾])?$/.exec(value);
    if (!match || (match[2] && match[1].indexOf('.') !== -1)) return false;
    var number = Number(match[1]) + (match[2] ? { '¼': 0.25, '½': 0.5, '¾': 0.75 }[match[2]] : 0);
    return number >= 3 && number <= 10 && Number.isInteger(number * 4);
  }
  function stableStringify(value) {
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    if (plain(value)) return '{' + Object.keys(value).sort().map(function (key) { return JSON.stringify(key) + ':' + stableStringify(value[key]); }).join(',') + '}';
    return JSON.stringify(value);
  }
  function properties(raw) {
    if (raw == null) raw = {};
    if (!plain(raw) || Object.keys(raw).length > 60) fail('INVALID_PROPERTIES');
    if (own(raw, '_pending_diamond_id') && raw._pending_diamond_id) fail('CART_PENDING', 409);
    var out = {};
    Object.keys(raw).forEach(function (key) {
      if (key === '_pending_diamond_id' || TRANSIENT.indexOf(key) !== -1) return;
      if (SEMANTIC.indexOf(key) === -1) fail('UNSUPPORTED_PROPERTY');
      out[key] = text(raw[key], ['Custom Engraving', 'Engraving Text'].indexOf(key) === -1 ? 500 : 80, true);
    });
    if (own(out, '_ring_builder') && out._ring_builder !== 'true') fail('UNSUPPORTED_BUNDLE');
    if (own(out, '_ring_type') && ['Ring', 'Loose'].indexOf(out._ring_type) === -1) fail('UNSUPPORTED_BUNDLE');
    if (own(out, '_needs_ring_size') && out._needs_ring_size !== 'true') fail('INVALID_PROPERTIES');
    if (own(out, '_pending_loose') && out._pending_loose !== 'true') fail('INVALID_PROPERTIES');
    if (own(out, 'Ring Size') && !validRingSize(out['Ring Size'])) fail('INVALID_RING_SIZE');
    return out;
  }
  function attributes(raw, allowed) {
    if (raw == null) raw = {};
    if (!plain(raw) || Object.keys(raw).length > 20 || !Array.isArray(allowed)) fail('INVALID_ATTRIBUTES');
    var out = {};
    Object.keys(raw).forEach(function (key) {
      if (isNonTransferableAttribute(key)) return;
      if (['__proto__', 'constructor', 'prototype'].indexOf(key) !== -1 || allowed.indexOf(key) === -1) fail('UNSUPPORTED_ATTRIBUTE');
      text(key, 80, false); out[key] = text(raw[key], 500, true);
    });
    return out;
  }
  function classify(line, raw) {
    var p = line.properties;
    if (p._ring_builder === 'true') {
      if (p._ring_type === 'Loose' || p._pending_loose) fail('UNSUPPORTED_BUNDLE', 409);
      if (p['Paired Diamond'] && p['Diamond SKU'] && !own(p, '_diamond_sku') && !p['Paired Setting'] && !p['Engraving Text']) return 'setting';
      if (p['Paired Setting'] && p._diamond_sku && !own(p, 'Diamond SKU') && !own(p, 'Custom Engraving') && !p['Paired Diamond'] && !p['Engraving Text']) return 'diamond';
      if (p['Engraving Text'] && p._diamond_sku && !own(p, 'Diamond SKU') && !own(p, 'Custom Engraving') && !own(p, 'Ring Size') && !p['Paired Setting'] && !p['Paired Diamond']) return 'engraving';
      fail('INCOMPLETE_BUNDLE', 409);
    }
    if (p._ring_type === 'Loose' || raw._pending_loose || p._diamond_sku || p.Certificate) {
      if (!p._diamond_sku || p._ring_type === 'Ring' || p['Paired Setting'] || p['Paired Diamond'] || p['Diamond SKU'] || own(p, 'Custom Engraving') || own(p, 'Engraving Text') || own(p, '_needs_ring_size')) fail('INCOMPLETE_BUNDLE', 409);
      p._ring_type = 'Loose'; p._pending_loose = 'true'; return 'loose';
    }
    if (p['Engraving Text'] || p['Custom Engraving'] || p['Paired Setting'] || p['Paired Diamond'] || p['Diamond SKU'] || p._ring_type) fail('UNSUPPORTED_BUNDLE', 409);
    return 'product';
  }
  function checkRoleProperties(line) {
    var keys = {
      product: ['Ring Size', '_needs_ring_size', 'Chain', 'Chain Length', 'Pendant Chain'],
      setting: ['_ring_builder', '_ring_type', 'Paired Diamond', 'Diamond SKU', 'Ring Size', 'Custom Engraving', '_needs_ring_size'],
      diamond: ['_ring_builder', '_ring_type', 'Paired Setting', '_diamond_sku', 'Diamond', 'Certificate', 'Ring Size'],
      engraving: ['_ring_builder', '_diamond_sku', 'Engraving Text'],
      loose: ['_ring_type', '_pending_loose', '_diamond_sku', 'Diamond', 'Certificate']
    }[line.kind];
    if (Object.keys(line.properties).some(function (key) { return keys.indexOf(key) === -1; })) fail('UNSUPPORTED_PROPERTY_ROLE');
  }
  function validateGroups(lines) {
    var groups = Object.create(null), stones = Object.create(null);
    lines.forEach(function (line) {
      var p = line.properties, sku = p._diamond_sku || p['Diamond SKU'];
      if (line.kind === 'diamond' || line.kind === 'loose') {
        if (!sku || line.sku !== sku || line.quantity !== 1 || stones[sku]) fail('DIAMOND_IDENTITY_MISMATCH', 409);
        stones[sku] = true;
      }
      if (['diamond', 'setting', 'engraving'].indexOf(line.kind) !== -1) {
        if (line.quantity !== 1) fail('INCOMPLETE_BUNDLE', 409);
        if (!groups[sku]) groups[sku] = [];
        groups[sku].push(line);
      }
    });
    // The current operations order model has one diamond/setting tuple. Do not
    // expand restored orders beyond that downstream contract in this first release.
    if (Object.keys(stones).length > 1) fail('MULTIPLE_DIAMONDS_UNSUPPORTED', 409);
    Object.keys(groups).sort().forEach(function (sku, index) {
      var group = groups[sku], diamonds = group.filter(function (l) { return l.kind === 'diamond'; }), settings = group.filter(function (l) { return l.kind === 'setting'; }), fees = group.filter(function (l) { return l.kind === 'engraving'; });
      if (diamonds.length !== 1 || settings.length !== 1 || fees.length > 1) fail('INCOMPLETE_BUNDLE', 409);
      var dp = diamonds[0].properties, sp = settings[0].properties;
      if ((dp['Ring Size'] || '') !== (sp['Ring Size'] || '')) fail('BUNDLE_SIZE_MISMATCH', 409);
      var engraving = sp['Custom Engraving'] || '';
      if ((engraving && (fees.length !== 1 || fees[0].properties['Engraving Text'] !== engraving)) || (!engraving && fees.length)) fail('BUNDLE_ENGRAVING_MISMATCH', 409);
      // The source diamond's _engraving can be stale after cart edits; setting is canonical.
      if (engraving) dp._engraving = engraving;
      group.forEach(function (line) { line.groupId = 'ring-' + (index + 1); });
    });
    var fingerprints = Object.create(null);
    lines.forEach(function (line) { var key = stableStringify([line.variantId, line.properties]); if (fingerprints[key]) fail('DUPLICATE_LINE', 409); fingerprints[key] = true; });
  }
  function normalizeCart(cart, options) {
    options = options || {};
    if (!plain(cart) || !Array.isArray(cart.items) || cart.items.length < 1 || cart.items.length > 30) fail('INVALID_CART');
    if (cart.note != null && cart.note !== '') fail('UNSUPPORTED_NOTE');
    if (!/^[A-Z]{3}$/.test(cart.currency || '')) fail('INVALID_CURRENCY');
    var lines = cart.items.map(function (item) {
      if (!plain(item)) fail('INVALID_LINE');
      var variantId = id(item.variant_id == null ? item.id : item.variant_id);
      if (variantId === SENTINEL || (item.properties && item.properties._pending_diamond_id)) fail('CART_PENDING', 409);
      if (item.selling_plan_allocation || item.selling_plan || item.parent_relationship || (Array.isArray(item.item_components) && item.item_components.length)) fail('UNSUPPORTED_LINE');
      if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 10) fail('INVALID_QUANTITY');
      var line = { variantId: variantId, quantity: item.quantity, properties: properties(item.properties), sku: text(item.sku == null ? '' : item.sku, 200, true) };
      line.kind = classify(line, item.properties || {}); checkRoleProperties(line); return line;
    });
    validateGroups(lines);
    var sourceOperations = Object.create(null);
    lines.forEach(function (line, index) {
      var operation = (cart.items[index].properties || {})._diy_operation_v1;
      if (!line.groupId || !operation) return;
      if (typeof operation !== 'string' || operation.length > 200) fail('INVALID_PROPERTIES');
      if (sourceOperations[line.groupId] && sourceOperations[line.groupId] !== operation) fail('AMBIGUOUS_BUNDLE', 409);
      sourceOperations[line.groupId] = operation;
    });
    return { version: 1, lines: lines, attributes: attributes(cart.attributes, options.allowedAttributes || []), currency: cart.currency };
  }
  function validateSnapshot(snapshot, options) {
    if (!plain(snapshot) || snapshot.version !== 1 || !Array.isArray(snapshot.lines) || Object.keys(snapshot).some(function (k) { return ['version', 'lines', 'attributes', 'currency'].indexOf(k) === -1; })) fail('INVALID_SNAPSHOT');
    var normalized = normalizeCart({ currency: snapshot.currency, attributes: snapshot.attributes, items: snapshot.lines.map(function (line) {
      if (!plain(line) || Object.keys(line).some(function (k) { return ['variantId', 'quantity', 'properties', 'sku', 'kind', 'groupId'].indexOf(k) === -1; })) fail('INVALID_LINE');
      return { variant_id: line.variantId, quantity: line.quantity, properties: line.properties, sku: line.sku };
    }) }, options);
    if (stableStringify(normalized) !== stableStringify(snapshot)) fail('NON_CANONICAL_SNAPSHOT');
    return normalized;
  }
  return { normalizeCart: normalizeCart, validateSnapshot: validateSnapshot, stableStringify: stableStringify, ShareCartError: ShareCartError, SENTINEL_VARIANT: SENTINEL, NON_TRANSFERABLE_ATTRIBUTES: NON_TRANSFERABLE_ATTRIBUTES.slice(), isNonTransferableAttribute: isNonTransferableAttribute };
}));
