
require("dotenv").config(); // ← ここが抜けていた ✅
console.log("✅ MONGO_URI:", process.env.MONGO_URI);

const express = require("express");
const { Client, middleware } = require("@line/bot-sdk");
const { OpenAI } = require("openai");
const axios = require("axios");
const { genreMap, budgetMap, keywordSuggestions } = require("./hotpepper_keyword_map");
const { MongoClient } = require("mongodb");

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();


const mongoClient = new MongoClient(process.env.MONGO_URI);
let userDB;

mongoClient.connect()
  .then(client => {
    console.log("✅ MongoDB接続成功");
    userDB = client.db("linebot").collection("users");

    // ✅ MongoDB接続成功後にExpressを起動
    const PORT = process.env.PORT || 1000;
    app.listen(PORT, () => {
      console.log(`✅ Bot is running on port ${PORT}`);
    });
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

// 🔥 Stripeのプラン定義（よりわかりやすく改善）
const stripePlans = {
  basic: {
    priceId: "price_1Rc4DbCE2c7uO9vomtr7CWPk",
    usageLimit: 20,
    label: "ベーシック（月500円）"
  },
  standard: {
    priceId: "price_1RgOITCE2c7uO9vor59pbAx2",
    usageLimit: 40,
    label: "スタンダード（月1000円）"
  },
  premium: {
    priceId: "price_1RgOJzCE2c7uO9voM5P9BmIH",
    usageLimit: Infinity,
    label: "プレミアム（月2000円・無制限）"
  }
};



// ✅ プランをユーザーが選択できるように修正
app.post("/create-checkout-session", express.json(), async (req, res) => {
  const { userId, plan } = req.body; // ← planを追加

  if (!stripePlans[plan]) {
    return res.status(400).json({ error: "無効なプランです。" });
  }

  const priceId = stripePlans[plan].priceId;

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }], // 動的にpriceをセット
      success_url: "https://line-gourmet-bot.onrender.com/success",
      cancel_url: "https://line-gourmet-bot.onrender.com/cancel",
      metadata: { lineUserId: userId },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Stripeセッション作成エラー:", err);
    res.status(500).json({ error: err.message });
  }
});


app.post("/create-portal-session", express.json(), async (req, res) => {
  const { userId } = req.body;

  try {
    const user = await userDB.findOne({ userId });

    if (!user || !user.stripeCustomerId) {
      return res.status(404).json({ error: "Stripeの顧客IDが見つかりません" });
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: "https://line.me",
    });

    res.json({ url: portalSession.url });
  } catch (err) {
    console.error("❌ カスタマーポータルセッション作成エラー:", err);
    res.status(500).json({ error: err.message });
  }
});



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

app.post("/webhook/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_ENDPOINT_SECRET);
  } catch (err) {
    console.error("❌ Stripe署名検証エラー:", err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case "checkout.session.completed": {
  const session = event.data.object;
  const lineUserId = session.metadata?.lineUserId;

  // プランのprice_idを取得（sessionから）
  const purchasedPlanId = session.items.data[0].price.id;

  if (lineUserId) {
    await userDB.updateOne(
      { userId: lineUserId },
      {
        $set: {
          subscribed: true,
          stripeCustomerId: session.customer,
          planId: purchasedPlanId, // ← ここにプランのIDを保存
          usageCount: 0,           // 新しく購入したため利用回数を0にリセット
          usageMonth: new Date().getMonth(), // 月も更新する
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );
    console.log(`✅ ユーザー ${lineUserId} をsubscribedに更新し、プラン（${purchasedPlanId}）をDBに保存しました`);
  }
  break;
}

    case "customer.subscription.deleted":
    case "customer.subscription.updated":{
      const subscription = event.data.object;
      const customerId = subscription.customer;

      if (subscription.status !== "active") {
        await userDB.updateOne(
          { stripeCustomerId: customerId },
          {
            $set: {
              subscribed: false,
              updatedAt: new Date()
            }
          }
        );
        console.log(`🚫 ユーザー（Customer ID: ${customerId}）をunsubscribedに更新しました`);
      }
      break;
      }

    default:
      console.log(`🤷‍♂️ 未処理のイベントタイプ ${event.type}`);
  }

  res.status(200).end();
});





app.post("/webhook", middleware(config), async (req, res) => { 
  try {
    const events = req.body.events;
    await Promise.all(events.map(async (event) => {
      const userId = event.source.userId;

      if (event.type === "message" && event.message.type === "text") {
        const userInput = event.message.text;


        // 🔥【ここに追加】🔥
        const userDoc = await userDB.findOne({ userId });

        // 初回（userDocが存在しない場合）
        if (!userDoc) {
          await userDB.insertOne({
            userId,
            usageCount: 1, // 初回利用カウント
            subscribed: false,
            usageMonth: new Date().getMonth(),
            updatedAt: new Date()
          });

          await client.replyMessage(event.replyToken, {
            type: "text",
            text: "🔰 初回は無料でご利用いただけます！ご希望のお店をお伝えください。"
          });
          return; // 初回終了（初回はここでリターン）
        }

        // 2回目以降
        if (!userDoc.subscribed) { // 未サブスクユーザーの処理
          if (userDoc.usageCount >= 1) { // 既に1回使用済みの場合
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: "🔒 無料でのご利用は1回のみです。引き続き利用するには、以下からプランをお選びください。",
              quickReply: {
                items: [
                  {
                    type: "action",
                    action: {
                      type: "postback",
                      label: "ベーシック（月500円・20回）",
                      data: "action=selectPlan&plan=basic",
                      displayText: "ベーシックプランを選択"
                    }
                  },
                  {
                    type: "action",
                    action: {
                      type: "postback",
                      label: "スタンダード（月1000円・40回）",
                      data: "action=selectPlan&plan=standard",
                      displayText: "スタンダードプランを選択"
                    }
                  },
                  {
                    type: "action",
                    action: {
                      type: "postback",
                      label: "プレミアム（月2000円・無制限）",
                      data: "action=selectPlan&plan=premium",
                      displayText: "プレミアムプランを選択"
                    }
                  }
                ]
              }
            });
            return; // 無料使用回数を超えたので、ここでリターン
          } else {
            // 2回目以降だがまだ無料回数内（今回の要件だとここは不要だが安全策）
            await userDB.updateOne(
              { userId },
              { $inc: { usageCount: 1 }, $set: { updatedAt: new Date() } }
            );
          }
        }

        // サブスク済ユーザー（月間使用回数チェック）
        if (userDoc.subscribed) {
          const currentMonth = new Date().getMonth();
          if (userDoc.usageMonth !== currentMonth) {
            await userDB.updateOne(
              { userId },
              { $set: { usageCount: 0, usageMonth: currentMonth } }
            );
            userDoc.usageCount = 0;
          }

          let usageLimit = 0;
          switch (userDoc.planId) {
            case stripePlans.basic.priceId:
              usageLimit = stripePlans.basic.usageLimit;
              break;
            case stripePlans.standard.priceId:
              usageLimit = stripePlans.standard.usageLimit;
              break;
            case stripePlans.premium.priceId:
              usageLimit = Infinity;
              break;
            default:
              usageLimit = 0; // 不明な場合は安全に0に設定
          }

          if (userDoc.usageCount >= usageLimit) {
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: "🔒 今月の利用上限に達しました。プランの変更またはアップグレードをご検討ください。",
              quickReply: {
                items: [
                  {
                    type: "action",
                    action: {
                      type: "postback",
                      label: "プラン変更",
                      data: "action=selectPlan",
                      displayText: "プラン変更"
                    }
                  }
                ]
              }
            });
            return;
          } else {
            await userDB.updateOne(
              { userId },
              { $inc: { usageCount: 1 }, $set: { updatedAt: new Date() } }
            );
          }
        }

 if (userInput.includes("解約") || userInput.includes("キャンセル")) {
  const response = await axios.post("https://line-gourmet-bot.onrender.com/create-portal-session", { userId });
  const portalUrl = response.data.url;

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `🔧 サブスクリプションの解約はこちら:\n${portalUrl}`
  });
}

else if (userInput.includes("プラン変更")) {
  // プラン変更（クイックリプライ）
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: "🔧 ご希望のプランを選択してください。",
    quickReply: {
      items: Object.entries(stripePlans).map(([planKey, details]) => ({
        type: "action",
        action: {
          type: "postback",
          label: details.label,
          data: `action=selectPlan&plan=${planKey}`,
          displayText: `${details.label}を選択`
        }
      }))
    }
  });
}



// 途中希望もっと静か・おしゃれ・個室などを初回取得済みショップから再選出する形式
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
     userInput.includes("隠れ家") ||
      userInput.includes("有名") ||
       userInput.includes("知る人ぞ知る") ||
        userInput.includes("有名") ||
         userInput.includes("人気") ||
          userInput.includes("行列") ||
           userInput.includes("SNS") ||
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
   `上記をもとに、以下の店舗リストから3件選び、理由を添えてください。\n` +
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


  const prevLocation = previous.previousStructure.location || "";
const prevGenre = previous.previousStructure.genre || "";
const prevKeyword = previous.previousStructure.keyword || "";




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



const prompt = 
`ユーザーの希望は「${previous.original}」です。
最初に検索した場所は「${prevLocation}」、ジャンルは「${prevGenre}」、キーワードは「${prevKeyword}」です。
必ずこれらの条件を踏まえ、以下の残り候補から違う3件を選び、理由を添えてください。
形式：
- 店名: ○○
- 理由: ○○`;

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
      url: shop.photo.pc.l ,
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
      content: `次の日本語文から以下を抽出してください：\n場所:\nジャンル:\n予算:\nキーワード:
      キーワード候補として以下を参考にしてください:
      ${keywordSuggestions.join(", ")}`
    },
    { role: "user", content: userInput }
  ]
});

const parsed = gptExtract.choices[0].message.content;
const location = parsed.match(/場所:\s*(.*)/)?.[1]?.trim() || "";
const genre = parsed.match(/ジャンル:\s*(.*)/)?.[1]?.trim() || "";
const keyword = parsed.match(/キーワード:\s*(.*)/)?.[1]?.trim() || "";
const budget = parsed.match(/予算:\s*(.*)/)?.[1]?.trim() || ""; 

await client.pushMessage(userId, {
  type: "text",
  text: "🔎 ご希望に合うお店を検索しています…"
});


// 🔁 検索条件を判定して、ジャンル検索 or 総合検索を分岐
const genreCode = genreMap[genre] || "";
const budgetCode = budgetMap[budget] || "";
const filters = ""; 
const allShops = await fetchShops(`${location} ${keyword || ""} ${filters || ""}`.trim(), genreCode, budgetCode);if (allShops.length === 0) {
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: "条件に合うお店が見つかりませんでした🙏"
  });
}

// 🔍 GPTに意味フィルタ選出（キーワードがあれば考慮させる）
const shopList = allShops.map(s => `店名: ${s.name} / 紹介: ${s.catch}`).join("\n");
const prompt = `ユーザーの希望は「${userInput}」です。以下のお店から希望に合いそうな3件を選んでください。できれば「${keyword}」の要素が入っているものを優先してください。\n形式：\n- 店名: ○○○\n- 理由: ○○○`;

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
  shown: selected.map(s => s.name),
  previousStructure: { location, genre, keyword } // ← 初回検索の条件をここに明確に保存
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

    // 🔥 作業４（今回追加したpostback処理）
   
     else if (event.type === "postback"){
        const replyToken = event.replyToken;
        const postbackData = new URLSearchParams(event.postback.data);

       
        
        const userDoc = await userDB.findOne({ userId });
        if (postbackData.get("action") === "selectPlan") {
  const planKey = postbackData.get("plan");
  
  const paymentLinks = {
    basic: "https://buy.stripe.com/eVq9AS2224B6d31ejM33W00",
    standard: "https://buy.stripe.com/eVqeVc4aa3x2d31b7A33W01",
    premium: "https://buy.stripe.com/fZu9ASbCC9Vqgfd1x033W02"
  };

  const sessionUrl = paymentLinks[planKey];

  if (!sessionUrl) {
    return client.replyMessage(replyToken, {
      type: "text",
      text: "⚠️ 選択されたプランの決済リンクが見つかりませんでした。再度お試しください。"
    });
  }

  await client.replyMessage(replyToken, {
    type: "text",
    text: `✅ 選択されたプランの登録・変更はこちらからお手続きください。\n${sessionUrl}`
  });

  return;
}

// ① userDocが存在しない場合（初回ユーザー）を先に処理
if (!userDoc) {
  await userDB.insertOne({
    userId,
    usageCount: 1,
    subscribed: false,
    previousStructure: null,
    allShops: [],
    shown: [],
    original: userInput,
    usageMonth: new Date().getMonth(),
    updatedAt: new Date()
  });
  console.log("🆕 新規ユーザー登録：1回目無料で続行");
} else {
  // ② userDocが存在する場合（通常処理）
  
  let usageLimit = 1; // 無料ユーザーのデフォルト値
  if (userDoc.subscribed) {
    switch (userDoc.planId) {
      case "price_1Rc4DbCE2c7uO9vomtr7CWPk":
        usageLimit = 20;
        break;
      case "price_1RgOITCE2c7uO9vor59pbAx2":
        usageLimit = 40;
        break;
      case "price_1RgOJzCE2c7uO9voM5P9BmIH":
        usageLimit = Infinity;
        break;
    }
  }

  const currentMonth = new Date().getMonth();
  if (userDoc.usageMonth !== currentMonth) {
    await userDB.updateOne(
      { userId },
      { $set: { usageCount: 0, usageMonth: currentMonth } }
    );
    userDoc.usageCount = 0; // リセットを反映
  }

 if (userDoc.usageCount >= usageLimit) {
  await client.replyMessage(event.replyToken, {
    type: "text",
    text: "🔒 月間の利用回数を超えました。ご希望のプランをお選びください。",
    quickReply: {
      items: [
        {
          type: "action",
          action: {
            type: "postback",
            label: "ベーシック（月500円・20回）",
            data: "action=selectPlan&plan=basic",
            displayText: "ベーシックプランを選択"
          }
        },
        {
          type: "action",
          action: {
            type: "postback",
            label: "スタンダード（月1000円・40回）",
            data: "action=selectPlan&plan=standard",
            displayText: "スタンダードプランを選択"
          }
        },
        {
          type: "action",
          action: {
            type: "postback",
            label: "プレミアム（月2000円・無制限）",
            data: "action=selectPlan&plan=premium",
            displayText: "プレミアムプランを選択"
          }
        }
      ]
    }
  });
  return;
}


  await userDB.updateOne(
    { userId },
    { $inc: { usageCount: 1 }, $set: { updatedAt: new Date() } }
  );
  console.log(`🟢 利用回数: ${userDoc.usageCount + 1}/${usageLimit}`);
}
}
   }));
       res.status(200).end(); // LINEへの正常レスポンス
  } catch (err) { // tryブロック終了＆catch開始
    console.error("❌ webhookエラー:", err);
    res.status(500).end();
  } // catch終了
}); 
   