
require("dotenv").config(); // ← ここが抜けていた ✅
console.log("✅ MONGO_URI:", process.env.MONGO_URI);

const express = require("express");
const { Client, middleware } = require("@line/bot-sdk");
const { OpenAI } = require("openai");
const axios = require("axios");
const { genreMap, budgetMap, keywordSuggestions } = require("./hotpepper_keyword_map");
const { MongoClient } = require("mongodb");

const app = express();

// ✅ LINEの署名検証に必要な rawBody を先にセット
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

const mongoClient = new MongoClient(process.env.MONGO_URI);
let userDB;

mongoClient.connect()
  .then(client => {
    console.log("✅ MongoDB接続成功");
    userDB = client.db("linebot").collection("users");
  })
  .catch(err => {
    console.error("❌ MongoDB接続エラー:", err);
  });

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new Client(config); // ✅ LINE SDKのクライアント初期化
const sessionStore = {}; // ✅ ユーザーごとのセッション記録用（メモリ保存）


const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});
const HOTPEPPER_API_KEY = process.env.HOTPEPPER_API_KEY;

function extractShopNames(text) {
  return text.match(/店名: (.+)/g)?.map(line => line.replace("店名: ", "").trim()) || [];
}

async function fetchShops(keyword, genreCode = "", budgetCode = "") {
  let all = [];
  for (let start = 1; start <= 100; start += 20) {
    const params = {
      key: HOTPEPPER_API_KEY,
      count: 20,
      start,
      format: "json"
    };
    if (keyword && keyword !== "未指定") params.keyword = keyword;
    if (genreCode) params.genre = genreCode;
    if (budgetCode) params.budget = budgetCode;
    const { data } = await axios.get("https://webservice.recruit.co.jp/hotpepper/gourmet/v1/", { params });
    if (!data.results.shop || data.results.shop.length === 0) break;
    all = all.concat(data.results.shop);
  }
  return all;
}

app.post("/webhook", express.raw({ type: "application/json" }), middleware(config), async (req, res) => {
  try {
    const events = req.body.events;
    await Promise.all(events.map(async (event) => {
      if (event.type === "message" && event.message.type === "text") {
        const userInput = event.message.text;
        const userId = event.source.userId;

const userDoc = await userDB.findOne({ userId });

// if (!userDoc) {
//   // 初回ユーザー → 登録して1回目無料
//   await userDB.insertOne({
//     userId,
//     introCount: 1,
//     subscribed: false,
//     previousStructure: null,
//     allShops: [],
//     shown: [],
//     original: userInput
//   });
//   console.log("🆕 新規ユーザー登録：1回目無料で続行");
// } else if (userDoc.subscribed) {
//   console.log("✅ 課金済みユーザー：続行");
// } else if (userDoc.introCount >= 1) {
//   // ⛔ 無料回数超え → Stripe課金誘導
//   await client.replyMessage(event.replyToken, {
//     type: "text",
//     text: "🔒 このBotは2回目以降の利用には有料プラン登録が必要です。\n👇ご登録はこちら\nhttps://your-stripe-checkout-link"
//   });
//   return;
// } 
// else {
//   // 無料2回目としてカウントアップ
//   await userDB.updateOne({ userId }, { $inc: { introCount: 1 } });
//   console.log("🟡 無料利用2回目");
// }

// ✅ 途中希望（もっと静か・おしゃれ・個室など）を初回取得済みショップから再選出する形式
if (
  (
    userInput.includes("もっと") ||
      userInput.includes("もう少し") ||     
      userInput.includes("もう") ||
    userInput.includes("ちょっと") ||  
    userInput.includes("できる") ||
    userInput.includes("静か") ||
    userInput.includes("個室") ||
    userInput.includes("夜") ||
    userInput.includes("おしゃれ") ||
    userInput.includes("雰囲気の良い") ||
    userInput.includes("映え") ||
    userInput.includes("インスタ映え") ||
    userInput.includes("美味しい") ||
    userInput.includes("高級") ||
    userInput.includes("安い") ||
    userInput.includes("コスパ") ||
    userInput.includes("駅近") ||
    userInput.includes("口コミ") ||
    userInput.includes("評判") ||
    userInput.includes("賑やか") ||
    userInput.includes("飲み放題") ||
    userInput.includes("予約") ||
    userInput.includes("落ち着いた") ||
    userInput.includes("子連れ") ||
    userInput.includes("駐車場") ||
    userInput.includes("深夜") ||
    userInput.includes("使える") ||
    userInput.includes("同じ") ||
    userInput.includes("条件") ||
    userInput.includes("場所") ||
    userInput.includes("ランチ") ||
    userInput.includes("ヘルシー") ||
    userInput.includes("健康志向") ||
    userInput.includes("ペット") ||
    userInput.includes("テラス") ||
    userInput.includes("地元") ||
    userInput.includes("ご当地") ||
    userInput.includes("記念日") ||
    userInput.includes("誕生日") ||
    userInput.includes("デート") ||
    userInput.includes("流行り") ||
    userInput.includes("バイキング") ||
    userInput.includes("食べ放題") ||
    userInput.includes("喫煙") ||
    userInput.includes("禁煙") ||
    userInput.includes("分煙") ||
    userInput.includes("Wi-Fi") ||
    userInput.includes("老舗") ||
    userInput.includes("名店") ||
    userInput.includes("スイーツ") ||
    userInput.includes("デザート") ||
    userInput.includes("貸切")
  ) &&
  sessionStore[userId]
)
 {
 
  console.log("🟢 【途中希望】ブロックに入りました:", userInput);

  const previous = sessionStore[userId];
const prev = sessionStore[userId].previousStructure || {};
 const prevLocation = prev.location || "";
const prevGenre    = prev.genre    || "";

  // 🔍 今回の追加希望を抽出
  const gptExtract = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [
      {
        role: "system",
        content:
          `次の日本語文から以下を抽出してください：\n場所:\nジャンル:\n予算:\nキーワード:\nこだわり条件:`
      },
      {
        role: "user",
        content: userInput
      }
    ]
  });

  const extracted = gptExtract.choices[0].message.content;
  const location = extracted.match(/場所:\s*(.*)/)?.[1]?.trim();
  const genre = extracted.match(/ジャンル:\s*(.*)/)?.[1]?.trim();
  const budget = extracted.match(/予算:\s*(.*)/)?.[1]?.trim();
  const keyword = extracted.match(/キーワード:\s*(.*)/)?.[1]?.trim();
  const filters = extracted.match(/こだわり条件:\s*(.*)/)?.[1]?.trim();

  await client.pushMessage(userId, {
  type: "text",
  text: "🔎 ご希望に合うお店を検索しています…"
});


  // 💡 前回の構造にマージ（上書き）
  const finalStructure = {
    location: location || prev.location,
    genre: genre || prev.genre,
    budget: budget || prev.budget,
    keyword: keyword || prev.keyword,
    filters: filters || prev.filters
  };

const shopList = previous.allShops.map(s => `店名: ${s.name} / 紹介: ${s.catch}`).join("\n"); // ← 再検索せず、前回と同じ店リスト
const prompt = 
  `前回の検索場所: ${prevLocation}\n` +
   `前回の検索ジャンル: ${prevGenre}\n` +
   `（ジャンルは必ず「${prevGenre}」の範囲で選んでください）\n` +
   `追加のご希望: ${userInput}\n\n` +
   `上記をもとに、以下の店舗リストから1件だけ選び、理由を添えてください。\n` +
  `形式：\n- 店名: ○○○\n- 理由: ○○○`;


  const gptPick = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: shopList }
    ]
  });

  const selectedNames = extractShopNames(gptPick.choices[0].message.content);
  const selected = previous.allShops.filter(s => selectedNames.includes(s.name));

  sessionStore[userId] = {
    original: `${previous.original} ${userInput}`,
    allShops: previous.allShops, // ← 再検索せず初回の店舗リストを保持
    shown: selected.map(s => s.name),
    previousStructure: finalStructure
  };

  for (const shop of selected) {
    const gptExtra = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content:
`以下の飲食店情報をもとに、【紹介文】と【おすすめの一品】をユーザーの印象に残るよう魅力的に自然な日本語で簡潔に生成してください。また、ユーザーが一目で見やすいように紹介文を工夫してください。
▼出力フォーマット：
【紹介文】
・店名のあとには必ず改行し、次の説明文へ
・顔文字や絵文字も1つ添えると魅力的です
・全体で2行以内を目安にまとめてください
・店名を《店名》で囲ってください

【おすすめの一品】
・料理名のあとに必ず改行し、次の説明文へ
・全体で1行以内を目安にまとめてください
・料理名を《料理名》で囲ってください`
        },
        {
          role: "user",
          content: `店名: ${shop.name}\nジャンル: ${shop.genre.name}\n紹介: ${shop.catch}\n予算: ${shop.budget.name}\n営業時間: ${shop.open}`
        }
      ]
    });

    const response = gptExtra.choices[0].message.content;
    const introMatch = response.match(/【紹介文】\s*([\s\S]*?)\s*(?=【|$)/);
    const itemMatch = response.match(/【おすすめの一品】\s*([\s\S]*)/);

    shop.generatedIntro = introMatch?.[1]?.trim() || "雰囲気の良いおすすめ店です。";
    shop.generatedItem = itemMatch?.[1]?.trim() || "料理のおすすめ情報は取得できませんでした。";
   const gptKeywordTag = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: `以下のユーザー希望から、ハッシュタグにできるキーワードを1〜2個だけ日本語で抽出してください。#記号付き・1行（例：#個室 #おしゃれ）`
        },
        {
          role: "user",
          content: userInput
        }
      ]
    });
    const keywordTags = gptKeywordTag.choices[0].message.content?.trim() || "";

    const gptShopTag = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: `以下の飲食店情報から、Instagram風のハッシュタグとして使えるもっとも最適なそのお店の特徴をキーワードを1~2つ日本語で抽出してください。
#記号をつけて1行で出力してください（例：#デート #夜景 #コスパ）`
        },
        {
          role: "user",
          content: `店名: ${shop.name}\nジャンル: ${shop.genre.name}\n紹介: ${shop.catch}\n予算: ${shop.budget.name}`
        }
      ]
    });
    const shopTags = gptShopTag.choices[0].message.content?.trim() || "";

    shop.generatedTags = `${keywordTags} ${shopTags}`.trim();
 }

  const bubbles = selected.map(shop => ({
    type: "bubble",
    hero: {
      type: "image",
      url: shop.photo.pc.l,
      size: "full",
      aspectRatio: "4:3",
      aspectMode: "cover"
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "xs",
      contents: [
        { type: "text", text: shop.name, weight: "bold", size: "md", wrap: true },
  { type: "text", text: shop.generatedTags, size: "sm", color: "#555555", wrap: true },        { type: "text", text: "📖 【紹介文】", size: "sm", wrap: true },
        ...shop.generatedIntro.split("\n").slice(0, 3).map(line => ({
          type: "text", text: line.trim(), size: "sm", wrap: true
        })),
        { type: "text", text: "🍴 【おすすめの一品】", size: "sm", wrap: true },
        ...shop.generatedItem.split("\n").slice(0, 2).map(line => ({
          type: "text", text: line.trim(), size: "sm", wrap: true
        })),
        {
          type: "text",
          text: /^[0-9]{3,4}[〜~ー−－]{1}[0-9]{3,4}円$/.test(shop.budget.name)
            ? `💴 ${shop.budget.name}`
            : "💴 情報未定",
          size: "sm",
          color: "#ff6600"
        },
              { type: "text", text: shop.non_smoking ? `🚬 ${shop.non_smoking}` : "🚬 喫煙情報なし",size: "sm",color: "#888888"},
              {type: "text",text: shop.address || "📍 住所情報なし",size: "sm",color: "#888888",wrap: true}
      ]
    },
    footer: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        {
          type: "button",
          style: "primary",
          action: {
            type: "uri",
            label: "詳細を見る",
            uri: shop.urls.pc
          }
        }
      ]
    }
  }));

  return client.replyMessage(event.replyToken, {
    type: "flex",
    altText: "ご希望に合わせて新しいお店をご紹介します！",
    contents: {
      type: "carousel",
      contents: bubbles
    }
  });
}


        
// ✅ "違う店" ブロック全体修正済みバージョン
if ((userInput.includes("違う") || userInput.includes("他")) && sessionStore[userId]) {
  const previous = sessionStore[userId];
  const remaining = previous.allShops.filter(s => !previous.shown.includes(s.name));


  if (remaining.length === 0) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "すでにすべてのお店をご紹介しました！また最初から条件を送ってください🙏"
    });
  }

  const shopList = remaining.map(s => `店名: ${s.name} / 紹介: ${s.catch}`).join("\n");
await client.pushMessage(userId, {
  type: "text",
  text: "🔎 ご希望に合うお店を検索しています…"
});


  const prompt = `ユーザーの希望は「${previous.original}」です。\n以下の残り候補から違う1件を選び、理由を添えてください。\n形式：\n- 店名: ○○\n- 理由: ○○`;

  const gptRes = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: shopList }
    ]
  });

  const selectedNames = extractShopNames(gptRes.choices[0].message.content);
  const selected = remaining.filter(s => selectedNames.includes(s.name));
  sessionStore[userId].shown.push(...selected.map(s => s.name));

  for (const shop of selected) {
    const gptExtra = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: `以下の飲食店情報をもとに、【紹介文】と【おすすめの一品】をユーザーの印象に残るよう魅力的に自然な日本語で簡潔に生成してください。また、ユーザーが一目で見やすいように紹介文を工夫してください。\n▼出力フォーマット：\n【紹介文】\n・店名のあとには必ず改行し、次の説明文へ\n・顔文字や絵文字も1つ添えると魅力的です\n・全体で2行以内を目安にまとめてください\n・店名を《店名》で囲ってください\n\n【おすすめの一品】\n・料理名のあとに必ず改行し、次の説明文へ\n・全体で1行以内を目安にまとめてください\n・料理名を《料理名》で囲ってください` 

        },
        {
          role: "user",
          content: `店名: ${shop.name}\nジャンル: ${shop.genre.name}\n紹介: ${shop.catch}\n予算: ${shop.budget.name}\n営業時間: ${shop.open}`
        }
      ]
    });

    const response = gptExtra.choices[0].message.content;
    const introMatch = response.match(/【紹介文】\s*([\s\S]*?)\s*(?=【|$)/);
    const itemMatch = response.match(/【おすすめの一品】\s*([\s\S]*)/);

    shop.generatedIntro = introMatch?.[1]?.trim() || "雰囲気の良いおすすめ店です。";
    shop.generatedItem = itemMatch?.[1]?.trim() || "料理のおすすめ情報は取得できませんでした。";
  // 🔍 GPTにタグを生成させる
const gptTag = await openai.chat.completions.create({
  model: "gpt-4",
  messages: [
    {
      role: "system",
      content: `以下の飲食店情報から、Instagram風のハッシュタグとして使える、もっとも最適なそのお店の特徴をキーワードを3つ日本語で抽出してください。
#記号をつけて1行で出力してください（例：#デート #夜景 #コスパ）`
    },
    {
      role: "user",
      content: `店名: ${shop.name}\nジャンル: ${shop.genre.name}\n紹介: ${shop.catch}\n予算: ${shop.budget.name}`
    }
  ]
});

// ✅ タグを格納（エラー防止のためtrimとfallbackもセット）
shop.generatedTags = gptTag.choices[0].message.content?.trim() || "#おすすめ";

  }

  const bubbles = selected.map(shop => ({
    type: "bubble",
    hero: {
      type: "image",
      url: shop.photo.pc.l,
      size: "full",
      aspectRatio: "4:3",
      aspectMode: "cover"
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "xs",
      contents: [
        { type: "text", text: shop.name, weight: "bold", size: "md", wrap: true },
       { type: "text", text: shop.generatedTags, size: "sm", color: "#555555", wrap: true },
        { type: "text", text: "📖 【紹介文】", size: "sm", wrap: true },
        ...shop.generatedIntro.split("\n").slice(0, 3).map(line => ({
          type: "text", text: line.trim(), size: "sm", wrap: true
        })),
        { type: "text", text: "🍴 【おすすめの一品】", size: "sm", wrap: true },
        ...shop.generatedItem.split("\n").slice(0, 2).map(line => ({
          type: "text", text: line.trim(), size: "sm", wrap: true
        })),
        {
          type: "text",
          text: /^[0-9]{3,4}[〜~ー−－]{1}[0-9]{3,4}円$/.test(shop.budget.name)
            ? `💴 ${shop.budget.name}`
            : "💴 情報未定",
          size: "sm",
          color: "#ff6600"
        },
{ 
  type: "text", 
  text: shop.non_smoking ? `🚬 ${shop.non_smoking}` : "🚬 喫煙情報なし", 
  size: "sm", 
  color: "#888888" 
},
         {type: "text",text: shop.address || "📍 住所情報なし",size: "sm",color: "#888888",wrap: true},
       ]
    },
    footer: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        {
          type: "button",
          style: "primary",
          action: {
            type: "uri",
            label: "詳細を見る",
            uri: shop.urls.pc
          }
        }
      ]
    }
  }));

  return client.replyMessage(event.replyToken, {
    type: "flex",
    altText: "他の候補をご紹介します！",
    contents: {
      type: "carousel",
      contents: bubbles
    }
  });
}

        // ✅ 通常の初回検索リクエスト
// ✅ 通常の初回検索リクエスト（場所＋ジャンル＋キーワードを柔軟に対応）
const gptExtract = await openai.chat.completions.create({
  model: "gpt-4",
  messages: [
    {
      role: "system",
      content: `次の日本語文から以下を抽出してください：\n場所:\nジャンル:\nキーワード:`
    },
    { role: "user", content: userInput }
  ]
});

const parsed = gptExtract.choices[0].message.content;
const location = parsed.match(/場所:\s*(.*)/)?.[1]?.trim() || "";
const genre = parsed.match(/ジャンル:\s*(.*)/)?.[1]?.trim() || "";
const keyword = parsed.match(/キーワード:\s*(.*)/)?.[1]?.trim() || "";

await client.pushMessage(userId, {
  type: "text",
  text: "🔎 ご希望に合うお店を検索しています…"
});


// 🔁 検索条件を判定して、ジャンル検索 or 総合検索を分岐
const genreCode = genreMap[genre] || "";
const allShops = await fetchShops(location, genreCode); // ジャンルがあれば検索に活用、なければ "" で場所のみ

if (allShops.length === 0) {
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: "条件に合うお店が見つかりませんでした🙏"
  });
}

// 🔍 GPTに意味フィルタ選出（キーワードがあれば考慮させる）
const shopList = allShops.map(s => `店名: ${s.name} / 紹介: ${s.catch}`).join("\n");
const prompt = `ユーザーの希望は「${userInput}」です。以下のお店から希望に合いそうな1件を選んでください。できれば「${keyword}」の要素が入っているものを優先してください。\n形式：\n- 店名: ○○○\n- 理由: ○○○`;

const gptPick = await openai.chat.completions.create({
  model: "gpt-4",
  messages: [
    { role: "system", content: prompt },
    { role: "user", content: shopList }
  ]
});

const selectedNames = extractShopNames(gptPick.choices[0].message.content);
const selected = allShops.filter(s => selectedNames.includes(s.name));
// ✅ 各店舗に紹介文とおすすめ一品を生成
for (const shop of selected) {
  const gptExtra = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [
      {
        role: "system",
        content: 
        `以下の飲食店情報をもとに、【紹介文】と【おすすめの一品】をユーザーの印象に残るよう魅力的に自然な日本語で簡潔に生成してください。また、ユーザーが一目で見やすいように紹介文を工夫してください。
▼出力フォーマット：
【紹介文】
・店名のあとには必ず改行し、次の説明文へ
・顔文字や絵文字も1つ添えると魅力的です
・全体で2行以内を目安にまとめてください
・店名を《店名》で囲ってください

【おすすめの一品】
・料理名のあとに必ず改行し、次の説明文へ
・全体で1行以内を目安にまとめてください
・料理名を《料理名》で囲ってください
`
   },
      {
        role: "user",
        content: `店名: ${shop.name}\nジャンル: ${shop.genre.name}\n紹介: ${shop.catch}\n予算: ${shop.budget.name}\n営業時間: ${shop.open}`
      }
    ]
  });

  const response = gptExtra.choices[0].message.content;
  console.log("GPT紹介文生成結果:", response);

const introMatch = response.match(/【紹介文】\s*([\s\S]*?)\s*(?=【|$)/);
const itemMatch = response.match(/【おすすめの一品】\s*([\s\S]*)/);

  shop.generatedIntro = introMatch?.[1]?.trim() || "雰囲気の良いおすすめ店です。";
  shop.generatedItem = itemMatch?.[1]?.trim() || "料理のおすすめ情報は取得できませんでした。";

    const gptTag = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [
      {
        role: "system",
        content: `以下の飲食店情報から、Instagram風のハッシュタグとして使える、もっとも最適なそのお店の特徴をキーワードを3つ日本語で抽出してください。\n#記号をつけて1行で出力してください（例：#デート #夜景 #コスパ）`
      },
      {
        role: "user",
        content: `店名: ${shop.name}\nジャンル: ${shop.genre.name}\n紹介: ${shop.catch}\n予算: ${shop.budget.name}`
      }
    ]
  });

  shop.generatedTags = gptTag.choices[0].message.content?.trim() || "#おすすめ";

}

        sessionStore[userId] = {
          original: userInput,
          allShops,
          shown: selected.map(s => s.name)
        };

        if (selected.length === 0) {
          return client.replyMessage(event.replyToken, { type: "text", text: "条件に近いお店が見つかりませんでした🙏" });
        }

        const bubbles = selected.map(shop => ({
          type: "bubble",
          hero: {
            type: "image",
            url: shop.photo.pc.l,
            size: "full",
            aspectRatio: "4:3",
            aspectMode: "cover"
          },
          body: {
            type: "box",
            layout: "vertical",
            spacing: "xs",
            contents: [
              { type: "text", text: shop.name, weight: "bold", size: "md", wrap: true },
              { type: "text", text: shop.generatedTags, size: "sm", color: "#555555", wrap: true },              { type: "text", text: `📖 【紹介文】\n${shop.generatedIntro}`, size: "sm", wrap: true },
              { type: "text", text: `🍴 【おすすめの一品】\n${shop.generatedItem}`, size: "sm", wrap: true },
              { type: "text", text: `💴 ${shop.budget.name}`, size: "sm", color: "#ff6600" },
              { type: "text", text: shop.non_smoking ? `🚬 ${shop.non_smoking}` : "🚬 喫煙情報なし",size: "sm",color: "#888888"},
              {type: "text",text: shop.address || "📍 住所情報なし",size: "sm",color: "#888888",wrap: true}
              ]
          },
          footer: {
            type: "box",
            layout: "vertical",
            spacing: "sm",
            contents: [
              {
                type: "button",
                style: "primary",
                action: {
                  type: "uri",
                  label: "詳細を見る",
                  uri: shop.urls.pc
                }
              }
            ]
          }
        }));
        await client.replyMessage(event.replyToken, [
          {
            type: "flex",
            altText: "おすすめのお店をご紹介します！",
            contents: {
              type: "carousel",
              contents: bubbles
            }
          },
          {
            type: "text",
            text: "気に入らない場合は、他の候補も見てみますか？",
            quickReply: {
              items: [
                {
                  type: "action",
                  action: {
                    type: "message",
                    label: "違う店が見たい",
                    text: "違う店"
                  }
                }
              ]
            }
          }
        ]);
      }
    }));
    res.status(200).end();
  } catch (err) {
    console.error("❌ エラー:", err);
    res.status(500).end();
  }
});

app.post("/webhook/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const event = JSON.parse(req.body.toString());

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const lineUserId = session.metadata?.lineUserId;

      if (lineUserId) {
        await userDB.updateOne(
          { lineUserId },
          {
            $set: {
              subscribed: true,
              stripeCustomerId: session.customer,
              updatedAt: new Date()
            }
          },
          { upsert: true }
        );
        console.log(`✅ ユーザー ${lineUserId} をsubscribed に更新しました`);
      }
    }

    res.status(200).end();
  } catch (err) {
    console.error("❌ Stripe Webhook エラー:", err);
    res.status(500).end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Bot is running on port ${PORT}`);
});