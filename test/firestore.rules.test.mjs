// firestore.rules のテスト。Firestore エミュレータに対して実際に読み書きし、
// 「通ること」と「弾かれること」の両方を確かめる。
//
//   cd test && npm install && npm test
//
// ルールを触ったら必ずこれを通してから公開すること。
// 弾けているつもりで開いていた、という取り違えはここでしか見つからない。
import {
  initializeTestEnvironment, assertFails, assertSucceeds
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs, query, collectionGroup
} from 'firebase/firestore';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const env = await initializeTestEnvironment({
  projectId: 'demo-chintai',
  firestore: {
    host: '127.0.0.1',
    port: 8080,
    rules: readFileSync(join(here, '..', 'firestore.rules'), 'utf8')
  }
});

const ROOM = 'room-for-test';
const ALICE = 'alice';
const MALLORY = 'mallory';   // 部屋IDを知っているだけの別の匿名ユーザー

// 物件1件ぶんの、ルールが通るはずの中身
function property(overrides) {
  return Object.assign({
    name: 'テスト物件', address: '神奈川県横浜市西区北幸2-1-5', addressLevel: 'banchi',
    locationFixed: true, lat: 35.46, lng: 139.62, rent: 90000, adminFee: 5000,
    depositMonths: 1, keyMoneyMonths: 1, layout: '1LDK', areaSqm: 45, builtYear: 2014,
    floor: 3, line: 'JR横浜線', station: '中野', walkMin: 8, commuteMin: 35,
    commuteNote: '乗換1回', imageUrls: [], url: '', memo: '',
    ratings: {}, status: 'interested',
    createdBy: ALICE, updatedBy: ALICE, createdAt: 1700000000000, updatedAt: 1700000000000
  }, overrides);
}

let failed = 0;
async function check(label, promise) {
  try {
    await promise;
    console.log('  ✅ ' + label);
  } catch (e) {
    failed++;
    console.log('  ❌ ' + label + '\n     → ' + String(e.message).split('\n')[0].slice(0, 160));
  }
}
const group = (title) => console.log('\n' + title);

async function seed() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, `lists/${ROOM}`), { seed: true });
    await setDoc(doc(db, `lists/${ROOM}/members/${ALICE}`), { nickname: 'アリス' });
    await setDoc(doc(db, `lists/${ROOM}/properties/p1`), property({ ratings: { [ALICE]: 4 } }));
    await setDoc(doc(db, `lists/${ROOM}/properties/p1/comments/c1`), { uid: ALICE, text: '駅から近い' });
    // createdBy / ratings を持たない、項目が増える前に保存された物件
    await setDoc(doc(db, `lists/${ROOM}/properties/old`), {
      name: '古い物件', address: '東京都中野区', lat: 35.7, lng: 139.66, rent: 80000
    });
    await setDoc(doc(db, `lists/other-room/properties/p9`), property());
  });
}

await seed();

const alice = env.authenticatedContext(ALICE).firestore();
const mallory = env.authenticatedContext(MALLORY).firestore();
const anon = env.unauthenticatedContext().firestore();

group('未認証を弾く');
await check('未認証は物件を読めない', assertFails(getDoc(doc(anon, `lists/${ROOM}/properties/p1`))));
await check('未認証は物件を書けない', assertFails(setDoc(doc(anon, `lists/${ROOM}/properties/p2`), property())));
await check('未認証はメンバーを読めない', assertFails(getDoc(doc(anon, `lists/${ROOM}/members/${ALICE}`))));

group('部屋を総当たりで探せない');
await check('lists コレクションの一覧取得は不可', assertFails(getDocs(collection(mallory, 'lists'))));
await check('部屋ドキュメント自体の読み取りは不可', assertFails(getDoc(doc(mallory, `lists/${ROOM}`))));
await check('部屋ドキュメントへの書き込みは不可', assertFails(setDoc(doc(mallory, `lists/${ROOM}`), { x: 1 })));
await check('コレクショングループ横断検索は不可',
  assertFails(getDocs(query(collectionGroup(mallory, 'properties')))));
await check('コメントのコレクショングループ横断検索も不可',
  assertFails(getDocs(query(collectionGroup(mallory, 'comments')))));

group('共有した相手は、部屋の中で普通に使える（回帰）');
await check('物件を読める', assertSucceeds(getDoc(doc(mallory, `lists/${ROOM}/properties/p1`))));
await check('物件を一覧できる', assertSucceeds(getDocs(collection(mallory, `lists/${ROOM}/properties`))));
await check('自分の名前で物件を追加できる',
  assertSucceeds(setDoc(doc(mallory, `lists/${ROOM}/properties/p2`),
    property({ createdBy: MALLORY, updatedBy: MALLORY }))));
await check('相手が追加した物件を編集できる',
  assertSucceeds(updateDoc(doc(mallory, `lists/${ROOM}/properties/p1`),
    { memo: '書き換えた', updatedBy: MALLORY })));
await check('自分の★を付けられる',
  assertSucceeds(updateDoc(doc(mallory, `lists/${ROOM}/properties/p1`),
    { ['ratings.' + MALLORY]: 5, updatedBy: MALLORY })));
await check('物件を削除できる', assertSucceeds(deleteDoc(doc(mallory, `lists/${ROOM}/properties/p2`))));
await check('自分の表示名を保存できる',
  assertSucceeds(setDoc(doc(mallory, `lists/${ROOM}/members/${MALLORY}`), { nickname: 'マロリー' })));
await check('参加者の一覧を読める', assertSucceeds(getDocs(collection(mallory, `lists/${ROOM}/members`))));
// 項目が増える前に保存された物件を締め出さないこと。
// resource.data.createdBy を素で参照するとここで評価エラーになり、編集できなくなる。
await check('createdBy を持たない古い物件も編集できる',
  assertSucceeds(updateDoc(doc(mallory, `lists/${ROOM}/properties/old`),
    { memo: '古い物件を編集', updatedBy: MALLORY })));
await check('createdBy を持たない古い物件にも★を付けられる',
  assertSucceeds(updateDoc(doc(mallory, `lists/${ROOM}/properties/old`),
    { ['ratings.' + MALLORY]: 3, updatedBy: MALLORY })));
await check('自分の名前でコメントできる',
  assertSucceeds(setDoc(doc(mallory, `lists/${ROOM}/properties/p1/comments/c2`),
    { uid: MALLORY, text: 'ここは良さそう', createdAt: 1700000000000 })));

group('JSONの読み込みが通る（js/db.js の bulkWrite と同じ書き方）');
// 「置き換え」は全削除のあとの新規作成。書き出した時点の二人ぶんの★をそのまま復元する。
await check('置き換え：★を二人ぶん持ったまま作り直せる',
  assertSucceeds(setDoc(doc(mallory, `lists/${ROOM}/properties/imported`),
    property({ createdBy: MALLORY, updatedBy: MALLORY, ratings: { [ALICE]: 4, [MALLORY]: 5 } }))));
// 「追加」で既にある物件に当たった場合。追加者と★には触れず、他の項目だけを重ねる。
await check('追加：既にある物件へは createdBy と ratings を送らずに重ねられる',
  assertSucceeds(setDoc(doc(mallory, `lists/${ROOM}/properties/p1`),
    { name: '読み込みで更新', memo: '重ねた', updatedBy: MALLORY, updatedAt: 1700000001000 },
    { merge: true })));
await check('追加：既にある物件に相手の★を送ると弾かれる（db.js が送らない理由）',
  assertFails(setDoc(doc(mallory, `lists/${ROOM}/properties/p1`),
    { ratings: { [ALICE]: 1 }, updatedBy: MALLORY }, { merge: true })));

group('なりすましを弾く');
await check('他人の表示名は書き換えられない',
  assertFails(setDoc(doc(mallory, `lists/${ROOM}/members/${ALICE}`), { nickname: '乗っ取り' })));
await check('createdBy を他人にして追加できない',
  assertFails(setDoc(doc(mallory, `lists/${ROOM}/properties/p3`),
    property({ createdBy: ALICE, updatedBy: ALICE }))));
await check('updatedBy を他人にして追加できない',
  assertFails(setDoc(doc(mallory, `lists/${ROOM}/properties/p3`),
    property({ createdBy: MALLORY, updatedBy: ALICE }))));
await check('編集時に updatedBy を詐称できない',
  assertFails(updateDoc(doc(mallory, `lists/${ROOM}/properties/p1`), { memo: 'x', updatedBy: ALICE })));
await check('編集時に createdBy を書き換えられない',
  assertFails(updateDoc(doc(mallory, `lists/${ROOM}/properties/p1`),
    { createdBy: MALLORY, updatedBy: MALLORY })));
await check('他人の★は書き換えられない',
  assertFails(updateDoc(doc(mallory, `lists/${ROOM}/properties/p1`),
    { ['ratings.' + ALICE]: 1, updatedBy: MALLORY })));
await check('ratings ごと差し替えて他人の★を消せない',
  assertFails(updateDoc(doc(mallory, `lists/${ROOM}/properties/p1`),
    { ratings: { [MALLORY]: 5 }, updatedBy: MALLORY })));
await check('他人の uid でコメントできない',
  assertFails(setDoc(doc(mallory, `lists/${ROOM}/properties/p1/comments/c3`),
    { uid: ALICE, text: '偽コメント', createdAt: 1700000000000 })));
await check('投稿済みのコメントは編集できない',
  assertFails(updateDoc(doc(mallory, `lists/${ROOM}/properties/p1/comments/c1`), { text: '改ざん' })));

group('決めた形しか保存させない');
await check('知らない項目は保存できない',
  assertFails(setDoc(doc(mallory, `lists/${ROOM}/properties/p4`),
    property({ createdBy: MALLORY, updatedBy: MALLORY, junk: 'x' }))));
await check('巨大なゴミデータは保存できない',
  assertFails(setDoc(doc(mallory, `lists/${ROOM}/properties/p4`),
    property({ createdBy: MALLORY, updatedBy: MALLORY, junk: 'x'.repeat(500000) }))));
await check('長すぎるメモは保存できない',
  assertFails(setDoc(doc(mallory, `lists/${ROOM}/properties/p4`),
    property({ createdBy: MALLORY, updatedBy: MALLORY, memo: 'あ'.repeat(2001) }))));
await check('長すぎる物件名は保存できない',
  assertFails(setDoc(doc(mallory, `lists/${ROOM}/properties/p4`),
    property({ createdBy: MALLORY, updatedBy: MALLORY, name: 'あ'.repeat(201) }))));
await check('画像URLを大量に持たせられない',
  assertFails(setDoc(doc(mallory, `lists/${ROOM}/properties/p4`),
    property({ createdBy: MALLORY, updatedBy: MALLORY,
               imageUrls: Array(11).fill('https://example.com/a.jpg') }))));
await check('編集で知らない項目を混ぜられない',
  assertFails(updateDoc(doc(mallory, `lists/${ROOM}/properties/p1`),
    { junk: 'x', updatedBy: MALLORY })));
await check('長すぎるコメントは投稿できない',
  assertFails(setDoc(doc(mallory, `lists/${ROOM}/properties/p1/comments/c4`),
    { uid: MALLORY, text: 'あ'.repeat(201), createdAt: 1700000000000 })));
await check('空のコメントは投稿できない',
  assertFails(setDoc(doc(mallory, `lists/${ROOM}/properties/p1/comments/c5`),
    { uid: MALLORY, text: '', createdAt: 1700000000000 })));

group('別の部屋には触れない（共有IDを知らないため到達できない）');
await check('部屋IDを知らなければ物件も読めない（IDを知っていれば読める点は設計どおり）',
  assertSucceeds(getDoc(doc(mallory, 'lists/other-room/properties/p9'))));

await env.cleanup();

console.log('\n' + (failed === 0
  ? '全項目が期待どおりでした。'
  : failed + ' 件が期待と違います。'));
process.exit(failed === 0 ? 0 : 1);
