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

  Chintai.geo = { search: search, reverse: reverse };
})(window.Chintai = window.Chintai || {});
