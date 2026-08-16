// 物件ページから項目を抽出して返す小さな中継サーバー（Cloudflare Workers）。
//
// なぜ中継が要るのか:
//   1. API キーをブラウザに置かないため。キーはここの環境変数にだけ存在し、
//      アプリ側にも GitHub にも出ない。
//   2. ブラウザからは CORS の制約で物件ページ本文を読めない。ここでなら読める。
//   3. 二人が同じ鍵を共有せずに使えるようにするため。
//
// 環境変数（すべて Cloudflare のダッシュボードで設定する。コードには書かない）:
//   KIMI_API_KEY   … Kimi の API キー。必ず Secret として登録する
//   APP_PASSPHRASE … このアプリからの利用だけを通すための合言葉。Secret として登録する
//   ALLOWED_ORIGIN … 許可するアプリの配信元。例: https://kakawo18.github.io
//   KIMI_BASE_URL  … 省略時 https://api.moonshot.ai/v1
//   KIMI_MODEL     … 使うモデル。省略時 kimi-k2.6
//   KIMI_THINKING  … 'disabled'（既定）で思考を切る。他の値を入れると指定自体を送らない
//   KIMI_MAX_TOKENS… 応答の上限。省略時 16000

const DEFAULT_BASE_URL = 'https://api.moonshot.ai/v1';

// 物件ページから決まった項目を抜き出すだけの仕事なので、最上位のモデルは要らない。
// K3 から K2.6 に落として費用を約1/3にしている（入力 $3→$0.95、出力 $15→$4 / 100万トークン）。
// K2.6 も strict な JSON スキーマに対応しているため、送る中身は変えていない。
// 変えたくなったら wrangler.toml か Cloudflare の画面で KIMI_MODEL を書き換える。
// コードを触る必要はない。
const DEFAULT_MODEL = 'kimi-k2.6';

// 考えてから答えるモデルでは、考える過程（reasoning_content）のトークンも
// この上限に含まれる。決まった項目を抜き出すだけの仕事に深い思考は要らないので
// 既定では思考を切っている。切らないと2つ困ることが起きる。
//   1. 考えている途中で上限に当たり、答えが途中で切れる
//   2. 思考も出力として課金されるため、安いモデルに替えた意味がなくなる
// 上限は、思考を有効にしたときでも足りるよう Kimi の推奨値に合わせてある。
const DEFAULT_MAX_TOKENS = 16000;

// 取り込むページ本文の上限。長すぎるページで料金と時間が膨らむのを防ぐ。
const MAX_PAGE_CHARS = 60000;
const MAX_PASTED_CHARS = 60000;

// ページ取得の上限。相手のサーバーに待たされ続けたり、
// 転送でたらい回しにされたりしないようにする。
const FETCH_TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 3;

// 抽出結果の形。アプリのフォームの項目とそのまま対応させてある。
const PROPERTY_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: ['string', 'null'], description: '物件名。号室が分かれば含める' },
    address: {
      type: ['string', 'null'],
      description: 'ページに書かれている所在地を、書かれているとおりに。都道府県から。書かれていない番地・号を補わない'
    },
    // 許可する値は description で示し、enum は使わない。
    // strict なスキーマ検証で弾かれると自動入力ごと失敗するため、
    // 想定外の値はアプリ側（js/extract.js）で捨てる方針にしている。
    addressLevel: {
      type: ['string', 'null'],
      description: 'address がどこまで書かれていたか。banchi（番地・号まで）/ chome（丁目まで）/ ' +
                   'town（町名まで）/ city（市区町村まで）のいずれか1語。address が null なら null'
    },
    rent: { type: ['integer', 'null'], description: '家賃（円/月）。万円表記は円に直す' },
    adminFee: { type: ['integer', 'null'], description: '管理費・共益費（円/月）' },
    depositMonths: { type: ['number', 'null'], description: '敷金（ヶ月）。円表記なら家賃で割る。なしは0' },
    keyMoneyMonths: { type: ['number', 'null'], description: '礼金（ヶ月）。円表記なら家賃で割る。なしは0' },
    layout: { type: ['string', 'null'], description: '間取り。例 1LDK' },
    areaSqm: { type: ['number', 'null'], description: '専有面積（㎡）' },
    builtYear: { type: ['integer', 'null'], description: '築年（西暦4桁）。築◯年としか書かれていなければ今年から引いて求める' },
    floor: { type: ['integer', 'null'], description: '所在階' },
    line: { type: ['string', 'null'], description: '最寄駅の路線名' },
    station: { type: ['string', 'null'], description: '最寄駅名。「駅」は付けない' },
    walkMin: { type: ['integer', 'null'], description: '最寄駅からの徒歩分数' },
    imageUrls: { type: 'array', items: { type: 'string' }, description: '間取り図や室内写真の画像URL。最大3件' },
    memo: { type: ['string', 'null'], description: '設備や条件の要点を一行で' }
  },
  required: ['name', 'address', 'addressLevel', 'rent', 'adminFee', 'depositMonths',
             'keyMoneyMonths', 'layout', 'areaSqm', 'builtYear', 'floor', 'line',
             'station', 'walkMin', 'imageUrls', 'memo'],
  additionalProperties: false
};

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

function json(body, status, env) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, corsHeaders(env))
  });
}

// 合言葉の比較。
// 先にハッシュを取ってから比べる。こうすると比べる長さが常に32バイトで揃うため、
// 「何文字目まで合っていたか」も「合言葉が何文字か」も応答時間から読み取れない。
async function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;

  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b))
  ]);

  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// 同じ相手からの連打を止める。合言葉の総当たりと、通ったあとの使い過ぎの両方に効く。
// 上限は wrangler.toml の [[unsafe.bindings]] で決める（既定は1分あたり15回）。
//
// バインディングが無い場合は通す。ここで閉じると、設定を入れ忘れただけで
// 自動入力が全く動かなくなり、原因も分かりにくい。合言葉は依然として必要なので、
// その場合の守りは以前と同じ強さに戻るだけになる。
async function withinRateLimit(request, env) {
  if (!env.RATE_LIMITER || typeof env.RATE_LIMITER.limit !== 'function') {
    console.warn('RATE_LIMITER が未設定です。回数制限なしで動いています');
    return true;
  }
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { success } = await env.RATE_LIMITER.limit({ key: ip });
  return success;
}

// 取りに行ってよい宛先か。
//
// Workers からプライベートIPには基本的に届かないが、それに寄りかからず自分で塞ぐ。
// ここを通す条件は「https で、名前がプライベート側を指していないこと」。
// リダイレクトのたびに毎回この判定を通す（最初のURLだけ見ても、
// 転送先で内側に入られたら意味がないため）。
const BLOCKED_HOSTS = /^(localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/i;

function allowedTarget(url) {
  let target;
  try {
    target = new URL(url);
  } catch (e) {
    return null;
  }

  // http を通す理由が無い。物件サイトはどこも https で配信している。
  if (target.protocol !== 'https:') return null;

  const host = target.hostname.replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTS.test(host)) return null;

  // IPv4 のプライベート・ループバック・リンクローカル
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const p = host.split('.').map(Number);
    if (p[0] === 127 || p[0] === 10 || p[0] === 0) return null;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return null;
    if (p[0] === 192 && p[1] === 168) return null;
    if (p[0] === 169 && p[1] === 254) return null;   // クラウドのメタデータ
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return null;
  }

  // IPv6 のループバック・ユニークローカル・リンクローカル
  if (host === '::1' || /^f[cd][0-9a-f]{2}:/i.test(host) || /^fe80:/i.test(host)) return null;

  return target;
}

// ページ本文の抽出。script/style を捨てて本文テキストだけを拾う。
//
// 相手のサーバーに主導権を渡さないよう、3つの上限を掛けている。
//   ・時間  … 応答を返さないサーバーに待たされ続けない
//   ・転送数… 転送で延々とたらい回しにされない
//   ・文字数… 巨大なページでメモリを使い切らない
async function fetchPageText(url) {
  let current = url;
  let res = null;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const target = allowedTarget(current);
    if (!target) return { ok: false, status: 0, reason: 'blocked' };

    res = await fetch(target.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
                      '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept-Language': 'ja,en;q=0.8'
      },
      // 自分で追う。転送先が内側を指していないかを毎回確かめるため。
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });

    if (res.status < 300 || res.status > 399) break;

    const next = res.headers.get('Location');
    if (!next) break;
    current = new URL(next, target).toString();
    res = null;
  }

  if (!res) return { ok: false, status: 0, reason: 'too_many_redirects' };
  if (!res.ok) return { ok: false, status: res.status };

  const chunks = [];
  let total = 0;
  let dropping = false;

  // 上限に達したら以降は捨てる。全部ためてから切り詰めると、
  // 切り詰める前にメモリが尽きる。
  function push(s) {
    if (total >= MAX_PAGE_CHARS) return;
    chunks.push(s);
    total += s.length;
  }

  const rewriter = new HTMLRewriter()
    .on('script, style, noscript', {
      element(el) {
        dropping = true;
        el.onEndTag(() => { dropping = false; });
      }
    })
    .on('img', {
      element(el) {
        const src = el.getAttribute('src') || el.getAttribute('data-src');
        if (src) push('\n[画像] ' + src + '\n');
      }
    })
    .on('*', {
      text(t) {
        if (dropping) return;
        const s = t.text.replace(/\s+/g, ' ');
        if (s.trim()) push(s);
      }
    });

  await rewriter.transform(res).arrayBuffer();

  const text = chunks.join(' ').replace(/ {2,}/g, ' ').trim();
  return { ok: true, text: text.slice(0, MAX_PAGE_CHARS) };
}

async function callKimi(env, sourceText) {
  const today = new Date().toISOString().slice(0, 10);

  const body = {
    model: env.KIMI_MODEL || DEFAULT_MODEL,
    max_tokens: Number(env.KIMI_MAX_TOKENS) || DEFAULT_MAX_TOKENS,
    messages: [
      {
        role: 'system',
        content:
          '日本の賃貸物件ページから項目を抜き出す。今日は' + today + '。\n' +
          '読み取れなかった項目は必ず null にする。推測で埋めない。\n' +
          '金額は円の整数にする（8.5万円→85000）。敷金・礼金は家賃に対するヶ月数で返し、' +
          '「なし」「0円」と書かれていれば 0 にする。\n' +
          '築年は西暦4桁で返す。「築12年」のような表記しかない場合は今年から引いて求める。\n' +
          '\n' +
          '住所について（重要）:\n' +
          '賃貸物件のページは番地や号を伏せていることが多い。書かれていない番地・号を' +
          '絶対に補ってはならない。近隣の建物や地図の説明から番地を推し量ることもしない。\n' +
          'address はページに書かれているところまでを、そのまま入れる。\n' +
          'addressLevel には、その address がどこまで書かれていたかを入れる。\n' +
          '  「神奈川県横浜市西区北幸2-1-5」→ banchi\n' +
          '  「神奈川県横浜市西区北幸2丁目」→ chome\n' +
          '  「神奈川県横浜市西区北幸」→ town\n' +
          '  「神奈川県横浜市西区」→ city\n' +
          '欠けている部分は欠けたまま返すのが正しい。'
      },
      { role: 'user', content: sourceText }
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'rental_property', strict: true, schema: PROPERTY_SCHEMA }
    }
  };

  // 思考を切る。KIMI_THINKING に 'disabled' 以外を入れると指定自体を送らず、
  // API の既定に従う（このモデルは思考が要る、と分かったときの逃げ道）。
  if ((env.KIMI_THINKING || 'disabled') === 'disabled') {
    body.thinking = { type: 'disabled' };
  }

  const res = await fetch((env.KIMI_BASE_URL || DEFAULT_BASE_URL) + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + env.KIMI_API_KEY
    },
    body: JSON.stringify(body)
  });

  const raw = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, detail: 'APIがエラーを返しました: ' + raw.slice(0, 300) };
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    return { ok: false, status: 502, detail: '応答がJSONではありません: ' + raw.slice(0, 200) };
  }

  const choice = payload.choices && payload.choices[0];
  if (!choice) {
    return { ok: false, status: 502, detail: 'choices が空です: ' + raw.slice(0, 200) };
  }

  const content = readContent(choice.message);
  if (!content) {
    // 本文が空になるのは、考える過程で max_tokens を使い切った場合が多い。
    // finish_reason を返して、切り詰めなのか別の理由なのかを見分けられるようにする。
    return {
      ok: false,
      status: 502,
      detail: '本文が空です（finish_reason: ' + (choice.finish_reason || '不明') + '）'
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(stripToJson(content));
  } catch (e) {
    // 途中で切れたのか、そもそも形が違うのかで対処が変わるので分けて伝える
    if (choice.finish_reason === 'length') {
      return {
        ok: false,
        status: 502,
        detail: '答えが途中で切れました（max_tokens 不足）。思考を切るか KIMI_MAX_TOKENS を増やしてください'
      };
    }
    return {
      ok: false,
      status: 502,
      detail: 'JSONとして読めません（finish_reason: ' + (choice.finish_reason || '不明') + '）: ' +
              content.slice(0, 200)
    };
  }
  return { ok: true, property: parsed };
}

// content の形はモデルによって違う。文字列のこともあれば、
// 画像も扱えるモデルでは [{ type:'text', text:'...' }] の配列で返ることもある。
// 考える過程を分けて返すモデルでは reasoning_content 側にしか入らないこともある。
function readContent(message) {
  if (!message) return '';
  const c = message.content;
  if (typeof c === 'string' && c.trim()) return c;
  if (Array.isArray(c)) {
    const joined = c.map(function (part) {
      if (typeof part === 'string') return part;
      return (part && (part.text || part.content)) || '';
    }).join('').trim();
    if (joined) return joined;
  }
  if (typeof message.reasoning_content === 'string' && message.reasoning_content.trim()) {
    return message.reasoning_content;
  }
  return '';
}

// ```json ... ``` で包まれたり、前後に説明文が付いたりして返ることがある。
// スキーマを指定していても、モデルによっては起こる。
function stripToJson(text) {
  let s = text.trim();

  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  if (s.charAt(0) !== '{') {
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start !== -1 && end > start) s = s.slice(start, end + 1);
  }
  return s;
}

// テストから直接呼ぶために出しておく（test/worker.fetch.test.mjs）。
// Workers は default export だけを見るので、これがあっても動きは変わらない。
export { allowedTarget, fetchPageText };

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }
    if (request.method !== 'POST') {
      return json({ error: 'method_not_allowed' }, 405, env);
    }
    if (!env.KIMI_API_KEY || !env.APP_PASSPHRASE) {
      return json({ error: 'server_not_configured' }, 500, env);
    }
    if (env.APP_PASSPHRASE.length < 12) {
      // 止めはしない（動いているものを設定だけで落とさない）。気づけるように残す。
      console.warn('APP_PASSPHRASE が12文字未満です。総当たりに耐えられません');
    }

    // 合言葉を見る前に数える。外れた回数も上限に含めないと総当たりを止められない。
    if (!(await withinRateLimit(request, env))) {
      return json({ error: 'rate_limited' }, 429, env);
    }

    let payload;
    try {
      payload = await request.json();
    } catch (e) {
      return json({ error: 'bad_request' }, 400, env);
    }

    if (!(await safeEqual(payload.passphrase || '', env.APP_PASSPHRASE))) {
      return json({ error: 'unauthorized' }, 401, env);
    }

    let sourceText = '';

    if (payload.url) {
      // 取りに行ってよい宛先かを、投げる前に確かめる（詳細は allowedTarget）
      const target = allowedTarget(payload.url);
      if (!target) {
        return json({ error: 'bad_url' }, 400, env);
      }

      let page;
      try {
        page = await fetchPageText(target.toString());
      } catch (e) {
        // 時間切れや接続できないページ。異常系ではなく通常の分岐として返す。
        return json({ error: 'fetch_failed', status: 0 }, 200, env);
      }
      if (!page.ok) {
        return json({ error: 'fetch_failed', status: page.status }, 200, env);
      }
      // 中身がほとんど無いのは JavaScript で描画するページ。文字を貼ってもらうしかない。
      if (page.text.length < 500) {
        return json({ error: 'page_empty' }, 200, env);
      }
      sourceText = 'この賃貸物件ページから項目を抜き出してください。\nURL: ' +
        target.toString() + '\n\n' + page.text;
    } else if (payload.text) {
      sourceText = 'この賃貸物件の情報から項目を抜き出してください。\n\n' +
        String(payload.text).slice(0, MAX_PASTED_CHARS);
    } else {
      return json({ error: 'bad_request' }, 400, env);
    }

    const result = await callKimi(env, sourceText);
    if (!result.ok) {
      return json({ error: 'model_failed', status: result.status, detail: result.detail }, 200, env);
    }
    return json({ property: result.property }, 200, env);
  }
};
