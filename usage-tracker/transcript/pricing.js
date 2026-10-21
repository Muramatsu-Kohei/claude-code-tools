'use strict';
// モデル別の API 定価($/MTok)。sessions.js / turncost.js のコスト換算で共通に使う
// (breakdown.js はトークン内訳のみでコスト換算をしないため参照しない)。
// 出典: https://platform.claude.com/docs/en/about-claude/pricing(2026-10-21 確認)。
//
// 重み付けは lib.js の cost() が行い、キャッシュ倍率の既定値も lib.js の CACHE_* 定数にある。
// この表に書くのは既定と違うものだけ: read はキャッシュ読みの倍率(input 単価に掛ける)で、
// 既定の 0.1x と違うモデル(Opus/Sonnet 5.5 は 0.05x、Fable 5.1 は 0.025x)にだけ持たせる。
// long は prompt 長で単価が切り替わるモデル用。prompt(input + cache 書き込み + cache 読み)が
// over を超えたリクエストは、全トークンを long 側の in/out(と read があればそれ)で数える。
// 4.6 以降で長コンテキストの割増があるのは Haiku 5.5 だけ(他は 1M まで標準単価)。
// fast は fast mode(usage.speed === 'fast')の in/out。prompt 長によらず一律で、キャッシュ倍率は
// その上に通常どおり掛かる(read も標準と同じ値を使う)。対応するのは Opus 5.5 / 5 / 4.8 だけ。
// キーは日付なしの形で書く。lib.js の modelKey() が ID 末尾の -YYYYMMDD を落とす。
//
// 表に無いモデルは $0 で数えられ、warnUnknownModels() が報告する。5.5 世代の追加漏れで
// 全コストが $0 になっていた実例があるので、警告が出たら表を足すこと。
module.exports = {
  'fable-5-1':          { in: 10,  out: 50,  read: 0.025 },
  'fable-5':            { in: 10,  out: 50 },
  'opus-5-5':           { in: 4,   out: 20,  read: 0.05, fast: { in: 8,  out: 40 } },
  'opus-5':             { in: 5,   out: 25,              fast: { in: 10, out: 50 } },
  'opus-4-8':           { in: 5,   out: 25,              fast: { in: 10, out: 50 } },
  'opus-4-7':           { in: 5,   out: 25 },
  'opus-4-6':           { in: 5,   out: 25 },
  'sonnet-5-5':         { in: 2,   out: 10,  read: 0.05 },
  // 発売時の導入価格 $2/$10 がそのまま定価になった(9/1 の $3/$15 への値上げは中止)
  'sonnet-5':           { in: 2,   out: 10 },
  'sonnet-4-6':         { in: 3,   out: 15 },
  'haiku-5-5':          { in: 0.1, out: 0.5, long: { over: 100e3, in: 0.5, out: 2.5 } },
  'haiku-4-5':          { in: 1,   out: 5  },
};
