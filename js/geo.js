// Nominatim（OpenStreetMap）による住所検索と逆引き。
// 日本の番地までは当たらないことが珍しくないため、失敗は異常系ではなく通常の分岐として扱い、
// 呼び出し側は必ず「地図で位置を指定」に誘導できるようにしてある。
(function (Chintai) {
  'use strict';

  var ENDPOINT = 'https://nominatim.openstreetmap.org';
  var MIN_INTERVAL_MS = 1100; // Nominatim の利用規約（1リクエスト/秒以下）を守る
  var lastCallAt = 0;
  var queue = Promise.resolve();

  // 直列化したうえで最低間隔を空ける。入力のたびに呼ばれても規約を破らない。
  function throttled(fn) {
    queue = queue.then(function () {
      var wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastCallAt));
      return new Promise(function (resolve) { setTimeout(resolve, wait); });
    }).then(function () {
      lastCallAt = Date.now();
      return fn();
    }).catch(function (err) {
      // 1件の失敗で以降の検索が止まらないよう、キューは必ず正常系に戻す
      return Promise.reject(err);
    });

    var result = queue;
    queue = queue.catch(function () { return null; });
    return result;
  }

  function search(query) {
    if (!query || query.trim().length < 2) return Promise.resolve([]);
    var url = ENDPOINT + '/search?format=jsonv2&countrycodes=jp&limit=5&accept-language=ja&q=' +
      encodeURIComponent(query.trim());

    return throttled(function () {
      return fetch(url, { headers: { 'Accept': 'application/json' } })
        .then(function (res) {
          if (!res.ok) throw new Error('検索に失敗しました (' + res.status + ')');
          return res.json();
        })
        .then(function (items) {
          return (items || []).map(function (it) {
            return {
              label: it.display_name,
              lat: parseFloat(it.lat),
              lng: parseFloat(it.lon)
            };
          });
        });
    });
  }

  function reverse(lat, lng) {
    var url = ENDPOINT + '/reverse?format=jsonv2&accept-language=ja&lat=' + lat + '&lon=' + lng;
    return throttled(function () {
      return fetch(url, { headers: { 'Accept': 'application/json' } })
        .then(function (res) {
          if (!res.ok) throw new Error('住所の取得に失敗しました');
          return res.json();
        })
        .then(function (data) {
          return (data && data.display_name) ? data.display_name : '';
        });
    });
  }

  /* ---------- 候補の照合 ---------- */

  // 「宮前町」「本町」のような町名は全国にいくつもある。検索結果の1位が
  // 目的の市区町村とは限らないため、都道府県と市区町村が一致しているかを
  // 確かめてから採用する。ここを省くと、まったく違う土地にピンが立つ。

  // 住所文字列を、照合に使う単位に分ける
  function addressParts(address) {
    var s = String(address || '').replace(/\s+/g, '');
    var pref = (s.match(/^(.{2,3}?[都道府県])/) || [])[1] || '';
    var rest = pref ? s.slice(pref.length) : s;

    // 政令指定都市は「川崎市川崎区」のように市と区が続く
    var city = (rest.match(/^(.+?[市郡])/) || [])[1] || (rest.match(/^(.+?区)/) || [])[1] || '';
    var ward = '';
    if (city && /[市郡]$/.test(city)) {
      ward = (rest.slice(city.length).match(/^(.+?[区町村])/) || [])[1] || '';
    }
    return { pref: pref, city: city, ward: ward };
  }

  // 検索結果の表記と、探している住所がどれだけ噛み合っているか
  function scoreOf(label, parts) {
    var s = String(label || '').replace(/\s+/g, '');
    var score = 0;
    // 「神奈川県」と「神奈川」の表記ゆれを吸収するため接尾辞を落として比べる
    if (parts.pref && s.indexOf(parts.pref.replace(/[都道府県]$/, '')) !== -1) score += 1;
    if (parts.city && s.indexOf(parts.city) !== -1) score += 2;
    if (parts.ward && s.indexOf(parts.ward) !== -1) score += 2;
    return score;
  }

  // 都道府県と市区町村の両方が一致した候補だけを返す。
  // 一致するものが無ければ null。勝手に決めるより、決めないほうが安全。
  function pickBest(items, address) {
    var parts = addressParts(address);
    if (!parts.pref && !parts.city) return null;

    var best = null;
    var bestScore = 0;
    (items || []).forEach(function (it) {
      var s = scoreOf(it.label, parts);
      if (s > bestScore) { bestScore = s; best = it; }
    });

    var need = (parts.pref ? 1 : 0) + (parts.city ? 2 : 0);
    return bestScore >= need ? best : null;
  }

  // 町名まで含めて見つからないときのために、市区町村までに切り詰めた住所を作る。
  // 違う土地に立てるくらいなら、範囲を広げて正しい市区町村に置くほうがよい。
  function coarser(address) {
    var p = addressParts(address);
    if (!p.city) return '';
    var coarse = p.pref + p.city + p.ward;
    return coarse === String(address || '').replace(/\s+/g, '') ? '' : coarse;
  }

  Chintai.geo = {
    search: search,
    reverse: reverse,
    pickBest: pickBest,
    coarser: coarser,
    addressParts: addressParts
  };
})(window.Chintai = window.Chintai || {});
