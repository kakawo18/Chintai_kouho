// Firestore への接続、匿名認証、オフライン永続化、購読と更新。
// データ構造:
//   lists/{roomId}/members/{uid}
//   lists/{roomId}/properties/{propId}
//   lists/{roomId}/properties/{propId}/comments/{commentId}
// 部屋ドキュメント自体には何も置かない。ルールで /lists/{roomId} の読み取りを禁止し、
// 共有IDを知らない相手が部屋を総当たりで列挙できないようにするための設計。
(function (Chintai) {
  'use strict';

  var db = null;
  var auth = null;
  var uid = null;
  var roomRef = null;

  function useEmulator() {
    return /[?&]emulator=1/.test(location.search);
  }

  function init(roomId) {
    firebase.initializeApp(Chintai.firebaseConfig);
    auth = firebase.auth();
    db = firebase.firestore();

    if (useEmulator()) {
      auth.useEmulator('http://127.0.0.1:9099', { disableWarnings: true });
      db.useEmulator('127.0.0.1', 8080);
    }

    roomRef = db.collection('lists').doc(roomId);

    // 圏外でも一覧と地図が見られるようにローカルにキャッシュする。
    // 複数タブを開いている場合などは有効化に失敗するが、その場合もオンラインでは通常どおり動く。
    return db.enablePersistence({ synchronizeTabs: true })
      .catch(function (err) {
        console.warn('オフラインキャッシュを有効にできませんでした:', err && err.code);
      })
      .then(function () {
        return auth.signInAnonymously();
      })
      .then(function (cred) {
        uid = cred.user.uid;
        return uid;
      });
  }

  function currentUid() {
    return uid;
  }

  function serverTime() {
    return firebase.firestore.FieldValue.serverTimestamp();
  }

  function propertiesRef() {
    return roomRef.collection('properties');
  }

  // properties の購読。onSnapshot なので、同居人の追加・編集がそのまま流れてくる。
  function subscribeProperties(onChange, onError) {
    return propertiesRef().onSnapshot(function (snap) {
      var list = snap.docs.map(function (doc) {
        return Chintai.model.normalize(doc.id, doc.data());
      });
      onChange(list, snap.metadata.fromCache);
    }, onError);
  }

  function subscribeMembers(onChange, onError) {
    return roomRef.collection('members').onSnapshot(function (snap) {
      var members = {};
      snap.docs.forEach(function (doc) {
        members[doc.id] = doc.data() || {};
      });
      onChange(members);
    }, onError);
  }

  function joinRoom(nickname) {
    return roomRef.collection('members').doc(uid).set({
      nickname: nickname || '',
      lastSeenAt: serverTime()
    }, { merge: true });
  }

  function setNickname(nickname) {
    return roomRef.collection('members').doc(uid).set({
      nickname: nickname,
      lastSeenAt: serverTime()
    }, { merge: true });
  }

  function addProperty(data) {
    var payload = Object.assign({}, data, {
      createdBy: uid,
      updatedBy: uid,
      createdAt: serverTime(),
      updatedAt: serverTime()
    });
    return propertiesRef().add(payload);
  }

  function updateProperty(id, data) {
    var payload = Object.assign({}, data, {
      updatedBy: uid,
      updatedAt: serverTime()
    });
    return propertiesRef().doc(id).update(payload);
  }

  function deleteProperty(id) {
    return propertiesRef().doc(id).delete();
  }

  // ★は人ごとに持つので、自分の uid のキーだけを書き換える
  function setRating(id, value) {
    var update = { updatedBy: uid, updatedAt: serverTime() };
    update['ratings.' + uid] = value;
    return propertiesRef().doc(id).update(update);
  }

  function setStatus(id, status) {
    return updateProperty(id, { status: status });
  }

  function subscribeComments(propId, onChange, onError) {
    return propertiesRef().doc(propId).collection('comments')
      .orderBy('createdAt', 'asc')
      .onSnapshot(function (snap) {
        onChange(snap.docs.map(function (doc) {
          var d = doc.data() || {};
          return {
            id: doc.id,
            uid: d.uid || '',
            text: d.text || '',
            createdAt: d.createdAt && d.createdAt.toMillis ? d.createdAt.toMillis() : null
          };
        }));
      }, onError);
  }

  function addComment(propId, text) {
    return propertiesRef().doc(propId).collection('comments').add({
      uid: uid,
      text: text,
      createdAt: serverTime()
    });
  }

  // 読み込み（インポート）用。まとめ書きするが、バッチ上限に配慮して分割する
  function bulkWrite(properties, mode) {
    var chunks = [];
    for (var i = 0; i < properties.length; i += 400) {
      chunks.push(properties.slice(i, i + 400));
    }

    var startedAt = Promise.resolve();
    if (mode === 'replace') {
      startedAt = propertiesRef().get().then(function (snap) {
        var batch = db.batch();
        snap.docs.forEach(function (doc) { batch.delete(doc.ref); });
        return batch.commit();
      });
    }

    return chunks.reduce(function (chain, chunk) {
      return chain.then(function () {
        var batch = db.batch();
        chunk.forEach(function (p) {
          var ref = p.id ? propertiesRef().doc(p.id) : propertiesRef().doc();
          var payload = Object.assign({}, p);
          delete payload.id;
          payload.updatedBy = uid;
          payload.updatedAt = serverTime();
          if (!payload.createdBy) payload.createdBy = uid;
          if (!payload.createdAt) payload.createdAt = serverTime();
          batch.set(ref, payload, { merge: mode === 'merge' });
        });
        return batch.commit();
      });
    }, startedAt);
  }

  Chintai.db = {
    init: init,
    currentUid: currentUid,
    subscribeProperties: subscribeProperties,
    subscribeMembers: subscribeMembers,
    joinRoom: joinRoom,
    setNickname: setNickname,
    addProperty: addProperty,
    updateProperty: updateProperty,
    deleteProperty: deleteProperty,
    setRating: setRating,
    setStatus: setStatus,
    subscribeComments: subscribeComments,
    addComment: addComment,
    bulkWrite: bulkWrite
  };
})(window.Chintai = window.Chintai || {});
