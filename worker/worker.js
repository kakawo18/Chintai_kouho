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

const DEFAULT_BASE_URL = 'https://api.moonshot.ai/v1';

// 物件ページから決まった項目を抜き出すだけの仕事なので、最上位のモデルは要らない。
// K3 から K2.6 に落として費用を約1/3にしている（入力 $3→$0.95、出力 $15→$4 / 100万トークン）。
// K2.6 も strict な JSON スキーマに対応しているため、送る中身は変えていない。
// 変えたくなったら wrangler.toml か Cloudflare の画面で KIMI_MODEL を書き換える。
// コードを触る必要はない。
const DEFAULT_MODEL = 'kimi-k2.6';

// 取り込むページ本文の上限。長すぎるページで料金と時間が膨らむのを防ぐ。
const MAX_PAGE_CHARS = 60000;
const MAX_PASTED_CHARS = 60000;

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

// 合言葉の比較で、一致した文字数から答えを絞り込まれないよう長さに依らない比較にする
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ページ本文の抽出。script/style を捨てて本文テキストだけを拾う。
async function fetchPageText(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
                    '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept-Language': 'ja,en;q=0.8'
    },
    redirect: 'follow'
  });

  if (!res.ok) {
    return { ok: false, status: res.status };
  }

  const chunks = [];
  let dropping = false;

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
        if (src) chunks.push('\n[画像] ' + src + '\n');
      }
    })
    .on('*', {
      text(t) {
        if (dropping) return;
        const s = t.text.replace(/\s+/g, ' ');
        if (s.trim()) chunks.push(s);
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
    max_tokens: 2000,
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
    return { ok: false, status: res.status, detail: raw.slice(0, 400) };
  }

  let parsed;
  try {
    const payload = JSON.parse(raw);
    parsed = JSON.parse(payload.choices[0].message.content);
  } catch (e) {
    return { ok: false, status: 502, detail: '応答を解釈できませんでした' };
  }
  return { ok: true, property: parsed };
}

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

    let payload;
    try {
      payload = await request.json();
    } catch (e) {
      return json({ error: 'bad_request' }, 400, env);
    }

    if (!safeEqual(payload.passphrase || '', env.APP_PASSPHRASE)) {
      return json({ error: 'unauthorized' }, 401, env);
    }

    let sourceText = '';

    if (payload.url) {
      let target;
      try {
        target = new URL(payload.url);
      } catch (e) {
        return json({ error: 'bad_url' }, 400, env);
      }
      // 社内ネットワークや別プロトコルへ踏み台にされないよう http(s) だけ通す
      if (target.protocol !== 'https:' && target.protocol !== 'http:') {
        return json({ error: 'bad_url' }, 400, env);
      }

      const page = await fetchPageText(target.toString());
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
