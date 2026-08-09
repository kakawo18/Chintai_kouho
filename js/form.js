// 物件の登録・編集フォーム。住所検索と地図ピッカーの行き来もここで面倒を見る。
(function (Chintai) {
  'use strict';

  var M = Chintai.model;
  var handlers = {};
  var current = null;   // 編集中の物件（新規なら null）
  var position = { lat: null, lng: null };
  var rating = 0;
  var status = 'interested';
  var searchTimer = null;
  var OTHER_LINE = '__other__';

  function $(id) { return document.getElementById(id); }
  function form() { return $('form'); }

  function init(h) {
    handlers = h || {};

    M.LAYOUTS.forEach(function (l) {
      var opt = document.createElement('option');
      opt.value = l;
      $('layout-list').appendChild(opt);
    });

    buildLineSelect();
    // 自分で「その他」を選んだときだけ入力欄へ移動する（編集を開いた瞬間に飛ばさない）
    $('line-select').addEventListener('change', function () {
      syncLineOther();
      if (!$('line-other').hidden) $('line-other').focus();
    });
    form().buildingAge.addEventListener('input', syncBuiltYearHint);

    var seg = $('status-seg');
    M.STATUSES.forEach(function (s) {
      var b = document.createElement('button');
      b.type = 'button';
      b.dataset.value = s.key;
      b.textContent = s.label;
      b.addEventListener('click', function () {
        status = s.key;
        syncStatus();
      });
      seg.appendChild(b);
    });

    $('form-cancel').addEventListener('click', close);
    $('form-save').addEventListener('click', save);
    $('form-delete').addEventListener('click', remove);
    $('btn-pick-on-map').addEventListener('click', startPicking);
    $('picker-cancel').addEventListener('click', cancelPicking);
    $('picker-confirm').addEventListener('click', confirmPicking);

    $('address-input').addEventListener('input', onAddressInput);
    $('autofill-run').addEventListener('click', runAutofill);

    ['rent', 'adminFee', 'depositMonths', 'keyMoneyMonths'].forEach(function (name) {
      form()[name].addEventListener('input', updateCostPreview);
    });
  }

  function open(property) {
    current = property || null;
    var f = form();
    f.reset();
    $('address-results').hidden = true;
    $('geo-status').hidden = true;

    // 自動入力は中継サーバーを設定した人にだけ出す
    $('autofill').hidden = !Chintai.extract.isConfigured();
    $('autofill-input').value = '';
    setAutofillStatus('');

    if (current) {
      $('form-title').textContent = '物件を編集';
      $('form-delete').hidden = false;
      f.name.value = current.name;
      f.address.value = current.address;
      ['rent', 'adminFee', 'depositMonths', 'keyMoneyMonths', 'areaSqm',
       'floor', 'walkMin', 'commuteMin'].forEach(function (k) {
        f[k].value = current[k] === null ? '' : String(current[k]);
      });
      ['layout', 'station', 'commuteNote', 'url', 'memo'].forEach(function (k) {
        f[k].value = current[k];
      });
      var age = M.builtYearToAge(current.builtYear);
      f.buildingAge.value = age === null ? '' : String(age);
      setLine(current.line);
      f.imageUrls.value = current.imageUrls.join('\n');
      position = { lat: current.lat, lng: current.lng };
      status = current.status;
      rating = M.ratingOf(current, handlers.getUid());
    } else {
      $('form-title').textContent = '物件を追加';
      $('form-delete').hidden = true;
      position = { lat: null, lng: null };
      status = 'interested';
      rating = 0;
      setLine('');
    }

    syncBuiltYearHint();
    syncStatus();
    syncPosition();
    updateCostPreview();
    Chintai.ui.renderRatingInput($('form-rating'), rating, onRatingPick);
    Chintai.ui.openPanel('form-panel');
  }

  // 押すたびに再描画して、選び直しと取り消しの両方を反映する
  function onRatingPick(value) {
    rating = value;
    Chintai.ui.renderRatingInput($('form-rating'), rating, onRatingPick);
  }

  function close() {
    Chintai.ui.closePanel('form-panel');
    current = null;
  }

  // 路線は事業者ごとにまとめた選択式。載っていない路線のために「その他」で自由入力へ逃がす。
  function buildLineSelect() {
    var sel = $('line-select');
    sel.innerHTML = '';

    var blank = document.createElement('option');
    blank.value = '';
    blank.textContent = '（未選択）';
    sel.appendChild(blank);

    M.LINE_GROUPS.forEach(function (group) {
      var og = document.createElement('optgroup');
      og.label = group.company;
      group.lines.forEach(function (line) {
        var opt = document.createElement('option');
        opt.value = line;
        opt.textContent = line;
        og.appendChild(opt);
      });
      sel.appendChild(og);
    });

    var other = document.createElement('option');
    other.value = OTHER_LINE;
    other.textContent = 'その他（自由入力）';
    sel.appendChild(other);
  }

  // 保存済みの路線が一覧にあれば選択、なければ「その他」に入れて元の文字列を残す
  function setLine(value) {
    var sel = $('line-select');
    if (value && M.ALL_LINES.indexOf(value) === -1) {
      sel.value = OTHER_LINE;
      $('line-other').value = value;
    } else {
      sel.value = value || '';
      $('line-other').value = '';
    }
    syncLineOther();
  }

  function syncLineOther() {
    $('line-other').hidden = $('line-select').value !== OTHER_LINE;
  }

  // 入力された築年数が西暦の何年にあたるかをその場に出し、取り違えに気づけるようにする
  function syncBuiltYearHint() {
    var age = M.num(form().buildingAge.value);
    var year = M.ageToBuiltYear(age);
    var hint = $('built-year-hint');
    hint.textContent = year === null ? '' : year + '年築';
    hint.hidden = year === null;
  }

  function syncStatus() {
    Array.prototype.forEach.call($('status-seg').children, function (b) {
      b.classList.toggle('is-on', b.dataset.value === status);
    });
  }

  function syncPosition() {
    var view = $('latlng-view');
    if (position.lat === null || position.lng === null) {
      view.textContent = '未設定';
    } else {
      view.textContent = position.lat.toFixed(5) + ', ' + position.lng.toFixed(5);
    }
  }

  // 敷金・礼金はヶ月で入力してもらい、家賃から円に換算してその場に出す
  function updateCostPreview() {
    var f = form();
    var draft = {
      rent: M.num(f.rent.value),
      adminFee: M.num(f.adminFee.value),
      depositMonths: M.num(f.depositMonths.value),
      keyMoneyMonths: M.num(f.keyMoneyMonths.value)
    };
    var total = M.monthlyTotal(draft);
    var initial = M.initialCost(draft);
    $('cost-preview').textContent =
      '実質月額 ' + (total === null ? '—' : M.formatYen(total)) +
      ' ／ 初期費用の目安 ' + (initial === null ? '—' : M.formatYen(initial));
  }

  /* ---------- 自動入力 ---------- */

  // 読み取った値はフォームに入れるだけで保存はしない。必ず目で見て直せるようにする。
  function runAutofill() {
    var input = $('autofill-input').value;
    if (!input.trim()) {
      setAutofillStatus('URL か物件情報を貼ってください');
      return;
    }

    var button = $('autofill-run');
    button.disabled = true;
    setAutofillStatus('読み取っています…');

    Chintai.extract.run(input).then(function (data) {
      var filled = applyExtracted(data);
      setAutofillStatus(filled.length
        ? filled.length + '項目を入れました（' + filled.join('、') + '）。内容を確認してください'
        : '読み取れる項目がありませんでした');
    }).catch(function (err) {
      setAutofillStatus(err.message);
    }).then(function () {
      button.disabled = false;
    });
  }

  function setAutofillStatus(text) {
    $('autofill-status').textContent = text;
  }

  var AUTOFILL_LABELS = {
    name: '物件名', address: '住所', rent: '家賃', adminFee: '管理費',
    depositMonths: '敷金', keyMoneyMonths: '礼金', layout: '間取り',
    areaSqm: '面積', builtYear: '築年数', floor: '階', line: '路線',
    station: '最寄駅', walkMin: '徒歩分', imageUrls: '画像', memo: 'メモ', url: '物件URL'
  };

  // 空欄だけを埋める。手で書いた内容を上書きしない。
  function applyExtracted(data) {
    var f = form();
    var filled = [];

    ['name', 'address', 'layout', 'station', 'url', 'memo'].forEach(function (k) {
      if (data[k] && !f[k].value.trim()) {
        f[k].value = data[k];
        filled.push(AUTOFILL_LABELS[k]);
      }
    });

    ['rent', 'adminFee', 'depositMonths', 'keyMoneyMonths', 'areaSqm', 'floor', 'walkMin']
      .forEach(function (k) {
        if (data[k] !== null && !f[k].value.trim()) {
          f[k].value = String(data[k]);
          filled.push(AUTOFILL_LABELS[k]);
        }
      });

    if (data.builtYear !== null && !f.buildingAge.value.trim()) {
      f.buildingAge.value = String(M.builtYearToAge(data.builtYear));
      filled.push(AUTOFILL_LABELS.builtYear);
    }

    if (data.line && !currentLineValue()) {
      setLine(data.line);
      filled.push(AUTOFILL_LABELS.line);
    }

    if (data.imageUrls.length && !f.imageUrls.value.trim()) {
      f.imageUrls.value = data.imageUrls.join('\n');
      filled.push(AUTOFILL_LABELS.imageUrls);
    }

    updateCostPreview();
    syncBuiltYearHint();

    // 住所が入ったら地図の位置も自動で取りにいく（失敗しても入力は残る）
    if (data.address && position.lat === null) runSearch(data.address);

    return filled;
  }

  function currentLineValue() {
    var sel = $('line-select');
    return sel.value === OTHER_LINE ? $('line-other').value.trim() : sel.value;
  }

  /* ---------- 住所検索 ---------- */

  function onAddressInput() {
    var q = this.value;
    clearTimeout(searchTimer);
    if (q.trim().length < 3) {
      $('address-results').hidden = true;
      return;
    }
    // 入力のたびに投げず、手が止まってから検索する
    searchTimer = setTimeout(function () { runSearch(q); }, 800);
  }

  function setGeoStatus(text) {
    var el = $('geo-status');
    el.textContent = text;
    el.hidden = !text;
  }

  function runSearch(q) {
    setGeoStatus('住所を検索しています…');
    Chintai.geo.search(q).then(function (items) {
      var box = $('address-results');
      box.innerHTML = '';
      if (!items.length) {
        box.hidden = true;
        setGeoStatus('候補が見つかりませんでした。「地図で位置を指定」から置いてください。');
        return;
      }
      setGeoStatus('');
      items.forEach(function (it) {
        var li = document.createElement('li');
        li.textContent = it.label;
        li.addEventListener('click', function () {
          position = { lat: it.lat, lng: it.lng };
          form().address.value = it.label;
          box.hidden = true;
          syncPosition();
        });
        box.appendChild(li);
      });
      box.hidden = false;
    }).catch(function () {
      $('address-results').hidden = true;
      setGeoStatus('住所検索に接続できませんでした。「地図で位置を指定」から置いてください。');
    });
  }

  /* ---------- 地図ピッカー ---------- */

  function startPicking() {
    Chintai.ui.closePanel('form-panel');
    $('crosshair').hidden = false;
    $('picker-bar').hidden = false;
    Chintai.map.startPicker(position);
  }

  function endPicking() {
    $('crosshair').hidden = true;
    $('picker-bar').hidden = true;
    Chintai.map.stopPicker();
    Chintai.ui.openPanel('form-panel');
  }

  function cancelPicking() {
    endPicking();
  }

  function confirmPicking() {
    position = Chintai.map.pickedPosition();
    endPicking();
    syncPosition();

    // 住所が空のときだけ逆引きで埋める（入力済みの住所を勝手に上書きしない）
    if (!form().address.value.trim()) {
      setGeoStatus('住所を取得しています…');
      Chintai.geo.reverse(position.lat, position.lng).then(function (address) {
        if (address && !form().address.value.trim()) form().address.value = address;
        setGeoStatus('');
      }).catch(function () {
        setGeoStatus('住所は取得できませんでしたが、位置は設定されています。');
      });
    }
  }

  /* ---------- 保存・削除 ---------- */

  function collect() {
    var f = form();
    return {
      name: f.name.value.trim(),
      address: f.address.value.trim(),
      lat: position.lat,
      lng: position.lng,
      rent: M.num(f.rent.value),
      adminFee: M.num(f.adminFee.value),
      depositMonths: M.num(f.depositMonths.value),
      keyMoneyMonths: M.num(f.keyMoneyMonths.value),
      layout: f.layout.value.trim(),
      areaSqm: M.num(f.areaSqm.value),
      builtYear: M.ageToBuiltYear(M.num(f.buildingAge.value)),
      floor: M.num(f.floor.value),
      line: $('line-select').value === OTHER_LINE
        ? $('line-other').value.trim()
        : $('line-select').value,
      station: f.station.value.trim(),
      walkMin: M.num(f.walkMin.value),
      commuteMin: M.num(f.commuteMin.value),
      commuteNote: f.commuteNote.value.trim(),
      imageUrls: f.imageUrls.value.split('\n').map(function (s) { return s.trim(); })
        .filter(function (s) { return !!s; }),
      url: f.url.value.trim(),
      memo: f.memo.value.trim(),
      status: status
    };
  }

  function save() {
    var data = collect();
    if (!data.name) {
      Chintai.ui.toast('物件名を入力してください');
      form().name.focus();
      return;
    }
    if (data.lat === null || data.lng === null) {
      Chintai.ui.toast('住所を選ぶか、地図で位置を指定してください');
      return;
    }
    handlers.onSave(current ? current.id : null, data, rating);
    close();
  }

  function remove() {
    if (!current) return;
    if (!confirm('「' + current.name + '」を削除します。同居人のリストからも消えます。よろしいですか？')) return;
    handlers.onDelete(current.id);
    close();
  }

  Chintai.form = { init: init, open: open, close: close };
})(window.Chintai = window.Chintai || {});
