// 中継サーバーが「どこへ取りに行くか」のテスト。
//
//   cd test && npm install && node worker.fetch.test.mjs
//
// Workers からプライベートIPには基本的に届かないが、それに寄りかからずに
// 自分で塞げているかを確かめる。リダイレクトで内側へ入られる経路も見る。
import { allowedTarget, fetchPageText } from '../worker/worker.js';

let failed = 0;
function check(label, ok) {
  if (ok) { console.log('  ✅ ' + label); }
  else { failed++; console.log('  ❌ ' + label); }
}
const group = (t) => console.log('\n' + t);

group('取りに行ってよい宛先');
[
  'https://suumo.jp/chintai/jnc_000012345/',
  'https://www.homes.co.jp/chintai/b-1234/',
  'https://example.co.jp:8443/page'
].forEach((u) => check('通す: ' + u, allowedTarget(u) !== null));

group('取りに行かない宛先');
[
  ['http（暗号化なし）', 'http://suumo.jp/x'],
  ['file スキーム', 'file:///etc/passwd'],
  ['ftp スキーム', 'ftp://example.com/x'],
  ['localhost', 'https://localhost/x'],
  ['ループバック v4', 'https://127.0.0.1/x'],
  ['ループバック v6', 'https://[::1]/x'],
  ['クラウドのメタデータ', 'https://169.254.169.254/latest/meta-data/'],
  ['プライベート 10/8', 'https://10.0.0.5/x'],
  ['プライベート 172.16/12', 'https://172.16.0.1/x'],
  ['プライベート 192.168/16', 'https://192.168.1.1/x'],
  ['キャリアグレードNAT', 'https://100.64.0.1/x'],
  ['ユニークローカル v6', 'https://[fd00::1]/x'],
  ['リンクローカル v6', 'https://[fe80::1]/x'],
  ['0.0.0.0', 'https://0.0.0.0/x'],
  ['*.internal', 'https://metadata.internal/x'],
  ['*.local', 'https://printer.local/x'],
  ['URLとして壊れている', 'https://['],
].forEach(([name, u]) => check('弾く: ' + name, allowedTarget(u) === null));

group('境界（塞ぎ過ぎていないこと）');
[
  ['172.15 は公開アドレス', 'https://172.15.0.1/x'],
  ['172.32 は公開アドレス', 'https://172.32.0.1/x'],
  ['192.169 は公開アドレス', 'https://192.169.0.1/x'],
  ['100.63 は公開アドレス', 'https://100.63.0.1/x'],
  ['localhost.example.com は別物', 'https://localhost.example.com/x']
].forEach(([name, u]) => check('通す: ' + name, allowedTarget(u) !== null));

/* ---------- リダイレクトの追従 ---------- */

// HTMLRewriter は Workers の機能なので、ここでは素通しのものを置く。
// 見たいのは「どのURLを取りに行ったか」だけ。
globalThis.HTMLRewriter = class {
  on() { return this; }
  transform() { return { arrayBuffer: async () => new ArrayBuffer(0) }; }
};

function stubFetch(routes) {
  const visited = [];
  globalThis.fetch = async (url) => {
    visited.push(url);
    const next = routes[url];
    if (next) {
      return new Response(null, { status: 302, headers: { Location: next } });
    }
    return new Response('本文', { status: 200 });
  };
  return visited;
}

group('リダイレクト');

{
  const visited = stubFetch({ 'https://a.example/1': 'https://b.example/2' });
  const res = await fetchPageText('https://a.example/1');
  check('公開ホストどうしの転送は追う', res.ok === true && visited.length === 2);
}

{
  // 転送先が内側を指す、いちばん危ない形
  const visited = stubFetch({ 'https://a.example/1': 'http://169.254.169.254/latest/meta-data/' });
  const res = await fetchPageText('https://a.example/1');
  check('転送先がメタデータなら追わない',
    res.ok === false && res.reason === 'blocked' && visited.length === 1);
}

{
  const visited = stubFetch({ 'https://a.example/1': 'https://127.0.0.1/x' });
  const res = await fetchPageText('https://a.example/1');
  check('転送先がループバックなら追わない',
    res.ok === false && res.reason === 'blocked' && visited.length === 1);
}

{
  const visited = stubFetch({ 'https://a.example/1': 'http://a.example/2' });
  const res = await fetchPageText('https://a.example/1');
  check('転送先が http なら追わない',
    res.ok === false && res.reason === 'blocked' && visited.length === 1);
}

{
  // 相対パスでの転送も、組み立て直してから判定する
  const visited = stubFetch({ 'https://a.example/1': '/2' });
  const res = await fetchPageText('https://a.example/1');
  check('相対パスの転送も追える', res.ok === true && visited[1] === 'https://a.example/2');
}

{
  const routes = {};
  for (let i = 0; i < 10; i++) routes['https://a.example/' + i] = 'https://a.example/' + (i + 1);
  const visited = stubFetch(routes);
  const res = await fetchPageText('https://a.example/0');
  check('たらい回しは途中で打ち切る',
    res.ok === false && res.reason === 'too_many_redirects' && visited.length <= 5);
}

group('大きすぎるページ');

{
  // 本文を延々と流してくるページ。全部ためてから切り詰めると、
  // 切り詰める前にメモリが尽きる。積む時点で止まっていることを見る。
  let handler = null;
  globalThis.HTMLRewriter = class {
    on(selector, h) { if (selector === '*' && h.text) handler = h; return this; }
    transform() {
      return { arrayBuffer: async () => {
        // 1000字 × 5000回 = 500万字を流し込む
        for (let i = 0; i < 5000; i++) handler.text({ text: 'あ'.repeat(1000) });
        return new ArrayBuffer(0);
      } };
    }
  };
  stubFetch({});
  const res = await fetchPageText('https://a.example/big');
  check('取り込む文字数に上限が効いている', res.ok === true && res.text.length <= 60000);
}

console.log('\n' + (failed === 0
  ? '全項目が期待どおりでした。'
  : failed + ' 件が期待と違います。'));
process.exit(failed === 0 ? 0 : 1);
