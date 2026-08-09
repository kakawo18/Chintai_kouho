// Leaflet の地図、物件ピン、位置ピッカー。
(function (Chintai) {
  'use strict';

  var TOKYO = [35.681236, 139.767125];
  var map = null;
  var markers = {};       // id -> L.Marker
  var layer = null;
  var selectedId = null;
  var onSelect = function () {};
  var picking = false;

  function init(elementId, options) {
    onSelect = (options && options.onSelect) || onSelect;

    var saved = Chintai.session.loadViewState().map;
    map = L.map(elementId, { zoomControl: false, attributionControl: true })
      .setView(saved ? [saved.lat, saved.lng] : TOKYO, saved ? saved.zoom : 12);

    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    layer = L.layerGroup().addTo(map);

    map.on('moveend', function () {
      var c = map.getCenter();
      var state = Chintai.session.loadViewState();
      state.map = { lat: c.lat, lng: c.lng, zoom: map.getZoom() };
      Chintai.session.saveViewState(state);
    });

    return map;
  }

  // ピンは divIcon で自作する。ステータスで色を変え、中に実質月額を出すことで、
  // 地図を眺めるだけでエリアごとの相場が掴めるようにしている。
  function buildIcon(p, isSelected) {
    var total = Chintai.model.monthlyTotal(p);
    var label = total === null ? '—' : Chintai.model.formatMan(total);
    var color = Chintai.model.statusColor(p.status);
    var cls = 'pin' + (isSelected ? ' pin--selected' : '');
    var html = '<div class="' + cls + '" style="--pin-color:' + color + '">' +
      '<span class="pin__label">' + escapeHtml(label) + '</span>' +
      '<span class="pin__tail"></span>' +
      '</div>';
    return L.divIcon({
      className: 'pin-wrap',
      html: html,
      iconSize: [56, 34],
      iconAnchor: [28, 34]
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 表示対象は絞り込み後の配列がそのまま渡ってくるので、一覧と地図が食い違うことはない
  function render(properties, currentSelectedId) {
    selectedId = currentSelectedId || null;
    layer.clearLayers();
    markers = {};

    properties.forEach(function (p) {
      if (p.lat === null || p.lng === null) return;
      var marker = L.marker([p.lat, p.lng], {
        icon: buildIcon(p, p.id === selectedId),
        zIndexOffset: p.id === selectedId ? 1000 : 0
      });
      marker.on('click', function () { onSelect(p.id); });
      marker.addTo(layer);
      markers[p.id] = marker;
    });
  }

  function focus(p, zoom) {
    if (!p || p.lat === null || p.lng === null) return;
    map.setView([p.lat, p.lng], zoom || Math.max(map.getZoom(), 15), { animate: true });
  }

  // 一覧が空でないときだけ全体表示にする（0件で世界地図まで引くのを防ぐ）
  function fitAll(properties) {
    var points = properties
      .filter(function (p) { return p.lat !== null && p.lng !== null; })
      .map(function (p) { return [p.lat, p.lng]; });
    if (!points.length) return false;
    if (points.length === 1) {
      map.setView(points[0], 15);
    } else {
      map.fitBounds(L.latLngBounds(points), { padding: [48, 48], maxZoom: 16 });
    }
    return true;
  }

  // 位置ピッカー。スマホでは一点タップより地図を動かすほうが確実なので、
  // 画面中央の十字に合わせてもらう方式にしている。
  function startPicker(initial) {
    picking = true;
    document.body.classList.add('is-picking');
    if (initial && initial.lat !== null && initial.lng !== null) {
      map.setView([initial.lat, initial.lng], Math.max(map.getZoom(), 16));
    }
    map.invalidateSize();
  }

  function stopPicker() {
    picking = false;
    document.body.classList.remove('is-picking');
  }

  function pickedPosition() {
    var c = map.getCenter();
    return { lat: c.lat, lng: c.lng };
  }

  function isPicking() {
    return picking;
  }

  function invalidate() {
    if (map) map.invalidateSize();
  }

  Chintai.map = {
    init: init,
    render: render,
    focus: focus,
    fitAll: fitAll,
    startPicker: startPicker,
    stopPicker: stopPicker,
    pickedPosition: pickedPosition,
    isPicking: isPicking,
    invalidate: invalidate
  };
})(window.Chintai = window.Chintai || {});
