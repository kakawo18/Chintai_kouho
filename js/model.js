// 物件データのスキーマ、派生値の計算、絞り込み・並べ替え、JSON 入出力。
// 保存する値と表示する値を分け、家賃の合計などは常にここで計算する。
(function (Chintai) {
  'use strict';

  var STATUSES = [
    { key: 'interested', label: '気になる', color: '#2f6fd0' },
    { key: 'scheduled', label: '内見予定', color: '#e08a1e' },
    { key: 'visited', label: '内見済', color: '#2a9d5c' },
    { key: 'rejected', label: '候補外', color: '#8a8f98' }
  ];

  var STATUS_BY_KEY = {};
  STATUSES.forEach(function (s) { STATUS_BY_KEY[s.key] = s; });

  var LAYOUTS = ['1R', '1K', '1DK', '1LDK', '2K', '2DK', '2LDK', '3DK', '3LDK', '4LDK以上'];

  function statusLabel(key) {
    return (STATUS_BY_KEY[key] || STATUS_BY_KEY.interested).label;
  }

  function statusColor(key) {
    return (STATUS_BY_KEY[key] || STATUS_BY_KEY.interested).color;
  }

  // 数値欄は空文字を null として保持する（0 と「未入力」を区別するため）
  function num(value) {
    if (value === null || value === undefined || value === '') return null;
    var n = Number(value);
    return isFinite(n) ? n : null;
  }

  function str(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  // Firestore から読んだ生データを、画面が前提にできる形に整える
  function normalize(id, raw) {
    var d = raw || {};
    return {
      id: id,
      name: str(d.name) || '(名称未設定)',
      address: str(d.address),
      lat: num(d.lat),
      lng: num(d.lng),
      rent: num(d.rent),
      adminFee: num(d.adminFee),
      depositMonths: num(d.depositMonths),
      keyMoneyMonths: num(d.keyMoneyMonths),
      layout: str(d.layout),
      areaSqm: num(d.areaSqm),
      builtYear: num(d.builtYear),
      floor: num(d.floor),
      line: str(d.line),
      station: str(d.station),
      walkMin: num(d.walkMin),
      commuteMin: num(d.commuteMin),
      commuteNote: str(d.commuteNote),
      imageUrls: Array.isArray(d.imageUrls) ? d.imageUrls.filter(function (u) { return !!str(u); }) : [],
      url: str(d.url),
      memo: str(d.memo),
      ratings: (d.ratings && typeof d.ratings === 'object') ? d.ratings : {},
      status: STATUS_BY_KEY[d.status] ? d.status : 'interested',
      createdBy: str(d.createdBy),
      updatedBy: str(d.updatedBy),
      createdAt: toMillis(d.createdAt),
      updatedAt: toMillis(d.updatedAt)
    };
  }

  // Firestore の Timestamp / 数値 / ISO 文字列のいずれで来ても扱えるようにする
  function toMillis(value) {
    if (!value) return null;
    if (typeof value === 'number') return value;
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (typeof value === 'string') {
      var t = Date.parse(value);
      return isNaN(t) ? null : t;
    }
    return null;
  }

  // 実質月額。家賃と管理費のどちらも未入力なら null（0円と区別する）
  function monthlyTotal(p) {
    if (p.rent === null && p.adminFee === null) return null;
    return (p.rent || 0) + (p.adminFee || 0);
  }

  // 初期費用の目安。敷金・礼金はヶ月で持ち、家賃から円に換算する
  function initialCost(p) {
    if (p.rent === null) return null;
    var months = (p.depositMonths || 0) + (p.keyMoneyMonths || 0);
    return Math.round(months * p.rent) + (monthlyTotal(p) || 0);
  }

  function buildingAge(p) {
    if (p.builtYear === null) return null;
    return new Date().getFullYear() - p.builtYear;
  }

  function formatYen(value) {
    if (value === null || value === undefined) return '—';
    return value.toLocaleString('ja-JP') + '円';
  }

  // 地図のピンや一覧の見出しで使う「8.5万」形式
  function formatMan(value) {
    if (value === null || value === undefined) return '—';
    var man = value / 10000;
    return (Math.round(man * 10) / 10) + '万';
  }

  function ratingOf(p, uid) {
    var r = p.ratings[uid];
    return typeof r === 'number' ? r : 0;
  }

  function maxRating(p) {
    var values = Object.keys(p.ratings).map(function (k) { return p.ratings[k]; });
    return values.length ? Math.max.apply(null, values) : 0;
  }

  var DEFAULT_FILTER = {
    keyword: '',
    maxRent: null,
    layouts: [],
    minRating: 0,
    ratingWho: 'any', // 'any' | 'mine' | 'theirs'
    statuses: ['interested', 'scheduled', 'visited'] // 「候補外」は既定で隠す
  };

  function filter(properties, f, uid) {
    var kw = f.keyword.trim().toLowerCase();
    return properties.filter(function (p) {
      if (f.statuses.length && f.statuses.indexOf(p.status) === -1) return false;

      if (f.maxRent !== null) {
        var total = monthlyTotal(p);
        // 家賃未入力の物件は上限で絞ったときに落とす（比較対象にならないため）
        if (total === null || total > f.maxRent) return false;
      }

      if (f.layouts.length && f.layouts.indexOf(p.layout) === -1) return false;

      if (f.minRating > 0) {
        var r;
        if (f.ratingWho === 'mine') {
          r = ratingOf(p, uid);
        } else if (f.ratingWho === 'theirs') {
          r = Object.keys(p.ratings).reduce(function (acc, k) {
            return k === uid ? acc : Math.max(acc, p.ratings[k] || 0);
          }, 0);
        } else {
          r = maxRating(p);
        }
        if (r < f.minRating) return false;
      }

      if (kw) {
        var hay = [p.name, p.address, p.station, p.line, p.memo].join(' ').toLowerCase();
        if (hay.indexOf(kw) === -1) return false;
      }

      return true;
    });
  }

  var SORTS = [
    { key: 'newest', label: '登録が新しい順' },
    { key: 'rentAsc', label: '実質月額が安い順' },
    { key: 'ratingDesc', label: '★が高い順' },
    { key: 'walkAsc', label: '駅から近い順' }
  ];

  // 未入力の値は常に末尾へ送る（安い順の先頭が「未入力」で埋まるのを防ぐ）
  function nullsLast(a, b, cmp) {
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return cmp(a, b);
  }

  function sort(properties, sortKey) {
    var list = properties.slice();
    list.sort(function (a, b) {
      switch (sortKey) {
        case 'rentAsc':
          return nullsLast(monthlyTotal(a), monthlyTotal(b), function (x, y) { return x - y; });
        case 'ratingDesc':
          return maxRating(b) - maxRating(a);
        case 'walkAsc':
          return nullsLast(a.walkMin, b.walkMin, function (x, y) { return x - y; });
        default:
          return (b.createdAt || 0) - (a.createdAt || 0);
      }
    });
    return list;
  }

  // 書き出し用。id と表示専用の派生値は含めず、復元に必要な値だけを残す
  function toExport(properties) {
    return {
      app: 'chintai-kouho',
      version: 1,
      exportedAt: new Date().toISOString(),
      properties: properties.map(function (p) {
        var o = {};
        Object.keys(p).forEach(function (k) {
          if (k !== 'id') o[k] = p[k];
        });
        o.id = p.id;
        return o;
      })
    };
  }

  function parseImport(text) {
    var data = JSON.parse(text);
    var list = data && Array.isArray(data.properties) ? data.properties : null;
    if (!list) throw new Error('物件データが見つかりませんでした');
    return list.map(function (raw) { return normalize(raw.id || null, raw); });
  }

  Chintai.model = {
    STATUSES: STATUSES,
    LAYOUTS: LAYOUTS,
    SORTS: SORTS,
    DEFAULT_FILTER: DEFAULT_FILTER,
    statusLabel: statusLabel,
    statusColor: statusColor,
    normalize: normalize,
    num: num,
    monthlyTotal: monthlyTotal,
    initialCost: initialCost,
    buildingAge: buildingAge,
    formatYen: formatYen,
    formatMan: formatMan,
    ratingOf: ratingOf,
    maxRating: maxRating,
    filter: filter,
    sort: sort,
    toExport: toExport,
    parseImport: parseImport
  };
})(window.Chintai = window.Chintai || {});
