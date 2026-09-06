'use strict';

function shortExcerpt(story) {
  const text = (story.spreads || []).slice(0, 2).map(s => s.text || '').join(' ').replace(/\s+/g, ' ').trim();
  const words = text.split(' ');
  if (words.length <= 65) return text;
  const cut = words.slice(0, 65).join(' ');
  const sentence = cut.match(/^.*[.!?](?:[”"])?(?=\s|$)/);
  return sentence ? sentence[0] : `${words.slice(0, 60).join(' ')}...`;
}

// An extractive blurb from the opening keeps the back cover specific to the
// child's actual story, avoids spoilers, and needs no additional model call.
function backCoverSynopsis(story, { cached } = {}) {
  if (typeof cached === 'string' && cached.trim()) return cached;
  return shortExcerpt(story);
}

module.exports = { backCoverSynopsis, shortExcerpt };
