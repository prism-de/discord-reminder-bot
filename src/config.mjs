// src/config.mjs

// 対象チャンネル名（部分一致）
export const CHANNEL_NAME_KEYWORDS = ["様連絡用", "様共有用"];

// 対象ロール（メンションされたユーザーがこのどれかを持っていること）
export const ALLOWED_ROLES = [
  "Prism正規カリキュラム講師",
  "Prismディベート講師",
  "Prism総コン商社講師",
  "Prismメンバー",
];

// 「対応済み」とみなすリアクションのセット（元メッセージについていること）
export const OK_REACTIONS = new Set(["✅", "👍", "🙇‍♂️", "🙇‍♀️", "🙇", "❤️"]);

// リマインドのチェック間隔（ミリ秒）— 10分ごとに期限到来を確認
export const CHECK_INTERVAL_MS = 10 * 60 * 1000;

// メンションからリマインドまでの待機時間（ミリ秒）— 本番は2日
//export const REMIND_AFTER_MS = 2 * 24 * 60 * 60 * 1000;
export const REMIND_AFTER_MS = 10 * 1000;

// テスト時は 60 * 1000（1分）などに一時変更して挙動確認すると便利
