// 書き出したJSONが、新しい firestore.rules の上限に収まっているかを調べる。
//
//   node check-limits.js ~/Downloads/bukken-memo-20260816.json
//
// ルールを公開する前に一度だけ通す。ルールは「更新後の姿」の全体を見るため、
// 上限を超えた物件が1件でも残っていると、その物件はそれ以降いっさい
// 編集できなくなる（★を付けるだけでも弾かれる）。
import { readFileSync } from 'node:fs';
const limits = { name: 200, address: 300, addressLevel: 20, layout: 40, line: 60,
                 station: 60, commuteNote: 200, url: 2000, memo: 2000, status: 20 };
const file = process.argv[2];
if (!file) { console.log('使い方: node check-limits.js 書き出したJSON'); process.exit(1); }
const data = JSON.parse(readFileSync(file, 'utf8'));
const list = (data && data.properties) || [];
let ng = 0;
list.forEach(function (p) {
  Object.keys(limits).forEach(function (k) {
    if (typeof p[k] === 'string' && p[k].length > limits[k]) {
      ng++;
      console.log('・「' + p.name + '」の ' + k + ' が ' + p[k].length + ' 文字（上限 ' + limits[k] + '）');
    }
  });
  if (Array.isArray(p.imageUrls) && p.imageUrls.length > 10) {
    ng++;
    console.log('・「' + p.name + '」の画像が ' + p.imageUrls.length + ' 件（上限 10）');
  }
});
console.log(ng === 0
  ? list.length + '件すべて新しいルールに収まっています。そのまま公開して大丈夫です。'
  : '上の ' + ng + ' 件を短くしてから、ルールを公開してください。');
