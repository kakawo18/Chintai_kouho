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

  // 元のページに住所がどこまで書かれていたか。
  // 物件サイトは番地を伏せていることが多く、そのまま地図に点で置くと
  // 「確かめた位置」と見分けがつかなくなる。どこまで書かれていたかを持っておき、
  // 足りないものは点ではなく範囲（半径メートル）として描くために使う。
  var ADDRESS_LEVELS = [
    { key: 'banchi', label: '番地まで', radius: 0 },
    { key: 'chome', label: '丁目まで', radius: 300 },
    { key: 'town', label: '町名まで', radius: 800 },
    { key: 'city', label: '市区町村まで', radius: 3000 }
  ];

  var ADDRESS_LEVEL_BY_KEY = {};
  ADDRESS_LEVELS.forEach(function (l) { ADDRESS_LEVEL_BY_KEY[l.key] = l; });

  // 粒度が分からないまま未確定になった場合の半径
  var DEFAULT_APPROX_RADIUS = 500;

  // 横浜〜東京のあいだを走る路線（一本で行けるかどうかは問わない）。
  // 探すエリアが変わったらこの配列を書き換えるだけで選択肢が入れ替わる。
  var LINE_GROUPS = [
    { company: 'JR', lines: [
      'JR東海道線', 'JR横須賀線', 'JR京浜東北・根岸線', 'JR湘南新宿ライン',
      'JR上野東京ライン', 'JR山手線', 'JR横浜線', 'JR南武線', 'JR鶴見線'
    ] },
    { company: '東急', lines: [
      '東急東横線', '東急目黒線', '東急田園都市線', '東急大井町線',
      '東急池上線', '東急多摩川線', '東急新横浜線'
    ] },
    { company: '京急', lines: ['京急本線', '京急大師線', '京急逗子線'] },
    { company: '相鉄', lines: ['相鉄本線', '相鉄いずみ野線', '相鉄新横浜線'] },
    { company: '横浜市営地下鉄', lines: ['ブルーライン', 'グリーンライン'] },
    { company: 'その他', lines: [
      'みなとみらい線', '東京メトロ日比谷線', '東京メトロ南北線', '都営三田線',
      '東京モノレール', 'りんかい線', '小田急線', '東海道新幹線'
    ] }
  ];

  var ALL_LINES = LINE_GROUPS.reduce(function (acc, g) {
    return acc.concat(g.lines);
  }, []);

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
      addressLevel: ADDRESS_LEVEL_BY_KEY[d.addressLevel] ? d.addressLevel : '',
      // 位置を人が確かめたかどうか。あとから足した項目なので、
      // 値が無いものは確定済みとして扱う（過去の物件が一斉に「要確認」になるのを防ぐ）。
      locationFixed: d.locationFixed !== false,
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

  // 築年数は入力しやすさを優先して「◯年」で受け取るが、保存するのは築年（西暦）。
  // 年数のまま保存すると年が変わるたびに値が古くなるため、時間が経っても狂わない西暦に直す。
  function buildingAge(p) {
    if (p.builtYear === null) return null;
    return new Date().getFullYear() - p.builtYear;
  }

  function ageToBuiltYear(age) {
    if (age === null) return null;
    return new Date().getFullYear() - age;
  }

  function builtYearToAge(year) {
    if (year === null) return null;
    return new Date().getFullYear() - year;
  }

  /* ---------- 位置の確からしさ ---------- */

  function isLocationApprox(p) {
    return p.locationFixed === false;
  }

  function approxRadius(p) {
    var level = ADDRESS_LEVEL_BY_KEY[p.addressLevel];
    return (level && level.radius) ? level.radius : DEFAULT_APPROX_RADIUS;
  }

  function addressLevelLabel(key) {
    var level = ADDRESS_LEVEL_BY_KEY[key];
    return level ? level.label : '';
  }

  // なぜ確定していないのかを一言で伝える。原因が分かれば直しようがある。
  function approxNote(p) {
    var label = addressLevelLabel(p.addressLevel);
    return label
      ? '住所が' + label + 'しか書かれていなかったため、おおよその位置です'
      : '位置がまだ確かめられていません';
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
    statuses: ['interested', 'scheduled', 'visited'], // 「候補外」は既定で隠す
    approxOnly: false // 位置が未確定のものだけを出す（あとでまとめて直すため）
  };

  function filter(properties, f, uid) {
    var kw = f.keyword.trim().toLowerCase();
    return properties.filter(function (p) {
      if (f.approxOnly && !isLocationApprox(p)) return false;

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
    LINE_GROUPS: LINE_GROUPS,
    ALL_LINES: ALL_LINES,
    ADDRESS_LEVELS: ADDRESS_LEVELS,
    SORTS: SORTS,
    DEFAULT_FILTER: DEFAULT_FILTER,
    statusLabel: statusLabel,
    statusColor: statusColor,
    normalize: normalize,
    num: num,
    monthlyTotal: monthlyTotal,
    initialCost: initialCost,
    buildingAge: buildingAge,
    ageToBuiltYear: ageToBuiltYear,
    builtYearToAge: builtYearToAge,
    isLocationApprox: isLocationApprox,
    approxRadius: approxRadius,
    approxNote: approxNote,
    addressLevelLabel: addressLevelLabel,
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
