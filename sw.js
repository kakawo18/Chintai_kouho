// アプリ本体をキャッシュしてオフラインでも起動できるようにする。
// 地図タイルは「一度見たエリア」だけを残す。OSM の利用規約に反する一括取得はしない。
var SHELL_CACHE = 'chintai-shell-v1';
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
      return cache.addAll(SHELL);
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

  // アプリ本体はキャッシュ優先。裏で更新しておき、次回の起動から新しくなる。
  event.respondWith(
    caches.match(req).then(function (cached) {
      var network = fetch(req).then(function (res) {
        if (res && res.status === 200) {
          var copy = res.clone();
          caches.open(SHELL_CACHE).then(function (cache) { cache.put(req, copy); });
        }
        return res;
      }).catch(function () { return cached; });
      return cached || network;
    })
  );
});
