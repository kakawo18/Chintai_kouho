// 物件ページの URL か、貼り付けたテキストから項目を取り出す。
// 実際の取得と抽出は worker/ の中継サーバーが行う。API キーはこちら側には存在しない。
(function (Chintai) {
  'use strict';

  var M = Chintai.model;

  var ADDRESS_LEVELS = ['banchi', 'chome', 'town', 'city'];

  // 「1-2-3」「1番2号」のような番地の並びが実際にあるか。
  // モデルが banchi と答えても、住所にその形が無ければ信用しない。
  // 取りこぼす側（＝要確認として残る）に倒すほうが、
  // 確かめずに済ませてしまうより安全なため。
  function hasBanchi(address) {
    if (!address) return false;
    var tail = address.replace(/^.*?[都道府県]/, '');
    return /\d+\s*[-−ー–—]\s*\d+/.test(tail) ||
           /\d+\s*番/.test(tail) ||
           /\d+\s*号/.test(tail);
  }

  function isUrl(value) {
    return /^https?:\/\/\S+$/i.test(value.trim());
  }

  function isConfigured() {
    var c = Chintai.session.getExtractConfig();
    return !!(c.endpoint && c.passphrase);
  }

  // 入力が URL ならページ取得から、そうでなければ貼られた文字から抽出する
  function run(input) {
    var conf = Chintai.session.getExtractConfig();
    if (!conf.endpoint || !conf.passphrase) {
      return Promise.reject(new Error('自動入力の設定がされていません'));
    }

    var value = String(input || '').trim();
    if (!value) return Promise.reject(new Error('URL か物件情報を入れてください'));

    var body = { passphrase: conf.passphrase };
    if (isUrl(value)) body.url = value; else body.text = value;

    return fetch(conf.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (res) {
      if (res.status === 401) throw new Error('合言葉が違います。設定を見直してください');
      if (!res.ok) throw new Error('中継サーバーに接続できませんでした (' + res.status + ')');
      return res.json();
    }).then(function (data) {
      if (data.error) throw new Error(messageFor(data.error, data.status, data.detail));
      return normalize(data.property || {}, isUrl(value) ? value : '');
    });
  }

  function messageFor(code, status, detail) {
    switch (code) {
      case 'fetch_failed':
        return 'ページを取得できませんでした（' + (status || '応答なし') +
          '）。ページの文字をコピーして貼ってください。';
      case 'page_empty':
        return 'このページは中身を読み取れませんでした。' +
          'ページの文字をコピーして貼ってください。';
      case 'model_failed':
        // モデル名を変えた直後は 404 / 400 が返る。原因が分かる形で出す。
        if (status === 404 || status === 400) {
          return '抽出に失敗しました（' + status + '）。' +
            '中継サーバーの KIMI_MODEL に指定したモデル名を確認してください。' +
            (detail ? '［' + detail + '］' : '');
        }
        // 番号だけでは何も分からないので、中継サーバーが掴んだ理由をそのまま出す
        return '抽出に失敗しました（' + (status || '') + '）。' +
          (detail ? '［' + detail + '］' : 'もう一度お試しください。');
      case 'server_not_configured':
        return '中継サーバーの設定が未完了です（APIキーか合言葉が未登録）。';
      default:
        return '自動入力に失敗しました（' + code + '）。';
    }
  }

  // 中継サーバーの応答をフォームに入れられる形に整える。
  // 数値でない値や範囲外の値は捨てて、誤った値がそのまま保存されないようにする。
  function normalize(raw, sourceUrl) {
    var out = {
      name: str(raw.name),
      address: str(raw.address),
      addressLevel: ADDRESS_LEVELS.indexOf(str(raw.addressLevel)) === -1 ? '' : str(raw.addressLevel),
      rent: int(raw.rent),
      adminFee: int(raw.adminFee),
      depositMonths: num(raw.depositMonths),
      keyMoneyMonths: num(raw.keyMoneyMonths),
      layout: str(raw.layout),
      areaSqm: num(raw.areaSqm),
      // ページの書き方（RC造・鉄筋コン・木造アパート…）を選択肢の言い方に寄せる
      structure: M.normalizeStructure(str(raw.structure)),
      builtYear: int(raw.builtYear),
      floor: int(raw.floor),
      line: str(raw.line),
      station: str(raw.station).replace(/駅$/, ''),
      walkMin: int(raw.walkMin),
      imageUrls: Array.isArray(raw.imageUrls)
        ? raw.imageUrls.filter(function (u) { return /^https?:\/\//i.test(u); }).slice(0, 3)
        : [],
      memo: str(raw.memo),
      url: sourceUrl
    };

    // 住所そのものが取れていなければ、粒度も意味を持たない
    if (!out.address) out.addressLevel = '';

    // 番地まであると答えていても、住所に番地の形が無ければ一段下げる
    if (out.addressLevel === 'banchi' && !hasBanchi(out.address)) {
      out.addressLevel = 'chome';
    }

    // 築年が明らかにおかしい値なら採用しない
    var year = new Date().getFullYear();
    if (out.builtYear !== null && (out.builtYear < 1900 || out.builtYear > year)) {
      out.builtYear = null;
    }

    // 路線名が一覧の表記に近ければ一覧側の表記に寄せる（選択肢に載るようにする）
    if (out.line) {
      var hit = M.ALL_LINES.filter(function (l) {
        return l === out.line || l.indexOf(out.line) !== -1 || out.line.indexOf(l) !== -1;
      }).sort(function (a, b) { return b.length - a.length; })[0];
      if (hit) out.line = hit;
    }

    return out;
  }

  function str(v) { return typeof v === 'string' ? v.trim() : ''; }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  function int(v) { return typeof v === 'number' && isFinite(v) ? Math.round(v) : null; }

  Chintai.extract = { run: run, isConfigured: isConfigured, isUrl: isUrl };
})(window.Chintai = window.Chintai || {});
