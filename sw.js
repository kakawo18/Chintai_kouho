// アプリ本体をキャッシュしてオフラインでも起動できるようにする。
// 地図タイルは「一度見たエリア」だけを残す。OSM の利用規約に反する一括取得はしない。
//
// 更新の扱いについて:
//   以前はキャッシュ優先で配信していたため、更新後に「新しい HTML と古い JS」が
//   混ざり、画面にボタンはあるのに何も起きない状態が起こり得た。
//   そこでアプリ本体は通信優先にし、通信できないときだけキャッシュを使う。
//   オフラインでの起動はこれまでどおり可能で、常に版が揃うようになる。
var APP_VERSION = 'v3';
var SHELL_CACHE = 'chintai-shell-' + APP_VERSION;
var TILE_CACHE = 'chintai-tiles-v1';
var TILE_LIMIT = 400;

var SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/style.css',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/images/marker-icon.png',
  './vendor/leaflet/images/marker-icon-2x.png',
  './vendor/leaflet/images/marker-shadow.png',
  './vendor/leaflet/images/layers.png',
  './vendor/leaflet/images/layers-2x.png',
  './vendor/firebase/firebase-app-compat.js',
  './vendor/firebase/firebase-auth-compat.js',
  './vendor/firebase/firebase-firestore-compat.js',
  './js/firebase-config.js',
  './js/model.js',
  './js/session.js',
  './js/db.js',
  './js/geo.js',
  './js/extract.js',
  './js/map.js',
  './js/ui.js',
  './js/form.js',
  './js/app.js'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      // cache: 'reload' を付けないとブラウザのHTTPキャッシュから古い版を拾い、
      // 新しいキャッシュに古い中身が入ってしまう。
      return cache.addAll(SHELL.map(function (url) {
        return new Request(url, { cache: 'reload' });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key !== SHELL_CACHE && key !== TILE_CACHE) return caches.delete(key);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

// 古いタイルから捨てて、キャッシュが際限なく膨らまないようにする
function trimCache(cacheName, limit) {
  caches.open(cacheName).then(function (cache) {
    cache.keys().then(function (keys) {
      if (keys.length <= limit) return;
      Promise.all(keys.slice(0, keys.length - limit).map(function (k) {
        return cache.delete(k);
      }));
    });
  });
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);

  // Firestore / 認証 / 住所検索は必ずネットワークに任せる
  if (url.hostname.indexOf('googleapis.com') !== -1 ||
      url.hostname.indexOf('firebaseio.com') !== -1 ||
      url.hostname.indexOf('nominatim.openstreetmap.org') !== -1) {
    return;
  }

  if (url.hostname.indexOf('tile.openstreetmap.org') !== -1) {
    event.respondWith(
      caches.open(TILE_CACHE).then(function (cache) {
        return cache.match(req).then(function (cached) {
          var network = fetch(req).then(function (res) {
            if (res && res.status === 200) {
              cache.put(req, res.clone());
              trimCache(TILE_CACHE, TILE_LIMIT);
            }
            return res;
          }).catch(function () { return cached; });
          return cached || network;
        });
      })
    );
    return;
  }

  if (url.origin !== location.origin) return;

  // アプリ本体は通信優先。更新した内容がその場で反映され、版が混ざらない。
  // 圏外や機内モードでは取得に失敗するので、そのときだけキャッシュを返す。
  event.respondWith(
    fetch(req).then(function (res) {
      if (res && res.status === 200) {
        var copy = res.clone();
        caches.open(SHELL_CACHE).then(function (cache) { cache.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (cached) {
        if (cached) return cached;
        // 直接開いた URL がキャッシュに無い場合でも、入口だけは返して起動させる
        if (req.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      });
    })
  );
});
