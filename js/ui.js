// ボトムシート、一覧、詳細カード、絞り込み、メニュー。DOM の描画はすべてここに集約する。
(function (Chintai) {
  'use strict';

  var M = Chintai.model;
  var handlers = {};
  var els = {};
  var snap = 'peek';
  var SNAPS = ['peek', 'half', 'full'];
  var detailUnsub = null;

  function $(id) { return document.getElementById(id); }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function relTime(ms) {
    if (!ms) return '';
    var diff = Date.now() - ms;
    if (diff < 60000) return 'たった今';
    if (diff < 3600000) return Math.floor(diff / 60000) + '分前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + '時間前';
    if (diff < 604800000) return Math.floor(diff / 86400000) + '日前';
    return new Date(ms).toLocaleDateString('ja-JP');
  }

  function init(h) {
    handlers = h || {};
    els = {
      sheet: $('sheet'),
      handle: $('sheet-handle'),
      scroll: $('sheet-scroll'),
      listView: $('list-view'),
      list: $('list'),
      listEmpty: $('list-empty'),
      listCount: $('list-count'),
      sortSelect: $('sort-select'),
      detailView: $('detail-view'),
      toast: $('status-toast'),
      filterBadge: $('filter-badge')
    };

    M.SORTS.forEach(function (s) {
      var opt = document.createElement('option');
      opt.value = s.key;
      opt.textContent = s.label;
      els.sortSelect.appendChild(opt);
    });
    els.sortSelect.addEventListener('change', function () {
      handlers.onSortChange(els.sortSelect.value);
    });

    initSheetGestures();
    initFilterPanel();
    setSnap('peek');
    window.addEventListener('resize', function () { setSnap(snap); });
    return els;
  }

  /* ---------- ボトムシート ---------- */

  function peekPx() {
    var v = getComputedStyle(document.documentElement).getPropertyValue('--peek');
    return parseInt(v, 10) || 92;
  }

  // シートの高さ＝画面に見えている量。段階ごとの目標高さを返す。
  function snapHeight(name) {
    if (name === 'full') return window.innerHeight * 0.88;
    if (name === 'half') return window.innerHeight * 0.5;
    return peekPx();
  }

  function setVisible(px) {
    document.documentElement.style.setProperty('--sheet-visible', px + 'px');
  }

  function setSnap(name) {
    snap = name;
    els.sheet.style.height = '';
    els.sheet.classList.remove('sheet--peek', 'sheet--half', 'sheet--full');
    els.sheet.classList.add('sheet--' + name);
    setVisible(snapHeight(name));
    // 折りたたむときは中身のスクロール位置も戻す（次に開いたとき途中から始まらないように）
    if (name === 'peek') els.scroll.scrollTop = 0;
  }

  function currentSnap() { return snap; }

  // ハンドルはドラッグでもタップでも動かせるようにする。
  // 移動量が小さいときはタップとみなして次の段階へ送る。
  function initSheetGestures() {
    var startY = 0, startHeight = 0, dragging = false, moved = 0;

    els.handle.addEventListener('pointerdown', function (e) {
      if (window.matchMedia('(min-width: 860px)').matches) return;
      dragging = true;
      moved = 0;
      startY = e.clientY;
      startHeight = els.sheet.offsetHeight;
      els.sheet.classList.add('is-dragging');
      els.handle.setPointerCapture(e.pointerId);
    });

    els.handle.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dy = startY - e.clientY;   // 上に引くほど高くする
      moved = Math.max(moved, Math.abs(dy));
      var next = Math.min(Math.max(startHeight + dy, peekPx()), snapHeight('full'));
      els.sheet.style.height = next + 'px';
      setVisible(next);
    });

    function end() {
      if (!dragging) return;
      dragging = false;
      els.sheet.classList.remove('is-dragging');

      if (moved < 6) {
        var i = SNAPS.indexOf(snap);
        setSnap(SNAPS[(i + 1) % SNAPS.length]);
        return;
      }

      var current = els.sheet.offsetHeight;
      var best = SNAPS[0], bestDist = Infinity;
      SNAPS.forEach(function (name) {
        var d = Math.abs(snapHeight(name) - current);
        if (d < bestDist) { bestDist = d; best = name; }
      });
      setSnap(best);
    }

    els.handle.addEventListener('pointerup', end);
    els.handle.addEventListener('pointercancel', end);
  }

  /* ---------- 一覧 ---------- */

  function nameOf(uid, ctx) {
    if (!uid) return '不明';
    var m = ctx.members[uid];
    if (m && m.nickname) return m.nickname;
    return uid === ctx.uid ? 'あなた' : '相手';
  }

  function starsHtml(value) {
    var out = '';
    for (var i = 1; i <= 5; i++) {
      out += '<span class="star' + (i <= value ? ' is-on' : '') + '">★</span>';
    }
    return '<span class="stars">' + out + '</span>';
  }

  // ★は人ごとに持つので、評価がある人ぶんだけ並べる（自分を先頭にする）
  function ratingRowsHtml(p, ctx) {
    var uids = Object.keys(p.ratings).filter(function (u) { return p.ratings[u] > 0; });
    if (uids.indexOf(ctx.uid) === -1 && p.ratings[ctx.uid] > 0) uids.push(ctx.uid);
    uids.sort(function (a, b) { return a === ctx.uid ? -1 : b === ctx.uid ? 1 : 0; });
    if (!uids.length) return '';
    return '<span class="stars-row">' + uids.map(function (u) {
      return '<span><span class="stars__who">' + escapeHtml(nameOf(u, ctx)) + '</span>' +
        starsHtml(p.ratings[u]) + '</span>';
    }).join('') + '</span>';
  }

  function metaLine(p) {
    var parts = [];
    if (p.layout) parts.push(p.layout);
    if (p.areaSqm !== null) parts.push(p.areaSqm + '㎡');
    if (p.station) parts.push(p.station + '駅' + (p.walkMin !== null ? ' 徒歩' + p.walkMin + '分' : ''));
    if (p.address && !parts.length) parts.push(p.address);
    return parts.join(' ・ ');
  }

  function renderList(properties, ctx) {
    els.listCount.textContent = properties.length + '件';
    els.sortSelect.value = ctx.sortKey;
    els.list.innerHTML = '';

    if (!properties.length) {
      els.listEmpty.hidden = false;
      els.listEmpty.textContent = ctx.total === 0
        ? 'まだ物件がありません。右下の＋から追加してください。'
        : '条件に合う物件がありません。絞り込みを見直してください。';
      return;
    }
    els.listEmpty.hidden = true;

    var frag = document.createDocumentFragment();
    properties.forEach(function (p) {
      var total = M.monthlyTotal(p);
      var card = document.createElement('button');
      card.type = 'button';
      card.className = 'card' + (p.id === ctx.selectedId ? ' is-selected' : '');
      card.innerHTML =
        '<span class="card__top">' +
          '<span class="card__name">' + escapeHtml(p.name) + '</span>' +
          '<span class="card__price">' + (total === null ? '—' : M.formatMan(total) + '円') + '</span>' +
        '</span>' +
        '<span class="card__meta">' + escapeHtml(metaLine(p)) + '</span>' +
        '<span class="card__foot">' +
          '<span class="tag" style="background:' + M.statusColor(p.status) + '">' +
            escapeHtml(M.statusLabel(p.status)) + '</span>' +
          ratingRowsHtml(p, ctx) +
          '<span class="card__updated">' +
            (p.updatedAt ? escapeHtml(nameOf(p.updatedBy, ctx)) + ' ' + relTime(p.updatedAt) : '') +
          '</span>' +
        '</span>';
      card.addEventListener('click', function () { handlers.onSelect(p.id); });
      frag.appendChild(card);
    });
    els.list.appendChild(frag);
  }

  /* ---------- 詳細 ---------- */

  function specRow(label, value) {
    if (value === null || value === undefined || value === '' || value === '—') return '';
    return '<tr><th>' + escapeHtml(label) + '</th><td>' + value + '</td></tr>';
  }

  function showDetail(p, ctx) {
    var total = M.monthlyTotal(p);
    var initial = M.initialCost(p);
    var age = M.buildingAge(p);

    var images = p.imageUrls.length
      ? '<div class="detail__images">' + p.imageUrls.map(function (u) {
          return '<img src="' + escapeHtml(u) + '" alt="" loading="lazy" ' +
            'onerror="this.outerHTML=\'<div class=&quot;img-fallback&quot;>画像を表示できません</div>\'">';
        }).join('') + '</div>'
      : '';

    var deposit = [];
    if (p.depositMonths !== null) deposit.push('敷金 ' + p.depositMonths + 'ヶ月');
    if (p.keyMoneyMonths !== null) deposit.push('礼金 ' + p.keyMoneyMonths + 'ヶ月');

    els.detailView.innerHTML =
      '<div class="detail__head">' +
        '<h2 class="detail__title">' + escapeHtml(p.name) + '</h2>' +
        '<span class="tag" style="background:' + M.statusColor(p.status) + '">' +
          escapeHtml(M.statusLabel(p.status)) + '</span>' +
      '</div>' +
      '<p class="detail__price">' + (total === null ? '—' : M.formatYen(total) + ' / 月') + '</p>' +
      '<p class="detail__sub">' +
        (p.createdBy ? '追加：' + escapeHtml(nameOf(p.createdBy, ctx)) : '') +
        (p.updatedAt ? '　最終更新：' + escapeHtml(nameOf(p.updatedBy, ctx)) + ' ' + relTime(p.updatedAt) : '') +
      '</p>' +
      images +
      '<div class="field"><span class="field__label">あなたの評価</span>' +
        '<div class="stars stars--input" id="detail-rating"></div></div>' +
      (Object.keys(p.ratings).filter(function (u) { return u !== ctx.uid && p.ratings[u] > 0; }).length
        ? '<p class="hint">' + ratingRowsHtml(p, ctx) + '</p>' : '') +
      '<table class="spec">' +
        specRow('家賃', M.formatYen(p.rent)) +
        specRow('管理費', M.formatYen(p.adminFee)) +
        specRow('敷金・礼金', deposit.length ? escapeHtml(deposit.join(' / ')) : '') +
        specRow('初期費用の目安', initial === null ? '' : M.formatYen(initial)) +
        specRow('間取り', escapeHtml(p.layout)) +
        specRow('面積', p.areaSqm === null ? '' : p.areaSqm + '㎡') +
        specRow('築年数', age === null ? '' : age + '年（' + p.builtYear + '年築）') +
        specRow('階', p.floor === null ? '' : p.floor + '階') +
        specRow('最寄駅', escapeHtml([p.line, p.station].filter(Boolean).join(' ')) +
          (p.walkMin !== null ? ' 徒歩' + p.walkMin + '分' : '')) +
        specRow('通勤時間', p.commuteMin === null ? '' : p.commuteMin + '分' +
          (p.commuteNote ? '（' + escapeHtml(p.commuteNote) + '）' : '')) +
        specRow('住所', escapeHtml(p.address)) +
        specRow('物件ページ', p.url ? '<a href="' + escapeHtml(p.url) + '" target="_blank" rel="noopener">開く</a>' : '') +
        specRow('メモ', p.memo ? escapeHtml(p.memo).replace(/\n/g, '<br>') : '') +
      '</table>' +
      '<div class="detail__actions">' +
        '<button class="btn btn--ghost" type="button" id="detail-back">一覧へ</button>' +
        '<button class="btn btn--primary" type="button" id="detail-edit">編集</button>' +
      '</div>' +
      '<div class="comments">' +
        '<p class="menu-block__title">コメント</p>' +
        '<div id="comment-list"></div>' +
        '<div class="comment-form">' +
          '<input id="comment-input" type="text" placeholder="一言メモを残す" maxlength="200">' +
          '<button class="btn btn--primary btn--sm" type="button" id="comment-send">送信</button>' +
        '</div>' +
      '</div>';

    renderRatingInput($('detail-rating'), M.ratingOf(p, ctx.uid), function (v) {
      handlers.onRate(p.id, v);
    });

    $('detail-back').addEventListener('click', showList);
    $('detail-edit').addEventListener('click', function () { handlers.onEdit(p.id); });
    $('comment-send').addEventListener('click', sendComment);
    $('comment-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') sendComment();
    });

    function sendComment() {
      var input = $('comment-input');
      var text = input.value.trim();
      if (!text) return;
      input.value = '';
      handlers.onAddComment(p.id, text);
    }

    els.listView.hidden = true;
    els.detailView.hidden = false;
    if (snap === 'peek') setSnap('half');

    if (detailUnsub) detailUnsub();
    detailUnsub = handlers.onWatchComments(p.id, function (comments) {
      renderComments(comments, ctx);
    });
  }

  function renderComments(comments, ctx) {
    var box = $('comment-list');
    if (!box) return;
    if (!comments.length) {
      box.innerHTML = '<p class="hint">まだコメントはありません。</p>';
      return;
    }
    box.innerHTML = comments.map(function (c) {
      return '<div class="comment">' +
        '<div class="comment__meta">' + escapeHtml(nameOf(c.uid, ctx)) + ' ' + relTime(c.createdAt) + '</div>' +
        escapeHtml(c.text) +
        '</div>';
    }).join('');
  }

  function renderRatingInput(container, value, onChange) {
    container.innerHTML = '';
    for (var i = 1; i <= 5; i++) {
      (function (n) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'star' + (n <= value ? ' is-on' : '');
        b.textContent = '★';
        b.setAttribute('aria-label', n + 'つ星');
        b.addEventListener('click', function () {
          // 同じ星をもう一度押したら評価を取り消す
          var next = (n === value) ? 0 : n;
          onChange(next);
        });
        container.appendChild(b);
      })(i);
    }
  }

  function showList() {
    if (detailUnsub) { detailUnsub(); detailUnsub = null; }
    els.detailView.hidden = true;
    els.listView.hidden = false;
  }

  function isDetailOpen() {
    return !els.detailView.hidden;
  }

  /* ---------- 絞り込み ---------- */

  function initFilterPanel() {
    var layouts = $('f-layouts');
    M.LAYOUTS.forEach(function (l) {
      layouts.appendChild(makeChip(l, l, 'layouts'));
    });

    var statuses = $('f-statuses');
    M.STATUSES.forEach(function (s) {
      statuses.appendChild(makeChip(s.label, s.key, 'statuses'));
    });

    var rating = $('f-rating');
    [0, 1, 2, 3, 4, 5].forEach(function (n) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.dataset.value = String(n);
      chip.textContent = n === 0 ? '指定なし' : '★' + n + '以上';
      chip.addEventListener('click', function () {
        handlers.onFilterPatch({ minRating: n });
      });
      rating.appendChild(chip);
    });

    var who = $('f-rating-who');
    [['any', 'どちらかが'], ['mine', '自分が'], ['theirs', '相手が']].forEach(function (pair) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.dataset.value = pair[0];
      chip.textContent = pair[1];
      chip.addEventListener('click', function () {
        handlers.onFilterPatch({ ratingWho: pair[0] });
      });
      who.appendChild(chip);
    });

    $('f-max-rent').addEventListener('input', function () {
      handlers.onFilterPatch({ maxRent: M.num(this.value.replace(/[^\d]/g, '')) });
    });
  }

  function makeChip(label, value, key) {
    var chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.dataset.value = value;
    chip.textContent = label;
    chip.addEventListener('click', function () {
      handlers.onFilterToggle(key, value);
    });
    return chip;
  }

  function syncFilterPanel(f) {
    $('f-max-rent').value = f.maxRent === null ? '' : String(f.maxRent);
    markChips($('f-layouts'), f.layouts);
    markChips($('f-statuses'), f.statuses);
    markChips($('f-rating'), [String(f.minRating)]);
    markChips($('f-rating-who'), [f.ratingWho]);

    // 既定と違う条件がいくつ効いているかをバッジで示す
    var d = M.DEFAULT_FILTER;
    var count = 0;
    if (f.maxRent !== null) count++;
    if (f.layouts.length) count++;
    if (f.minRating > 0) count++;
    if (f.statuses.join(',') !== d.statuses.join(',')) count++;
    els.filterBadge.hidden = count === 0;
    els.filterBadge.textContent = String(count);
  }

  function markChips(container, values) {
    Array.prototype.forEach.call(container.children, function (chip) {
      chip.classList.toggle('is-on', values.indexOf(chip.dataset.value) !== -1);
    });
  }

  /* ---------- その他 ---------- */

  var toastTimer = null;
  function toast(message) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.hidden = true; }, 2600);
  }

  function openPanel(id) { $(id).hidden = false; }
  function closePanel(id) { $(id).hidden = true; }

  Chintai.ui = {
    init: init,
    setSnap: setSnap,
    currentSnap: currentSnap,
    renderList: renderList,
    showDetail: showDetail,
    showList: showList,
    isDetailOpen: isDetailOpen,
    renderRatingInput: renderRatingInput,
    syncFilterPanel: syncFilterPanel,
    toast: toast,
    openPanel: openPanel,
    closePanel: closePanel,
    escapeHtml: escapeHtml,
    relTime: relTime
  };
})(window.Chintai = window.Chintai || {});
