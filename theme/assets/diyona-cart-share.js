/* Inert until explicitly constructed and enabled. No theme includes or UI bindings. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../../lib/cart-share-contract'));
  else root.DiyonaCartShare = factory(root.DiyonaCartShareContract);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (contract) {
  'use strict';
  var IMPORT = '_diy_share_import_v1', LINE = '_diy_share_line_v1';
  function problem(code) { var e = new Error(code); e.code = code; return e; }
  function stable(value) {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(function (k) { return JSON.stringify(k) + ':' + stable(value[k]); }).join(',') + '}';
    return JSON.stringify(value);
  }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function cartSignature(cart) {
    if (!cart || !Array.isArray(cart.items) || typeof cart.token !== 'string' || !cart.token) throw problem('INVALID_CART');
    return stable({token:cart.token, currency:cart.currency, attributes:cart.attributes || {}, note:cart.note || '',
      items:cart.items.map(function (li) { return {key:li.key, id:li.variant_id, sku:li.sku, quantity:li.quantity,
        properties:li.properties || {}, selling_plan_allocation:li.selling_plan_allocation || null}; })});
  }
  function createClient(options) {
    options = options || {};
    var transport = options.transport, coordinator = options.coordinator, journal = options.journal;
    var crypto = options.crypto || globalThis.crypto, now = options.now || Date.now;
    var wait = options.wait || function (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); };
    var prepared = new WeakMap(), captureBusy = false;
    function enabled() {
      if (options.enabled !== true) throw problem('SHARING_DISABLED');
      if (!contract || !transport || !coordinator || typeof coordinator.state !== 'function' || typeof coordinator.exclusive !== 'function') throw problem('INTEGRATION_REQUIRED');
    }
    // The future theme integration must cover ALL writers, including native/TT fallbacks.
    // Event listeners and two matching reads alone are not a mutation barrier.
    function state() {
      var s = coordinator.state();
      if (!s || s.ready !== true || s.busy !== false || typeof s.revision !== 'number' || !Number.isSafeInteger(s.revision) || typeof s.context !== 'string' || !s.context) throw problem('CART_BUSY');
      return stable(s);
    }
    function current(version) { if (state() !== version) throw problem('CART_CHANGED'); }
    function normalize(cart) { return contract.normalizeCart(cart, {allowedAttributes:options.allowedAttributes || []}); }
    function supportedDestinationMetadata(cart) {
      return !cart.note && Object.keys(cart.attributes || {}).every(function (key) {
        return (contract.NON_TRANSFERABLE_ATTRIBUTES || []).indexOf(key) !== -1;
      });
    }
    async function stableCart(allowEmpty, verificationOnly) {
      var version = state(), first = await transport.getCart(); current(version);
      var fingerprint = cartSignature(first);
      var snapshot = verificationOnly ? null : first.items.length || !allowEmpty ? normalize(first) : null;
      await wait(options.stableMs || 150);
      current(version);
      var second = await transport.getCart(); current(version);
      if (cartSignature(second) !== fingerprint) throw problem('CART_CHANGED');
      return {cart:second, snapshot:snapshot, version:version, fingerprint:fingerprint};
    }
    // Release the writer barrier before waiting for an existing producer. Keeping
    // it while polling a sentinel would prevent that same producer from settling.
    async function withSettledCart(allowEmpty, action, verificationOnly) {
      var initial = coordinator.state(), context = initial && initial.context;
      if (typeof context !== 'string' || !context) throw problem('CART_BUSY');
      var deadline = now() + (options.pendingTimeoutMs || 20000);
      for (;;) {
        var actionStarted = false;
        try {
          return await coordinator.exclusive(async function () {
            var present = coordinator.state();
            if (!present || present.context !== context) throw problem('CART_CHANGED');
            var source = await stableCart(allowEmpty, verificationOnly);
            actionStarted = true;
            return action(source);
          });
        } catch (error) {
          if (actionStarted || !error || ['CART_PENDING','CART_BUSY'].indexOf(error.code) === -1 || now() >= deadline) throw error;
          await wait(options.pollMs || 500);
          var currentContext = coordinator.state();
          if (!currentContext || currentContext.context !== context) throw problem('CART_CHANGED');
        }
      }
    }
    async function capture() {
      enabled();
      if (captureBusy) throw problem('CAPTURE_IN_PROGRESS');
      captureBusy = true;
      try {
        return await withSettledCart(false, async function (source) {
          var response = await transport.createShare(source.snapshot);
          current(source.version);
          var after = await transport.getCart(); current(source.version);
          if (cartSignature(after) !== source.fingerprint) throw problem('CART_CHANGED');
          if (!response || !/^[A-Za-z0-9_-]{43}$/.test(response.token || '') || !Number.isFinite(Date.parse(response.expiresAt)) || Date.parse(response.expiresAt) <= now()) throw problem('INVALID_SHARE_RESPONSE');
          // Only return the bearer token after confirming this is still the selected cart.
          return clone(response);
        });
      } finally { captureBusy = false; }
    }
    async function preview(token) { enabled(); return transport.getShare(validToken(token)); }
    function validToken(token) { if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw problem('INVALID_TOKEN'); return token; }
    async function prepare(token, context) {
      enabled(); validToken(token);
      if (!context || !/^[A-Z]{2}$/.test(context.country || '') || !/^[A-Z]{3}$/.test(context.currency || '')) throw problem('INVALID_CONTEXT');
      return withSettledCart(true, async function (destination) {
        if (destination.cart.items.length) throw problem('DESTINATION_NOT_EMPTY');
        // v1 never replaces a recipient's notes or attributes, even on an empty cart.
        if (!supportedDestinationMetadata(destination.cart)) throw problem('DESTINATION_METADATA_PRESENT');
        if (destination.cart.currency !== context.currency) throw problem('CURRENCY_CONTEXT_MISMATCH');
        var response = await transport.prepareShare(token, context);
        current(destination.version);
        var p = response && response.preparation;
        if (!p || p.version !== 1 || typeof p.id !== 'string' || !p.id || !Array.isArray(p.lines) || !p.lines.length || !Number.isFinite(Date.parse(p.expiresAt)) || Date.parse(p.expiresAt) <= now() || p.country !== context.country || p.currency !== context.currency || p.priceLocked !== false || p.availabilityConfirmed !== false) throw problem('INVALID_PREPARATION');
        // A transport or server integration bug must never bypass the same
        // sentinel, property, role and bundle invariants used for capture.
        try { contract.validateSnapshot({version:1, lines:p.lines, attributes:p.attributes || {}, currency:p.currency}, {allowedAttributes:options.allowedAttributes || []}); }
        catch (_) { throw problem('INVALID_PREPARATION'); }
        if (!Array.isArray(p.prices) || p.prices.length !== p.lines.length || !p.prices.every(function (price,index) {
          var line = p.lines[index], money = price && price.unitPrice;
          return price && price.lineIndex === index && price.variantId === line.variantId && price.quantity === line.quantity &&
            money && typeof money.amount === 'string' && /^\d+(?:\.\d{1,6})?$/.test(money.amount) && Number.isFinite(Number(money.amount)) && Number(money.amount) > 0 && money.currencyCode === p.currency;
        })) throw problem('INVALID_PREPARATION');
        // Attribute writes are a separate non-atomic endpoint. v1 refuses them on restore.
        if (Object.keys(p.attributes || {}).length) throw problem('ATTRIBUTE_RESTORE_UNSUPPORTED');
        var after = await transport.getCart(); current(destination.version);
        if (cartSignature(after) !== destination.fingerprint) throw problem('CART_CHANGED');
        var handle = Object.freeze({id:p.id, expiresAt:p.expiresAt, country:p.country, currency:p.currency,
          lines:clone(p.lines), prices:clone(p.prices || []), priceLocked:false, availabilityConfirmed:false, checkoutReady:false});
        // Use a private copy: callers cannot change the reviewed payload through the handle.
        prepared.set(handle, {token:token, preparation:clone(p), destination:destination});
        return handle;
      });
    }
    async function digest(text) {
      if (!crypto || !crypto.subtle || typeof crypto.randomUUID !== 'function') throw problem('SECURE_CRYPTO_REQUIRED');
      return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))).map(function (b) { return b.toString(16).padStart(2,'0'); }).join('');
    }
    function readReceipt(key) {
      if (!journal || typeof journal.get !== 'function' || typeof journal.set !== 'function') throw problem('DURABLE_JOURNAL_REQUIRED');
      try {
        var raw = journal.get(key);
        if (raw == null) return null;
        var record = JSON.parse(raw);
        if (!record || record.version !== 1 || typeof record.operation !== 'string' || !record.operation || !Array.isArray(record.items) || !record.items.length || record.items.length > 30 || !Array.isArray(record.skus) || record.skus.length !== record.items.length || !/^[A-Z]{3}$/.test(record.currency || '') || !['uncertain','complete'].includes(record.state)) throw Error();
        record.items.forEach(function (item,index) {
          if (!item || typeof item.id !== 'string' || !/^[1-9]\d{0,15}$/.test(item.id) || !Number.isSafeInteger(Number(item.id)) || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 10 || !item.properties || typeof item.properties !== 'object' || Array.isArray(item.properties) || item.properties[IMPORT] !== record.operation || item.properties[LINE] !== String(index) || typeof record.skus[index] !== 'string') throw Error();
        });
        return record;
      } catch (_) { throw problem('RESTORE_JOURNAL_UNAVAILABLE'); }
    }
    function saveReceipt(key, receipt) {
      var encoded = JSON.stringify(receipt);
      try { journal.set(key, encoded); if (journal.get(key) !== encoded) throw Error(); }
      catch (_) { throw problem('RESTORE_JOURNAL_UNAVAILABLE'); }
    }
    function restored(cart, receipt) {
      var owned = cart.items.filter(function (li) { return (li.properties || {})[IMPORT] === receipt.operation; });
      var complete = owned.length === receipt.items.length && receipt.items.every(function (expected, index) {
        var matches = owned.filter(function (li) { return (li.properties || {})[LINE] === expected.properties[LINE]; });
        if (matches.length !== 1) return false;
        var actual = matches[0], props = actual.properties || {};
        // Shopify may omit empty properties. Missing size stays unsized; never invent one.
        return String(actual.variant_id) === String(expected.id) && actual.sku === receipt.skus[index] && actual.quantity === expected.quantity &&
          String(actual.variant_id) !== '51975403077948' && !props._pending_diamond_id && !actual.selling_plan_allocation && !actual.selling_plan && !actual.parent_relationship && !(Array.isArray(actual.item_components) && actual.item_components.length) &&
          Object.keys(expected.properties).every(function (k) { return props[k] === expected.properties[k] || (expected.properties[k] === '' && !Object.prototype.hasOwnProperty.call(props,k)); }) &&
          Object.keys(props).every(function (k) { return Object.prototype.hasOwnProperty.call(expected.properties,k); });
      });
      return complete && cart.items.length === owned.length ? 'complete' : owned.length ? 'partial' : 'none';
    }
    async function restore(handle) {
      enabled();
      var entry = prepared.get(handle);
      if (!entry) throw problem('PREPARE_REQUIRED');
      return coordinator.exclusive(async function () {
        var p = entry.preparation, source = entry.destination;
        if (Date.parse(p.expiresAt) <= now()) throw problem('PREPARATION_EXPIRED');
        current(source.version);
        var key = 'diyShare:v1:' + await digest(source.cart.token + '\n' + entry.token);
        current(source.version);
        var receipt = readReceipt(key), before = await transport.getCart(); current(source.version);
        if (before.token !== source.cart.token || before.currency !== p.currency) throw problem('CART_CHANGED');
        if (receipt) {
          var outcome = restored(before, receipt);
          if (outcome === 'complete') return {cart:before, alreadyRestored:true, checkoutReady:false};
          throw problem(outcome === 'partial' ? 'RESTORE_PARTIAL' : 'RESTORE_UNCERTAIN');
        }
        if (cartSignature(before) !== source.fingerprint || before.items.length) throw problem('CART_CHANGED');
        var operation = crypto.randomUUID(), groups = Object.create(null);
        var items = p.lines.map(function (line, index) {
          var group = line.groupId || 'line-' + index;
          if (!groups[group]) groups[group] = crypto.randomUUID();
          var props = Object.assign({}, line.properties || {});
          props._diy_operation_v1 = groups[group]; props[IMPORT] = operation; props[LINE] = String(index);
          return {id:line.variantId, quantity:line.quantity, properties:props};
        });
        receipt = {version:1, operation:operation, state:'uncertain', items:items, skus:p.lines.map(function (line) { return line.sku; }), currency:p.currency};
        // Persist before dispatch. No automatic replay after timeout, reload, partial 422 or 5xx.
        if (Date.parse(p.expiresAt) <= now()) throw problem('PREPARATION_EXPIRED');
        saveReceipt(key, receipt);
        current(source.version);
        var addError = null;
        try { await transport.addItems(items); } catch (e) { addError = e; }
        var after;
        try { after = await transport.getCart(); cartSignature(after); }
        catch (_) { throw problem('RESTORE_UNCERTAIN'); }
        current(source.version);
        if (after.token !== source.cart.token || after.currency !== p.currency || !supportedDestinationMetadata(after) || stable(after.attributes || {}) !== stable(source.cart.attributes || {})) throw problem('RESTORE_UNCERTAIN');
        var result = restored(after,receipt);
        if (result !== 'complete') throw problem(result === 'partial' ? 'RESTORE_PARTIAL' : 'RESTORE_UNCERTAIN');
        receipt.state = 'complete'; saveReceipt(key,receipt);
        // The normal cart renderer/checkout guards must refresh dates and require missing sizes.
        return {cart:after, added:true, recoveredLostResponse:!!addError, checkoutReady:false};
      });
    }
    // Recovery is an inspection operation, including after reload or preparation
    // expiry. It never prepares, adds, removes, or refreshes a cart line.
    async function recover(token) {
      enabled(); validToken(token);
      return withSettledCart(true, async function (source) {
        var key = 'diyShare:v1:' + await digest(source.cart.token + '\n' + token);
        current(source.version);
        var receipt = readReceipt(key);
        if (!receipt) throw problem('RESTORE_NOT_FOUND');
        if (source.cart.currency !== receipt.currency || !supportedDestinationMetadata(source.cart)) throw problem('RESTORE_UNCERTAIN');
        var outcome = restored(source.cart, receipt);
        if (outcome !== 'complete') throw problem(outcome === 'partial' ? 'RESTORE_PARTIAL' : 'RESTORE_UNCERTAIN');
        return {cart:source.cart, alreadyRestored:true, recovered:true, checkoutReady:false};
      }, true);
    }
    return Object.freeze({capture:capture, preview:preview, prepare:prepare, restore:restore, recover:recover});
  }
  function createBrowserTransport(options) {
    options = options || {};
    var api = new URL(options.apiUrl);
    if (api.protocol !== 'https:' || api.username || api.password || api.search || api.hash) throw problem('INVALID_API_URL');
    var root = options.root || '/';
    if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(root)) throw problem('INVALID_CART_ROOT');
    var fetchImpl = options.fetch || globalThis.fetch;
    async function request(url, method, body, cart) {
      var response = await fetchImpl(url,{method:method, credentials:cart?'same-origin':'omit', cache:'no-store', redirect:'error',
        headers:{Accept:'application/json', 'Content-Type':'application/json'},
        body:body === undefined ? undefined : JSON.stringify(body), signal:AbortSignal.timeout(15000)});
      var data;
      try { data = await response.json(); } catch (_) { throw problem('INVALID_RESPONSE'); }
      if (!response.ok) throw problem(data && data.error || 'REQUEST_FAILED');
      return data;
    }
    return Object.freeze({
      getCart:function () { return request(root+'cart.js','GET',undefined,true); },
      addItems:function (items) { return request(root+'cart/add.js','POST',{items:items},true); },
      createShare:function (snapshot) { return request(api.href,'POST',{action:'create',snapshot:snapshot}); },
      getShare:function (token) { return request(api.href+'?token='+encodeURIComponent(token),'GET'); },
      prepareShare:function (token,context) { return request(api.href,'POST',{action:'prepare',token:token,country:context.country,currency:context.currency}); }
    });
  }
  function createStorageJournal(storage) {
    return {get:function (key) { return storage.getItem(key); }, set:function (key,value) { storage.setItem(key,value); }};
  }
  return {createClient:createClient, createBrowserTransport:createBrowserTransport, createStorageJournal:createStorageJournal};
}));
