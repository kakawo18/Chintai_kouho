// 共有ID（部屋）の発行と解決、ニックネーム、端末に残す表示設定。
// 共有IDはリポジトリには一切含めず、URL の # 以降と端末内にだけ持つ。
(function (Chintai) {
  'use strict';

  var ROOM_KEY = 'chintai_room_id';
  var NICK_KEY = 'chintai_nickname';
  var VIEW_KEY = 'chintai_view_state';
  var EXTRACT_KEY = 'chintai_extract_config';

  function safeGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function safeSet(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* プライベートモード等では黙って諦める */ }
  }

  function newRoomId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    // randomUUID が無い環境向けの代替。推測されない長さを確保する
    var bytes = new Uint8Array(16);
    (window.crypto || {}).getRandomValues
      ? crypto.getRandomValues(bytes)
      : bytes.forEach(function (_, i) { bytes[i] = Math.floor(Math.random() * 256); });
    return Array.prototype.map.call(bytes, function (b) {
      return ('0' + b.toString(16)).slice(-2);
    }).join('');
  }

  function roomFromHash() {
    var m = /(?:^|[#&])room=([^&]+)/.exec(location.hash || '');
    return m ? decodeURIComponent(m[1]) : null;
  }

  // URL の共有ID が最優先。次に端末の保存値。どちらも無ければ新しい部屋を作る。
  function resolveRoomId() {
    var fromUrl = roomFromHash();
    if (fromUrl) {
      safeSet(ROOM_KEY, fromUrl);
      return { id: fromUrl, joined: true };
    }
    var saved = safeGet(ROOM_KEY);
    if (saved) return { id: saved, joined: false };

    var created = newRoomId();
    safeSet(ROOM_KEY, created);
    return { id: created, joined: false, created: true };
  }

  function shareUrl(roomId) {
    return location.origin + location.pathname + '#room=' + encodeURIComponent(roomId);
  }

  // 共有IDを URL に載せておくと、ブックマークやホーム画面追加からも同じ部屋に戻れる
  function syncHash(roomId) {
    var desired = '#room=' + encodeURIComponent(roomId);
    if (location.hash !== desired) {
      history.replaceState(null, '', location.pathname + location.search + desired);
    }
  }

  function getNickname() {
    return safeGet(NICK_KEY) || '';
  }

  function setNickname(name) {
    safeSet(NICK_KEY, name);
  }

  function loadViewState() {
    try {
      return JSON.parse(safeGet(VIEW_KEY) || '{}');
    } catch (e) {
      return {};
    }
  }

  function saveViewState(state) {
    safeSet(VIEW_KEY, JSON.stringify(state));
  }

  // 自動入力の接続先と合言葉。端末内にだけ置き、共有データには載せない。
  //
  // 平文で置いている。localStorage である以上、同じオリジンで動くスクリプトからは
  // どう置いても読めるため、暗号化しても守りは増えない（鍵も同じ場所に要る）。
  // 実際の守りは「そのスクリプトを差し込ませないこと」＝ URL の scheme 検証と CSP のほう。
  function getExtractConfig() {
    try {
      return JSON.parse(safeGet(EXTRACT_KEY) || '{}');
    } catch (e) {
      return {};
    }
  }

  function setExtractConfig(config) {
    safeSet(EXTRACT_KEY, JSON.stringify(config));
  }

  Chintai.session = {
    getExtractConfig: getExtractConfig,
    setExtractConfig: setExtractConfig,
    resolveRoomId: resolveRoomId,
    newRoomId: newRoomId,
    shareUrl: shareUrl,
    syncHash: syncHash,
    getNickname: getNickname,
    setNickname: setNickname,
    loadViewState: loadViewState,
    saveViewState: saveViewState
  };
})(window.Chintai = window.Chintai || {});
