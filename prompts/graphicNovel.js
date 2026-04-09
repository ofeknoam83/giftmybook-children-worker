'use strict';

const GRAPHIC_NOVEL_SYSTEM = `You are a master children's graphic novelist creating a personalized illustrated story book for a child aged 9-12.

You will write exactly 35 story beats across 5 scenes (7 beats per scene).
Each beat becomes one illustrated page in the book.

STORY STRUCTURE (5 scenes, 7 beats each):
- Scene 1 (beats 1-7): Setup — introduce the child, their world, and the mission/quest
- Scene 2 (beats 8-14): Rising action — first challenges and discoveries
- Scene 3 (beats 15-21): Complications — things get harder, the stakes rise
- Scene 4 (beats 22-28): Climax — the biggest challenge, beat 25 is the SPLASH moment
- Scene 5 (beats 29-35): Resolution — triumph, change, emotional landing, beat 35 is the final SPLASH

BEAT TYPES:
- "story": single illustration page with text zone at bottom (USE FOR ALL beats except splashes)
- "splash": full-page dramatic illustration, minimal text (USE ONLY for beat 25 and beat 35)

WRITING RULES:
- caption: 1-2 sentences of vivid narrator poetry, max 25 words. Present tense. Evocative, not explanatory. Empty string "" if the image tells it.
- dialogue: What the character says, max 10 words. ALL-CAPS is applied automatically. Empty string "" if no one speaks this beat.
- speaker: "left" or "right" — which side of the image the speaking character will be on
- image: Rich scene description. What we SEE. 50-80 words. Include: what the character is doing, their expression, the environment (foreground, background), lighting/mood. End EVERY story beat image description with: "COMPOSITION: leave bottom 20% of image as simple background (floor, sky, wall, space) — text is placed there."
- DO NOT mention art style in image descriptions — that is applied separately.

OUTPUT FORMAT — return ONLY valid JSON, no markdown:
{
  "title": "...",
  "beats": [
    {
      "n": 1,
      "scene": 1,
      "type": "story",
      "caption": "...",
      "dialogue": "...",
      "speaker": "left",
      "image": "..."
    }
  ]
}`;

function GRAPHIC_NOVEL_USER(childDetails, theme, customDetails, seed, artStyle) {
  const name = childDetails.childName || childDetails.name;
  const age = childDetails.childAge || childDetails.age;
  const gender = childDetails.childGender || childDetails.gender;
  const pronoun = gender === 'girl' ? 'she' : gender === 'boy' ? 'he' : 'they';
  const pronounObj = gender === 'girl' ? 'her' : gender === 'boy' ? 'his' : 'their';

  return `Create a 35-beat graphic novel story for ${name}, age ${age}.

CHILD DETAILS:
Name: ${name}
Age: ${age}
Gender: ${gender} (pronoun: ${pronoun}/${pronounObj})
Theme: ${theme}
About ${name}: ${customDetails || 'A curious and brave child who loves adventure.'}
Story seed: ${seed?.storySeed || ''}
Setting: ${seed?.setting || 'a magical world'}
${seed?.repeated_phrase ? `Recurring phrase: "${seed.repeated_phrase}"` : ''}

RULES:
- Every beat must advance the story — no filler
- Beat 25: type "splash" — the climactic moment of scene 4
- Beat 35: type "splash" — the triumphant final moment
- All other beats: type "story"
- Caption and dialogue can both be empty for pure action beats
- The story must have a clear arc: want → obstacle → effort → triumph → change
- Include at least one memorable repeatable line (the kind a parent would quote)
- Personalize every scene: use ${name}'s name, specific details from customDetails

Art style context (DO NOT put in image descriptions): ${artStyle || 'cinematic_3d'}`;
}

module.exports = { GRAPHIC_NOVEL_SYSTEM, GRAPHIC_NOVEL_USER };
