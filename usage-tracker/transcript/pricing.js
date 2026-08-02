'use strict';
// モデル別の API 定価($/MTok)。sessions.js / turncost.js のコスト換算で共通に使う
// (breakdown.js はトークン内訳のみでコスト換算をしないため参照しない)。
// cache_read=0.1x, cache_creation=1.25x として重み付けするのは呼び出し側の cost() 関数。
module.exports = {
  'fable-5':            { in: 10, out: 50 },
  'opus-5':             { in: 5,  out: 25 },
  'opus-4-8':           { in: 5,  out: 25 },
  'opus-4-7':           { in: 5,  out: 25 },
  'opus-4-6':           { in: 5,  out: 25 },
  'sonnet-5':           { in: 3,  out: 15 },
  'sonnet-4-6':         { in: 3,  out: 15 },
  'haiku-4-5-20251001': { in: 1,  out: 5  },
};
