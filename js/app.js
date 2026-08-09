// 起動と結線。状態（物件・メンバー・絞り込み・選択）はここが持つ。
(function (Chintai) {
  'use strict';

  var M = Chintai.model;
  var ui = Chintai.ui;

  var properties = [];
  var members = {};
  var filter = null;
  var sortKey = 'newest';
  var selectedId = null;
  var uid = null;
  var roomId = null;
  var didInitialFit = false;
  var detailSignature = '';

  function $(id) { return document.getElementById(id); }

  function ctx() {
    return {
      uid: uid,
      members: members,
      selectedId: selectedId,
      sortKey: sortKey,
      total: properties.length
    };
  }

  function findProperty(id) {
    for (var i = 0; i < properties.length; i++) {
      if (properties[i].id === id) return properties[i];
    }
    return null;
  }

  // 絞り込みと並べ替えの結果を、一覧と地図の両方に同じ配列で渡す。
  // ここを一本にしておくことで、リストに出ている物件と地図のピンが食い違わない。
  function render() {
    var visible = M.sort(M.filter(properties, filter, uid), sortKey);
    ui.renderList(visible, ctx());
    Chintai.map.render(visible, selectedId);
    ui.syncFilterPanel(filter);

    if (!didInitialFit && visible.length) {
      didInitialFit = Chintai.map.fitAll(visible);
    }

    if (ui.isDetailOpen() && selectedId) {
      var p = findProperty(selectedId);
      if (!p) {
        // 同居人が削除した場合は一覧に戻す
        selectedId = null;
        ui.showList();
      } else {
        var sig = JSON.stringify(p);
        if (sig !== detailSignature) {
          detailSignature = sig;
          ui.showDetail(p, ctx());
        }
      }
    }
  }

  function selectProperty(id) {
    selectedId = id;
    var p = findProperty(id);
    if (!p) return;
    detailSignature = JSON.stringify(p);
    Chintai.map.focus(p);
    ui.showDetail(p, ctx());
    render();
  }

  function patchFilter(patch) {
    Object.keys(patch).forEach(function (k) { filter[k] = patch[k]; });
    saveView();
    render();
  }

  function toggleFilterValue(key, value) {
    var list = filter[key].slice();
    var i = list.indexOf(value);
    if (i === -1) list.push(value); else list.splice(i, 1);
    filter[key] = list;
    saveView();
    render();
  }

  function saveView() {
    var state = Chintai.session.loadViewState();
    state.filter = filter;
    state.sortKey = sortKey;
    Chintai.session.saveViewState(state);
  }

  /* ---------- 保存系 ---------- */

  function onSave(id, data, rating) {
    var writes;
    if (id) {
      writes = Chintai.db.updateProperty(id, data).then(function () {
        return Chintai.db.setRating(id, rating);
      });
    } else {
      var payload = Object.assign({}, data, { ratings: {} });
      if (rating > 0) payload.ratings[uid] = rating;
      writes = Chintai.db.addProperty(payload).then(function (ref) {
        selectedId = ref.id;
      });
    }
    writes.then(function () {
      ui.toast(id ? '保存しました' : '物件を追加しました');
    }).catch(function (err) {
      ui.toast('保存できませんでした: ' + (err && err.message ? err.message : err));
    });
  }

  function onDelete(id) {
    Chintai.db.deleteProperty(id).then(function () {
      if (selectedId === id) {
        selectedId = null;
        ui.showList();
      }
      ui.toast('削除しました');
    }).catch(function (err) {
      ui.toast('削除できませんでした: ' + (err && err.message ? err.message : err));
    });
  }

  /* ---------- バックアップ ---------- */

  function exportJson() {
    var data = M.toExport(properties);
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var d = new Date();
    var stamp = d.getFullYear() +
      ('0' + (d.getMonth() + 1)).slice(-2) +
      ('0' + d.getDate()).slice(-2);
    a.href = url;
    a.download = 'chintai-kouho-' + stamp + '.json';
    a.click();
    URL.revokeObjectURL(url);
    ui.toast(properties.length + '件を書き出しました');
  }

  function importJson(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var list;
      try {
        list = M.parseImport(String(reader.result));
      } catch (e) {
        ui.toast('読み込めませんでした: ' + e.message);
        return;
      }

      var merge = confirm(
        list.length + '件を読み込みます。\n\n' +
        'OK：今のリストに追加する\n' +
        'キャンセル：今のリストを消して置き換える'
      );
      if (!merge && !confirm('現在の' + properties.length + '件をすべて削除して置き換えます。よろしいですか？')) {
        return;
      }

      Chintai.db.bulkWrite(list, merge ? 'merge' : 'replace').then(function () {
        ui.toast(list.length + '件を読み込みました');
      }).catch(function (err) {
        ui.toast('読み込みに失敗しました: ' + (err && err.message ? err.message : err));
      });
    };
    reader.readAsText(file);
  }

  /* ---------- 画面の結線 ---------- */

  function wireChrome() {
    $('btn-add').addEventListener('click', function () {
      Chintai.form.open(null);
    });

    $('q').addEventListener('input', function () {
      filter.keyword = this.value;
      render();
    });

    $('btn-filter').addEventListener('click', function () {
      ui.syncFilterPanel(filter);
      ui.openPanel('filter-panel');
    });
    $('filter-close').addEventListener('click', function () { ui.closePanel('filter-panel'); });
    $('filter-reset').addEventListener('click', function () {
      filter = JSON.parse(JSON.stringify(M.DEFAULT_FILTER));
      filter.keyword = $('q').value;
      saveView();
      render();
    });

    $('btn-menu').addEventListener('click', function () {
      $('share-url').value = Chintai.session.shareUrl(roomId);
      $('nickname-input').value = Chintai.session.getNickname();
      renderMembers();
      renderExtractState();
      ui.openPanel('menu-panel');
    });
    $('menu-close').addEventListener('click', function () { ui.closePanel('menu-panel'); });

    $('btn-copy').addEventListener('click', function () {
      var url = Chintai.session.shareUrl(roomId);
      var done = function () { ui.toast('URLをコピーしました'); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(done).catch(fallbackCopy);
      } else {
        fallbackCopy();
      }
      function fallbackCopy() {
        var input = $('share-url');
        input.select();
        try { document.execCommand('copy'); done(); }
        catch (e) { ui.toast('コピーできませんでした。URLを長押しして選択してください'); }
      }
    });

    if (navigator.share) {
      var shareBtn = $('btn-share');
      shareBtn.hidden = false;
      shareBtn.addEventListener('click', function () {
        navigator.share({
          title: '賃貸候補メモ',
          text: '引っ越し候補のリストを共有します',
          url: Chintai.session.shareUrl(roomId)
        }).catch(function () { /* ユーザーが閉じただけなので何もしない */ });
      });
    }

    $('btn-save-nickname').addEventListener('click', function () {
      var name = $('nickname-input').value.trim();
      Chintai.session.setNickname(name);
      Chintai.db.setNickname(name).then(function () { ui.toast('表示名を保存しました'); });
    });

    $('btn-save-extract').addEventListener('click', function () {
      Chintai.session.setExtractConfig({
        endpoint: $('extract-endpoint').value.trim(),
        passphrase: $('extract-passphrase').value
      });
      renderExtractState();
      ui.toast('自動入力の設定を保存しました');
    });

    $('btn-export').addEventListener('click', exportJson);
    $('btn-import').addEventListener('click', function () { $('import-file').click(); });
    $('import-file').addEventListener('change', function () {
      if (this.files && this.files[0]) importJson(this.files[0]);
      this.value = '';
    });
  }

  // 合言葉そのものは画面に出さず、設定済みかどうかだけ示す
  function renderExtractState() {
    var conf = Chintai.session.getExtractConfig();
    $('extract-endpoint').value = conf.endpoint || '';
    $('extract-passphrase').value = conf.passphrase || '';
    $('extract-state').textContent = (conf.endpoint && conf.passphrase)
      ? '設定済み。物件の追加画面で使えます'
      : '未設定（手入力のみ）';
  }

  function renderMembers() {
    var names = Object.keys(members).map(function (u) {
      var n = members[u].nickname;
      return (n || (u === uid ? 'あなた' : '名前未設定')) + (u === uid ? '（あなた）' : '');
    });
    $('members-view').textContent = names.length
      ? 'このリストの参加者：' + names.join('、')
      : '';
  }

  /* ---------- 起動 ---------- */

  function start() {
    var room = Chintai.session.resolveRoomId();
    roomId = room.id;
    Chintai.session.syncHash(roomId);

    var view = Chintai.session.loadViewState();
    filter = Object.assign(JSON.parse(JSON.stringify(M.DEFAULT_FILTER)), view.filter || {});
    filter.keyword = '';
    sortKey = view.sortKey || 'newest';

    Chintai.map.init('map', { onSelect: selectProperty });

    ui.init({
      onSelect: selectProperty,
      onEdit: function (id) { Chintai.form.open(findProperty(id)); },
      onRate: function (id, value) {
        Chintai.db.setRating(id, value).catch(function () { ui.toast('評価を保存できませんでした'); });
      },
      onAddComment: function (id, text) {
        Chintai.db.addComment(id, text).catch(function () { ui.toast('コメントを送れませんでした'); });
      },
      onWatchComments: function (id, cb) {
        return Chintai.db.subscribeComments(id, cb, function () { /* 権限エラー等は握りつぶす */ });
      },
      onSortChange: function (key) { sortKey = key; saveView(); render(); },
      onFilterPatch: patchFilter,
      onFilterToggle: toggleFilterValue
    });

    Chintai.form.init({
      onSave: onSave,
      onDelete: onDelete,
      getUid: function () { return uid; }
    });

    wireChrome();
    ui.syncFilterPanel(filter);

    Chintai.db.init(roomId).then(function (myUid) {
      uid = myUid;

      var nickname = Chintai.session.getNickname();
      if (!nickname) return askNickname(room);
      return Chintai.db.joinRoom(nickname);
    }).then(function () {
      Chintai.db.subscribeProperties(function (list) {
        properties = list;
        render();
      }, function (err) {
        ui.toast('データを読み込めませんでした: ' + (err && err.code ? err.code : err));
      });

      Chintai.db.subscribeMembers(function (map) {
        members = map;
        renderMembers();
        render();
      }, function () { /* メンバー情報は無くても本体は使える */ });
    }).catch(function (err) {
      $('boot-error-msg').textContent =
        'Firebase に接続できませんでした。通信状況を確認して開き直してください。（' +
        (err && err.code ? err.code : err) + '）';
      ui.openPanel('boot-error');
    });
  }

  // 初回のみ名前を尋ねる。共有URLから来た場合は、参加した旨を伝える。
  function askNickname(room) {
    return new Promise(function (resolve) {
      if (room.joined) {
        $('welcome-desc').textContent = '共有リストに参加します。表示名を決めてください。';
      }
      ui.openPanel('welcome-panel');
      $('welcome-nickname').focus();

      function done() {
        var name = $('welcome-nickname').value.trim();
        Chintai.session.setNickname(name);
        ui.closePanel('welcome-panel');
        resolve(Chintai.db.joinRoom(name));
      }

      $('welcome-start').addEventListener('click', done);
      $('welcome-nickname').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') done();
      });
    });
  }

  window.addEventListener('DOMContentLoaded', start);

  // Service Worker はエミュレータでの動作確認中は登録しない（古い資産を掴むのを避ける）
  if ('serviceWorker' in navigator && !/[?&]emulator=1/.test(location.search)) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () { /* 失敗しても本体は動く */ });
    });
  }
})(window.Chintai = window.Chintai || {});
