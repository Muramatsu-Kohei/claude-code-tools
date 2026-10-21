'use strict';
// モデル別の API 定価($/MTok)。sessions.js / turncost.js のコスト換算で共通に使う
// (breakdown.js はトークン内訳のみでコスト換算をしないため参照しない)。
// 出典: https://platform.claude.com/docs/en/about-claude/pricing(2026-10-21 確認)。
//
// 重み付けは呼び出し側の cost() 関数が行う。キャッシュ書き込みはどのモデルも 5 分 TTL が 1.25x、
// 1 時間 TTL が 2x で共通なので表に持たない。キャッシュ読みは世代で倍率が違う
// (標準は 0.1x、Opus 5.5 / Sonnet 5.5 は 0.05x、Fable 5.1 は 0.025x)ので read に持つ。
// long は prompt 長で単価が切り替わるモデル用。prompt(input + cache 書き込み + cache 読み)が
// over を超えたリクエストは、全トークンを long 側の in/out で数える。
//
// 表に無いモデルは $0 で数えられ、warnUnknownModels() が報告する。5.5 世代の追加漏れで
// 全コストが $0 になっていた実例があるので、警告が出たら表を足すこと。
module.exports = {
  'fable-5-1':          { in: 10,  out: 50,  read: 0.025 },
  'fable-5':            { in: 10,  out: 50 },
  'opus-5-5':           { in: 4,   out: 20,  read: 0.05 },
  'opus-5':             { in: 5,   out: 25 },
  'opus-4-8':           { in: 5,   out: 25 },
  'opus-4-7':           { in: 5,   out: 25 },
  'opus-4-6':           { in: 5,   out: 25 },
  'sonnet-5-5':         { in: 2,   out: 10,  read: 0.05 },
  // 発売時の導入価格 $2/$10 がそのまま定価になった(9/1 の $3/$15 への値上げは中止)
  'sonnet-5':           { in: 2,   out: 10 },
  'sonnet-4-6':         { in: 3,   out: 15 },
  'haiku-5-5':          { in: 0.1, out: 0.5, long: { over: 100e3, in: 0.5, out: 2.5 } },
  'haiku-4-5-20251001': { in: 1,   out: 5  },
};
