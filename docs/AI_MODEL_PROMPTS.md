# GiftMyBook — AI Model Prompts (by Flow Order)

> A consolidated inventory of **every AI model prompt** across the GiftMyBook codebase, organized by the order in which each prompt fires during a generation flow. Covers all three repositories:
>
> - **`giftmybook-standalone`** — the web app (Express + React) that orchestrates everything and also makes many direct AI calls.
> - **`giftmybook-children-worker`** — the Cloud Run service that generates personalized children's books (text + illustrations) and add-ons (covers, coloring books, comics, games).
> - **`giftmybook-worker`** — the Cloud Run service that generates general/adult books, ebooks, audiobooks, and comics.
>
> Each entry gives a short name, the file:line where the prompt lives, the model/provider and role, and the verbatim prompt text (templates keep their `${placeholder}` expressions). Very long prompts note their line count.

## How to read this document

The codebase contains **layered generations** of the children's-book pipeline (a legacy `storyPlanner.js` + `prompts/` system, the structured `bookPipeline` planner, and `Writer V2` under `services/writer/`). All are documented here as distinct subsystems; each subsystem's section is internally ordered by flow. "MAIN" vs "SIDE/LEGACY" tags indicate the production path vs. alternate/optional paths where known.

## AI providers & models in use

| Provider | Models seen | Typical roles |
|----------|-------------|---------------|
| **OpenAI** | `gpt-5.4`, `gpt-5.4-mini`, `gpt-4.1-mini`, `gpt-4o-mini`, `gpt-image-2` | Writer / critic / adjudicator (manuscript quality), titles, dialogue, QA review, square-frame illustration |
| **Google Gemini** | `gemini-3.1-pro-preview`, `gemini-3.1-flash-image` (Nano Banana 2), `gemini-3-flash-preview`, `gemini-2.5-pro`, `gemini-2.5-flash` | All image generation (covers, spreads, coloring, comics, game assets), all vision QA/OCR, scene planning, summarizer |
| **DeepSeek** | `deepseek-v4-pro`, `deepseek-v4-flash` | Planner / director / rhyme-judge (structured-output tasks; cheaper) |
| **Google Cloud TTS** | Chirp3-HD / Wavenet voices | Audiobook narration (SSML/voice config — not LLM prompts) |
| ~~Anthropic / Claude~~ | — | **Not used anywhere in the codebase.** |

**Routing notes:** In `giftmybook-worker`, `services/gemini.js` auto-selects the provider from the model-name prefix and fails over to `gemini-2.5-flash`; `functionCall()` strips DeepSeek from function-calling chains. In `giftmybook-children-worker`, the legacy `storyPlanner.js` text stages are "PLANNER-routed" (DeepSeek default, Gemini fallback), while `Writer V2` defaults all roles to `gpt-5.4`. Per-role overrides via `BOOK_PIPELINE_V2_<ROLE>_FAMILY` env vars.

## Top-level contents

1. **giftmybook-standalone** — web-app flows (content, covers, children options, post-gen edits, audiobook localization, support, admin, passthrough).
2. **giftmybook-children-worker**
   - 2.1 Story brainstorm & writing (storyPlanner brainstorm, writerBrief master templates, Writer V2, alternate formats).
   - 2.2 Book pipeline — planner → writer QA → book-wide QA (`services/bookPipeline`).
   - 2.3 Illustrator — interior render + image vision-QA (`services/illustrator`).
   - 2.4 Add-ons & side flows (cover, coloring book, comics, game assets, narrative-pattern selector).
3. **giftmybook-worker** — book writing, illustrations, comics, audiobook (general/adult).

---


# 1. giftmybook-standalone (web app)

# AI Prompts in giftmybook-standalone (by flow order)

## Summary

This repo is the **web app** (Express server + React client). Most heavy book generation is delegated to Cloud Run **workers** (`submitToWorker`, `callWorker('/generate-cover')`, `/rebuild-docx`, etc. in `server/services/docx.js` and `server/services/cloudrun.js`). **However, the standalone server DOES make many direct AI calls itself** — title/TOC/preview/manuscript generation, cover image generation, back-cover copy, support chat, admin QA, audiobook translation, etc.

All LLM text calls funnel through `services/gemini.js#invokeLLM` (Gemini 2.5 Flash primary → GPT-5.4-mini fallback) or `services/geminiProxy.js#proxyText`. Image calls go through `services/gemini.js#generateImage` / `proxyImage` (Gemini 3.1 Flash Image, with GPT-image-2 fallback via `services/openaiImage.js`). Some admin routes call OpenAI `gpt-5.4` directly.

`services/geminiProxy.js` and `services/openaiImage.js` are **transport only** (no embedded prompts). `client/` contains **no prompts** (it only calls these endpoints; `AdminChildrenQA.jsx` merely displays a worker-returned prompt).

Flow groups below: **(A)** Adult/"chat book" creation flow, **(B)** Cover generation, **(C)** Children's book flow, **(D)** Post-generation edit flow, **(E)** Audiobook, **(F)** Support, **(G)** Admin tools, **(H)** Generic base44-replacement passthrough.

---

## A. Adult "chat book" content flow (`server/routes/content.js`, model: invokeLLM → gemini-2.5-flash / gpt-5.4-mini)

Flow order in the app: **titles → toc (+ first chapter preview) → chapter-preview / character-description → manuscript → submit-docx (delegates to worker)**.

### A1. Title generation — `content.js:102-124`
System prompt (memoir vs default), `content.js:117-119`:
```
You are a world-class book title creator specializing in evocative, personal memoir titles. Always respond with valid JSON.
```
or
```
You are a world-class book title creator specializing in witty, personalized gift books. Always respond with valid JSON.
```
User prompt (`content.js:102-115`, template):
```
Generate 3 ${titleStyle} for a personalized gift book about ${subjectDesc}.
${occasion ? `Gift occasion: ${occasion}` : ''}
${isPetBook ? `This is a pet book about a ${petType}.` : ''}
${isCoupleBook ? `This is a couple's book.` : ''}${coupleGenderNote}

Character / Story Details:
${highlightReel || `Main character: ${mainCharacter}`}

Requirements:
${titleToneReq}
- Max 6 words per title, no colons
${coupleTitleReq}- Include a subtitle and short synopsis (max 30 words) as reasoning

Return exactly 3 titles as JSON: {"titles": [{"title": "...", "subtitle": "...", "reasoning": "..."}]}
```
(`titleStyle`/`titleToneReq` swap memoir vs comedy; `coupleGenderNote` adds pronoun/gender rules at lines 86-88.)

### A2. Table of Contents — `content.js:163-183`
System prompt:
```
You are an expert narrative architect specializing in personalized gift books. Always respond with valid JSON.
```
User prompt (`content.js:163-178`):
```
You are an expert narrative architect. Create 14 chapters + 1 epilogue (15 total) for a personalized book.

Book Title: "${book.title}"
Genre: ${book.genre}
Main Character(s): ${authors}
${structureInstructions}

Character Registry:
${characterRegistry}

Story Context:
${storyContext || 'A story about interesting characters'}

HERO PROTECTION: The main character is the gift recipient. Every chapter description must portray them as fundamentally lovable and sympathetic. Edgy or blunt personality traits should be framed as endearing quirks, never as meanness.

Return JSON: {"chapters": [{"title": "...", "description": "...", "pages": "1-16"}, ...]} (exactly 15 items, pages 1-240)
```
`structureInstructions` (memoir vs default), `content.js:160-161`:
```
Structure: Thematic/episodic. Each chapter is a self-contained essay organized around one life theme, relationship, era, or recurring situation. Chapters do NOT build toward a single climax. Order for emotional variety and natural flow. Include specific scenes from the story context in each chapter description.
```
/
```
Structure: One escalating narrative arc with connected, cause-and-effect chapters.
```

### A3. First chapter preview (inside /toc) — `content.js:205-217`
System prompt (memoir vs default), `content.js:211-213`:
```
You are a talented author writing personal memoirs in the tradition of David Sedaris — warm, observational, wryly self-deprecating. Always respond with valid JSON.
```
/
```
You are a talented author writing personalized comedy books. Always respond with valid JSON.
```
User prompt (`content.js:205-209`):
```
Write the OPENING SECTION of the first chapter titled "${firstTitle}" (600-800 words).
Book Title: "${book.title}", Genre: ${book.genre}, Main Character: ${mainChar}
Story details: ${questionContext}
IMPORTANT: The main character is the gift recipient. This is a GIFT book — portray them as lovable, warm, and sympathetic. If their personality includes edgy traits (blunt honesty, dark humor, stubbornness), show these as charming quirks that make people love them. NEVER write the protagonist being cruel, petty, or unkind.
Return JSON: {"content": "..."}
```

### A4. Chapter preview (standalone endpoint + GET cached) — `content.js:258-271` and `content.js:455-468`
Same system prompts as A3 (memoir vs comedy). User prompt (`content.js:258-262` / `455-459`):
```
Write the opening 600-800 words of chapter "${title}" for book "${book.title}".
Genre: ${book.genre}, Main Character: ${mainChar}
Details: ${context}
IMPORTANT: The main character is the gift recipient. This is a GIFT book — portray them as lovable, warm, and sympathetic. If their personality includes edgy traits (blunt honesty, dark humor, stubbornness), show these as charming quirks that make people love them. NEVER write the protagonist being cruel, petty, or unkind.
Return JSON: {"content": "..."}
```

### A5. Character description — `content.js:296-307`
System prompt (memoir vs default), `content.js:300-302`:
```
You are a character designer for personal memoirs — warm, specific, and humanizing. Always respond with valid JSON.
```
/
```
You are a character designer for personalized comedy books. Always respond with valid JSON.
```
User prompt (`content.js:296-298`):
```
Generate a ${charDescTone} character description for ${characterName || 'the main character'} in book "${book.title}".
Details: ${JSON.stringify(briefData.answeredQuestions?.slice(0, 5) || [])}
Return JSON: {"description": "..."}
```

### A6. Full manuscript — `content.js:331-344`
System prompt (memoir vs default), `content.js:337-339`:
```
You are a bestselling memoir author in the tradition of David Sedaris writing personalized gift books. Always respond with valid JSON.
```
/
```
You are a bestselling comedy author writing personalized gift books. Always respond with valid JSON.
```
User prompt (`content.js:331-335`):
```
Create ${manuscriptType} for "${book.title}".
Genre: ${book.genre}
Characters: ${book.participants?.join(', ') || 'Main characters'}
Write 8 chapters, each 600-800 words. ${manuscriptTone}
Return JSON: {"summary": "...", "chapters": [{"title": "...", "content": "..."}]}
```

> A7. `POST /submit-docx` (`content.js:361`) is **delegation only** — `submitToWorker()` (no prompt here).

---

## B. Cover generation (`server/routes/covers.js`)

### B1. Front cover IMAGE generation — `covers.js:266`, `:331`, `:408`
`generateGoogleAICover()` builds one of three image prompts (mode = artistic / couple / photo), then races **Gemini 3.1 Flash Image** (direct + proxy, `aspectRatio 2:3`) with **gpt-image-2** fallback (`covers.js:519-615`).

- **Artistic mode** (`covers.js:266-316`, ~50 lines): begins `ALLOW TEXT ON IMAGE:` ... renders exact title + "A Story about ${characterName}", "DO NOT INCLUDE ANY PEOPLE OR FACES", theme = `${themeFromChapters}`, rotating illustration style, composition/negative-constraint blocks.
- **Couple mode** (`covers.js:331-397`, ~67 lines): `ALLOW TEXT ON IMAGE:` ... "Author: A Story about ${char1FirstName} and ${char2FirstName}", "FACIAL LIKENESS PRIORITY (CRITICAL FOR COUPLES)" (both faces must match photo), composition rules (no close-ups, head below upper third), negative constraints.
- **Photo / single mode** (`covers.js:408-465`, ~58 lines): `ALLOW TEXT ON IMAGE:` ... "Author: ${authorLine}" (= `A STORY ABOUT ${NAME}`), "FACIAL LIKENESS PRIORITY: The face MUST match the input photo closely", subject gender/personality notes, composition + negative constraints.

All three share the rotating style list at `covers.js:245-251`:
```
'Create a beautiful cover-style illustration in portrait (2:3). painterly storybook illustration with textured brushstrokes, rich warm colors, and a nostalgic feel',
'Semi-realistic digital cartoon portrait, modern illustrated poster style, bold outlines with smooth painterly shading, vibrant saturated colors, expressive character art',
'Pixar-inspired soft 3D illustration with rounded shapes, gentle expression, warm lighting, and a cinematic family-friendly glow',
'oil painting style with rich textures, dramatic lighting, and classical artistic composition',
'Vibrant 90s cartoon style with bold outlines, bright saturated colors, and expressive character poses'
```
Verbatim photo-mode prompt (`covers.js:408-465`):
```
ALLOW TEXT ON IMAGE:
Text IS allowed on the book cover. Only render the specified title and author name. No additional text, no extra numbers, no random words, no signatures, no watermarks.

RENDER THESE EXACT TEXT ELEMENTS (in all caps), according to best practices for book covers

Book Title: ${title.toUpperCase()}

Author: ${authorLine}
The title should appear prominently near the top or upper-middle area of the cover.
The author name should appear smaller, tastefully placed near the bottom or lower-middle area.
Use clean, elegant, readable typography.

ILLUSTRATION STYLE:
Create a beautiful cover-style illustration in portrait (2:3).
${illustrationStyle}

FACIAL LIKENESS PRIORITY:
The face MUST match the input photo closely.

PRIMARY CREATIVE ANCHOR:
Theme: "${theme}"
Interpret the theme visually as one coherent, cinematic concept.

SCENE DESCRIPTION:
Subject: ${...gender...} (based on the face reference). ${personalityNotes...}

Action: show them engaged in a humorous or lively moment that reflects their personality.

Setting: an environment that reflects the character's personality and the book's theme, with strong depth and atmosphere.
Choose a background that makes sense for the story—it could be indoors, outdoors, urban, natural, or abstract, based on what fits best.

SYMBOLIC ELEMENTS (optional, 1-2 max):
Simple, generic props that hint at their personality and interests. No logos or brand markings.

PERSONALITY TONE:
They radiate joy, intelligence, humor, and curiosity. A person who brings warmth and energy into every environment.

COMPOSITION RULES:
Medium-wide, three-quarter, or full-body shot; avoid tight close-ups.
Highest point of the head must remain below the upper third of the frame.
The face should sit on or below the horizontal midline.
Ensure the title is placed where it will be clearly readable against the background.

COHERENCE & CONTINUITY:
No floating or fragmented objects.
Keep lighting, color, perspective, and shadows consistent.
The image must feel like one unified scene, not a collage.

NEGATIVE CONSTRAINTS (avoid):
close-up portraits
oversized faces dominating the frame
eyes above the 50% height line
hair above 60% height
extra or unintended text, letters, numbers, logos, UI, or symbols

TEXT RULES:
Only render the exact title and the exact author name.
No additional text should appear anywhere.
```

### B2. Back-cover COPY (synopsis + fake reviews) — `covers.js:698-741`
LLM text via invokeLLM (gemini-2.5-flash). System prompt (`covers.js:738`):
```
You are a witty book marketer writing back cover content. Always respond with valid JSON.
```
User prompt (`covers.js:698-733`, ~36 lines): "You are writing back cover content for a personalized gift book..." — outputs JSON `{synopsis, reviews:[{text,attribution:"The Daily Muse"},{...,"Weekend Reader"}]}`, with explicit gender-pronoun rules.

### B3. Cover design concept (text) — `covers.js:1165-1169`
System prompt: `You are a professional book cover designer. Always respond with valid JSON.`
User prompt (`covers.js:1165-1167`):
```
Design a book cover concept for "${book.title}" by ${book.participants?.join(', ') || 'the author'}.
Genre: ${book.genre}. ${style ? `Style: ${style}.` : ''} ${colors ? `Colors: ${colors}.` : ''}
Return JSON: {"coverDescription": "...", "colorPalette": [...], "layoutSuggestion": "..."}
```

> Note: `coverGenerationPrompt` is persisted to DB (`covers.js:645`); `generatePersonalizedBackCoverContent` is also reused by `functions.js`.

---

## C. Children's book flow (`server/routes/children.js`, `POST /books/:id/generate-options`)

Flow: child photo + brief → **(C1) 3 title concepts (LLM)** → **(C2) 3 front covers (image)** → **(C3) interior preview illustration (image)**. The full interior pipeline is delegated to the children worker; these are the preview/cover assets generated by the standalone app.

### C1. Children title concepts — `children.js:1076-1080`
invokeLLM (gemini, JSON). System prompt: `You are a creative children's book title generator.`
User prompt (`children.js:1078`, single long template line, ~40 lines of content): "You are creating 3 delightful children's book concepts for a personalized book..." — takes childName/age/gender, selected theme, theme key, genre, questionnaire highlight reel; enumerates per-theme requirements (Birthday, Bedtime Magic, Love to mom, Father's Day, Adventure, Educational, Arts & Imagination, Friends); returns JSON `{titles:[{title,subtitle,synopsis}]}`.

### C2. Children FRONT COVER image (×3 options) — `children.js:1166-1250`
`coverPrompt` per title option, generated via `generateGeminiImage` → Gemini 3.1 Flash Image (`aspectRatio 1:1`, `children.js:861-964`). ~85 lines. Verbatim opening:
```
Create a FRONT BOOK COVER for a personalized children's book in exact square format (1:1) for an 8.5 x 8.5 inch printed book.

CRITICAL FORMAT REQUIREMENT:
- The composition must be designed natively as a square cover
- The image must read beautifully in exact 1:1 format
- Leave balanced room for title placement near the top
- Do not create a portrait image cropped into a square

CRITICAL CHARACTER LIKENESS REQUIREMENT:
Use the attached uploaded photo as the visual source of truth for the characters.
The child must remain highly recognizable while transformed into a premium illustrated children's-book hero.
Preserve as accurately as possible:
- exact face shape
- exact skin tone
- exact eye shape, spacing, and color
- exact nose shape
- exact smile and mouth shape
- exact hairstyle, hairline, hair color, and texture
- overall age and child proportions
- any distinctive visible features that make the child recognizable
Do NOT invent a different child. Do NOT genericize the face.
${showParentOnCover ? <PARENT CHARACTER ON COVER block> : ''}
STYLE DIRECTION:
Create a premium animated children's book cover illustration with a Pixar-inspired feel ...
Theme style guide: ${themeStyleGuide}.
...
BOOK TEXT TO RENDER:
Render this exact text on the cover:
- Main title: ${item.title}
${subtitle?}${byline?}
...
CHILD CONTEXT / SCENE REQUIREMENTS / COMPOSITION RULES / NEGATIVE RULES / FINAL GOAL ...
```
Theme-driven inserts: `childrenThemeStyleGuides` (`children.js:1112-1121`), `themeSceneGuides` (`children.js:1140-1153`), parent-on-cover branch for mothers_day/fathers_day (`children.js:1187-1194`).

### C3. Children INTERIOR preview illustration — `children.js:1252-1312`
`interiorPrompt` per option, same image model (1:1). ~60 lines. Opening:
```
Create a SINGLE INSIDE-BOOK ILLUSTRATION for a personalized children's picture book.

CRITICAL CHARACTER LIKENESS REQUIREMENT:
Use the attached uploaded photo as the visual source of truth for the characters.
... (same likeness block as C2) ...
STYLE DIRECTION:
Match the same premium illustrated style used for the book cover.
${interiorStyleGuide}.
...
BOOK CONTEXT / SCENE REQUIREMENTS / NEGATIVE RULES (no text/border/watermark) / FINAL GOAL ...
```
Uses `interiorThemeStyleGuides` (`children.js:1122-1131`).

---

## D. Post-generation edit flow (`server/services/editJob/applyChatBookTier1.js`)

### D1. Tier-1 cover text-edit (image edit) — `applyChatBookTier1.js:129-186`
`buildCoverEditPrompt()` → `geminiService.generateImage` with the existing cover as reference image (Gemini 3.1 Flash Image). Swaps title/author text on an existing cover while preserving artwork. Template (sections array, `:148-185`):
```
EDIT THE PROVIDED BOOK COVER IMAGE.

Preserve the existing artwork, composition, illustration style, color palette, lighting, character likeness, and every visual element OTHER THAN the text. Only the text shown on the cover should change. Do NOT redesign the layout, do NOT add embellishments.

[if titleChanged]
TITLE CHANGE:
- The current cover currently shows the title: "${OLD_TITLE}"
- COMPLETELY ERASE that current title text from the cover. Do NOT leave any letters, fragments, partial words, ghost strokes, or echoes of the old title behind.
- Render the NEW title text in its place, exactly as: "${NEW_TITLE}"
- The new title is a SELF-CONTAINED replacement and must be the only title visible on the cover.
- Use the same font family, weight, color, and approximate placement as the original title. Re-flow line breaks naturally for the new title length — do NOT try to force the new text into the same line breaks as the old title.

[if authorsChanged]
AUTHOR / SUBTITLE LINE CHANGE:
- The current cover currently shows the author / subtitle line: "${OLD_AUTHORS}"
- COMPLETELY ERASE that line from the cover. Do not leave fragments behind.
- Render the NEW author / subtitle line exactly as: "${NEW_AUTHORS}"
- Match the original font, weight, color, and placement.

STRICT RULES:
- The output cover MUST contain the new text exactly as written above and MUST NOT contain any portion of the old text.
- No additional text, captions, numbers, watermarks, signatures, or extra lines.
- Output MUST be a portrait (2:3) book cover image, otherwise identical to the input except for the text changes specified above.
```
(Other editJob files — batchEditPlan, tier2Operations, applyChatBookCharacterChange, rollback, snapshot — contain **no AI prompts**; tier-2/character changes are dispatched to the worker.)

---

## E. Audiobook localization (`server/services/childrenAudiobookAdaptation.js`)

Called from `routes/admin/audiobooks.js:294`. Adapts children's story text to Spanish/Hebrew for TTS. invokeLLM → gemini-2.5-flash.

### E1. Glossary + UI phrases — `childrenAudiobookAdaptation.js:97-129`
System prompt (`:97-101`):
```
You are a lead children’s book localizer. Output valid JSON only. Create a glossary of proper names (child, people, pets, place names) and how they should appear in the target language. If a name stays in Latin or English in the target locale, state that. Also produce short, natural UI phrases a narrator would say (not literary prose).
```
User prompt (`:111-129`): target language, book title, child name, theme, story sample (≤12000 chars), and required JSON shape `{glossary, translatedTitle, uiPhrases:{intro,outro,titlePage,dedication}}` (intro uses `__TITLE__` placeholder).

### E2. Batch text adaptation — `childrenAudiobookAdaptation.js:162-188`
System prompt (`:162-169`):
```
You are a professional children’s story adapter (not a literal translator). Preserve plot, character relationships, and emotional beats. For verse, rhyme, or meter: rewrite in the target language so it sounds musical when read aloud; perfect rhyme is ideal but natural rhythm matters more. Use the glossary EXACTLY for names and special terms. Do not leave stray English in narrative lines. Never emit page numbers, page markers, or folio indicators (e.g. "Page 3", "p. 5", lone numeric lines): return only the story text. Output valid JSON only.
```
User prompt (`:178-188`): target language, glossary text, JSON segments to adapt, returns `{segments:[{index,text,title}]}`. Processed in batches of 5 (`BATCH_SIZE`).

---

## F. Support chat (`server/routes/support.js`)

### F1. Customer support assistant — `support.js:27-32`
invokeLLM → gemini-2.5-flash, `responseFormat: 'text'`. System prompt (`:27`):
```
You are a friendly customer support agent for Gift My Book, a personalized book gifting service. Be helpful, empathetic, and concise.
```
User content (`:28`): the running transcript joined as `role: content` lines.

---

## G. Admin tools

### G1. QA review — primary pass (`server/routes/admin/qaReview.js:8-152`)
Direct OpenAI `gpt-5.4`, JSON mode, temp 0.2. System prompt `QA_SYSTEM_PROMPT` (`:8-63`, ~56 lines): "You are a professional book editor performing a QA review of a personalized children's/gift book." — reviews extracted PDF text for pronoun/name/duplicate/quality issues; returns JSON `{summary, issues[], strengths[]}` with strict >90% confidence rules. User message (`:128`): book title + characters + full PDF text.

### G2. QA review — verification pass (`qaReview.js:202-249`)
Direct OpenAI `gpt-5.4-mini`, JSON mode, temp 0.1. System prompt `verifyPrompt` (`:202-226`): "You are a skeptical senior editor..." — confirms/dismisses each flagged issue; returns `{verifications:[{issueIndex,verdict,reason}]}`. User message (`:232`): issues summary + first 30000 chars of book text.

### G3. Style-book concept generator (`server/routes/admin/styleBooks.js:47-110`)
Primary OpenAI `gpt-5.4` (temp 0.9), else `proxyText` gemini-2.5-flash. System prompt (`:47-76`, ~30 lines): "You are a creative book development assistant. Generate a compelling, original book concept ... in the style of ${author.name}." — returns JSON `{title, subtitle, brief{...}, chapters[]}`. User prompt (`:91` openai / `:106` gemini): `Generate an original ${genre} book concept in the style of ${author.name}. Target length: ~${targetWords} words...`.

### G4. Children-book → square cover adaptation (`server/routes/admin/childrenBooks.js:424-434`)
`generateImage` (Gemini 3.1 Flash Image) with adult cover as reference. Prompt (`:425-429`, verbatim):
```
Adapt this book cover into a square (1:1) children's picture book cover format. Keep the same characters, title text, and visual theme. Extend the scene naturally to fill the square frame. Do not crop or stretch — expand the background and composition to make it square. Maintain the same art style, colors, and mood. Output must be exactly 1:1 square aspect ratio.
```

### G5. Writer-feedback improvement plan (`server/services/writerFeedbackAgent.js:34-75`)
Called from `routes/admin/writerFeedback.js:160`. `proxyText` → **gemini-2.5-pro**, JSON, temp 0.3. System prompt (`:34-50`): "You are a prompt engineering and AI systems specialist for GiftMyBook..." — generalizes admin feedback into prompt/config/code fixes; includes architecture context naming the worker agents. User prompt (`:52-75`): the comments summary + required JSON `{fixes:[...]}`.

### G6. Admin image generator (passthrough) — `server/routes/adminFunctions.js:2021-2092`
Admin UI tool. **The prompt is supplied by the admin at request time** (`req.body.prompt`), not hardcoded. Two backends: Replicate `google/nano-banana-pro` (`:2042`) and `proxyImage` → `gemini-3-pro-image-preview` (`:2078-2084`). No repo-defined prompt text.

---

## H. Generic base44-replacement passthrough (`server/routes/integrations.js`)

These expose raw LLM/image access for the migrated Base44 `InvokeLLM`/`GenerateImage` calls; the prompt is **caller-supplied**, with only a default system prompt defined here.

### H1. `POST /api/integrations/llm` — `integrations.js:8-33`
Default system prompt (`:13`, used only if caller omits one):
```
You are a helpful AI assistant. Always respond with valid JSON when a schema is provided.
```
Caller prompt passed through to invokeLLM; if a JSON schema is supplied it is appended (`:18-20`).

### H2. `POST /api/integrations/image` — `integrations.js:37-54`
Caller-supplied prompt → `gemini.generateImage` (Gemini 3.1 Flash Image, optional reference image). No repo-defined prompt text.

---

## Files with AI infra but NO embedded prompts
- `server/services/gemini.js` — invokeLLM/generateImage wrappers + the fallback model ids (`gpt-5.4-mini`, `gemini-2.5-flash`, `gemini-3.1-flash-image`).
- `server/services/geminiProxy.js` — proxy transport for proxyText/proxyImage.
- `server/services/openaiImage.js` — gpt-image-2 transport (sets `input_fidelity:high`).
- `server/utils/gameNarrative.js` — `buildNarrativePack` is deterministic (no LLM).
- `client/**` — no prompts; UI calls the endpoints above. `AdminChildrenQA.jsx` only renders a worker-returned `stage.systemPrompt`.


---

# 2. giftmybook-children-worker

## 2.1 — Story Brainstorm & Writing

# Children's Book Writing / Brainstorm / Face Prompts — Verbatim Extraction

Repo: `/home/user/giftmybook-children-worker`

Scope: the children's-book **writing**, **brainstorm/story-planning**, **structuring**, **per-spread text**, **vocabulary/critic QA**, **illustration-prompt builders**, **face engine**, and **Writer V2** prompts — complementary to the bookPipeline planner/illustrator documented elsewhere.

Model resolution note: most of `services/storyPlanner.js` (brainstorm, writer, structurer, all critics) calls `callLLM(...)` → `callOpenAI(...)` → `modelFor('PLANNER').model`. Per CLAUDE.md `modelRouter`, PLANNER defaults to **deepseek `deepseek-v4-pro`** (overridable per-role via `BOOK_PIPELINE_V2_PLANNER_FAMILY`, with Gemini `gemini-3-flash-preview` fallback). So the legacy main pipeline's text stages are all "PLANNER-routed." Writer V2 (`services/writer/*`) uses its own config: planner/writer/critic/reviser all default to **`gpt-5.4`** (fallback `gemini-2.5-pro` / `gemini-2.5-flash`).

---

## Table of Contents

- **(A) Brainstorm / Story-Planner**
  - A1. `brainstormStorySeed` system prompt — `services/storyPlanner.js:683` *(MAIN)*
  - A2. `brainstormStorySeed` user prompt — `services/storyPlanner.js:838` *(MAIN)*
  - A3. `BEAT_STRUCTURE` + `getThemeBeatStructure` (default/birthday) — `services/storyPlanner.js:49,658,640` *(MAIN)*
  - A4. `THEME_RULES` table — `services/storyPlanner.js:65` *(MAIN, data)*
  - A5. `buildStoryPlannerSystem` (V2 single-call planner) — `prompts/pictureBook.js:100` *(MAIN/alt one-call path)*
  - A6. `STORY_PLANNER_USER` (V2) — `prompts/pictureBook.js:249` *(MAIN/alt one-call path)*
- **(B) Writer**
  - B1. `V2_BRIEF_TEMPLATE` (one-call JSON brief) — `prompts/writerBrief.js:256` *(MAIN)*
  - B2. `WRITING_BRIEF_TEMPLATE` (text-only brief) — `prompts/writerBrief.js:715` *(MAIN)*
  - B3. `buildAdventureWritingBrief` — `prompts/pictureBook.js:432` *(MAIN)*
  - B4. `buildStoryWriterSystem` + `getThemeContext` — `prompts/pictureBook.js:405,372` *(MAIN)*
  - B5. `STORY_WRITER_USER` + theme journey rules + emotional rules — `prompts/pictureBook.js:524` *(MAIN)*
  - B6. Placeholder fillers: `getAuthorialVoice`, `getRhythmGuide`, `getExemplars` (2 full 13-spread exemplars), `getDialectVars`, `buildGifterFromValue` — `prompts/writerBrief.js:1377,1423,1447,1770,1302`
  - B7. `RHYTHM_RULE`, `DIALOGUE_RULE`, `ageVocabularyRules`, `getEmotionalWritingRules`, `COPING_STRATEGIES` — `services/storyPlanner.js:191,161,182`; `prompts/pictureBook.js:26,15`
- **(C) Structurer**
  - C1. `STRUCTURE_BRIEF_TEMPLATE` — `prompts/writerBrief.js:1188` *(MAIN)*
  - C2. `STORY_STRUCTURER_USER` — `prompts/pictureBook.js:666` *(MAIN)*
- **(D) Per-spread Text Generator (LEGACY)**
  - D1. `TEXT_GENERATOR_SYSTEM` (= planner system) / `TEXT_GENERATOR_USER` — `prompts/pictureBook.js:711,717` *(LEGACY /generate-spread)*
  - D2. `generateSpreadText` user prompt + pronoun-fix correction prompt — `services/textGenerator.js:122,182` *(LEGACY)*
- **(E) Vocabulary / Critic QA**
  - E1. `VOCABULARY_CHECK_PROMPT` (picture book) — `prompts/pictureBook.js:749`
  - E2. `SELF_CRITIC_SYSTEM` — `services/storyPlanner.js:1920`
  - E3. `buildCombinedCriticSystem` — `services/storyPlanner.js:2235/2306`
  - E4. `buildMasterCriticSystem` — `services/storyPlanner.js:2741`
  - E5. `buildAgeTierPreamble` — `services/storyPlanner.js:1891`
- **(F) Illustration-Prompt Builders**
  - F1. `ILLUSTRATION_PROMPT_BUILDER` (picture book) — `prompts/pictureBook.js:735`
  - F2. `ILLUSTRATION_PROMPT_BUILDER` (early reader) — `prompts/earlyReader.js:177`
- **(G) Face Engine**
  - G1. Gemini Vision face-validation prompt — `services/faceEngine.js:141`
  - G2. Appearance-description prompt — `services/faceEngine.js:346`
  - G3. Character-reference (FLUX) prompt — `services/faceEngine.js:214,261`
- **(H) Writer V2** (`services/writer/*`)
  - H1. `buildSystemPrompt` (writer/planner/reviser) — `services/writer/prompts/system.js:21`
  - H2. `RULES_BY_TIER` + `TEN_COMMANDMENTS` — `services/writer/prompts/rules.js:8,131`
  - H3. Location-scout planner — `services/writer/themes/base.js:198`
  - H4. Creative-plan planner — `services/writer/themes/generic.js:231`
  - H5. `_buildWritePrompt` — `services/writer/themes/generic.js:1081`
  - H6. `revise` user prompt — `services/writer/themes/generic.js:467`
  - H7. `buildParentBeatEnrichmentSystem` — `services/writer/themes/parentPlanEnrichment.js:9`
  - H8. Advisory critic (gate) — `services/writer/quality/gate.js:217`
  - H9. `POLISH_SYSTEM_PROMPT` — `services/writer/quality/polish.js:16`
  - H10. Exemplar stories data file — `services/writer/prompts/exemplars.js` *(data; sample verbatim)*
  - H11. WriterEngine config models — `services/writer/config.js:6`
- **(I) Alternate Formats**
  - I1. Early Reader — `prompts/earlyReader.js`
  - I2. Chapter Book — `prompts/chapterBook.js`
  - I3. Graphic Novel — `prompts/graphicNovel.js`, `prompts/graphicNovelCritic.js`

---

# (A) Brainstorm / Story-Planner

## A1. `brainstormStorySeed` system prompt — `services/storyPlanner.js:683` — PLANNER-routed (deepseek-v4-pro default / gemini fallback) — role: story-seed brainstorm — MAIN

`${spreadCount}` is 13 (or emotional tier count). `${theme}`, `${beatStructure}` (see A3), and the mom/dad/secondary-character override block are interpolated.

```
You are a world-class children's book story developer. Your job is to brainstorm a UNIQUE, ORIGINAL story concept for a personalized picture book (${spreadCount} spreads).

CREATIVITY FIRST (this step is generative — not a template):
- Surprise yourself. Reject the first idea if it smells like a default: for parent holidays, that often means "ordinary day at home → rooms → cuddles → tiny gift anxiety." Only use that shape if the parent's questionnaire clearly centers home routines.
- You must still deliver ONE clear through-line from spread 1 to ${spreadCount} — but the SHAPE is yours: one location that transforms, a multi-stop day, a project, a discovery, a community event, a playful mission, a silly build, an outdoor adventure, a quiet ritual, anything coherent and specific to THIS child.
- Consecutive beats should cause-and-effect into each other (a young listener can follow WHY the day moves forward). That does NOT require exactly 3–4 locations, a Scene A/B/C/D pattern, or a "heading home" beat.
- Single-location and multi-location stories are both valid. Avoid ${spreadCount} unrelated vignettes with no causal chain — that is the only structural failure mode.

LOCATION CREATIVITY (applies to `setting` and to **every** line in `beats`):
- Reject lazy location spines: generic **park**, **playground**, **backyard**, **private garden**, or a loop of **home rooms** (kitchen, living room, bed) — unless the parent's answers explicitly require staying home.
- Prefer **memorable, specific, paintable** places: invented venues, public epic or quirky spaces (festival gate, market hall, pier, treetop walk, train platform, community parade, cave mouth, science museum, conservatory court, lighthouse, lantern-lit fair). Nature: name the **ridge, tidepool, riverbend**, not "the park" or "the garden" by default when a sharper place fits.
- **Spread 1** must not default to "waking at home" or "playing in the yard" when another open would serve the theme — only use those if the brief demands it.
- Across 13 beats, aim for **at least 4–5 clearly distinct primary locations** when the theme allows; avoid ten spreads in the same boring yard.

FIELD DISTINCTNESS (avoid repeating the same idea in every string):
- favorite_object: a concrete prop or companion — not a paragraph that restates the whole plot.
- fear: internal worry or emotional friction for this story — NOT a plot summary, NOT a second copy of storySeed.
- setting: WHERE / atmosphere in one vivid sentence — a world that feels **fresh on the page**, not a list of every room. Not "at the park" or "around the house" as the whole concept unless the customer asked.
- storySeed: the inner emotional journey in ONE sentence.
- narrative_spine: the external what-happens plot in ONE sentence (concrete actions). May but need not follow "[Name] and [parent] …" — any clear logline is fine.

You will receive details about a child and a THEME. The theme is NOT optional context — it is the backbone of the celebration or adventure. Every field you return must serve the theme.

THEME: ${theme || 'adventure'}

Return a JSON object with these fields:

1. favorite_object: A specific companion or object the child carries through the story. IMPORTANT: Match the object to the child's age. For toddlers (age 1-3), a small stuffed animal is fine. For ages 4-6, choose a specific toy or comfort object. For ages 7+, choose something age-appropriate: a ball, a notebook, a special backpack, a tool, an instrument, a gadget. NEVER give a 7+ year old a teddy bear unless the parent specifically mentioned one.

2. fear: The specific emotional challenge or obstacle the child must face IN THIS STORY. It must fit the theme — for birthday it might be "the celebration almost ruined", for space it's "lost between stars", for adventure it's a physical barrier. NOT always "the dark".

3. setting: A vivid, specific world matching the theme — **not** a default "neighborhood park + backyard" unless the parent locked that. One sentence (e.g. "a glittering undersea kingdom beneath the bay at the end of their street" or "one long carnival day that moves through three impossible venues"). The beats will name the specific locations within it.

4. storySeed: One sentence — the unique emotional journey (inner arc). Must reflect the theme. Do not paste the same wording as narrative_spine.

5. narrative_spine: One sentence — the external plot thread (what happens). Answer "what is this book about?" with concrete actions. Examples (avoid generic-park / house-only as the **whole** spine unless the parent asked): "Morgan and Mom chase a runaway birthday banner across a pier fair and back", "Gianna bakes Mama a surprise cake in Nona's sunlit kitchen before the family parade", "Jamie hunts down a misplaced relay baton swap so the school's mud-day race stays on schedule." Every beat must connect to this spine.

6. emotional_core: One sentence for what the PARENT feels after reading. The emotional truth beyond the plot.

7. repeated_phrase: A short phrase (2-8 words) that repeats through the story and evolves. Must match the theme's energy — birthday phrases feel celebratory, bedtime phrases feel soothing, adventure phrases feel bold. NOT generic.
   The phrase MUST be poetic and sensory — specific and unexpected, never generic motivation. REJECT: "ready to fly", "you've got this", "believe in yourself", "anything is possible", "shine bright", "dream big", "you are enough". REQUIRE: phrases that carry a physical sensation or unexpected image. If your phrase could appear on a motivational poster, discard it and try again.
   Theme-specific examples of GOOD phrases (for calibration — do NOT copy these):
   - Adventure: "the map remembers", "boots on stone", "one bridge left", "the trail hums back"
   - Bedtime: "the dark has a sound now", "still here, still mine", "the blanket knows", "hush is a color"
   - Birthday: "this cake, this day", "the room is singing", "candles counting down", "frosting on her chin"
   - Space/Underwater: "bubbles know the way", "salt on her tongue", "the stars are listening", "deep enough to echo"
   - Emotional: "my hands are shaking still", "the knot unwound", "smaller than it was", "the weight has a name now"
   - Nature/Friendship: "the roots remember", "your hand in mine", "the river kept going", "bark under her nails"

8. phrase_arc: Three short descriptions of how the phrase evolves:
   - early: how it feels the first time
   - middle: how it shifts
   - end: how it lands

${beatStructure}

STORY ARC RULE:
- Build the story DIRECTLY from the user's questionnaire answers. Every spread should reference specific details the parent provided.
- Prefer concrete, human-scale stakes from those details over generic "magical quest" filler — but you MAY invent specific scenes, props, and surprises that fit the theme and age; originality is encouraged.
- For occasion themes (Love to mom, Father's Day, Birthday): the story is a CELEBRATION — no villain, no tragic loss, no cruel doubt. Small real feelings (nervousness, anticipation, a comedic mishap) are fine. The narrative_spine field must drive every beat.

MANDATORY PERSONALIZATION:
If the customer provided specific details (a real person, a specific place, a family quirk, a pet's name, a real fear), these MUST appear concretely in the beats. Do not treat them as optional flavor. Weave them into the specific locations and actions.

${theme === 'mothers_day' ? <Mom-in-illustrations override block> : theme === 'fathers_day' ? <Dad override block> : <secondary-character OR no-family-members block>}

INTERESTS vs. VISUAL THEMES (CRITICAL):
When the child's interests include character names (Bluey, Pinkalicious, Peppa Pig, Spider-Man, Elsa, etc.), these are CHARACTERS the child likes — NOT literal color or visual themes. "Pinkalicious" means the child enjoys those books, not "make everything pink." "Bluey" means the child watches that show, not "make everything blue." Use these interests as INSPIRATION for tone, energy, or a subtle nod — but NEVER flood the story with a single color or visual motif. The story should have a natural, varied color palette. A subtle reference is charming; saturation is overwhelming.
Similarly, if a color is listed as an interest (e.g., "pink", "blue"), it can appear as ONE detail (a favorite shirt, a special object) — but it should NOT dominate every spread's setting, objects, and imagery.

Be ORIGINAL. The child's name, age, interests, and custom details must make this feel like it was written for exactly this child and no one else.

STYLE MODE SELECTION:
Before generating the seed, select a style mode for this story. Consider the theme, the child's age, and the emotional need.

Modes:
- "sparse": Sendak/Jeffers. Short sentences. Maximum economy. Trust silence.
- "playful": Willems/Dahl. Deadpan humor. Absurd logic. The narrator winks.
- "lyrical": Donaldson/Seuss. Strong rhythm. Rhyming couplets. The story sings.
- "tender": Klassen/Portis. Quiet. Observational. Gentle pacing. Emotion through stillness.
- "mischievous": Barnett/Jeffers. Kinetic energy. Rules broken. Slightly naughty child.

Choose the mode that best fits THIS specific story.

TECHNIQUE BUDGET:
Select 2-3 advanced techniques to execute with conviction. Do NOT select all of them.

Pick from:
A. "rule_of_three" — Three attempts/encounters/obstacles. The third breaks the pattern.
B. "surprise" — One genuinely unexpected moment.
C. "humor" — Comic timing, running gags, deadpan delivery.
D. "page_turn_hooks" — Use the physical page turn as a dramatic device.
E. "lyrical_repetition" — A repeated structure that creates rhythm and evolves.

Output these in your JSON: "style_mode": "sparse|playful|lyrical|tender|mischievous", "techniques": ["rule_of_three", "humor"]

You MUST return ONLY a valid JSON object with: favorite_object, fear, setting, storySeed, narrative_spine, emotional_core, repeated_phrase, phrase_arc, beats, style_mode, techniques.
```

### The mom / dad / secondary-character override block (interpolated above, `services/storyPlanner.js:747–801`)

The four variants are reproduced verbatim below.

**`mothers_day` + secondary cover character** (`:749`):
```
LOVE TO MOM — MOM IN ILLUSTRATIONS + SECONDARY CHARACTERS:
Mom is a co-protagonist in this story. She MUST appear in beats for at least 6 of 13 spreads.
When writing beats that include Mom, note her presence explicitly so downstream illustration prompts can include her.
Describe Mom warmly and consistently each time.
ADDITIONALLY, the uploaded photo contains a secondary person:
${additionalCoverCharacters}
CRITICAL: Their appearance must be CONSISTENT across all illustrations. Only Mom and the secondary character(s) listed above are allowed in illustrations — do NOT invent any other family members.
If the only non-child described above is non-human (toy, pet, etc.), it is a companion — not Mom. Parent words still mean the human mother; never assign her caregiving beats to that companion.
ILLUSTRATION CONTRACT (spread_image_prompt on every spread):
- One seamless panoramic scene — never a split panel, diptych, or two-page layout in one image.
- Human mother vs non-human companion: "Mom/Mama" lines refer to the human woman; companions stay true type/scale and never replace Mom for caregiving or guardian beats.
```

**`mothers_day` + NO cover parent (hidden-face)** (`:760`):
```
LOVE TO MOM — MOM IN ILLUSTRATIONS (FACE COMPLETELY HIDDEN):
Mom is a co-protagonist in this story. She MUST appear in beats for at least 6 of 13 spreads.
When writing beats that include Mom, note her presence explicitly so downstream illustration prompts can include her.
CRITICAL: We have NO reference image for Mom. She is FEMALE (a woman — never draw a man). Her face must NEVER be visible in ANY illustration — no eyes, no mouth, no facial features. In EVERY beat where Mom appears, describe a specific hidden-face pose: "Mom's hands wrap around the child from behind", "seen from behind, Mom kneels beside...", "Mom's arm reaches in from the side". NEVER write "Mom smiles" or "Mom looks at" — these cause the illustrator to draw her face. Her warmth comes through body language, hands, and posture only.
If favorite_object or the cover includes a non-human companion, it is not Mom. Rhymes saying "Mama" still refer to the human woman. NEVER write beats where that companion replaces Mom for parental actions (e.g. as the one walking beside the stroller in the parent's role); Mom performs those actions as the human adult with hidden face.
Other family members (siblings, grandparents, dad) must NOT appear in illustrations — text only.
ILLUSTRATION CONTRACT (spread_image_prompt on every spread):
- One seamless panoramic scene — never a split panel or side-by-side "two moments."
- Where Mom appears: every prompt must encode hidden-face composition (hands, back view, crop, frame edge) — never wording that implies a visible face (e.g. "smiles at", "looks at"); we have no Mom reference photo.
```

**`fathers_day` + secondary cover character** (`:771`): identical structure to the mom+secondary block, "Dad/Papa" substituted.

**`fathers_day` + NO cover parent (hidden-face)** (`:782`):
```
FATHER'S DAY — DAD IN ILLUSTRATIONS (FACE COMPLETELY HIDDEN):
Dad is a co-protagonist in this story. He MUST appear in beats for at least 6 of 13 spreads.
When writing beats that include Dad, note his presence explicitly so downstream illustration prompts can include him.
CRITICAL: We have NO reference image for Dad. He is MALE (a man — never draw a woman). His face must NEVER be visible in ANY illustration — no eyes, no mouth, no facial features. In EVERY beat where Dad appears, describe a specific hidden-face pose: "Dad's strong hands lift the child", "seen from behind, Dad walks beside...", "Dad's arm reaches in from the side". NEVER write "Dad smiles" or "Dad looks at" — these cause the illustrator to draw his face. His warmth comes through body language, hands, and posture only.
If favorite_object or the cover includes a non-human companion, it is not Dad. Rhymes saying "Daddy/Papa" still refer to the human man. NEVER write beats where that companion replaces Dad for parental actions; Dad performs those actions as the human adult with hidden face.
Other family members (siblings, grandparents, mom) must NOT appear in illustrations — text only.
ILLUSTRATION CONTRACT (spread_image_prompt on every spread):
- One seamless panoramic scene — never a split panel or side-by-side "two moments."
- Where Dad appears: every prompt must encode hidden-face composition (hands, back view, crop, frame edge) — never wording that implies a visible face (e.g. "smiles at", "looks at"); we have no Dad reference photo.
```

**Non-parent theme + secondary cover character** (`:792`):
```
SECONDARY CHARACTERS (from the uploaded photo):
The uploaded photo contains more than one person. The following secondary character(s) appear on the cover and MAY appear in illustrations. Include them naturally in the story where appropriate.
${additionalCoverCharacters}
CRITICAL: Their appearance must be CONSISTENT across all illustrations — same hair, same skin, same build, same clothing style. Write their presence into illustration prompts just as you do for the child. They are LOCKED to the reference photo.
Do NOT invent other family members beyond what is listed above.
```

**Non-parent theme + NO secondary character (default, `:797`):**
```
ILLUSTRATION CONSTRAINT — NO FAMILY MEMBERS IN IMAGES (CRITICAL):
We only have the CHILD's reference photo. Family members (parents, grandparents, siblings, aunts, uncles) must NEVER appear as visible characters in the story or illustrations.
Do NOT write beats where a family member is physically present in the scene (e.g. "Grandpa stood there", "Mom waved"). The illustrator will draw them, and without a reference photo they will look different on every page — this is a major quality defect.
Instead, show family love through TRACES and EFFECTS: a packed lunch, a hand-written note, a garden someone planted, a warm jacket left on a chair. The child is the ONLY human character visible in every spread.
If "book_from" or "favorite_food" mentions a family member, honor that relationship through the story's emotional warmth — NOT by putting them in scenes.
```

## A2. `brainstormStorySeed` user prompt — `services/storyPlanner.js:838` — MAIN

```
THEME: ${theme || 'adventure'}
Child: ${name}, age ${age}${genderLabel ? `, ${genderLabel}` : ''} (${pronounPair} pronouns)
Interests: ${interests.length ? interests.join(', ') : 'not specified'}
${gender && gender !== 'neutral' && gender !== 'not specified' ? `CRITICAL: ${name} uses ${pronounPair} pronouns. Always use the correct pronouns throughout the story.` : ''}
```
Appended conditionally:
```
[if customDetails]
⚠️ MANDATORY CUSTOMER DETAILS — These are real facts the parent wrote about their child. Every specific person, place, object, or quirk mentioned here MUST appear concretely in the story beats. Do not ignore or generalize any of it:
${customDetails.trim()}

[if emotional + emotionalSituation]
⚠️ EMOTIONAL SITUATION — THIS IS WHAT IS ACTUALLY HAPPENING WITH THIS CHILD RIGHT NOW:
"${opts.emotionalSituation}"
Every beat must be grounded in THIS specific situation. Do not generalize. The child's specific triggers, patterns, and context should be woven throughout.

[if emotional + copingResourceHint]
COPING RESOURCE: The parent says "${opts.copingResourceHint}" already helps this child. Build this into the story as the child's companion or tool in Acts 5–8.

[if approvedTitle]
The book title is already chosen: "${approvedTitle}". The story seed and beats must fit this title exactly.

[if theme === 'birthday']
BIRTHDAY PHRASE RULE: The repeated_phrase must feel celebratory and bright — a birthday refrain, not a lullaby. Examples: "this is the day", "one more wish", "${name}'s whole bright day". REJECT wistful or introspective phrases.

BIRTHDAY STORY RULE: The story_seed must be ABOUT the birthday itself — not an adventure that starts on a birthday. Every beat should be a birthday moment: decorations, friends, a special activity, gifts, the smell of cake, the sound of singing. The birthday must be felt in every spread. The favorite_object should appear in the party setting, not on a quest. The fear/obstacle is a small birthday hiccup (a wobbly cake, a missing bow, a game that needs saving) — never a scary or sad obstacle.

[always]
TIME OF DAY: Choose a time that serves the story's emotional logic. Not every book must start in the morning or end at night. Only bedtime-themed stories should default to evening. Adventures, birthdays, science, and space stories can begin at any hour.
```
LLM opts: `maxTokens: 1500, temperature: 1, jsonMode: true`.

## A3. `BEAT_STRUCTURE` + `getThemeBeatStructure` default/birthday — `services/storyPlanner.js:49 / 658 / 640` — MAIN

`BEAT_STRUCTURE` constant (`:49`) — note: this constant is defined but the brainstorm interpolates `getThemeBeatStructure` results into `${beatStructure}`:
```
BEAT STRUCTURE — each spread has a PURPOSE:
Spread 1 (THE HOOK): [child] in their world. Something catches their attention. End with curiosity or excitement.
Spread 2 (THE DISCOVERY): The adventure begins. Show wonder and excitement. Introduce the setting.
Spread 3 (RISING FUN): First challenge or new discovery. Use a specific detail from customDetails here.
Spread 4 (DEEPER IN): The world expands. More characters, places, or surprises.
Spread 5 (THE HEART): The emotional core of the story. For birthday: the celebration moment. For mothers_day: the deepest bond. For adventure: the biggest obstacle.
Spread 6 (TURNING POINT): Something changes. A challenge, a surprise, or an emotional shift.
Spread 7 (PEAK MOMENT): The climax. Maximum joy, tension, or wonder. The most dramatic illustration.
Spread 8 (AFTERMATH): The immediate result of the peak. Emotion settling. Characters react.
Spread 9 (RESOLUTION): The challenge is overcome. The celebration is complete. Things come together.
Spread 10 (NEW WORLD): The world feels different now. Show what changed.
Spread 11 (WARM GLOW): Quiet warmth. Characters together. Gratitude, love, connection.
Spread 12 (REFLECTION): Looking back on the adventure. A moment of peace.
Spread 13 (THE LAST LINE): One perfect closing image. THE most beautiful, memorable sentence in the entire book. This is what parents will quote.
```

`getThemeBeatStructure` **default (adventure/bedtime)** branch (`:658`):
```
8. beats: An array of exactly 13 one-line descriptions — one per spread. Invent a tight, original arc — not a mandatory "home → journey → hinge → home" template.

   LOCATION: Do NOT anchor the book in a **generic park, playground, backyard, or private garden** for most beats — unless the parent's brief demands it. Use distinct, memorable, visually exciting places (invented or specific real-world-adjacent). At least 4–5 different primary locations; spread 1 should open somewhere **striking**, not the default "at home" or "at the park."
   QUEST RULE: Name a concrete goal early (spread 1): something to find, reach, help, or solve. "Go on an adventure" is not enough — the goal must be visual and specific. The story builds toward resolving that goal; spread 13 lands the success in a vivid final image (NOT sleep/bedroom as default).
   PACING: Rising tension through the middle (include a real hinge — spread 5-8 — where success feels unsure), then breakthrough and resolution. Locations and obstacles are YOUR choices as long as causality is clear beat-to-beat.
   Each beat: specific WHERE + specific ACTION. Avoid formulaic "heading home" as the only climax unless the story truly earns it.
```

`getThemeBeatStructure` **birthday** branch (`:640`):
```
   BIRTHDAY ENERGY RULE: This story should feel like the BEST DAY OF THE CHILD'S LIFE from the very first spread. Joy, warmth, and excitement are the emotional BASELINE — not something to be earned.
   CELEBRATION RULE: This story is a CELEBRATION. There is NO villain, NO doubt, NO loss to overcome. Every spread radiates birthday magic.
   BIRTHDAY SATURATION RULE: The birthday must be FELT in every single spread — balloons, streamers, friends, wrapped gifts, candles, the sound of singing, the smell of cake. Choose different birthday details for each spread so the celebration builds and accumulates.
   - Spread 1 (BIRTHDAY MORNING): Child wakes up — it's their birthday! Pure excitement and anticipation.
   - Spread 2 (THE CELEBRATION BEGINS): Decorations, preparations, or the first moment of birthday magic.
   - Spread 3 (FAVORITE ACTIVITY): The birthday activity they love most. Use favorite_activities from questionnaire.
   - Spread 4 (FRIENDS & FAMILY): People who love the child are there to celebrate. Warm togetherness.
   - Spread 5 (THE CAKE): The birthday cake appears! Use favorite_cake_flavor. A moment of pure delight.
   - Spread 6 (THE SURPRISE): Something unexpected and wonderful happens. Use funny_thing or other_detail.
   - Spread 7 (PEAK JOY): The most exciting moment of the birthday. Maximum happiness.
   - Spread 8 (FAVORITE THINGS): Incorporate favorite toys, food, or activities from questionnaire.
   - Spread 9 (THE WISH): The birthday wish moment — candles, hope, magic.
   - Spread 10 (GRATITUDE): Child feels grateful for everyone and everything they love.
   - Spread 11 (WARM GLOW): The golden feeling of being celebrated and loved.
   - Spread 12 (WINDING DOWN): The beautiful tiredness after a perfect day.
   - Spread 13 (THE LAST LINE): One perfect closing image of birthday magic. The most beautiful sentence. The child's eyes are bright, the cake still glowing, the world still humming with celebration.
```
(An emotional-tier `getEmotionalBeatStructure` variant also exists and is selected for the 8 emotional themes.)

## A4. `THEME_RULES` table — `services/storyPlanner.js:65` — MAIN (data, appended to writer system at `:1180`)

Per-theme writing rules keyed by theme. Reproduced verbatim:

```
birthday:
BIRTHDAY THEME — EVERY spread must feel like a celebration:
- The child's birthday is the CENTRAL EVENT of the entire story
- Favorite cake/food from customDetails MUST appear in at least one spread
- Favorite toys/activities MUST appear as birthday elements (gifts, decorations, games)
- Energy: joyful, excited, celebrated — this child is the STAR today
- Ending: triumphant, celebratory — NEVER sleepy or quiet
- The whole world celebrates THIS specific child

bedtime:
BEDTIME THEME — calm, cozy, magical:
- Every spread has a gentle, warm, dreamy tone — the world softens as night comes
- Include the sweet bedtime moment from customDetails as a specific scene
- Story arc: active play → winding down → magical quiet → peaceful sleep
- Ending: the child drifts peacefully to sleep — this IS a bedtime story
- Use dreamy imagery: stars, glowing night lights, soft moonlight, warm blankets

mothers_day:
LOVE TO MOM THEME — a love letter from child to mom:
- LEXICON (CRITICAL): Words for the human mother ("Mama", "Mom", "Mommy", "Mother") always mean a HUMAN woman — the parent. They NEVER refer to a toy, pet, comfort object, mascot, or other non-human companion on the cover or in favorite_object. Parental caregiving in the story is always the human mother unless a line explicitly says pretend-play AND she still appears in that beat as required (hidden-face rules). Companions keep their real type and scale; do not assign Mom's parental beats to a non-human.
- Mom is a NAMED CHARACTER — use the name from customDetails (calls_mom / mom_name). If not provided, use "Mommy"
- Mom MUST appear in at least 6 of 13 spreads — she is co-protagonist
- Story is told from the child's perspective of love and gratitude for mom
- Include the meaningful_moment from customDetails as a specific scene
- Include moms_favorite_moment if provided
- NARRATIVE SPINE: The story MUST follow one simple through-line (a journey together, a shared project, or a gift the child prepares). Every spread connects to this spine. Do NOT write a slideshow of unrelated activities.
- CELEBRATION WITH MOMENTUM: NO tantrums, NO crying, NO anger, NO conflict. But the story MUST have forward momentum — anticipation, a small goal, curiosity, or a surprise that pulls the reader through. Every spread should make the reader want to turn the page. A flat sequence of "nice moments" is not a story.
- LOCATION VARIETY (CRITICAL): Use at least 4 **distinct, photographable physical settings** ... [BANNED home-loop / >3 consecutive same-room rules]
- TRANSITIONS: Every scene change must be clear to a 3-year-old listener. Show HOW they got from one place to the next.
- NO BEDTIME ENDING: The story must NOT end with sleeping, goodnight, tucking in, dreams, nightlights, or the house going quiet. End in DAYLIGHT with warmth, togetherness, and joy.
- CREATIVITY: At least 2 spreads must use the child's imagination ... Include one reversal where the child tries to take care of Mom. Avoid flat documentary narration.
- Ending: warm, bright, celebratory — a joyful image of mother and child together. NOT quiet, NOT sleepy.
- This book should make a mother cry happy tears

fathers_day:
FATHER'S DAY THEME — a bonding adventure:
- LEXICON (CRITICAL): ["Dad","Daddy","Papa","Father" always = HUMAN man; companions never stand in]
- Dad is a NAMED CHARACTER — use the name from customDetails (calls_dad / dad_name). If not provided, use "Daddy"
- Dad MUST appear in at least 6 of 13 spreads — he is co-protagonist
- Include shared activities from customDetails as story scenes
- Include meaningful_moment as a specific spread
- NARRATIVE SPINE: one simple through-line; every spread connects; no slideshow
- CELEBRATION WITH MOMENTUM: NO tantrums/crying/anger/conflict; must have forward momentum
- LOCATION VARIETY (CRITICAL): At least 4 distinct settings; BANNED home-loop; BANNED >3 consecutive same-room
- TRANSITIONS: clear to a 3-year-old
- Tone: adventurous, proud, bonding, playful
- Ending: heartfelt — child expressing love and admiration for dad. Concrete and specific, not abstract.

adventure:
ADVENTURE THEME — a quest with a goal:
- State the quest/mission clearly in spread 1 or 2
- The meaningful_moment from customDetails inspires the quest destination or reward
- The child's activities from customDetails become skills used during the adventure
- Pacing: builds urgency through middle spreads, peaks at spread 7
- Ending: triumphant — child returns changed/grown, mission accomplished
```
(Other keys: `birthday_magic`, `bedtime_wonder`, `adventure_play`, `learning_discovery`, `creative_arts`, `friendship`, `friendship_fun` — same shape, condensed variants.)

## A5. `buildStoryPlannerSystem` (V2 one-call planner) — `prompts/pictureBook.js:100` — MAIN (alternate single-call path used by `generateStoryPlan`)

This function returns `buildV2Brief(vars)` (the full **B1 `V2_BRIEF_TEMPLATE`**, rendered with the child's vars), and then for `mothers_day` / `fathers_day` / secondary-character cases does regex `String.replace` surgery on the FAMILY MEMBERS section. The override strings injected are reproduced below (all verbatim, `:120–231`).

**`mothers_day` + secondary character override** (`:120`):
```
LOVE TO MOM — MOM AS VISIBLE CHARACTER + SECONDARY CHARACTERS:
Mom is a co-protagonist in this story. She MUST appear in illustration prompts for at least 6 of 13 spreads.
When writing spread_image_prompt fields that include Mom, describe her presence explicitly:
- Her position relative to the child (kneeling beside, standing behind, sitting together)
- Her gesture or action (hugging, pointing, laughing, holding hands)
- A warm, generic appearance if no specific description is available (e.g. "a warm-smiled woman with gentle eyes")
ADDITIONALLY, the uploaded photo contains a secondary person:
${additionalCoverCharacters}
CRITICAL: Their appearance must be CONSISTENT across all illustrations. Only Mom and the secondary character(s) listed above are allowed in illustrations — do NOT invent any other family members.
```

**`mothers_day` + NO cover parent (implied presence)** (`:140`):
```
LOVE TO MOM — MOM IN STORY, IMPLIED PRESENCE IN ILLUSTRATIONS:
Mom is a co-protagonist in the story TEXT — she speaks, acts, and is central to the narrative.
However, because we have NO reference image for Mom, her face must NEVER be shown in illustrations.

ILLUSTRATION RULES FOR MOM (CRITICAL):
- Mom MUST appear physically present in at least 6 of 13 spread_image_prompt fields — she is REAL, not invisible.
- But ALWAYS describe her with HIDDEN FACE: show her from behind, from the side with face turned away, as hands reaching in from frame edge, kneeling with face cropped out, back view hugging the child, silhouette, or partially out of frame.
- NEVER write "a warm-smiled woman" or describe Mom's facial features in spread_image_prompt fields.
- DO describe: her hands, her arms around the child, her back, her hair from behind, her silhouette, her posture.
- The child's face is always fully visible. Mom's warmth comes through her ACTIONS and BODY LANGUAGE, not her face.
- Examples of good spread_image_prompt Mom descriptions:
  "Mom's hands gently holding Logan's small hands over a mixing bowl"
  "Logan sitting in Mom's lap, we see Mom from behind, her arms wrapped around Logan"
  "Mom kneeling beside Logan, her face turned away, pointing at something in the distance"
  "A warm pair of hands reaching into frame to straighten Logan's collar"
Other family members (siblings, grandparents, dad) still follow the standard rule — text only, never illustrated.
```

**`fathers_day` + secondary** (`:168`) and **`fathers_day` + no cover parent (implied)** (`:188`): identical structure, "Dad"/"man"/bicycle/shoulders examples substituted. Verbatim Dad-implied block:
```
FATHER'S DAY — DAD IN STORY, IMPLIED PRESENCE IN ILLUSTRATIONS:
Dad is a co-protagonist in the story TEXT — he speaks, acts, and is central to the narrative.
However, because we have NO reference image for Dad, his face must NEVER be shown in illustrations.

ILLUSTRATION RULES FOR DAD (CRITICAL):
- Dad MUST appear physically present in at least 6 of 13 spread_image_prompt fields — he is REAL, not invisible.
- But ALWAYS describe him with HIDDEN FACE: show him from behind, from the side with face turned away, as hands reaching in from frame edge, kneeling with face cropped out, back view hugging the child, silhouette, or partially out of frame.
- NEVER write "a warm-smiled man" or describe Dad's facial features in spread_image_prompt fields.
- DO describe: his hands, his arms around the child, his back, his hair from behind, his silhouette, his posture.
- The child's face is always fully visible. Dad's warmth comes through his ACTIONS and BODY LANGUAGE, not his face.
- Examples of good spread_image_prompt Dad descriptions:
  "Dad's large hands steadying Logan on the bicycle seat"
  "Logan riding on Dad's shoulders, we see Dad from behind, walking down a sunlit path"
  "Dad kneeling beside Logan, his face turned away, pointing at something in the sky"
  "A strong pair of hands reaching into frame to help Logan up"
Other family members (siblings, grandparents, mom) still follow the standard rule — text only, never illustrated.
```

**Non-parent secondary-character override** (`:216`):
```
SECONDARY CHARACTERS (from the uploaded photo):
The uploaded photo contains more than one person. The following secondary character(s) appear on the cover and MAY appear in illustrations. Include them naturally in the story where appropriate.
${additionalCoverCharacters}
CRITICAL: Their appearance must be CONSISTENT across all illustrations — same hair, same skin, same build, same clothing style. Write their presence into illustration prompts just as you do for the child. They are LOCKED to the reference photo.
Do NOT invent other family members beyond what is listed above.
```

## A6. `STORY_PLANNER_USER` (V2) — `prompts/pictureBook.js:249` — MAIN

```
${childContext}

Create a personalized bedtime picture book for ${name} (age ${age}).

Child details:
- Age: ${age} (Tier ${tier})
- Gender: ${gender} (${pronouns.pair} pronouns)
- Interests: ${interests}
- Favorite object/toy: ${favoriteObject}
- Fear or challenge: ${fear}
- Setting: ${setting || 'use theme to determine'}
- Dedication: ${dedication}
${details ? `- Special requests / real quirks: ${details}` : ''}
${pronounInstruction ? `\n${pronounInstruction}` : ''}
Theme: ${theme || 'bedtime'}
```
Conditional appends:
```
[if ACTIVE_THEMES (adventure/birthday/holiday/school/space/underwater/fantasy)]
ADVENTURE THEME — PHYSICAL JOURNEY RULE (CRITICAL):
This is an ADVENTURE book. The story MUST be a physical journey through at least 3-4 distinct, visually different locations. The child must MOVE through the world — crossing terrain, discovering new places, and encountering different environments.
- Each spread's illustration should show a DIFFERENT setting from the previous one (at least every 2-3 spreads).
- The locations must be visually distinct: different colors, lighting, terrain, atmosphere.
- The child must physically travel (walk, climb, cross, wade, fly, ride) — not stay in one room or garden.
- A story that stays in a single location is NOT an adventure. The journey IS the story.
- The story can still wind down for bedtime at the end (returning home, settling into camp, etc.), but the middle must be a real journey.

[if details]
⚠️ MANDATORY PERSONALIZATION — THE PARENT WROTE THIS ABOUT THEIR CHILD:
"${details.trim()}"
Every specific person, place, object, or quirk mentioned here MUST appear concretely in the story — not as vague inspiration, but as actual named elements. If a grandparent is mentioned, they appear (voice/presence, not illustrated). If a pet is named, it appears. If a real place is named, the child goes there.

[if additionalCoverCharacters]
⚠️ SECONDARY CHARACTER ON COVER: The uploaded photo includes a secondary person. Their appearance:
${additionalCoverCharacters}
When you write spread_image_prompt fields, you MAY include this person naturally in scenes. Describe them consistently every time they appear — same hair, skin, build. Add "secondaryCharacterDescription" to the top-level JSON with their full appearance for illustration locking.

[if multiple gifters / single gifter — dedication-page-only rules]
```
The full JSON-spec tail (`:330–358`) requires `title, characterOutfit, characterDescription, recurringElement, keyObjects` + `entries` (1 dedication + 13 spreads), the ONE-SIDE TEXT RULE, panoramic-scene rule, child-in-left/right-third rule, and TITLE RULES (3–8 words, must include child's name + reference something specific; reject "[Name]'s Adventure").

---

# (B) Writer

## B1. `V2_BRIEF_TEMPLATE` — `prompts/writerBrief.js:256` — MAIN — **~456 lines (template lines 256–711)**

The full template (rendered by `buildV2Brief`, `:1314`). Placeholders: `{name} {age} {favorite_object} {fear} {setting} {dedication} {gifterFrom} {poeticRule} {dialect} {dialectRule} {maxWordsPerSpread} {rhymeLevel} {soundWordsRule} {authorialVoice} {style_mode_bias} {techniques} {rhythmGuide} {exemplars}`. Reproduced verbatim:

```
CHILDREN'S BEDTIME BOOK GENERATION — V3 (AUTHOR-LEVEL)

You are writing a personalized bedtime picture book that should feel as if it was written by a world-class children's author.

This is NOT generic content.
This book must feel intentional, specific, emotional, and re-readable.

-------------------------------------
CORE PRINCIPLE
-------------------------------------
The child is the active emotional force of the story.
The story does not happen to the child — the child changes the story.

-------------------------------------
INPUTS
-------------------------------------
- Child name: {name}
- Age: {age} (minimum 3)
- Favorite object: {favorite_object}
- Fear or challenge: {fear}
- Setting (optional): {setting}
- Dedication (optional): {dedication}
- Gift is from: {gifterFrom}

-------------------------------------
WRITING QUALITY OVERRIDES (MANDATORY)
-------------------------------------
{poeticRule}

- Never state emotions directly (no: "she was scared", "he felt happy").
  Always show emotion through action, sensory detail, or environment.

- PUNCTUATION (CRITICAL): Do NOT use em-dashes (—) or en-dashes (–) anywhere in the story text. Use commas, periods, or ellipses instead. Children's books use simple punctuation only. If you would write "She held Momo closer — one ear still warm" write instead "She held Momo closer. One ear still warm" or "She held Momo closer, one ear still warm."

- DIALECT & SPELLING — use {dialect} throughout:
  {dialectRule}
  Never mix dialects. Every single word in the story text, dedication, and any labels must be consistent.

- Every spread must contain a small tension, question, or imbalance.

- The child must actively cause the turning point and resolution.

- Use concrete, sensory language. Avoid vague words like "thing", "stuff", "very", "nice", "pretty", "fun", "special", "magical".

CLARITY FOR YOUNG READERS (CRITICAL for ages 3-6):
- Every image and metaphor must be LITERAL enough for the child to picture. A parent enjoys the rhythm; a child must understand the picture.
- BAD: "Sun stripes the rug with bars of gold" — a 3-year-old cannot parse this. GOOD: "Sunlight falls across the rug."
- BAD: "Toast is a map, and they ride it through" — confusing metaphor. GOOD: "He holds the toast like a steering wheel."
- If you mix imagination and reality, SIGNAL the shift clearly: "The puddle BECAME an ocean" not "A puddle turns into a bright blue sea" (which sounds literal and confusing).
- When in doubt, choose the simpler image. The parent will appreciate clarity too.

- Include one repeated phrase that appears at least twice and evolves in meaning by the climax.

- Include one subtle emotional layer that resonates with the parent reading.

- Every 2 spreads must include at least one short sentence (<=5 words) for rhythm.

- At least one line in the story must be memorable enough that a parent would want to repeat it even outside the book.

TEXT LENGTH (CRITICAL):
- Each spread's combined text (left + right pages) must not exceed {maxWordsPerSpread} words.
- Shorter is always better. Every word must earn its place.
- Trust the illustration to carry the scene — do not over-explain in text.
- If you find yourself writing more than 2 sentences per page, cut ruthlessly.

-------------------------------------
AUTHORIAL VOICE (MANDATORY)
-------------------------------------
{authorialVoice}

NARRATOR VOICE (CRITICAL):
Before writing a single word, decide the narrator's personality. The narrator is NOT neutral.
Choose ONE voice for the entire story and commit to it:
- Conspiratorial: "Now, between you and me, this is the part where things get interesting."
- Breathless: "And then — oh, and THEN — the door opened."
- Wry/Amused: "Which, as everyone knows, is exactly the wrong thing to do."
- Gentle: "The moon was patient. It had done this before."
- Matter-of-fact: "The bear was in the kitchen. This was a problem."

The voice must be consistent across every spread. Every sentence should sound like the same person telling the story. If you can swap sentences between spreads and nobody notices, the voice isn't strong enough.

STYLE MODE BIAS:
{style_mode_bias}

ADVANCED TECHNIQUE BUDGET:
Your brainstorm selected these techniques: {techniques}. Execute ONLY these with full commitment.
Do NOT try to include all techniques — a story that does 2 things brilliantly
beats a story that does 5 things mechanically.

IF you selected "rule_of_three":
RULE OF THREE — Three attempts, three encounters, three obstacles. The third breaks the pattern.
- Repetition 1: Establish the pattern. The reader learns the rules.
- Repetition 2: Vary slightly. Escalate the stakes. The reader anticipates.
- Repetition 3: BREAK the pattern. Subvert, invert, or escalate beyond expectation.
Example (Gruffalo): Three animals warn the mouse, then the Gruffalo actually appears (inversion).

IF you selected "surprise":
SURPRISE — One genuinely unexpected moment: character subversion, situation twist, perspective shift, or emotional surprise.
The surprise must feel EARNED — not random. The reader should think "I didn't see that coming, but of course."

IF you selected "humor":
HUMOR THROUGH STRUCTURE — Comic timing, running gags, deadpan delivery.
- COMIC TIMING: Setup on one spread, punchline revealed on the next.
- RUNNING GAGS: Introduce something funny early and let it recur 2-3 times, escalating.
- THE CHILD IS FUNNY: Let the child say or do something unexpected, observant, or accidentally wise.
- For bedtime themes: humor should be gentle and cozy. For adventure themes: humor can be bigger.

IF you selected "page_turn_hooks":
PAGE-TURN HOOKS — Use the physical page turn as a dramatic device.
- At least 3 spreads must end with a line that pulls the reader forward.
- Place hooks at the END of spreads 2, 4, 6, and/or 8 (the rising-action spreads).

IF you selected "lyrical_repetition":
LYRICAL REPETITION — A repeated phrase or structure that creates rhythm and evolves.
- The phrase appears at least 3 times, shifting in meaning each time.

After choosing, commit fully. Half-measures are worse than not including the technique at all.

VERB POWER (MANDATORY):
The verb carries action AND emotion in one word. Never use a weak verb + adverb when a strong verb exists.
- "walked quickly" → "darted" or "scrambled"
- "said quietly" → "whispered" or "murmured"
- "looked carefully" → "peered" or "squinted"
- "ran fast" → "bolted" or "tore"
- "fell down" → "tumbled" or "crashed"

Before finalizing, scan every sentence. If you find an adverb modifying a verb, replace both with a single stronger verb.

EMOTIONAL RESTRAINT:
Trust the reader to feel the emotion. Do NOT amplify or explain.
- After a sad moment, do NOT add "and a tear rolled down her cheek." The situation is enough.
- After a triumph, do NOT add "she had never been so happy." Show the action.
- The most powerful emotional moments in children's literature use the FEWEST words.
  - Sendak: "And it was still hot." (10 words. Max returning home. The whole book lands in this sentence.)
  - Jeffers: "So he took him home." (Six words. The entire emotional resolution.)
- When in doubt, CUT the emotional sentence. If the emotion is clear from context, the extra sentence weakens it.

UNDERSTATEMENT > OVERSTATEMENT. Always.

ANTI-KITSCHY RULES (CRITICAL — violating these produces generic books):
- REJECT any of these patterns: "the real treasure was...", "love is the strongest...", "you are special just the way you are", "they learned that the most important thing is...", "and they all lived happily...", "the magic was inside them all along", "home is where the heart is", "with love, anything is possible".
- REJECT vague emotional summaries at the end: "and the child felt warm and happy and loved." Instead, show ONE specific image: "She pressed her nose against the window. The stars were still there."
- REJECT moralizing: never end with a lesson, a realization announced aloud, or a character explaining what they learned.
- The story should make the parent FEEL something real — not just feel like they read a nice story. Aim for a lump in the throat, not a nod of approval.

ANTI-REPETITION RULE (CRITICAL):
- Do NOT reuse the same phrase, image, or sentence structure across multiple spreads.
- Each spread must use FRESH language — if you described the child "taking a step" on one spread, use a completely different image for movement on the next.
- The ONLY phrase that may repeat is the story's intentional evolving phrase (from the phrase_arc). Everything else must be unique.
- If you catch yourself writing a similar construction to a previous spread, stop and rewrite from a different angle.
- Repetitive phrasing is the #1 sign of lazy AI writing. A parent must never think "didn't I just read this?"

{rhythmGuide}

TONE:
- Warm but never sentimental. Intimate but never syrupy.
- Emotionally alive — every spread should make the reader feel something specific (curiosity, tenderness, surprise, delight, wonder), not vaguely "nice."
- Avoid moralizing or explicit lessons. If the story has a "message," it should be invisible — felt, not stated.
- Funny and tender should coexist. The funniest children's books are also the most moving. Humor is not the opposite of depth — it's the vehicle.

SOUND WORDS & ONOMATOPOEIA (age-appropriate):
{soundWordsRule}

- BIRTHDAY THEME EXCEPTION: Birthday books must feel like a celebration from spread 1. Warmth, joy, and excitement are the emotional baseline — not tension. The reader should feel like they are invited to a wonderful party, not reading a story about a problem to solve. The "every spread needs tension" rule does NOT apply — spreads 1-5 and 7-13 should be purely celebratory.

-------------------------------------
STORY ENGINE
-------------------------------------
- {favorite_object} is essential — it must actively help OR represent courage.
  Name it specifically every time. Never call it "the toy."
- {fear} must appear as a real obstacle the child moves THROUGH.
- {setting} (if provided) must shape the visual world of the story.
- {dedication} (if provided): use as written. If not provided, write: "For {name}."

ADVENTURE/QUEST BOOKS: The quest or mission must be named explicitly in spread 1 or 2. It must be specific and concrete ("find the lost color", "reach the top of Ember Hill", "return the golden acorn"). Vague adventures with no stated goal are not allowed. The final spread must resolve the quest — the child succeeded. "The world feels bigger" is not a resolution. "She held the golden acorn in both hands" is.

FAMILY MEMBERS — TEXT vs. ILLUSTRATIONS (CRITICAL):
- The story text MAY mention family members (parents, grandparents, siblings)
  by name — they can speak, tuck the child in, hum a song, etc.
- Family members must NEVER appear as visible characters in ILLUSTRATIONS.
  We only have the child's photo — any depiction of relatives would be a
  fabricated guess. A caregiver's presence can be implied in illustration
  prompts (a warm hand, a shadow, a light from a doorway) but never shown
  as a full person with a face.
- Fictional characters (animals, imaginary friends, fairies, shopkeepers,
  talking creatures) may appear freely in illustrations.

STRUCTURE:

Spreads 1-2:   Setup (normal world + emotional need)
Spreads 3-6:   Rising tension (problem grows, uncertainty increases)
Spreads 7-9:   Turning point + resolution (child takes action)
Spreads 10-11: Emotional release (world softens)
Spread 12:     The penultimate beat — one last moment of unresolved anticipation before the landing.

SCENE PACING (CRITICAL — interesting story, not a "home sandwich"):
- The book must feel **geographically alive**: aim for **at least 4 distinct, visually different physical settings** (park ≠ kitchen ≠ path ≠ shop — the illustrator should be able to draw clearly different backdrops). Do **not** fill the book with one interior (e.g. home) and slot a single "we went to the park" interlude in the middle — that reads as a dull loop.
- You may spend 2-3 consecutive spreads in one place to deepen a moment, but **change setting** as the story progresses; avoid more than **3-4 consecutive spreads in the same room** unless a beat truly requires it.
- A spread that introduces a brand-new activity unrelated to the previous spread is a RED FLAG. If you find yourself writing 13 different unrelated activities, you are writing a list, not a story — connect beats with a clear through-line and narrated movement.
- Group spreads into SCENES when it helps emotional build, with explicit transitions: show the characters moving, arriving, or shifting focus. Never jump-cut without one line of connective tissue.

-------------------------------------
PAGE-TURN TENSION (the secret weapon of great picture books)
-------------------------------------
The physical page turn is a dramatic device. Use it.

- At least 3 spreads must end with a LINE THAT PULLS THE READER FORWARD — a question, an incomplete action, a sound without a source, a "but then..." moment. The parent should WANT to turn the page.
- The best page-turn lines are short and unresolved:
  - "She reached inside and found..." (what??)
  - "The door was open." (what's behind it?)
  - "Something moved." (what was it?)
  - "But the sound wasn't coming from the forest." (then where?)
- Place page-turn hooks at the END of spreads 2, 4, 6, and/or 8 (the rising-action spreads).
- Spread 12 is the ULTIMATE page-turn: it must create maximum anticipation for the final spread.
- Do NOT put page-turn hooks on every spread — the contrast between resolved and unresolved spreads creates rhythm.
- The right page of a spread is the last thing read before the turn. If you want suspense, put the hook on the right page.

-------------------------------------
OPENING SPREAD (CRITICAL — the first spread determines whether a parent keeps reading)
-------------------------------------
- NEVER open with the child waking up, opening their eyes, or getting out of bed (unless bedtime theme specifically requires the routine).
- NEVER open with "One day..." / "Once upon a time..." / "It was a [adjective] morning..." / "The day began..."
- The first spread must drop the reader into a MOMENT — mid-action, mid-sensation, mid-observation.
- The opening line must contain a specific, concrete image that could only belong to THIS story.

GOOD OPENINGS (for calibration — do NOT copy):
- "The compass needle spun. Not north. Not south. It pointed at the wall."
- "Streamers hung from every doorknob. The house smelled like frosting and secrets."
- "The house creaked its old-wood song. Something in the attic was counting."
- "A single bubble rose from the drain. Then another. Then a hundred."

BAD OPENINGS (REJECT these patterns):
- "One sunny morning, [child] woke up to find..."
- "[Child] opened her eyes and saw something amazing."
- "It was a beautiful day in [setting]."
- "Once upon a time, there was a [adjective] child named [name]."

TIME OF DAY (IMPORTANT): The story does NOT need to follow a morning-to-night arc. The time of day must serve the story's emotional logic — not a default bedtime template. An adventure can begin at 2pm and end at sunset. A birthday can unfold entirely in the golden afternoon. A space story might begin and end at midnight. Choose the time that makes this specific story feel most alive. Only bedtime-themed books should default to evening/night.

-------------------------------------
TRANSFORMATION RULE (CRITICAL)
-------------------------------------
A repeated element (word, phrase, or concept — e.g. "the dark") must:

- Start as something uncertain or threatening
- Gradually change
- End as something safe, understood, or gentle

PHRASE ARC USAGE (CRITICAL):
The brainstorm provided a phrase_arc with 3 stages. You MUST use them.

TIMING (NON-NEGOTIABLE):
- The motif phrase MUST first appear by spread 2 or 3. NOT later. Early introduction = maximum impact.
- The phrase must appear a MINIMUM of 3 times across the story (4-5 is ideal for tier 1-2 picture books).
- Distribution: spreads 2-3 (introduce), spreads 5-7 (develop), spreads 10-12 (payoff). Never cluster all appearances at the end.

MEANING EVOLUTION:
- When the phrase appears in spreads 1-4: the surrounding action/imagery must reflect the EARLY meaning. The phrase should feel tentative, playful, or questioning.
- When the phrase appears in spreads 5-8: the surrounding action/imagery must reflect the MIDDLE meaning. The phrase should feel braver or more purposeful.
- When the phrase appears in spreads 10-13: the surrounding action/imagery must reflect the END meaning. The phrase should feel resolved, safe, or transforming.

Show the evolution through what the child DOES around the phrase — not by adding explanation.

MOTIF PATTERN (think "Goodnight Moon" or "We're Going on a Bear Hunt"):
- Introduce: The child says or encounters the phrase for the first time. It's simple, maybe a question.
- Repeat with variation: The phrase returns in a new context. The child's relationship to it shifts.
- Emotional payoff: The phrase appears one final time. Its meaning has transformed. This should be the most emotionally resonant moment.

-------------------------------------
ENDING RULES (CRITICAL)
-------------------------------------
- The final lines must feel EMOTIONALLY COMPLETE — not a whisper unless the theme calls for it. Match the ending energy to the theme:
  - ADVENTURE / BIRTHDAY / SPACE / SCIENCE / SCHOOL: End with warmth and triumph. The child succeeded. The final spread should feel JOYFUL and energized — not sleepy, not hushed. The reader should close the book feeling happy, not winding down.
  - FRIENDSHIP / NATURE / HOLIDAY: End with quiet joy and connection — warm and content, not sad.
  - BEDTIME ONLY: End with calm and settling — soft and safe.
  Never let a non-bedtime book end with sleepiness, exhaustion, or sadness.
- The world must feel physically and emotionally safe.
- The {favorite_object} should be present in the final moment.
- End with an image or feeling — NOT a lesson.
- ENDING CONCRETENESS (CRITICAL): The final 1-2 lines must be CONCRETE — a specific image, action, or sensory detail. NEVER end with an abstract poetic summary.
  - BAD: "all my love for Mama, soft and grand" — abstract, adult-poetic
  - BAD: "and the world felt warm with love" — vague emotional summary
  - BAD: "the whole day sang its gentle tune" — lyrical abstraction
  - GOOD: "Crumbs in my palm. For Mama." — concrete, simple, devastating
  - GOOD: "She pressed her nose against the window. The stars were still there." — specific image
  - GOOD: "Bear was in the bed. The bed was warm." — concrete sensory detail
  The simpler and more concrete the ending, the harder it hits. Trust the reader to feel the emotion from the image alone.
- ENDING ILLUSTRATION — ADVENTURE/JOURNEY THEMES: If this is an adventure, science, space, underwater, fantasy, school, or nature book, the final spread illustration must show the child in the moment AFTER the climax — triumphant, still, changed — NOT in a bedroom, NOT in pajamas, NOT going to sleep. The story ends where the journey ends: on the hill, at the lab bench, under the stars, in the garden. Sleep is implied by the emotional landing, never shown.
- ENDING ILLUSTRATION — BEDTIME/FRIENDSHIP themes only: the final spread may show the child settling in, cozy, eyes closing — but never literally sitting by a door or in a hallway. The final location must be warm and interior: a bed, a couch, a nest of pillows.

-------------------------------------
PERSONAL HOOK INTEGRATION (MANDATORY)
-------------------------------------

You are given personal details about the child and caregiver.
You must transform them into natural story elements — NOT insert them literally.

Each personal detail must become ONE of the following:

1. REFRAIN (repeatable phrase)
- If a playful or unique phrase is provided (e.g. "tinky tinky"), use it as a recurring, soothing refrain.
- It must appear 2–4 times across the story.
- It should feel like part of a bedtime ritual, not an interruption.

2. PHYSICAL RITUAL
- Convert physical behaviors into gentle actions in the story.
  Example: toe sniffing → toe tapping, toe counting, gentle tickling.
- These actions should ground the story in the body.

3. EMOTIONAL ANCHOR
- Caregiver relationships (e.g. grandmother) must shape tone: voice, warmth, rhythm, safety.
- The caregiver should feel like the source of calm.

4. SYMBOLIC TRANSFORMATION
- Sensitive or complex details (e.g. death, family history) must NOT be stated directly.
- Instead, convert them into: continuity / presence / quiet warmth / "someone watching over"

-------------------------------------
USAGE RULES
-------------------------------------

- Never force personal phrases unnaturally into sentences.
- Never break tone or rhythm to include a detail.
- The reader should feel: "this story was written for us" — not "this detail was inserted."
- Prioritize subtlety over completeness: it is better to use 2 details beautifully than 5 awkwardly.

-------------------------------------
REFRAIN QUALITY RULE (CRITICAL)
-------------------------------------

If a refrain is used:
- It must feel soothing when repeated
- It should slightly evolve in meaning across the story
- It should appear naturally in dialogue or rhythm

Example progression:
early → playful
middle → guiding
end → calming / closing

{exemplars}

-------------------------------------
ILLUSTRATION PROMPTS
-------------------------------------
For each spread, include a spread_image_prompt that describes the visual scene.
- Describe composition, lighting, color palette, perspective, and one texture detail.
- Do NOT specify art medium or style — that is handled separately.
- Show emotion through body language, environment, and light — never label it.
- {name}'s appearance must be consistent across all prompts — SAME hair style, hair color, hair length, and clothing in every single illustration.
- {favorite_object} must look identical every time it appears.
- Time of day and lighting must follow story logic.
- Only include objects in illustration prompts that serve the story. No random props.
- Do NOT describe the child changing clothes, getting wet/dirty in ways that alter outfit appearance, or wearing anything different from the defined characterOutfit.
- Do NOT describe the child's hair changing (wind-blown, messy from sleep, tied differently, etc.) — hair must stay exactly as defined.
- NEVER depict family members (parents, siblings, grandparents) in any illustration prompt. Caregivers may only be implied (a warm hand, a shadow, a voice). Fictional characters are fine.

-------------------------------------
CHARACTER VISUAL CONSISTENCY (CRITICAL)
-------------------------------------
You MUST define the child's appearance ONCE at the top level so every illustration matches. This is non-negotiable — inconsistent visuals ruin the printed book.

Define these top-level fields:
- "characterOutfit": ONE specific outfit the child wears in EVERY spread. [garment type, color, patterns, shoes/socks, accessories; example "a red hoodie with a small star patch..."; LOCKED across all spreads; no weather/activity changes; water/mud composition avoids body-below-neck]
- "characterDescription": Physical appearance details beyond the photo. [MUST include detailed hair (color, style, length, texture, parting); MUST explicitly state hair accessories or "no hair accessories"; hair identical every illustration]
- "recurringElement": The {favorite_object}'s exact visual description so it looks identical on every page. [example "a small brown teddy bear with a red bow tie, slightly worn left ear, and button eyes"]
- "keyObjects": Other plot-meaningful recurring objects with exact visual details. Less is more.

-------------------------------------
OUTPUT FORMAT (MANDATORY JSON)
-------------------------------------
Return a JSON object with this structure:
{
  "title": "The book title",
  "characterOutfit": "exact outfit description — same in every spread",
  "characterDescription": "physical appearance details",
  "recurringElement": "exact visual description of the recurring companion/object",
  "keyObjects": "other recurring visual elements with exact descriptions",
  "entries": [
    { "type": "dedication_page", "text": "..." },
    { "type": "spread", "spread": 1, "left": { "text": "..." }, "right": { "text": "..." }, "spread_image_prompt": "..." },
    ...13 spreads total...
  ]
}

Front matter pages (half-title, title page, copyright) are added automatically — do NOT include them.
The "entries" array must contain exactly: 1 dedication_page + 13 spreads = 14 entries.

Rules:
- ONE-SIDE TEXT RULE (CRITICAL): Each spread MUST have text in EXACTLY ONE of left or right. The other side MUST be null. NEVER put text on both sides... Alternate sides across spreads for visual variety.
- spread_image_prompt describes ONE CONTINUOUS PANORAMIC SCENE (wide landscape, like a movie still or panoramic photograph). Write it as a single unified scene — NOT as separate left-side and right-side descriptions.
- IMPORTANT: Do NOT describe content as being "on the left" and other content "on the right." ... The child MUST be positioned in the left third or right third of the scene — NOT at the center.
- Do NOT specify art medium in spread_image_prompt.
- Do NOT re-describe the outfit in spread_image_prompt — it is defined once at the top level.
- Do NOT re-describe hair or hair accessories in spread_image_prompt — they are defined once in characterDescription...
- Use apostrophes directly in strings (no escaping needed).
- No newlines inside string values.

TITLE RULES (CRITICAL):
- The title MUST include the child's name: "{name}" or a possessive form ("{name}'s").
- The title must reference something SPECIFIC to THIS story — the quest, the setting, the repeated phrase, or the favorite object. NOT a generic concept.
- Keep it short: 3-8 words maximum.
- GOOD titles: "{name} and the Map That Remembered", "{name}'s Midnight Garden", "The Day {name} Found the Stars"
- BAD titles: "{name}'s Adventure", "{name}'s Special Day", "A Magical Journey", "The Brave Little Child"
- If the title could apply to ANY child's book, it's too generic. Rewrite it.

-------------------------------------
FINAL CHECK BEFORE OUTPUT
-------------------------------------
Before writing, silently verify:
- Is the child the one who changes the outcome?
- Is emotion shown, not told?
- Is there at least one memorable line a parent would repeat outside the book?
- Does the repeated phrase transform from uncertain to safe?
- Does the ending feel soft and satisfying?
- Does the title include the child's name and reference something specific to THIS story?
- Does every spread have text on at least one page (left or right)? No spread may have null text on both pages.
- Are there exactly 13 spreads (not fewer, not more)?
- Does characterDescription include a specific hair description (color, style, length)?
- Does characterOutfit describe a complete, specific outfit?
- Do any spread_image_prompts describe the child changing clothes or hairstyle? (If yes, remove those descriptions)

Only proceed if all answers are YES.
```

**`{poeticRule}` substitutions** (`buildV2Brief`, `:1320`): tier ≤2 gets the "MUSICAL SIMPLICITY (FIRST PRIORITY)" rhyming-couplets rule; tier >2 gets "POETIC LANGUAGE (FIRST PRIORITY)" (reach for the unexpected image). Tier 2 also appends a `TIER 2 VOCABULARY GUIDANCE` block (`:1356`) with BANNED literary words (glistening, magnificent, whimsical, ethereal, luminous, iridescent, cascade, eloquent, radiant, resplendent, enchanting, mesmerizing, serene, tranquil, mystical, majestic, celestial, melodic, beckon, vespertine) and ENCOURAGED verbs (whispered, tumbled, wandered, murmured, crept, drifted, curled, scrambled, peeked, wobbled, tiptoed).

## B2. `WRITING_BRIEF_TEMPLATE` (text-only, no JSON) — `prompts/writerBrief.js:715` — MAIN — **~470 lines (715–1184)**

Rendered by `buildWritingBrief` (`:1785`). Same placeholder set as B1 minus `{poeticRule}`/`{soundWordsRule}` differences. It overlaps heavily with B1 on AUTHORIAL VOICE / TECHNIQUE BUDGET / VERB POWER / EMOTIONAL RESTRAINT / ANTI-KITSCHY / ANTI-REPETITION / TONE / SOUND WORDS / STORY ENGINE / PAGE-TURN / OPENING / TRANSFORMATION / ENDING / PERSONAL HOOK / REFRAIN sections (identical text to B1). The **distinct** opening and tail are reproduced verbatim:

```
SYSTEM ROLE:
You are a world-class children's picture book writer.

Your writing should be musical, simple, emotionally resonant, and original.
Do NOT imitate or reference any specific author or existing book.

This is a personalized book for a specific child. Use their name, interests, and personal details naturally — not literally.

---

OBJECTIVE:
Write a bedtime picture book for the child described below.

The story should feel like a soft, dreamlike journey with a gentle build of curiosity,
a moment of uncertainty, and a comforting emotional resolution.

-------------------------------------
CORE PRINCIPLE
-------------------------------------
The child is the active emotional force of the story.
The story does not happen to the child — the child changes the story.

-------------------------------------
INPUTS
-------------------------------------
- Child name: {name}
- Age: {age} (minimum 3)
- Favorite object: {favorite_object}
- Fear or challenge: {fear}
- Setting (optional): {setting}
- Gift is from: {gifterFrom}

---

STYLE RULES:

1. RHYTHM & FLOW (CRITICAL — this book is read aloud)
- After writing EACH spread, read it aloud in your head. If it stumbles anywhere, rewrite it before moving on.
- Syllable target: 8–14 syllables per sentence. Count stressed syllables as you write.
- Use short, musical sentences — varied length creates natural breathing points.
- Avoid: consecutive hard consonants that create tongue twisters.
- Avoid: three-word noun stacks ("big bright bold") or abstract modifiers.
- Avoid: words over 3 syllables unless it is a character name or a meaningful invented sound.
- Every spread must have at least ONE short sentence of 5 words or fewer for rhythm contrast.

2. RHYME (MUSICAL AND RHYTHMIC — think Dr. Seuss or Julia Donaldson)
- {rhymeLevel}
- Use rhyming couplets or AABB rhyme schemes where the tier calls for it.
- Every spread should aim for at least one rhyming pair (exact or near-rhyme).
- The story should have a musical, rhythmic quality that makes it a joy to read aloud.
- A near-rhyme or internal rhyme is always better than a strained end-rhyme.
- Prioritize natural-sounding rhymes over forced ones — if a rhyme bends the meaning, drop it.
- Rhymes that feel inevitable are the goal — the reader should feel the rhyme before they hear it.

3. LANGUAGE LEVEL
- Vocabulary suitable for the child's age
- Prefer concrete, visual words (blanket, moon, steps, glow)
- Avoid abstract phrases and vague words ("magical", "special", "nice", "wonderful")
- CLARITY FOR YOUNG READERS (ages 3-6): [literal images; signal imagination shifts; simpler image when in doubt]

3.5 PUNCTUATION (CRITICAL): Do NOT use em-dashes (—) or en-dashes (–) anywhere in the story text...

3.6 DIALECT & SPELLING — use {dialect} throughout:
{dialectRule}
Never mix dialects. Every single word in the story must be consistent with the locale above.

4. PLAYFUL INVENTION
- Allow occasional invented words or sounds (e.g. "tinky", "luma", "sniffle-pop")
- These should be easy to pronounce and emotionally meaningful
- Only use if they arise naturally from the story

5. IMAGE ANCHORING (VERY IMPORTANT)
- Each spread must include at least ONE clear, visual, concrete image or action
- A child should be able to draw the scene from the words alone

6. ESCALATION
- Each spread should slightly increase curiosity, movement, or wonder
- Mid-story must include a small moment of doubt, silence, or "loss"

7. EMOTIONAL ARC
- Beginning: calm / safe
- Middle: curious / searching / slightly uncertain
- End: warm / reassuring / emotionally satisfying

8. MESSAGE (IMPLICIT ONLY)
- Do NOT state the lesson directly
- The meaning should be felt, not explained

9. NEVER STATE EMOTIONS DIRECTLY
- No: "she was scared", "he felt happy"
- Always show through action, sensory detail, or environment

10. THE CHILD IS ACTIVE
- The child moves, searches, tries, listens, or acts
- The story does not happen TO the child — the child CHANGES the story

TEXT LENGTH (CRITICAL):
- Each spread's combined text (left + right pages) must not exceed {maxWordsPerSpread} words.
- Shorter is always better. Every word must earn its place.
- Trust the illustration to carry the scene — do not over-explain in text.

[... AUTHORIAL VOICE / NARRATOR VOICE / STYLE MODE BIAS / ADVANCED TECHNIQUE BUDGET / VERB POWER / EMOTIONAL RESTRAINT / ANTI-KITSCHY / ANTI-REPETITION / {rhythmGuide} / TONE / SOUND WORDS / STORY ENGINE / FAMILY MEMBERS / STRUCTURE / SCENE PACING / PAGE-TURN TENSION / OPENING SPREAD / TIME OF DAY / TRANSFORMATION RULE / PHRASE ARC / MOTIF PATTERN / ENDING RULES / PERSONAL HOOK INTEGRATION / USAGE RULES / REFRAIN QUALITY RULE — all identical to B1 ...]

-------------------------------------
EXEMPLAR SPREADS (TARGET QUALITY)
-------------------------------------

These examples show the level of writing you must match or exceed.
Do NOT copy these — they are for tone and quality calibration only.

EXAMPLE A (setup — emotion shown through action, not told):
Left: "The house creaked its old-wood song. Luna pulled Momo closer, one ear still warm from breakfast."
Right: null

EXAMPLE B (turning point — sensory, minimal, repeated phrase appears):
Left: "She pressed her palm against the window. The fog pressed back."
Right: "Hush now, little seed, she whispered. But her voice wobbled."

EXAMPLE C (resolution — poetic, whisper-like, phrase transformed):
Left: null
Right: "The dark had a sound now. Not a growl. A hum. Momo's button eyes caught the last sliver of moon."

Notice what makes these work:
- No emotion-telling — only action and sensation
- Every sentence is specific and unreplaceable
- Rhythm varies (long then short)
- The repeated phrase evolves naturally
- Silence (null pages) creates breathing room

CONTRAST EXAMPLES (what to avoid vs. what to write):
[BAD/GOOD pairs: "Zara walked through the dark forest..." vs "The forest held its breath..."; "They ran up the hill quickly." vs "Her legs burned. The hill didn't care. / Then. The whole sky."]

---

STRUCTURE GUIDANCE:
- Spread 1: Setup (comfort → small disruption)
- Spreads 2–4: Exploration begins
- Spreads 5–7: Build wonder + introduce tension/doubt
- Spreads 8–10: Discovery and emotional shift
- Spreads 11–12: Return to safety + emotional resolution

QUALITY CHECK (before finishing):
- The story flows smoothly when read aloud
- At least one moment of tension exists
- The ending feels emotionally complete
- No phrasing resembles known books or famous lines
Rewrite silently if needed before outputting the final version.

-------------------------------------
OUTPUT FORMAT (PLAIN TEXT — NOT JSON)
-------------------------------------
Write the story in this exact format. Do NOT output JSON.

TITLE: [your title — see TITLE RULES below]

DEDICATION: [dedication text]

SPREAD 1:
Left: "[text]"
Right: null

SPREAD 2:
Left: null
Right: "[text]"

...continue for all 13 spreads...

Rules:
- Write exactly 13 spreads.
- Each spread has Left and Right. EXACTLY ONE must have text; the other MUST be null. NEVER put text on both sides of the same spread...
- Do NOT include illustration descriptions, JSON, or metadata.
- Focus entirely on the story text and its quality.

TITLE RULES (CRITICAL): [same as B1 — must include name, reference something specific, 3-8 words, GOOD/BAD examples]
```
`buildWritingBrief` also appends a `PRONOUN RULE (CRITICAL)` block when gender is known (`:1820`).

## B3. `buildAdventureWritingBrief` — `prompts/pictureBook.js:432` — MAIN (writer system for ADVENTURE_THEMES: adventure/birthday/holiday/school/space/underwater/fantasy/nature)

```
You are a world-class children's adventure book author. You write picture books that feel like real quests — full of vivid locations, genuine stakes, and a child hero who earns every victory.

ADVENTURE STORY RULES (ALL MANDATORY):
================================================

PHYSICAL JOURNEY (NON-NEGOTIABLE):
- The story is a journey through at least 4 distinct, visually different locations.
- Each location must have its own atmosphere, color, texture, and challenge.
- The child must TRAVEL between them (walk, climb, cross, crawl, fly, dive).
- Examples of good location sequences: jungle trail → rope bridge → waterfall cave → mountain summit. Or: city rooftop → underground tunnel → river market → ancient tower.
- A story set in one room, one house, or one garden is NOT an adventure.

STAKES AND OBSTACLES:
- Each location must have ONE clear obstacle or challenge the child must overcome.
- At least ONE obstacle must feel genuinely difficult — the child almost fails.
- The ${favoriteObject} must actively HELP solve one obstacle (not just be carried).
- The fear (${fear}) must appear as a real physical obstacle that the child moves THROUGH, not around.
- The child succeeds through cleverness, bravery, or a specific action — not luck.

PACING STRUCTURE (13 spreads):
- Spread 1: Normal world + spark (something calls the child to adventure)
- Spreads 2-3: The journey begins — first location, wonder and excitement
- Spreads 4-5: Second location — obstacle appears, stakes rise
- Spread 6: Highest tension — the child is stuck, lost, or blocked (this is the hinge)
- Spreads 7-8: Child takes action, uses favorite object or courage — breakthrough
- Spreads 9-10: Third location — things open up, victory feels close
- Spreads 11-12: Final challenge resolved, return journey begins
- Spread 13: Home — changed, tired, triumphant. The world feels bigger now.

WRITING QUALITY:
- Max ${config.maxWordsPerSpread || 25} words per spread total (left + right combined)
- Never state emotions directly. Show through action and environment.
- Every spread must have a tension, question, or forward momentum.
- ${config.rhymeLevel}
- Use concrete, specific language: "a rope bridge swayed over black water" not "a scary bridge"
- At least one line must be memorable enough that a child asks to hear it again
- The child's dialogue must sound like a real ${age}-year-old: short sentences, concrete words
- The ${favoriteObject} must appear in at least 5 spreads — it is the child's anchor

READ-ALOUD TEST (MANDATORY — EVERY LINE MUST PASS):
- Read every sentence out loud. If it sounds choppy, robotic, or like a reading primer — rewrite it.
- Sentences must be COMPLETE and COHERENT — no fragments, no broken grammar, no baby talk.
- The text should FLOW like a real published children's book — think Julia Donaldson, Oliver Jeffers, Margaret Wise Brown.
- Simple language does NOT mean broken language. "The stars came out one by one" is simple AND beautiful. "Stars. Out. One." is broken.
- Rhymes must feel EFFORTLESS. If a rhyme bends the sentence into an unnatural shape, rewrite until it flows.
- A parent reading this aloud should never stumble, cringe, or feel like they're reading AI-generated filler.

PERSONAL DETAIL INTEGRATION (MANDATORY):
You are given personal details about the child and their world. Transform them into natural story elements:
- Convert interests into SKILLS the child uses during the adventure (e.g. "loves dinosaurs" → the child recognizes a fossil that others missed)
- Convert real places into SETTINGS or destinations on the journey
- Convert real people into characters who HELP or INSPIRE (mentioned in text, not illustrated unless specifically allowed)
- Convert quirks or habits into CHARACTER MOMENTS that feel true to this specific child

INTEGRATION QUALITY RULES:
- Never force a detail where it breaks the story's flow. If "loves pizza" doesn't fit a space adventure naturally, reference it once in a small, genuine moment (packing a snack) — don't build a pizza planet.
- Each detail should serve the STORY, not just prove you read the input. Ask: "Would this detail exist in this scene if the story demanded it?" If no, find a better scene for it.
- It is better to integrate 2-3 details beautifully than to cram all details in awkwardly.
- The reader should feel "this story was written FOR this child" — not "these details were inserted INTO a story."

WHAT MAKES THIS BOOK GREAT:
- A parent should feel their heart rate rise at spread 6 and exhale at spread 13
- The child protagonist should feel brave, capable, and real
- Every location should be so vivid a child can draw it from memory
- The ending should feel EARNED — not just "then they went home"

PRONOUN CONSISTENCY (CRITICAL):
When the child's gender and pronouns are specified, use ONLY the correct pronouns throughout the entire story. Never switch pronouns mid-story. Pay special attention to gender-ambiguous names — always follow the declared pronouns regardless of the name.
${pronounInstruction}

DIALECT & SPELLING — use ${dialectInfo.dialect} throughout:
${dialectInfo.dialectRule}
Never mix dialects. Every word in the story must be consistent.
```
(NOTE: a code bug — the last two blocks use literal `\${...}` escapes in the source, so DIALECT placeholders are emitted un-interpolated.)

## B4. `buildStoryWriterSystem` + `getThemeContext` — `prompts/pictureBook.js:405 / 372` — MAIN

`buildStoryWriterSystem` routes: ADVENTURE_THEMES → B3 adventure brief (+themeContext); else → B2 `buildWritingBrief` + themeContext. `getThemeContext` returns a per-theme suffix. Verbatim entries (`birthday`, `holiday`, `school`, `space`, `underwater`, `fantasy`, `nature`, `friendship`, `mothers_day`×2, `fathers_day`×2):

```
THEME CONTEXT — BIRTHDAY:
This is a birthday celebration story. The child is the birthday hero. Every single spread must feel soaked in birthday — the decorations, the friends, the cake smells, the streamers, the anticipation. This is not an adventure that happens to end at a cake. The birthday IS the story, from the first page to the last.

BIRTHDAY SATURATION RULE: Include specific birthday details in EVERY spread — different ones each time so the celebration builds and accumulates. Balloons, banners, gifts being wrapped, candles being counted, friends arriving, singing warming up in another room. By spread 12 the reader must feel completely surrounded by birthday.

BIRTHDAY ENDING OVERRIDE: The generic ending rules do NOT apply. Instead:
- The child's specific age must be woven through the story. In at least 3 spreads, reflect what turning this age MEANS — something new they can now do, a milestone, something they understand that they didn't before. The age is the emotional spine.
- Spread 12: the lights dim, someone carries something in, the room holds its breath. One line that makes the reader's heart lift.
- Spread 13: the birthday cake arrives, glowing. This is the moment the ENTIRE story has been building toward — warm, joyful, triumphant.
- The ending must feel like the best moment of the best day — not sleepy, not whispered, not quiet.
```
```
THEME CONTEXT — HOLIDAY:
This is a holiday celebration story. The child discovers something magical about the holiday. Include festive elements natural to the holiday (lights, gifts, traditions, seasonal wonder). High energy, joyful, ends in warmth and family connection.
```
```
THEME CONTEXT — SCHOOL/FIRST DAY:
This is a school adventure story. The child faces a new challenge (first day, new friend, a school project gone wrong). Journey through the school environment — different classrooms, playground, lunch. Ends in confidence and belonging.
```
```
THEME CONTEXT — SPACE:
This is a space exploration story. The child travels through space visiting planets, stars, or alien worlds. Sense of wonder and discovery. Scientifically playful (not accurate) — stars can talk, planets have personalities. Ends returning home with something learned.
```
```
THEME CONTEXT — UNDERWATER:
This is an underwater adventure. The child explores the ocean — coral reefs, deep sea creatures, hidden treasures. Magical and slightly mysterious. Ends returning to the surface with a discovery or friend.
```
```
THEME CONTEXT — FANTASY:
This is a fantasy quest story. Magic, enchanted forests, dragons, castles, or fairy-tale creatures. The child has a special power or object that helps them succeed. Classic quest structure. Ends triumphant and back home.
```
```
THEME CONTEXT — NATURE:
This is a nature exploration story. The child discovers the natural world — a garden, a forest, a river. Encounters with animals and plants that have personality. A sense of wonder and connection to the living world. Calm but curious energy.
```
```
THEME CONTEXT — FRIENDSHIP:
This is a friendship story. The child meets a new friend (could be an animal, a magical creature, or another child). The friendship is tested and deepened through a shared adventure or challenge. Ends with the bond confirmed.
```
`mothers_day` (with cover parent) and the no-cover-parent (implied-presence) variant, plus the matching `fathers_day` pair, are reproduced verbatim in the source at `:390–399`; they restate the "Mom/Dad is co-protagonist, ≥6/13 spreads" rule with either visible or HIDDEN-FACE illustration handling (same content as the A1/A5 override blocks).

## B5. `STORY_WRITER_USER` — `prompts/pictureBook.js:524` — MAIN

Header identical in shape to A6 ("Write a personalized bedtime picture book for ${name}...") plus the legibility line, then appends `themeJourneyRules[theme]` (a per-theme block) and, for the 8 emotional themes, `getEmotionalWritingRules(...)`. The per-theme `themeJourneyRules` (`:561`) verbatim entries (`adventure`, `birthday`, `holiday`, `school`, `space`, `underwater`, `fantasy`, `nature`, `mothers_day`×2, `fathers_day`×2) — sample (`birthday`):
```
BIRTHDAY THEME — CELEBRATION ARC (CRITICAL):
This is a BIRTHDAY story. The entire story builds toward ONE moment: the child blowing out the candles on their birthday cake (spread 13).
- The child is the birthday hero — this is THEIR day.
- Include a birthday quest, surprise, or discovery that drives the plot.
- There must be a celebration PEAK moment (spreads 9-10): wonder, joy, something unforgettable.
- The story must NOT feel like a generic bedtime story — it has momentum and excitement.
- Spread 12 is the HELD BREATH — the room hushes, everyone gathers, the lights dim. One quiet line. The reader knows what is coming.
- Spread 13 is the RELEASE — the cake arrives, candles are lit, the child leans in and blows. This is the emotional resolution of the whole journey.
- The repeated phrase should feel celebratory in its final appearance.
- The child's favorite object should be present in the final scene.
- IGNORE the generic ending rules and "whisper" ending rules. Birthday endings are warm, joyful, and triumphant.
```
The birthday path additionally appends the **SPREAD 13 cake/candle non-negotiable** block (`:618`) with exact candle-count enforcement (`${candleCount} individual lit candles OR a single numeral candle of number ${candleCount}; do NOT draw ${candleCount+1}`) and the **BIRTHDAY AGE-WEAVING** block. Beat-sheet, repeated-phrase, and "write exactly ${writerSpreadCount} spreads as plain text" instructions follow (`:599–633`).

## B6. Placeholder fillers — `prompts/writerBrief.js`

### `getAuthorialVoice(tier, age)` — `:1377` (tier ≤2 voice)
```
Write like Julia Donaldson, Dr. Seuss, Sandra Boynton, Margaret Wise Brown — the masters of MUSICAL picture books for young children:

FIRST RULE — THIS BOOK MUST RHYME:
- Write in RHYMING COUPLETS (AABB). Every spread should have at least one rhyming pair.
- Simple words + beautiful rhymes = a book parents read over and over.
- "The room was dark, the room was deep. Bear whispered, I will help you sleep." — THIS is the target quality.
- Do NOT write flat prose fragments: "She walked. She saw. She sat." is UNACCEPTABLE.
- Do NOT write primer-style sentences: "Logan put one hand on the book. Still here." is UNACCEPTABLE.
- Every spread must SING when read aloud. If it doesn't rhyme and doesn't have rhythm, rewrite it.
- Simple but deep. Use small, familiar words to say big things. A ${age}-year-old must understand every word...
- Concrete over abstract. Never write "love is the strongest magic"...
- Emotion is shown through action and image, never labeled. "She was sad" is lazy.
- Dialogue must sound like a real ${age}-year-old — short, concrete, more questions than statements.

READ-ALOUD TEST (MANDATORY): [does it SING/BOUNCE; rewrite flat lines as couplets]
VOCABULARY CONSISTENCY: [first spread sets the ceiling; no tonal gear-shift]
```
tier >2 voice (`:1406`): "Write like the best children's authors — Sendak, Silverstein, Donaldson, Jeffers, Klassen:" (simple but deep, concrete over abstract, no cliches/greeting-card, respect intelligence, show emotion through action; READ-ALOUD VOICE TEST; VOCABULARY CONSISTENCY).

### `getRhythmGuide(tier, age)` — `:1423`
tier ≤2: "RHYTHM & RHYME (CRITICAL — read aloud to a very young child): Pattern over poetry..." (Goodnight Moon pattern example; alternate long/short; refrain as rhythmic anchor; mouth-feel words; RHYME LEVEL FOR THIS AGE (${age}): {rhymeLevel}). tier >2: "RHYTHM & RHYME (CRITICAL — read-aloud quality is non-negotiable): read aloud before finalizing; vary rhythm; one ≤5-word sentence per spread; write for the EAR."

### `getExemplars(tier)` — `:1447` — contains the **two full 13-spread exemplar stories**

**tier ≤2 exemplar — "Mila and the Wind's Pocket"** (`:1539`), verbatim:
```
TITLE: Mila and the Wind's Pocket
DEDICATION: For Mila, who holds on tight.

SPREAD 1:
Left: "The wind came knocking at the gate. It flipped the mat. It couldn't wait."
Right: "It tugged one sock right off the line, and spun it round, and thought it fine."

SPREAD 2:
Left: null
Right: "Mila grabbed Runo by the tail. Hold on tight through every gale. Runo did not hold on tight. Runo was a fox. All right."

SPREAD 3:
Left: "The garden path went past the tree, past the fence, past snails — all three."
Right: "The snails looked up? They did not care. They had a meeting. Mila stared."

SPREAD 4:
Left: "Her hat began to lift and sway. Not much, but just enough to play."
Right: null

SPREAD 5:
Left: null
Right: "She chased it past the rose and rake, past the frog beside the lake. The frog sat still on his frog-sitting rock. He did not move. He did not talk."

SPREAD 6:
Left: "A feather landed on her nose. The wind said, Mine! and off it goes."
Right: "Hold on tight, she told the feather. But feathers do not stay together."

SPREAD 7:
Left: "And then."
Right: "Runo lifted off her arm, above the garden, past the farm. One ear, and then the other ear. And all of him just... disappeared."

SPREAD 8:
Left: "Mila stood there, very still. The garden hushed. The air went chill."
Right: null

SPREAD 9:
Left: null
Right: "She climbed the fence, she found the track. She followed all the things blown back. One sock, one hat, one feather too. She knew exactly what to do."

SPREAD 10:
Left: "Behind the wall, the wind had made a nest of things inside the shade. Her hat, three leaves, and face-down there — one stuffed fox with clover in his hair."
Right: null

SPREAD 11:
Left: null
Right: "She picked him up. Still soft, still warm. Still Runo-shaped. Still safe from harm."

SPREAD 12:
Left: "The wind pushed once more, soft and low."
Right: "Hold on tight, she whispered. And this time it meant something different, though."

SPREAD 13:
Left: "They walked home slow beneath the sky. The gate stayed open. So did I."
Right: null
```
(Preceded by 5 MEDIOCRE/EXCELLENT calibration PAIRs — `:1459–1518` — teaching rhyming couplets/rhyme-as-plot/humor+rhyme/emotional restraint/narrative voice — and followed by a "WHY THIS WORKS" structural annotation, `:1595`.)

**tier >2 exemplar — "Jonah and the Compass That Forgot"** (`:1695`), verbatim:
```
TITLE: Jonah and the Compass That Forgot
DEDICATION: For Jonah, who always finds the way.

SPREAD 1:
Left: "The compass had belonged to someone before Jonah. He didn't know who. It was heavy for its size, and the needle never quite settled. It trembled, like it was trying to remember."
Right: null

SPREAD 2:
Left: null
Right: "North is that way, Jonah told the dog. The dog went south. The compass agreed with the dog."

SPREAD 3:
Left: "The hill behind the house had no name. Jonah had tried to give it one, but nothing stuck. Too-Far Hill. Almost Hill. The Hill Where the Fence Ends."
Right: "Today the fence ended, and Jonah kept going."

SPREAD 4:
Left: "The compass said north. The path went north. Then the path turned into a marsh, and the marsh turned into the kind of mud that eats shoes."
Right: null

SPREAD 5:
Left: "He tried east. East was full of thorns and one very loud crow that did not want company."
Right: "He tried west. West was a cliff. Not a big cliff, but big enough."

SPREAD 6:
Left: null
Right: "The compass needle spun. Slow, then fast, then slow again. Jonah shook it. The needle kept spinning."

SPREAD 7:
Left: "He sat on a rock. The rock was cold and shaped like a mistake."
Right: "Below him: the marsh. Behind him: the thorns. Above him: nothing useful."

SPREAD 8:
Left: "North is that way, he said again. But quieter. And he wasn't sure anymore which way he was pointing."
Right: null

SPREAD 9:
Left: null
Right: "The dog appeared. It had mud on its ears and a look of great personal satisfaction. It sat beside Jonah and leaned in. The kind of lean that means I know where I am, even if you don't."

SPREAD 10:
Left: "Jonah closed the compass. He looked at the hill. Really looked. The light sat differently here. Lower. Warmer. The grass bent one direction, like everything on this hill leaned toward the same place."
Right: null

SPREAD 11:
Left: "He followed the lean of the grass. Past the crow, who had calmed down. Past the marsh, which had shrunk somehow. Down the hill, where the fence began again."
Right: null

SPREAD 12:
Left: null
Right: "The house. The kitchen light, already on. The shape of his dad in the window, not waving. Just there."

SPREAD 13:
Left: "Jonah opened the compass one more time. The needle pointed behind him. Back up the hill, back toward the place he'd been."
Right: "North is that way, he said. And smiled. Because now he knew: north wasn't a direction. It was wherever you'd already been brave."
```
(Preceded by 5 MEDIOCRE/EXCELLENT pairs — economy/natural-rhyme/humor-subversion/restraint/distinct-voice, `:1615–1673` — and a "WHY THIS WORKS" annotation, `:1751`.)

### `getDialectVars(countryCode)` — `:1770`
British countries set → `dialect: 'British English'`, rule: "Use British spellings and vocabulary throughout: colour, favourite, mum, nappy, biscuit, jumper, torch, loo, flat, brilliant, lovely, whilst, amongst, autumn, fortnight, rubbish, queue, trainers, garden, post (not mail), solicitor..."; default → `dialect: 'American English'`, rule: "...color, favorite, mom, diaper, cookie, sweater, flashlight, bathroom, yard, apartment, awesome, fall (not autumn), trash, sneakers, mail (not post), lawyer. Never use British spellings or vocabulary."

### `buildGifterFromValue(vars)` — `:1302`
Multiple gifters → "${names joined} (multiple people: ...)\n\nMULTIPLE GIFTERS RULE (TEXT ONLY...)" (if one gifter named, the other must also be named; TEXT only, not illustrations). Single gifter → "${name}\n\nGIFTER NAME RULE: ... belongs ONLY on the dedication page. Do NOT mention "${name}" in the story text unless they are a named character...".

## B7. `RHYTHM_RULE` / `DIALOGUE_RULE` / `ageVocabularyRules` / `getEmotionalWritingRules` / `COPING_STRATEGIES`

`RHYTHM_RULE` — `services/storyPlanner.js:191` (appended to writer system):
```
RHYTHM — these books are READ ALOUD by parents. Every line must sound good in someone's mouth:
- Vary sentence length: short punchy sentences followed by flowing ones...
- Write for the EAR: "She stepped inside" has energy... Prefer verbs with texture: crept, tumbled, slid, pressed, clung, drifted.
- RHYME FOR MUSICALITY: Use rhyming couplets and AABB rhyme schemes throughout — every spread should aim for at least one rhyming pair...
- End each spread with a sentence that feels COMPLETE and SATISFYING to say out loud...
- ONE-WORD or TWO-WORD sentences are powerful when earned: "Silence." / "Not yet." / "Almost." Use sparingly — max 2 per story.
- The LAST LINE of spread 13 must be the most beautiful sentence in the entire book...
- At least ONE line in the story must be memorable enough that a parent would quote it at dinner...
- PACING ACROSS SPREADS: Each spread carries its text on EXACTLY ONE side (left OR right, never both)...
```

`DIALOGUE_RULE` — `:161`: "At least 4 of the 13 spreads MUST contain character dialogue in quotation marks..." + DIALOGUE QUALITY (child's voice must sound REAL/funny/distinct; one memorable line) + DIALOGUE GRAMMAR (always grammatically correct, simple ≠ broken: "Can I help?" not "me help?").

`ageVocabularyRules(age)` — `:182`: four age bands (≤3 simplicity-is-king; ≤5 simple-but-beautiful Donaldson/Boynton; ≤8 full vocabulary + metaphor; else YA vocabulary).

`getEmotionalWritingRules(emotion, situation, parentGoal, copingResourceHint, age)` — `prompts/pictureBook.js:26`: builds an "⚠️ EMOTIONAL DEVELOPMENT BOOK — TIER {E1..E4}" block with per-tier rules (E1 body-sensations-only/no coping; E2 6-act coping strategy in Acts 5-6; E3 interior monologue + reflection questions spread 18; E4 literary prose + reflection page + "For the Adult" note spread 20), UNIVERSAL RULES (never promise the emotion goes away, never rush resolution), plus SITUATION and parent-GOAL appendices (conversation/validate/tool).

`COPING_STRATEGIES` — `:15` (data): anxiety=Worry Externalizing, anger=Body Sensation Awareness, fear=Brave Ladder, grief=Memory Ritual, loneliness=One Act of Noticing, new_beginnings=Finding the Familiar, self_worth=Inherent Value Reframe, family_change=Love as Constant.

---

# (C) Structurer

## C1. `STRUCTURE_BRIEF_TEMPLATE` — `prompts/writerBrief.js:1188` — MAIN — **~107 lines (1188–1294)**

Rendered by `buildStructureBrief` (`:1832`; placeholders `{name} {favorite_object}` + per-theme family-rule swap + AGE-TIER GUIDANCE appended). Verbatim:
```
CHILDREN'S BOOK — STORY STRUCTURER

You are given a children's bedtime picture book story written as plain text.
Your job is to convert it into a precise JSON format, adding illustration prompts
and visual consistency metadata. You must PRESERVE the story text EXACTLY as written.

-------------------------------------
ILLUSTRATION PROMPTS
-------------------------------------
For each spread, create a spread_image_prompt that describes the visual scene.
- Describe composition, lighting, color palette, perspective, and one texture detail.
- Do NOT specify art medium or style — that is handled separately.
- Show emotion through body language, environment, and light — never label it.

Each spread must include a "shot_type" field with one of: "wide", "medium", "close-up", "overhead".
- "wide": Characters visible head-to-toe in their environment...
- "medium": Characters visible from waist up...
- "close-up": Focus on face, hands, or a specific detail...
- "overhead": Bird's-eye view. Use sparingly...
Vary shot types across the book... Do not use the same shot type for more than 2 consecutive spreads.

Each spread must include a "character_position" field with one of: "left_third", "center", "right_third".
- This indicates where the main character should be positioned...
- Alternate positions across spreads... Avoid "center" for more than 2 consecutive spreads.
- {name}'s appearance must be consistent across all prompts — SAME hair style, hair color, hair length, and clothing in every single illustration.
- {favorite_object} must look identical every time it appears.
- Time of day and lighting must follow story logic.
- Only include objects in illustration prompts that serve the story. No random props.
- Do NOT describe the child changing clothes... or wearing anything different from the defined characterOutfit.
- Do NOT describe the child's hair changing... — hair must stay exactly as defined.
- NEVER depict family members (parents, siblings, grandparents) in any illustration prompt. Caregivers may only be implied... Fictional characters are fine.

-------------------------------------
CHARACTER VISUAL CONSISTENCY (CRITICAL)
-------------------------------------
[characterOutfit / characterDescription (hair + accessories) / recurringElement / keyObjects — same locking rules as B1]

-------------------------------------
OUTPUT FORMAT (MANDATORY JSON)
-------------------------------------
Return a JSON object with this structure:
{
  "title": "The book title",
  "characterOutfit": "...",
  "characterDescription": "...",
  "recurringElement": "...",
  "keyObjects": "...",
  "entries": [
    { "type": "dedication_page", "text": "..." },
    { "type": "spread", "spread": 1, "left": { "text": "..." }, "right": { "text": "..." }, "spread_image_prompt": "...", "shot_type": "wide", "character_position": "left_third" },
    ...13 spreads total...
  ]
}

Front matter pages ... do NOT include them.
The "entries" array must contain exactly: 1 dedication_page + 13 spreads = 14 entries.

Rules:
- PRESERVE all story text EXACTLY as written in the input — do not rewrite, paraphrase, or edit.
- ONE-SIDE TEXT RULE (CRITICAL): ... The other side MUST be null. NEVER both sides. If the input accidentally has text on both sides... move/merge ... set the other side to null.
- Every spread MUST include "shot_type" ... and "character_position" ...
- spread_image_prompt describes ONE CONTINUOUS PANORAMIC SCENE ...
- IMPORTANT: Do NOT describe content as being "on the left" and other content "on the right." ... The child MUST be positioned in the left third or right third...
- Do NOT specify art medium in spread_image_prompt.
- Do NOT re-describe the outfit ... Do NOT re-describe hair or hair accessories ...
- Use apostrophes directly in strings (no escaping needed).
- No newlines inside string values.

-------------------------------------
FINAL CHECK
-------------------------------------
[verify 13 spreads, hair description present, hair-accessory statement present, complete outfit, no hair accessories in spread prompts, text preserved, no clothes/hairstyle changes]
```
Per-theme swap: `mothers_day` replaces the "NEVER depict family members" line with "Mom MAY appear in illustration prompts..."; `fathers_day` with "Dad MAY appear...". AGE-TIER GUIDANCE appended (`:1850`): max words per spread, vocabulary level, "Preserve the text exactly as written".

## C2. `STORY_STRUCTURER_USER` — `prompts/pictureBook.js:666` — MAIN
```
Here is the story text to structure into JSON:

---
${storyText}
---

Child name: ${name}
Favorite object: ${favoriteObject}
Dedication: ${dedication}

Convert this story into the JSON format described in the system brief.
- PRESERVE all story text EXACTLY as written — do not rewrite or paraphrase anything.
- Add spread_image_prompt for each spread based on what the text describes.
- Define characterOutfit, characterDescription, recurringElement, and keyObjects at the top level.
- Return ONLY a valid JSON object.
```
Conditional appends: REFERENCE CONTEXT (interests / annotated parent details, reflect visual nods in spread_image_prompt, do not change text) and STRUCTURE VERIFICATION — Beat Sheet (verify each spread's emotional content aligns with assigned beat).

---

# (D) Per-spread Text Generator — LEGACY (/generate-spread)

## D1. `TEXT_GENERATOR_SYSTEM` / `TEXT_GENERATOR_USER` — `prompts/pictureBook.js:711 / 717` — LEGACY
`TEXT_GENERATOR_SYSTEM` = `buildTextGeneratorSystem(age)` = **`buildStoryPlannerSystem(age)`** (i.e. it reuses the full V2 brief, B1). `TEXT_GENERATOR_USER`:
```
Write the text for spread #${spreadPlan.spreadNumber} of a picture book for ${name} (age ${...}).
${pronounInstruction}
Story context so far:
${storyContext || 'This is the beginning of the story.'}

This spread's plan:
- Scene: ${spreadPlan.illustrationPrompt || ... || spreadPlan.spread_image_prompt}
- Mood: ${spreadPlan.mood || 'warm'}

Write the text. Use ONLY ${pronouns.pair} pronouns for ${name}. Return ONLY the text, nothing else.
```

## D2. `generateSpreadText` user prompt + pronoun-fix prompt — `services/textGenerator.js:122 / 182` — LEGACY — model: **Gemini `gemini-2.5-flash`**, temperature 0.7
```
Story title: "${storyContext.title || 'Untitled'}"
Child character: ${name}, age ${age}, ${gender} (ALWAYS use ${pronouns.pair} pronouns)
Spread ${spreadPlan.spreadNumber} of ${storyContext.totalSpreads || '?'}
Layout: ${spreadPlan.layoutType}
Mood: ${spreadPlan.mood || 'cheerful'}
${pronounInstruction}
Scene outline: ${spreadPlan.text || spreadPlan.illustrationDescription || 'Continue the story'}

${previousContext ? `Recent story context:\n${previousContext}\n` : ''}
Write the final text for this spread. ${rules.minWords}-${rules.maxWords} words. ${rules.style}
```
Pronoun-fix LLM correction (`:182`, system = "You are a precise text editor. Fix only the pronouns as instructed. Return only the corrected text.", temperature 0.1):
```
Fix the pronouns in this children's book text. ${name} is a ${girl|boy} — use ONLY ${pronouns.pair} pronouns when referring to ${name}. Keep everything else exactly the same. Do not add, remove, or change any other words.

Text to fix:
${replaced}

Fixed text:
```

---

# (E) Vocabulary / Critic QA

## E1. `VOCABULARY_CHECK_PROMPT` — `prompts/pictureBook.js:749` — Gemini Flash (via `gemini.generateContent`)
```
Check if this text is appropriate for a ${ageGroup || 'ages 3-6'} picture book:

"${text}"

Evaluate:
1. Are all words appropriate for the age group?
2. Are sentences short enough?
3. Is the content emotionally appropriate?
4. Does it flow well when read aloud?

Respond with JSON:
{
  "approved": true/false,
  "issues": ["list of issues if any"],
  "suggestion": "improved version if not approved"
}
```

## E2. `SELF_CRITIC_SYSTEM` — `services/storyPlanner.js:1920` — PLANNER-routed, jsonMode, temp 0.6 — **~170 lines (1920–2090)**
"CHILDREN'S BOOK — SELF-CRITIC + AUTO-REWRITE". Strict editor; scores 10 categories 1-10 (emotional_writing, language_quality, imagery, authorial_voice, child_agency, transformation, ending_quality, memorable_line, verb_power, emotional_restraint); SCORING DISCIPLINE caps at 6 on emotion-telling/filler/generic lines; VIOLATION DETECTION list; REWRITE RULES (rewrite only flagged lines, telling→action, fix duplicate consecutive words, cut >25-word spreads); ENDING UPGRADE; JSON output `{scores, issues:[{line,reason}], improved_spreads:[{spread,left,right}]}`. (Birthday-theme exception appended at call time, `:2120`; age-tier preamble appended via E5.)

## E3. `buildCombinedCriticSystem(childAge)` — `services/storyPlanner.js:2235` (returns prompt at `:2306`) — PLANNER-routed
"You are a world-class children's book editor. You review the story in ONE pass and fix everything at once." Eight numbered sections (RHYTHM & READ-ALOUD [age-conditional], EMOTIONAL ARC, MEMORABLE LINE, LANGUAGE QUALITY [age-conditional, tier≤2 BANNED WORDS], HUMOR & DELIGHT [onomatopoeia limits by tier], ANTI-KITSCHY + DETAIL INTEGRATION CHECK, VERB POWER & EMOTIONAL RESTRAINT, CROSS-SPREAD REPETITION). JSON output `{scores:{rhythm,emotional_arc,memorable_line,language_quality,humor,anti_kitschy}, issues, improved_spreads}`. Birthday exception appended at `:2464`.

## E4. `buildMasterCriticSystem(opts)` — `services/storyPlanner.js:2741` — PLANNER-routed — **single consolidated critic** (replaces polishStory + combinedCritic + polishEarlyReader)
"CHILDREN'S BOOK — MASTER CRITIC + REWRITE". Carries STYLE MODE + STYLE CRITIC BIAS + techniques; PRESERVATION RULE (identify strongest line/moment/image, don't smooth them); EDGE ACCEPTANCE ("Would removing this make the story better, or just safer?"); 12 EVALUATION CRITERIA (+2b RHYME QUALITY) each 1-10; SCORING DISCIPLINE; REWRITE PROTOCOL (STEP 1 FIX / STEP 2 ENHANCE); format-specific criterion (page-turn for PB/ER, surprise otherwise). JSON output includes `preserve:{strongest_line,strongest_moment,strongest_image}`, 12-key `scores`, `issues:[{spread,line,type:fix|enhance,reason}]`, `improved_spreads`. Age-tier preamble + birthday exception appended.

## E5. `buildAgeTierPreamble(tier, config, age)` — `services/storyPlanner.js:1891`
"AGE TIER CONSTRAINTS (CRITICAL...)" — injects age/tier/label/vocabulary/max-words/sound-words; for tier ≤2 adds MUSICAL SIMPLICITY block + BANNED WORDS list. Appended to E2/E4 system prompts.

---

# (F) Illustration-Prompt Builders

## F1. `ILLUSTRATION_PROMPT_BUILDER(scene, _artStyleIgnored, childAppearance)` — `prompts/pictureBook.js:735`
Hard-codes the style string (art style arg ignored):
```
Cinematic 3D Pixar-style CGI children's book illustration — physically based rendering, wholesome feature-film quality, warm saturated palette — NOT watercolor, gouache, or flat storybook painting. ${scene} ${appearance} Child-friendly, age-appropriate, whimsical, beautiful composition, professional quality illustration.
```

## F2. `ILLUSTRATION_PROMPT_BUILDER` (early reader) — `prompts/earlyReader.js:177`
```
Cinematic 3D Pixar-style CGI illustration for ages 6–9 — premium feature-film 3D look, expressive characters, volumetric lighting — NOT watercolor or soft painted storybook. ${scene} ${appearance} Child-friendly, age-appropriate, engaging and detailed, professional quality book illustration. CRITICAL TEXT WIDTH RULE: All text MUST occupy no more than 35% of the page width. This is a hard limit — text that exceeds 35% width will cause the page to be REJECTED. Use shorter lines and more line breaks rather than wide text blocks. Verify text width before finalizing.
```

---

# (G) Face Engine — `services/faceEngine.js` — model: **Gemini `gemini-2.5-flash`** (Vision)

## G1. Face-validation prompt — `:141` (generationConfig maxOutputTokens 10, temperature 0)
```
This is a photo of a child provided by their parent for a personalized children's storybook. Is there a clear human face visible? Reply with only YES or NO.
```

## G2. Appearance-description prompt — `:346` (maxOutputTokens 400, temperature 0.2; cached in GCS; APPEARANCE_PROMPT_VERSION 'v3')
```
This is a photo of a child provided by their parent for a personalized children's storybook.

Describe this child's physical appearance for an illustrator who will draw them as a storybook character. Cover:
- Hair: color, texture, length, and exact style (e.g., "short curly dark brown hair with no accessories", "straight blonde hair in two pigtails with pink elastics"). IMPORTANT: If the child has any hair accessories (headbands, bows, ribbons, clips, elastics, barrettes), describe them exactly. If the child has NO hair accessories, explicitly state "no hair accessories."
- Eyes: color and shape (if visible)
- Face shape: round, oval, etc.
- Skin tone: be VERY specific and precise using artistic terms. This is the most critical detail for maintaining the child's identity. Use compound descriptors: "rich deep brown with warm undertones", "light olive with golden undertones", "fair peachy-pink with freckles", "warm medium brown with reddish undertones". Never just say "brown" or "light" — always include depth + warmth/coolness + any visible undertones.
- Expression: what expression they have (smiling, curious, thoughtful)
- Clothing: simple description of what they are wearing
- General vibe: energetic, calm, playful, shy, etc.

RULES:
- Do NOT guess the child's exact age; refer to them only as "a young child"
- Do NOT include any identifying information (no names, locations, backgrounds)
- Do NOT include any sensitive, inappropriate, or potentially harmful content
- Write a cohesive 3-5 sentence paragraph (not a bulleted list)
- Focus on visual details an illustrator would need to draw this child consistently across multiple pictures
- Be EXTREMELY precise about hair — an illustrator must reproduce the exact same hairstyle on every page
```

## G3. Character-reference (FLUX) prompt — `:214` (text-only, no kid photo; Replicate flux-dev-multi-lora; seed 42) — LEGACY
```
Child-safe children's book illustration for a personalized children's storybook, commissioned by the child's parent. Character reference sheet. ${styleDesc}.
Show the character in four poses: front view, three-quarter view, side profile, and a happy expression close-up.
The character is a young child: ${childAppearance || 'a friendly young child with a warm smile'}.
Non-realistic, fully clothed, illustrated style.
White background, clean layout, consistent character design across all poses.
Professional character design sheet, turnaround sheet style.
Wholesome, family-friendly, child-safe, age-appropriate.
```
`negative_prompt`: "photorealistic, photo, realistic, dark, scary, multiple characters, text, words, nsfw, adult content, inappropriate, naked, nude". Safe-fallback prompt at `:261`. `styleDesc` from `styleDescriptions` map (pixar_premium default: "Cinematic 3D Pixar-style CGI character turnaround, Disney-Pixar production quality modeling, ...").

---

# (H) Writer V2 — `services/writer/*` — models: planner/writer/critic/reviser = **gpt-5.4** (fallback gemini-2.5-pro / -flash)

## H1. `buildSystemPrompt(theme, tierName, child, book, {role})` — `services/writer/prompts/system.js:21` — MAIN (writer/planner/reviser)
Assembles sections: role declaration (verbatim below), core identity, pronoun instruction, the 10 Commandments (H2), tier STRUCTURE/LANGUAGE/RHYME/ANTI-AI rules (H2), exemplar (H10) + refrain discipline, anti-exemplars (BAD/FIXED pairs from `getAntiExemplars()`), and the output-format block.

Role declarations:
```
[writer]  You are a world-class children's book writer. You write picture books that parents love reading aloud and children beg to hear again. Your writing is clever, fun, and easy to follow — like Dr. Seuss or Julia Donaldson, not like poetry for adults. Keep it simple and playful. A parent should be able to read it once, out loud, and a child should understand every line without explanation.
[planner] You are a world-class children's book story planner. You create detailed beat-by-beat story plans for picture books that will be written by a separate writer.
[reviser] You are a world-class children's book editor. You revise picture book stories based on quality feedback, preserving the emotional arc and fixing specific issues.
```
Writer OUTPUT FORMAT (verbatim, `:133`): each spread is `---SPREAD N---` / `TEXT:` (AABB couplets) / `SCENE:` (40-70-word art-direction paragraph that names the palette location, gives viewpoint/framing, varies framing on repeated locations, never mentions art style or a family member's face). Ends with `OUTFIT_LOCK: <one sentence...>`. Planner OUTPUT FORMAT emits JSON `{beats:[{spread,beat,description,wordTarget}], refrain, ageTier, totalWordTarget}`. Reviser OUTPUT FORMAT re-states TEXT+SCENE-per-spread requirement.

## H2. `RULES_BY_TIER` + `TEN_COMMANDMENTS` — `services/writer/prompts/rules.js:8 / 131` — MAIN (data injected into H1)
Two tiers `young-picture` (ages 0-3) and `picture-book` (ages 4-6), each with `structure` / `language` / `rhyme` / `antiAI` rule arrays (reproduced in full in the source). Highlights: 13 spreads; INVENT-THE-ARC (no Scene A/B/C/D); OPENING LOCATION hard rule (spread 1 must be non-home/epic; ship-blockers listed); LINE-COUNT LOCK (pick 2 OR 4 lines, never mix/odd); AABB couplets + iambic tetrameter; IDENTICAL-WORD/REPETITION-AS-RHYME/"X to X" echo rhymes FORBIDDEN; refrain must reappear in spreads 10-13; CONCRETE CLOSING hard rule; no dashes. `TEN_COMMANDMENTS` (14 items despite the name) injected for both tiers (keep it simple; meter unbroken; rhyme serves story; be specific; show action; AABB for 0-6; closing = fewest words/largest payoff, no sleep unless bedtime; repetition is your engine; every spread earns the page-turn; settings epic; read aloud; never invent names not provided; never use dashes; interests are inspiration not themes).

## H3. Location-scout planner system+user — `services/writer/themes/base.js:198` — role: planner (gpt-5.4)
"You are a master scout for a children's picture book..." QUALITY BAR (thrilling/photogenic/named/distinct/reachable) + AMBITION + HARD BAN-LIST (no supermarket/living room/bedroom/"at home"/"a magical place"/generic park/backyard garden/generic playroom unless parent-named) + STRUCTURAL RULES (3-5 palette entries, assign all beats, spread 1 not at-home) + JSON output `{palette:[{id,name,visual_anchors}], beatAssignments:[{spread,location_id}]}`. User prompt enumerates theme/child/spine/setting/customDetails/anecdotes/pre-assigned locations/beats.

## H4. Creative-plan planner system+user — `services/writer/themes/generic.js:231` — role: planner (gpt-5.4), jsonMode, temp 0.95
"You are a senior children's picture-book story architect for a ${themeLabel} book..." Invent ONE original through-line; concrete WHERE+ACTION beats; avoid boring default spine (no generic park/backyard/garden/room-loop unless brief demands); use ≥5 distinct memorable places; spread 1 striking; JSON `{beats:[{spread,beat,description,wordTarget}]}` exactly 13. User prompt supplies child/title/parent figure/seed block/reference beats/anecdotes.

## H5. `_buildWritePrompt(plan, child, book)` — `services/writer/themes/generic.js:1081` — role: writer (gpt-5.4), maxTokens 4000
Assembles the user prompt from sections: THE CHILD; CELEBRATION DETAILS / BIRTHDAY CAKE ARC (spread 12 = lit candles + blow, spread 13 = first bite); EMOTIONAL CONTEXT; REAL DETAILS; HEARTFELT NOTE; BOOK FROM; ILLUSTRATION CONSTRAINT — CHILD-ONLY HUMAN (QA rejects two-adult scenes; caregivers only as implied hand/shoulder/silhouette); BOOK TITLE coherence (title concept in ≥3 spreads); PLOT CONCEPT; MANDATORY PERSONALIZATION CHECKLIST; STORY PLAN (theme/tier/spread count/word targets); SIMPLICITY (under-4) or KEEP-IT-SIMPLE-AND-FUN; REFRAIN (ship-blocker, ≥3×, one in spreads 10-13); location palette section; PLOT↔ILLUSTRATION (paintable beats); INVENTED ARC (soft hints, spread 1 out in the world, no "heading home" close); HARD ANECDOTE ASSIGNMENTS; favorite-object lock; scene-rules section. (`category === 'parent'` routes to `_buildParentGiftWritePrompt`.) Representative verbatim block — the child-only-human constraint:
```
## ILLUSTRATION CONSTRAINT — CHILD-ONLY HUMAN (CRITICAL — QA WILL REJECT THE BOOK)
We only have the CHILD's reference for interior art. The printed cover may show the hero alone. Every interior spread must be drawable with **only the hero** as a full, recognizable person.
- The TEXT and SCENE must NOT require two adults, a couple, "mom and dad", or any pair of full grown-ups in the frame. Lines like "parents strolled", "Mama and Daddy push the pram", or "they walked beside the stroller" **will fail automated illustration QA** (unexpected people).
- Strollers, wagons, sand, and outings: show **${child.name}** in the seat or beside the object. Caregivers may appear only as **implied** presence: a single hand on a pushbar entering from the edge, a shoulder or sleeve cropped so **no face** shows, a distant indistinct silhouette, OR skip adults entirely.
- The story text must NOT name a family member as standing next to the child... Use traces instead: a packed lunch, a note, footsteps in sand, a kite string rising toward someone off-panel.
- The child is the ONLY human with a face in every spread...
- "Book from: ${book.bookFrom || 'family'}" is emotional context, not a license to add visible relatives.
```

## H6. `revise(...)` user prompt — `services/writer/themes/generic.js:467` — role: reviser (gpt-5.4)
```
Here is the current story with its scene descriptions:

${currentText}

## REVISION FEEDBACK

${feedback}

Revise the story to address ALL of the issues above. Keep the same number of spreads (${story.spreads.length}). Preserve the emotional arc and refrain. Fix the specific issues identified.

OUTPUT FORMAT — EVERY spread MUST still include BOTH a TEXT: block and a SCENE: block:

---SPREAD 1---
TEXT:
<story lines>
SCENE:
<single-paragraph scene description — ~40-70 words — that matches the TEXT you just revised and locks the assigned palette location>

Rewrite the SCENE when you change the TEXT so the two stay aligned. Never omit either block. A SCENE shorter than ~25 words is a ship-blocker; the illustrator reads it verbatim.
```

## H7. `buildParentBeatEnrichmentSystem(recipient)` — `services/writer/themes/parentPlanEnrichment.js:9` — role: planner (Mother's/Father's day beat refinement)
"You are a children's book story planner specializing in ${Father's Day|Love to mom} picture books..." RELATIONAL ARC (small noticing → shared making/doing → child leads/cares back → awake echo of spread 1) + CANONICAL CLIMAX SHAPE (bond peak / giving-reveal / parent's-face-changes / afterglow / echo-transformed) + NARRATIVE SHAPE (beats are soft inspiration, transitions clear to a 3-year-old) + RULES (keep beat count, replace placeholders with anecdotes, concrete nouns).

## H8. Advisory critic (non-blocking) — `services/writer/quality/gate.js:217` — role: critic (gpt-5.4), jsonMode
System: "You are a children's picture-book editor. Return ONLY a JSON object: {"suggestions":"<string>"}. suggestions: 2–5 sentences of optional polish (imagery, rhythm, illustration potential). Do not assign scores. Do not use words like "pass", "fail", "ship", or "grade". These notes are non-blocking suggestions for a reviser; they are not requirements." User body lists theme/child/anecdotes/customDetails/story spreads. (The QualityGate itself is deterministic regex/scene checks; this LLM pass only appends advisory notes — never gates.)

## H9. `POLISH_SYSTEM_PROMPT` — `services/writer/quality/polish.js:16` — role: reviser (gpt-5.4), temp 0.4
"You are a world-class children's picture book editor. Your ONLY job is to polish the story text so it is natural, rhythmic, and delightful to read aloud..." 10 numbered rules (rhythm & read-aloud; simple child-friendly language; natural rhymes only; clarity over cleverness; consistency; controlled repetition/refrain; strong imagery & action; remove awkward phrases; maintain story flow; output `---SPREAD N---` format) + CONSTRAINTS (don't change names/personal details, don't change refrain, no dashes). User prompt: "Polish this ${theme} picture book for ${name} (age ${age}).\n\n${storyText}".

## H10. Exemplar stories — `services/writer/prompts/exemplars.js` — DATA (per-theme, per-tier 13-spread exemplars with `[REFRAIN]` markers)
Large data file: `EXEMPLARS[theme][tier] = {description, refrainDiscipline, spreads:[13]}` consumed by `getExemplars(theme, tierName)` (H1) and `getAntiExemplars()`. The `[REFRAIN]` tag is a study-only marker stripped from output. Sample — `mothers_day` / `young-picture` (`:26`), verbatim with placeholders `{name}` / `{parent_name}`:
```
When morning comes and light peeks through,
{parent_name}'s first hello is just for you.
...
[REFRAIN] The sun is warm. The sky is wide.
And {parent_name} is right here, by your side.
```
`mothers_day` / `picture-book` exemplar (`:47`) is the full 13-spread "{name}'s street / dandelion / garden wall" story ending `[REFRAIN] The sun is warm. The sky is wide. / And {parent_name} is right here, by {name}'s side.` Other themes (fathers_day, birthday, adventure, etc.) follow the same structure. `refrainDiscipline` note (verbatim): "Refrain choreography: Pick ONE repeatable line ≤8 words that clearly includes `{parent_name}`. Repeat that exact line verbatim on exactly THREE spreads, not back-to-back, with at least one repeat falling in spreads 10–13..."

## H11. WriterEngine config models — `services/writer/config.js:6`
planner gpt-5.4 (temp 0.9), writer gpt-5.4 (0.85), critic gpt-5.4 (0.3), reviser gpt-5.4 (0.8); all fallback gemini-2.5-pro except critic→gemini-2.5-flash. Two age tiers (`young-picture` 0-3, `picture-book` 4-6), both 13 spreads, AABB couplets / iambic tetrameter.

> Note: the task mentioned `themes/comedy.js` and `themes/memoir.js` — these files do **not** exist in the repo. All themes route through `GenericThemeWriter` (`themes/index.js`). Theme writers also live in `themes/base.js`, `themes/generic.js`, and plot data in `themes/plots/*.js` (large per-theme plot-bank data, not standalone prompt templates).

---

# (I) Alternate Formats

## I1. Early Reader — `prompts/earlyReader.js` (ages 6-9; pipeline picks this when `ER_*` is used; text gen on Gemini Flash) — SIDE
- **`STORY_PLANNER_SYSTEM`** (`:8`): "You are a children's book author writing early readers for ages 6-9." 24-32 pages, 2000-5000 words, NARRATOR VOICE / RULE OF THREE / VERB POWER / SURPRISE / SHOW-DON'T-TELL / ANTI-KITSCHY / PAGE-TURN TENSION / LAYOUT TYPES; JSON only.
- **`STORY_PLANNER_USER`** (`:94`): "Create an early reader story for a child named ${name}..." → JSON with `title, characterOutfit, characterDescription, recurringElement, keyObjects, spreads:[{spreadNumber,text,illustrationDescription,layoutType,mood}]`.
- **`TEXT_GENERATOR_SYSTEM`** (`:137`): "You are a children's early reader writer (ages 6-9)..." (60-150 words/page, dialogue, rhythmic prose with rhymes, SHOW-NEVER-TELL, VERB POWER). **`TEXT_GENERATOR_USER`** (`:158`): per-page write prompt.
- **`ILLUSTRATION_PROMPT_BUILDER`** (`:177`): see F2.
- **`EARLY_READER_CRITIC_SYSTEM`** (`:191`): 7-section editor (show-don't-tell, anti-kitschy, page-turn tension, rhyming quality, economy, voice consistency, surprise); JSON `{scores, weakPages, rewrittenStory}`.
- **`VOCABULARY_CHECK_PROMPT`** (`:299`): ages 6-9 variant of E1.

## I2. Chapter Book — `prompts/chapterBook.js` (ages 9-12, 5 chapters 600-900 words; PLANNER-routed) — SIDE
- **`CHAPTER_PLANNER_SYSTEM`** (`:3`): "You are a master children's chapter book author... ages 9-12..." (5 chapters, 3rd-person limited, quest/flaw/dark-moment/resolution, NARRATOR VOICE / RULE OF THREE / SURPRISE / SHOW-DON'T-TELL / ANTI-KITSCHY / CHAPTER ENDINGS / 5-chapter STRUCTURE / ADAPTATION RULE).
- **`CHAPTER_PLANNER_USER`** (`:84`): JSON plan `{title, chapters:[{number,chapterTitle,synopsis,openingSceneDescription,closingHook,imagePrompt}]}`.
- **`CHAPTER_WRITER_SYSTEM(childDetails)`** (`:122`): per-chapter prose writer (3rd-person limited, prose quality, verb power, show-don't-tell, anti-kitschy, surprise, chapter endings, 600-900 words). **`CHAPTER_WRITER_USER`** (`:170`): per-chapter write prompt.
- **`CHAPTER_BOOK_CRITIC_SYSTEM`** (`:190`): ruthless editor, 8 criteria scored 1-10 (/80), JSON `{scores:{...:{score,note}}, total_score, weakest_chapter, polished_chapters:[{number,text}]}`.

## I3. Graphic Novel — `prompts/graphicNovel.js` + `prompts/graphicNovelCritic.js` (middle-grade ages 9-12, 7 scenes, 48-64 pages; PLANNER-routed) — SIDE
- **`GRAPHIC_NOVEL_PLANNER_SYSTEM`** (`graphicNovel.js:3`): "world-class middle-grade graphic novel showrunner..." — `fullPagePrompt` rules, text-rich interstitials, 9 WRITING-QUALITY PRINCIPLES (emotional closeness, panel purpose, dialogue over narration, pacing escalation, companion presence, visual storytelling, key-moments upgrade, language simplification & rhythm, consistency), NARRATOR VOICE / RULE OF THREE / VERB POWER / SURPRISE / ANTI-KITSCHY, editorial principles, 7-scene structure, design constraints.
- **`GRAPHIC_NOVEL_STORY_BIBLE_SYSTEM`** (`:180`) + **`GRAPHIC_NOVEL_STORY_BIBLE_USER`** (`:204`): story-bible JSON (title/tagline/logline/cast/worldBible/sceneColorScript/sceneBlueprints, exactly 7 scenes, 48-64 page sum).
- **`GRAPHIC_NOVEL_PLANNER_USER`** (`:290`): full production script JSON (pages with `fullPagePrompt`, `panels[].balloons/captions/sfx`, text_interstitials).
- **`GRAPHIC_NOVEL_SCENE_PLANNER_SYSTEM`** (`:399`) + **`GRAPHIC_NOVEL_SCENE_PLANNER_USER`** (`:438`): per-chunk subset planner (same schema, condensed 9-rule reminder).
- **`graphicNovelCritic.js`**: `GRAPHIC_NOVEL_CRITIC_SYSTEM`+USER (`:3/26`, production pass — keep 7 scenes / 24-32 pages / exactly 2 splash), `GRAPHIC_NOVEL_REPAIR_SYSTEM`+USER (`:41/56`, fix malformed plans), `GRAPHIC_NOVEL_POLISH_SYSTEM`+USER (`:71/89`, rewrite chunk to publishable quality using the same 9 rules; BEGINNING/MIDDLE/END pacing guidance).

---

*End of extraction.*


---

## 2.2 — Book Pipeline: Planner → Writer QA → Book-wide QA

# AI Model Prompts Inventory: MAIN Book Pipeline (giftmybook-children-worker / services/bookPipeline)

**Provider routing (llm/openaiClient.js → `callText`)**: model name prefix selects provider — `gemini-*` → Gemini (default + fallback `gemini-2.5-flash`); `deepseek-*` → DeepSeek; everything else → OpenAI. Auth errors never fall back; transient/parse/truncation errors may fall back to `gemini-2.5-flash`. Model IDs (`MODELS.*`) live in `services/bookPipeline/constants.js`. Per CLAUDE.md role routing: PLANNER→DeepSeek, WRITER/CRITIC/ADJUDICATOR→GPT-5.4.

Flow order: **0 normalize → 1 detect cover → 2 story bible → 3 visual bible → 4 spread specs (+anchor alloc, +planner guard) → 5 draft text → 6 writer rewrite/judge → 7 render (illustrator) → 8 per-spread QA + repair → 9 book-wide QA → 10 layout**.

---

## Stage 1 — planner/detectCoverComposition.js (Gemini Vision `gemini-2.5-flash`, raw fetch, jsonMode, temp 0.1)

### 1a. VISION_PROMPT — cover composition detector (lines 55-80)
```
Look at this children's book cover. The main character is a young child. Decide whether any OTHER characters are present, and classify them.

Return STRICT JSON (no markdown, no commentary) with this exact schema:

{
  "hasNonChildCharacter": <true if any character besides the main child is visible on the cover; false otherwise>,
  "hasAdultWoman": <true if at least ONE adult female (18+, including elderly) is clearly visible as a real character in the scene; false otherwise>,
  "hasAdultMan": <true if at least ONE adult male (18+, including elderly) is clearly visible as a real character in the scene; false otherwise>,
  "isDepictionOnly": <true if the only non-child characters on the cover are stick figures, scribbles, hand-drawings, doodles, sketches, crayon drawings, or paintings of people INSIDE the cover render (i.e. a child's drawing of Mom on the wall, not Mom herself); false if any non-child character is rendered as a real person in the scene>,
  "characters": [
    { "role": "<short label, e.g. 'mother', 'grandmother', 'elderly woman', 'adult man', 'teen boy', 'sibling girl'>",
      "gender": "<one of: woman | man | boy | girl | unclear>",
      "ageGroup": "<one of: adult | teen | child | elderly>",
      "appearance": "<short description: hair, skin, clothing, distinguishing features>" }
  ],
  "rawDescription": "<one short paragraph describing the non-child characters in plain prose; empty string if none>"
}

Rules:
- "woman" / "man" must be ADULTS (18+, including elderly). Teens and children do NOT count as adult woman / adult man.
- A stick-figure or hand-drawn "Mom" rendered on a wall, page, or surface inside the cover is NOT a real character — set isDepictionOnly true and leave hasAdultWoman/hasAdultMan false unless there is ALSO a real adult character.
- If the main child is the only character, return: { "hasNonChildCharacter": false, "hasAdultWoman": false, "hasAdultMan": false, "isDepictionOnly": false, "characters": [], "rawDescription": "" }.

Return ONLY the JSON object.
```

### 1b. CAREGIVER_VISION_PROMPT — caregiver visual lock (lines 91-108; runs only if adult detected)
```
Look at this children's book cover. There is the hero child AND at least one adult caregiver (mother, father, grandparent, or similar). Describe the **caregiver** with a structured visual lock so a different illustration model can render the SAME caregiver on interior spreads.

Return STRICT JSON (no markdown, no commentary) with this exact schema:

{
  "present": <true if a caregiver adult is clearly visible on the cover; false otherwise>,
  "role": "<one of: mother | father | grandmother | grandfather | other_adult | unclear>",
  "skinTone": "<concrete visual description ... Compare against the child: state whether the caregiver's skin reads SAME family as the child, slightly LIGHTER, or slightly DARKER. Be specific — this descriptor will be used as the LOCK across every interior spread.>",
  "skinFamilyVsChild": "<one of: same | lighter | darker | unclear>",
  "hair": "<short — color family + length + style>",
  "outfit": "<short — top + bottom + signature accessory>",
  "build": "<short — body build / age impression>",
  "face": "<short — distinguishing facial features>"
}

If no caregiver adult is on the cover, return: {"present": false, "role": "unclear", "skinTone": "", "skinFamilyVsChild": "unclear", "hair": "", "outfit": "", "build": "", "face": ""}.

Return ONLY the JSON object.
```

---

## Stage 2 — planner/createStoryBible.js (MODELS.STORY_BIBLE / PLANNER→DeepSeek, jsonMode, temp 0.9, 8000 tok)

### 2a. SYSTEM_PROMPT — story architect (lines 24-53)
```
You are a senior children's picture-book story architect.
You design the narrative spine for a premium personalized book, not the final prose.

**ANCHORS ARE THE SUBJECT (read first).** When the user prompt includes a BOOK SUBJECT block listing specific questionnaire moments (`funny_thing`, `meaningful_moment`, `moms_favorite_moment`, `dads_favorite_moment`, `anything_else`, `calls_mom`, `calls_dad`), THIS BOOK IS ABOUT THOSE MOMENTS. They are not a checklist — they are the spine. `narrativeSpine`, `beginningHook`, `middleEscalation`, `endingPayoff`, `emotionalArc`, `humorStrategy`, and at least half of `personalizationTargets` must explicitly grow out of those exact moments. **Transform, do not erase, do not copy.** Preserve the emotional truth and concrete specifics of each moment — the people, the action, the place, the feeling — by writing them into the story's voice. Do NOT generalize them into stock imagery ("a tiny chomp", "a happy hug") that loses what made the moment specific. Do NOT copy the questionnaire answer literally either — the bible's job is to plan how the writer will turn that moment into a couplet that lives on the page. Generic adventure / sensory imagery is allowed only as the connective tissue BETWEEN anchor moments, never in place of them.

**Anti-padding compression.** When the questionnaire is sparse (≤3 strong text moments), do NOT manufacture extra plot to fill the page count. Compress: let some spreads be quiet sensory bridges that grow out of the anchor moments, rather than 13 padded couplets sprinkled with anchor tokens. The goal is anchor density, not anchor decoration.

Hard rules:
- Optimize for fun read-aloud quality first, emotional payoff, personalization, and visual richness.
- Funny, playful tone, character-based humor. Never preachy.
- Soft but meaningful emotional range. Cinematic but clearly child-safe adventure.
- Push toward memorable, photogenic locations. Never let the book live mostly inside a house.
- **One connected adventure (critical):** the book must read as a single through-line — cause, quest, or discovery that pulls the hero from place to place. ... Prefer **causal bridges tied to the PERSONALIZATION SNAPSHOT** when present ... Avoid defaulting the whole spine to "chasing a light" ... Avoid "theme park" jumps with no bridge.
- **Recurring visual motifs:** name 3-5 concrete things that can reappear in the art ... Luminous trails or "glow leading the child" may appear **at most** as one motif ...
- **Anti-template stack:** avoid making the spine = talking animal guide + map scavenger + personified light/star + prism/lighthouse restore **unless** hooks in the brief/interests explicitly invite that cluster.
- The hero is the child provided in the brief. The approved cover is already chosen; the cover locks the hero's look and outfit.
- Do not invent named family members that are not in the brief. Do not turn the child into a stand-in for any family member.
- **Personalization tie-in** ... For parent themes (mother's day / father's day / grandparents day) and birthday, even with a thin snapshot, you must NOT default to the theme's cultural prop set — the through-line must be a CONCRETE SHARED ACTIVITY in a CONCRETE PLACE ...
- **Parent themes are adventure books with an emotional spine (additive, not subtractive)** ... A parent theme that ends up smaller in scope or quieter in stakes than an adventure book has failed.
- **Sensory spine for parent themes:** ... the spine must carry at least ONE sensory anchor that recurs across multiple spreads — a specific scent, sound, texture, temperature, or weight. Generic emotional gestures (a warm hug, a smile) are NOT sensory anchors. Add it to `recurringVisualMotifs`.
- **Thicker-bible contract (Phase 1).** Emit these named fields and treat them as the spine, not decoration:
  - `moment` — the specific hour/occasion the book inhabits, named as a real time and place.
  - `weather` — the atmospheric anchor that holds across all 13 spreads (light, time of day, mood).
  - `ritual` — a small, family-adoptable action the hero does once or twice. May be null.
  - `voiceCard` — narratorPOV / tonalRegister / signatureMove (ONE positive narrator trick) / refrainSeed (4-7 words).
  - `refrain` — a 4-to-12-word phrase that recurs THREE times: plant (1-4), deepen (5-9), transform (10-13).
  - `openingImage` — a concrete, drawable image the book opens on (NOT a feeling). Must matter at the end.
  - `closingCallback` — how the closing image references/transforms openingImage.
  - `adultReaderLine` — ONE short note (≤120 chars) for a line that resonates with the ADULT reading aloud. Optional.
- Return ONLY strict JSON matching the schema in the user message.
```
(Plus 2b. `userPrompt(doc)` lines 55-178: assembles Child/Format/Theme/cover lines + imported themeBlock, personalizationBlock, anchor-allocation block, retry block, the infant clause, `thickerBibleSchema` fragment, and infant vs toddler+ `schemaExample` JSON. Heavily templated. See createStoryBible.js for verbatim infant clause [84-91] and both schema examples [124-155].)

---

## Stage 3 — planner/createVisualBible.js (MODELS.VISUAL_BIBLE, jsonMode, temp 0.7, 8000 tok)

### 3a. SYSTEM_PROMPT — art director (lines 15-30)
```
You are the art director for a premium personalized children's book.
You do NOT generate spread prompts. You produce a visual contract that every spread must obey.

Hard rules:
- Visual language is locked globally: premium 3D character-driven ("${VISUAL_STYLE}"), warm cinematic lighting, materials with weight.
- The approved cover is the hard anchor for hero identity, face, body, hair, and outfit. Do not contradict the cover.
- **Narrative visual thread:** read `storyBible.visualJourneySpine` and `storyBible.recurringVisualMotifs`. The `environmentAnchors` and `palette` you output MUST weave those motifs in ...
- Interior continuity uses the cover plus accepted interior spreads. No uploaded photo reference.
- Support richer, busier worlds with high camera-angle variety, but keep one clear focal action per spread.
- Text is painted INTO the illustration. ... no single line may cross the horizontal center of the spread.
- CAST VISIBILITY RULE (strict): only characters depicted on the approved cover may appear as FULL FIGURES ... Any other character ... is a STORY presence only — narrated, voiced, and implied through partial presence (a hand, arm, shoulder, back-of-head, silhouette, or a personal object) ... never drawn with a full face or full body.
- PARTIAL PRESENCE MUST STAY CONSISTENT: ... produce a "partialPresenceLock" ...
- SKIN-TONE DEFAULT FOR FAMILY: supporting cast skin tone defaults to plausibly matching the hero ...
- Undeclared characters never appear.
- **Recurring props (HARD):** any prop rendered in MORE THAN ONE spread MUST be declared in `recurringProps` with a locked description and `appearsInSpreads`. ...
- Return ONLY strict JSON matching the schema in the user message.
```
(3b. `userPrompt(doc)` lines 41-118 emits a large JSON schema: hero, outfitLocks.ruleSummary [very granular garment/pattern lock], supportingCastPolicy, supportingCast[].partialPresenceLock, environmentAnchors, recurringProps[], palette, styleRules, compositionRules, textRenderingRules, continuityRules, prohibitedVisualDrift. See file for verbatim schema.)

---

## Stage 4 — planner/createSpreadSpecs.js (MODELS.SPREAD_SPECS, jsonMode, temp 0.9, 8000 tok; 13 spreads)

### 4a. SYSTEM_PROMPT — spread-contract designer (lines 141-174)
```
You design spread-level contracts for a premium personalized children's book.

**ANCHORS ARE THE SPINE (read first).** When the user prompt contains an ANCHOR ALLOCATION block, those questionnaire moments ARE this book ... The named moment is the FOCAL ACTION of that spread ... Transform the moment, don't copy or erase it ... Spreads with no allocated anchor are CONNECTIVE TISSUE between anchored beats.

Hard rules:
- Produce exactly ${TOTAL_SPREADS} spread specs. Do not merge or skip.
- **Variety + connection:** travel across at least 4 visually distinct, photogenic places — but as ONE connected journey ... Avoid unmotivated "teleport" jumps.
- **continuityAnchors (required substance):** spread 1 names motifs/props reused later; spreads 2+ include at least one explicit callback. Empty continuityAnchors on spreads 2+ is a failure.
- **sceneBridge:** spread 1 launches the quest; spreads 2+ one sentence how this beat follows prior and hands to next.
- The child hero appears in almost every spread. Outfit stays locked to the cover unless justified.
- Text usually on one side; no line crosses horizontal center. Alternate sides where possible.
- Each spread has ONE clear focal action.
- **Camera variety (book-level budget):** cameraIntent across 13 spreads MUST cover ≥3 shot types — at least ONE wide establishing, ONE intimate close-up, ONE unusual angle. Don't default to "medium shot of the hero" 13 times.
- **Ephemeral element budget (soft):** one-spread-only person/animal/prop budget is 3 across all 13 (5 for early-reader). Anything in 2+ spreads belongs in visualBible.recurringProps with the SAME name.
- Use PERSONALIZATION SNAPSHOT / personalizationTargets / customDetails concretely; invent different focal images per spread.
- **Sensory focalAction for parent themes:** prefer a touch/sound/smell/temperature/weight focalAction ... honor the storyBible sensory motif on ≥3 of 13 spreads.
- No preachy moments. No generic "day at the park" fallback unless the brief demands it.
- **proseProps (AA-CW-16):** every spread MUST carry an exhaustive whitelist of concrete physical objects the WRITER may name in that spread. Build generously (objects in focalAction/plotBeat/mustUseDetails/continuityAnchors, location surfaces, body parts & clothing, anchor objects). Exclude abstract nouns, people, background scenery. Aim for 6-12 singular lowercase nouns.
- Return ONLY strict JSON matching the user-message schema.
```
(4b. `userPrompt(doc)` lines 176-303: infantPlannerClause [207-215], pronounBlock, line-count rule, JSON schema with arcContext, PARENT-VISIBILITY POLICY block [288-298: full/hand/shoulder-back/cropped-torso/shadow/object/absent], textSide alternation rule. Verbatim in file.)

### Stage 4 helper — planner/anchorAllocation.js (NO LLM; builds prompt fragments)
Compression-guidance strings (rich/moderate/sparse anchor density), per-spread `ANCHOR (key) — Spread N must transform this moment...`, `ADDRESS (key): ... use the word "..." verbatim`, and the `## ANCHOR ALLOCATION` / `## BOOK SUBJECT` headers embedded into Stage 2 & 4 user prompts.

### Stage 4 guard — planner/plannerGuard.js (gemini-2.5-flash, jsonMode, temp 0, PB_INFANT only)
**PLANNER_GUARD_SYSTEM (lines 49-82)** — infant-band locomotion safety auditor:
```
You are an INFANT BAND safety auditor for a personalized children's picture book pipeline.
The book ... is a board book for a LAP BABY (ages 0-1). The child cannot walk, run, climb, jump, hop, skip, march, dance, twirl, leap, gallop, crawl across distances, stand on their own ... The child sits, lies, looks, reaches, holds, snuggles, giggles, coos, pats, claps, hears, smells, touches, points, watches, waves, blinks, gasps. Energy and motion come from THE WORLD AROUND THE BABY ...
You are reviewing the planner's spread specs ... For each spread: spreadNumber, focalAction, plotBeat.
Your job: identify any phrasing that puts the BABY in self-locomotion ...
[HITS examples: "runs across the meadow", "tiptoes", "scampers", "leaps", "climbs onto lap on her own", "dances around the room", "stands at the window"]
[CLEAN examples: "Mama lifts Scarlett to see the moon", "reaches for the soft red leaf as Mama holds her", "Mama sways with Scarlett in her arms"]
Reframing rule: CLEAN when the baby is the still point and the world/parent provides motion; HIT when the baby is the agent of locomotion.
Return strict JSON: { "hits": [ { "spreadNumber", "problemPhrase", "reason", "suggestedAlternative" } ] }. Emit hits ONLY when confident. If clean, { "hits": [] }.
```

---

## Stage 5 — writer/draftBookText.js (MODELS.WRITER = gpt-5.4, jsonMode, temp band-dependent, 12000 tok)

### 5a. SYSTEM_PROMPT — children's-book verse writer (lines 30-81)
```
You write premium children's book verse for image-first spreads.

RHYME — READ THIS FIRST (AA-CW-22 + AA-CW-26, hard rules, no exceptions):
- A rhyme means TWO DIFFERENT WORDS whose final stressed vowel + final consonant sound match. "chin / grin" is a rhyme. "chin / chin" is NOT — identity rhyme, automatic failure.
- NEVER end two lines on the same word. NEVER repeat the line-ending word inside the same line.
- NEVER ship a couplet that does not rhyme out loud. ...
- BANNED rhyme patterns: identity ("glow/glow"), stem/containment ("by/nearby", "town/hometown"), suffix-only ("running/jumping"), and the lazy "Mama/drama" pair.
- DROPPED ARTICLES: never "in lap", "by chin", "on knee" — always use a determiner ("in her lap", "by Mama's chin").
- BEFORE you emit a spread: read lines 1+2 aloud. If same word / don't rhyme / share a stem, fix it.

MEANING FIRST — NO RHYME-DRIVEN FILLER (AA-CW-26):
- Every word, especially the line-ending rhyme word, must mean something concrete. ...
- BANNED filler: archaic words ("nigh", "yon", "thee", "o'er"); end-of-line "by" with no object; off-scene nouns/verbs to land a rhyme; abstract end-words used as concrete.

VARY YOUR PHRASES — NO STRUCTURAL CRUTCHES:
- Do not repeat a 3+ word phrase across 4+ spreads.

Hard rules (every spread):
- Honor the spread spec exactly (side, personalization, beat). Read-aloud quality first. Third-person by default.
- **HERO PRONOUNS — single source of truth.** Use ONLY the declared set for the hero across the ENTIRE book. Never swap. Prefer the hero's name over a pronoun if ambiguous.
- **Arc context.** Use arcContext (callbackToSpread → echo earlier spread; setsUpSpread → plant forward note). The book is ONE arc; closing is a transformed echo of the opening.
- Funny/playful tone, character-based humor. Never preach. Use the child's name sometimes, not constantly.
- **Scene flow:** use sceneBridge + continuityAnchors so the read-aloud feels like a single adventure.
- **PROSE-PROP WHITELIST (AA-CW-16, hard rule).** Every concrete physical noun the hero/parent INTERACTS WITH must be (a) the child/parent, (b) a body part, (c) the location, or (d) in proseProps. Outside the whitelist = writer_invented_prop = QA failure. If you can't complete a couplet using the whitelist, choose a different rhyme word — NEVER invent a prop.

Picture-book structure (MANDATORY): EXACTLY 4 lines per spread for ALL bands (PB_INFANT/PB_TODDLER/PB_PRESCHOOL), separated by "\n". RHYME SCHEME band-conditional: TODDLER/PRESCHOOL full AABB; INFANT lines 1+2 rhyme, lines 3+4 default free-verse (AA-CW-18). Real end-rhymes only. LINE LENGTH per band (infant ~2-5 w/line hardMax 6; toddler ~3-7; preschool ~6-12). No invented words. No similes a child wouldn't recognize.

BOOK-LEVEL DIVERSITY SELF-AUDIT (AA-CW-19, MANDATORY before returning JSON):
- No single verb lemma in >3 of 13 spreads. No single concrete refrain noun (sleeve, hand, leaf, blanket, arm, lap, chin, cheek) in >3 of 13. Rewrite offenders before returning. Vary by sensory channel (verb-led / sensory image / state line / sound line).

Early reader: 3-4 short prose lines per spread; rhyme optional.

Return ONLY strict JSON: { "spreads": [ { "spreadNumber", "text": "LINE1\nLINE2\nLINE3\nLINE4", "side", "lineBreakHints", "personalizationUsed", "writerNotes" } ] }.
```
(5b. `userPrompt` lines 87-375 renders blocks: line-count reminder, STORY ARC CONTEXT, VOICE/REFRAIN/BOOKENDS/ADULT-READER-LINE, OUTDOOR-SENSORY BUDGET, pronoun block, RHYME CONTRACT banner, text-policy block, story bible JSON, visual cues, spread specs JSON. Verbatim blocks in file lines 197-352.)

---

## Stage 6 — writer/rewriteBookText.js (MODELS.WRITER = gpt-5.4, jsonMode, 7000 tok)

### 6a. REWRITE_SYSTEM_PROMPT (lines 22-40)
```
You are rewriting specific spreads of a children's book. Keep every other spread exactly as-is.
For each spread listed, produce an improved version addressing the listed issues using the hints. Honor the spec (side, beat, personalization). Read-aloud first. Musical, simple, low repetition. Never preachy.
Picture-book structure: EXACTLY 4 lines, "\n"-separated, AABB couplets. Real end-rhymes only — no identity, no slant, no suffix-only, no stem/containment, no "Mama/drama". PB_INFANT ~2-5 words/line.
MEANING FIRST. Every word — especially the rhyme word — must mean something concrete. Forbidden filler: archaic/poetic words; end-of-line "by" with no object; off-scene nouns/verbs; abstract end-words as concrete. ...
VARY YOUR PHRASES. Do not lean on a single sentence frame across the book.
Use the hero pronouns provided — no switching. Infant books: no locomotion verbs on the baby.
Return ONLY strict JSON: { "spreads": [ { "spreadNumber", "text", "side", "lineBreakHints", "personalizationUsed", "writerNotes" } ] }
```
(6b. buildRewriteUserPrompt lines 42-80 reuses arc/voice blocks + pronoun line + issues/hints JSON. `reviseSpreadProseForIllustrator` injects an illustrator-mismatch hint string [222-227].)

### Stage 6 judge — qa/checkWriterDraft.js (MODELS.WRITER_JUDGE = gpt-5.4, jsonMode, temp 0.2, 6000 tok)
**JUDGE_SYSTEM (lines 14-65)** — spread-by-spread manuscript judge:
```
You are judging a children's-book manuscript spread by spread. Each spread is exactly 4 lines.
IDENTITY-RHYME GATE — CHECK THIS FIRST. Strip punctuation/lowercase the last word of each line. If L1==L2 last word, broken. If L3==L4 last word, broken. Same word twice = broken, always.
THE RHYME SCHEME IS AABB. L1 rhymes L2; L3 rhymes L4; couplets needn't rhyme each other. Flag: identity rhymes, stem/containment, suffix-only, mismatched tail vowels, "Mama/drama". If either couplet fails, the spread is broken.
MEANING CHECK — equal weight to rhyme. Flag rhyme-driven filler even if acoustics work (end-word that makes no literal sense; archaic filler; past-tense verbs shoved in for rhyme). If you can't say what the line means in one clause, broken.
Also flag broken for: DROPPED ARTICLE; PRONOUN MISTAKE (vs provided hero pronouns / ambiguous antecedent); AGE-INAPPROPRIATE ACTION (infant locomotion with baby as subject); VERBATIM REPETITION (full line or 3+ word phrase across 4+ spreads — opening/closing may echo); CONTINUITY BREAK (prop/location mismatch).
For rhyme breaks, name the failing couplet and suggest a concrete meaning-preserving rewrite. For everything else, when in doubt mark broken: false. Bias toward NOT flagging taste/mood/fragment style.
Return ONLY: { "perSpread": [ { "spreadNumber", "broken", "issues": [], "hints": [] } ] }. One entry per spread.
```
(6d. buildJudgeUserPrompt lines 88-106 — age band, hero pronouns, spreads JSON.)

---

## Stage 7 — Illustrator (render) — prompts live in services/illustrator/* (see Gaps report)

## Stage 8 — qa/checkSpread.js — NO literal prompts (orchestrator over illustrator vision QA: textQa, consistencyQa, actionConsistencyQa)

### Stage 8 repair — qa/planRepair.js (NO own LLM call; emits literal image-model correction strings injected into the illustrator correction turn)
`renderCorrectionNote` (lines 85-195) assembles a `correctionNote`. Key verbatim instruction strings (per QA tag):
- Header: `Fix all of the following in the next attempt:`
- extra_word/unexpected_text: `Do not paint any extra words, signage, or environmental text. Only the provided caption.`
- midline: physically narrow the caption panel to ≤25% width, keep central ~30% text-free, change line breaks/panel width on regen.
- hero/outfit: `Match the approved cover for hero face, hair, and outfit. Do not restyle the hero.`
- body_disconnected/duplicated_hero: render the hero as ONE single connected body, one silhouette, one outfit, one set of limbs.
- disembodied_limb: remove floating limbs; implied hand must enter from a frame edge with wrist+forearm+elbow; else replace with signature object.
- implied_parent_skin_mismatch / full_body_parent_skin_mismatch: re-paint parent skin to EXACTLY match the cover child's tone (same family); a two-shade gap is a hard fail.
- parent_turned_away: re-stage parent engaged with the child.
- style_drift: re-render to match the BOOK COVER rendering tradition exactly.
- hair_continuity_drift / hero_age_proportions_drift / outfit_continuity_drift: align hair/age-proportions/outfit to cover + recent spreads.
- split_panel: ONE continuous wide 16:9 panorama, no diptych/seam.
- action_mismatch: re-render so the hero VISIBLY performs the action the text describes.
- age_action_impossible: replace impossible action with age-appropriate supported pose (lap baby supported by parent/stroller/high chair).
- duplicated/spelling/missing word: render the caption exactly once, word-for-word.
- text_priority preserve: keep hero face/hair/skin/outfit, fix only text problems.
- SURGICAL CAREGIVER REPAIRS header: `SURGICAL CAREGIVER REPAIRS (from vision QA — apply EXACTLY as written):`

---

## Stage 9 — qa/checkBookWide.js (MODELS.BOOK_WIDE_QA = gemini-2.5-flash, jsonMode, temp 0.2, 5000 tok)
**SYSTEM_PROMPT — final reviewer (lines 21-29)**
```
You are the final reviewer on a premium personalized children's book.
Review the full manuscript and the list of illustrations as a whole.
Flag problems that per-spread review cannot see:
  - repeated composition or camera across non-adjacent spreads
  - outfit/hair/identity drift between non-adjacent spreads
  - monotony of locations
  - tone mismatch (e.g. comedic setup, flat resolution)
  - ending that does not pay off the setup
Be specific. Return ONLY strict JSON with the schema in the user message. Be lenient — mark "pass": true unless there is a real defect.
```
(userPrompt lines 31-51: story bible JSON + spreads JSON + `{ "pass", "globalIssues", "flaggedSpreads":[{spreadNumber,issue,severity}] }`.)


---

## 2.3 — Illustrator: Interior Render + Image QA

# AI Model Prompts Inventory: Illustrator Subsystem (giftmybook-children-worker / services/illustrator + bookPipeline/illustrator)

**Models:** interior spread generation = `gemini-3.1-flash-image` (chat session) or OpenAI `gpt-image-2`; legacy `/generate-spread` = `gemini-3.1-flash-image`; ALL vision QA/OCR = `gemini-2.5-flash` (`GEMINI_QA_MODEL` / `TEXT_VERIFY_MODEL`). No Anthropic models used.

This is **Stage 7 (render)** + the vision-QA legs of **Stage 8** of the main book pipeline. The session **system instruction** is built once per book and carried on every image turn; per-spread **user turns** stage each spread.

---

## A. Session system instruction — services/illustrator/systemInstruction.js
`buildSystemInstruction` (wide/square) and `buildSystemInstructionQuad` (4:1) concatenate the fragments below with `\n\n`.

### A1. Intro — square (gpt-image-2) vs wide (Gemini) (lines 116-119)
Square:
```
You are the illustrator for a premium ${TOTAL_SPREADS}-spread children's picture book. Each per-spread call is STATELESS, but every call ATTACHES the BOOK COVER as the first reference image and may attach the most recent approved interior spreads as additional references — they are the canonical hero (face, hair, skin tone, outfit) and the canonical 3D CGI Pixar feature-film art style. For each prompt, generate ONE 1:1 square full-bleed illustration that matches those reference images on hero identity and style, while staging the SCENE from the per-spread prompt. The manuscript caption is rendered as PDF text on the FACING PAGE — your image must contain NO text. Every spread must read as the same hero, same outfit, same style as the references.
```
Wide:
```
You are the illustrator for a premium ${TOTAL_SPREADS}-spread children's picture book. You will be given a BOOK COVER image (the ground-truth character + style reference) and then a sequence of ${TOTAL_SPREADS} per-spread prompts. For each prompt, generate ONE 16:9 full-bleed illustration. Every spread must look like it came from the same painting session as the cover — identical art style, identical characters, identical outfits, same quality.
```

### A2. ART STYLE — match the cover (lines 122-127)
```
### ART STYLE — MATCH THE BOOK COVER EXACTLY (the cover is the only style ground truth)
Art style is the BOOK COVER's art style — exactly. Every interior spread must visually read as the SAME RENDERING TRADITION as the approved cover image: same surface treatment, same shading, same material logic, same hair-rendering approach, same lighting language, same level of detail.
- If the cover renders as 3D CGI, every interior is 3D CGI.
- If the cover renders as 2D illustration, every interior is 2D illustration.
- If the cover renders as a painted / watercolor / gouache style, every interior reads as that same style.
The cover is the single visual style ground truth for this book. Do not introduce any rendering tradition the cover doesn't show, and do not reject the cover's style in favor of a different one. Style consistency between cover and interiors is the contract — if you're ever torn between "match the cover" and any independent style target, always match the cover.
```

### A3. CONSISTENCY CONTRACT (lines 131-137)
```
### CONSISTENCY CONTRACT (HARD FAIL — READ FIRST, RE-READ EVERY TURN)
Identity is the contract of this book. Lighting, camera angle, mood, and weather may change between spreads. **Identity may not.**
- The hero child's face shape, eye color, eye shape, hair color, hair length, hairstyle, skin tone, and skin undertone are IDENTICAL on every spread to the BOOK COVER. No drift, no aging up/down, no hairstyle change, no skin-tone shift between rooms or lighting.
- The hero's outfit is the same garment system as the cover on every spread. Situational coverage (pajamas, swimwear, towel, snow coat) ONLY when the SCENE explicitly names it. Otherwise: hold the cover outfit.
- If a parent/secondary appears on the cover, their face, hair, build, and outfit are IDENTICAL on every spread.
- If a parent/secondary is implied (hand, shoulder, back-of-head, cropped torso), they are the SAME person across every spread: same skin tone, sleeve color/fabric, accessories, hair glimpse. Lock on first appearance.
- A reader flipping from spread 1 to spread 13 should be unable to tell anyone has changed except for the action of the moment.
```

### A4. CHARACTER LOCK (lines 141-160) — includes "ONE SINGLE CONNECTED BODY", "LIMB COUNT", "OBJECT INTEGRITY"
```
### CHARACTER LOCK
The hero child on the cover is the ONLY hero of every spread. Preserve their face, ethnicity, skin tone, eye color, hair color + hairstyle, and body proportions EXACTLY as rendered on the cover.
${childAppearance ? `Short reference (belt-and-suspenders with the cover image): ${childAppearance}.` : ''}
Outfit (visual lock only): Copy the hero's clothing as it appears on the BOOK COVER image and keep it aligned with your own prior interior frames in this chat. Same family/colors/silhouette across spreads unless the SCENE explicitly calls for a situational swap.
**Bathtub / shower:** the usual street outfit does NOT apply while the child is in bath water — see ### BATH, SHOWER, AND SWIMMING.
Show the hero EXACTLY ONCE per spread. Never twins, never split mirror views, never montages.

ONE SINGLE CONNECTED BODY (CRITICAL — anatomy fail if violated):
- The hero is ONE real 3D character, rendered as a single continuous body. Head → neck → shoulders → torso → hips → legs → feet must all be anatomically connected, on ONE vertical line, in ONE pose, at ONE scale, in the same outfit top to bottom.
- FORBIDDEN: a torso with a second pair of legs/hips/shorts floating next to it; a shirt that does NOT connect to the pants below; two overlapping versions of the child; a "ghost" body offset; any visible seam where the upper body ends and a second lower body begins.
- Mental check before output: trace the silhouette head → neck → chest → waist → hips → thighs → knees → shins → feet in ONE continuous path.

LIMB COUNT (HARD RULE — every spread, every character):
- Each human has EXACTLY two arms, two hands, two legs, two feet. No third arm, no third hand on the stroller bar, no extra fingers fused into a sleeve. Count visible hands per character before output: ≤ 2 per body.
- Hands belong to one body each; a hand must trace back to an arm, shoulder, torso (or believable off-frame body).

OBJECT INTEGRITY (HARD RULE — prominent man-made objects):
- Strollers, prams, carts, bikes, scooters, wagons, chairs, tables, ladders, swings, cribs, high chairs must read as STRUCTURALLY COHERENT. Handles connect with a real bar. Wheels in matching pairs. No floating handle, no two seats fused to one wheel, no duplicated frame bars.
```

### A5. HERO CHILD SKIN TONE LOCK (heroChildSkinToneLock, lines 37-48)
```
HERO CHILD SKIN TONE LOCK (cover-anchored — HARD LOCK on every interior):
The HERO CHILD's skin tone on the BOOK COVER is the SINGLE ground-truth color reference ... Same lightness, same warmth, same undertone, every spread.
- If the cover child reads fair/very pale → every interior child reads fair/very pale (NOT medium-tan, olive, sun-kissed, or darker because the scene is outdoors).
- If the cover reads medium → every interior reads medium (NOT much darker brown, NOT washed-out fair).
- If the cover reads deep brown → every interior reads deep brown (NOT lighter, NOT milky pale).
- Undertones don't drift either ... Lighting may change brightness, NOT skin family.
- Treat the cover child's cheek/hand skin as a literal swatch and re-use it on every interior. A two-shade gap or undertone shift is a HARD FAIL.
```

### A6. IMPLIED PARENT SKIN TONE LOCK (impliedParentSkinToneLock, lines 55-61)
ANY visible parent/relative skin (off-cover) MUST match the HERO CHILD's cover skin tone EXACTLY (same family/household/ethnicity). Two-shade gap = hard fail.

### A7. BATH, SHOWER, AND SWIMMING (modest/model-safe, lines 166-174)
Never nude/explicit; never submerged in street clothes; bubble-bath foam hides torso/legs; modest swimwear at pools; steam/silhouette/towel for showers; face/hair/skin/proportions still match cover.

### A8. WHO MAY APPEAR ON SPREADS — buildFamilyPolicySection (lines 278-367)
Conditional sections:
- **Secondary on cover:** each cover character keeps EXACT cover appearance. (+ themed parent on cover under same lock; + warning if the cover adult is NOT the themed parent.)
- **No secondary on cover / OFF-COVER ADULT POLICY (HARD):** off-cover adult NEVER appears in any form (no face/body/hand/shoulder/shadow/silhouette/reflection); presence ONLY via manuscript text + signature OBJECTS (mug, coat on hook, empty rocking chair, folded blanket, glasses, slippers); never substitute a pet/plush.
- **THEMED PARENT — VISUAL MODEL LOCK (on cover):** same facial identity as cover; HARD RULES — NO SHADOW SUBSTITUTION FOR THE PARENT'S BODY; ONE TORSO, TWO ARMS; EXACTLY ONE PARENT IN ANY FRAME; PARENT SKIN TONE = COVER PARENT SKIN TONE (compare to parent's own cover patch, not the child's).
- **THEMED PARENT POLICY (NOT on cover):** parent is the GIFT RECIPIENT, central to text, but NEVER drawn visibly in any form; presence via (a) manuscript caption + (b) signature objects only. Default signature objects per theme — mother: `a folded soft cardigan, a still-warm tea mug, a worn paperback face-down on a side table, a single pair of slippers`; grandparent: `reading glasses on a side table, a knitted shawl, a teacup on a saucer, a worn novel face-down`; father: `a casual wristwatch, a folded jacket over a chair-back, a coffee mug, a pair of work boots`.
- **FAMILY WORDS vs COMPANIONS:** "family"/"we"/"our"/"together" = people, not pets/plush.

### A9. RECURRING ITEMS & CHARACTERS (lines 192-193)
First on-screen appearance is canonical; same design/palette/features in every later spread.

### A10. NAMED LOCATIONS + SHOT VARIETY — buildNamedLocationsSection (lines 458-497)
Lock each named place's light/architecture/materials/mood on first appearance; reuse exactly (like revisiting a movie set); per-entry `• ${name}` + `Locked visual anchors: ${anchors}`. SHOT VARIETY: same place ≠ same photograph — follow the per-spread SCENE for framing, avoid near-duplicate compositions.

### A11. COMPOSITION — SQUARE (lines 201-217) / WIDE (lines 221-242)
Square: single 1:1 self-contained painting, 8.5×8.5″, ~5% trim inset, NO diptych/seam, NO on-image text (caption on facing page). Wide: 16:9 full-bleed, "PANORAMA LOCK" — one continuous environment, forbidden vertical seam / "text-canvas half" / two skies; compose the caption over a naturally quiet region of the SAME scene; in-world readable text forbidden except the manuscript caption.

### A12. PRINT & CAPTION POLICY (wide) — buildPictureBookPrintAndCaptionPolicy (lines 386-402)
16:9→square crop band (middle two-thirds safe), ON-IMAGE CAPTION = only the manuscript passage, ONE SIDE + ONE CORNER, vertical/horizontal safe margins (`~${topPad}%`/`~${bottomPad}%`/`~${edge}%`, center `~${centerBandPct}%` text-free), readability without dead halves, modest book serif.

### A13. ON-IMAGE TEXT (wide) — buildTextSection (lines 418-450)
14 numbered rules (corner-anchor, one-side-only, exact geometry, "the corner is not a blank canvas", EXACT TEXT no hallucinated words, no duplicate captions, font lock, cross-spread consistency, locked size tier, color/light, natural blend, wrapping ≤ N words/line, not-a-title, empty-text case) + an 8-point MANDATORY SELF-CHECK (a-h) before finalizing.

### A14. QUALITY BAR + BODY CONTINUITY SELF-CHECK (lines 255-263)
Anatomically correct hands/feet/faces; 4-point body-continuity self-check before output.

### A15. OUTPUT (lines 267-268)
`Respond with exactly ONE image per prompt. Do not narrate...`

### A16. QUAD (4:1 dual-spread) system instruction — buildSystemInstructionQuad (lines 526-625)
4:1 ultra-wide containing TWO consecutive spreads (LEFT=earlier, RIGHT=next); ART STYLE uses `PIXAR_STYLE.prefix/suffix/antiStyle` ("a still frame from a modern Disney-Pixar feature film — NOT a traditional children's-book illustration"); CHARACTER LOCK (once per half); bath rules; COMPOSITION 4:1 dual (left=spread A, right=spread B, story flows left→right, no seam at 4:1 center); per-half captions; quad print/caption policy (split at horizontal midpoint into two 2:1 buffers).

---

## B. Per-spread user turns — services/illustrator/prompt.js
`buildSpreadTurn` assembles `### SPREAD n of N`, `### SCENE` (caller scene), CHARACTER ANCHOR, parent-visibility, TEXT block, `### REMINDERS`, optional correction.

### B1. CHARACTER ANCHOR block (buildCharacterAnchorBlock, lines 313-360)
Lead: `### CHARACTER ANCHOR (RE-LOCK EVERY SPREAD — IDENTITY MUST NOT DRIFT)`. With description: bullets for Hero ground truth (literal), HAIR/EYES/SKIN LOCK, HERO SKIN TONE cover-anchored lock, LIMB COUNT, OBJECT INTEGRITY, REFERENCE IMAGES (Ref 1 = cover; others = approved interiors), OUTFIT LOCK (pre-render checklist — match exact garments/prints), OUTFIT CONTINUITY. Without description: condensed 4 bullets. Parent-theme anchor lines (on-cover = identical person; off-cover = NEVER visibly drawn + signature-object lock + no invented stand-in).

### B2. Parent-visibility stage direction (buildParentVisibilityReminder, lines 383-401)
One line per value: `full` / `hand` / `shoulder-back` / `cropped-torso` / `shadow` (off-frame cast shadow, no face features) / `object` / `absent`. Off-cover override forces object-implies-them.

### B3. ON-IMAGE TEXT block (buildTextBlock, lines 413-457)
No-text case = full-bleed, no overlay. With text: `TEXT: "..."`, CHOSEN SIDE, CHOSEN CORNER, exact PLACEMENT geometry, WIDTH CAP (HARD, ≤ `${maxWidthPct}%` of this spread's width; in quad, "this spread" = the local half), TYPOGRAPHY lock, size note, natural blend, color/light.

### B4. REMINDERS block (lines 248-273)
One-story-many-places; caption = in-scene type (lit/graded, no subtitle bar); one subtitle spec for the book; art-style HARD check (3D CGI Pixar frame, not 2D/watercolor/anime); hero look (outfit+face match cover & earlier interiors); keep cover characters identical; per-spread text rule; SCENE first; ONE scene edge-to-edge; no vertical seam; shot variety. + conditional longer-read-aloud and parent-theme reminders.

### B5. Correction turn (buildCorrectionTurn, lines 485-492) + tag directives (buildTagDirectives, lines 528-678)
`The previous attempt had these problems — fix ALL of them and regenerate:` + issues + `SPECIFIC ACTIONS TO TAKE:` + directives + appended `### CORRECTION FOR THIS RETRY\n${correctionNote}`. Per-QA-tag remediation lines (verbatim) for: text_on_both_sides, text_in_center_band/text_crosses_midline, text_duplicated_caption/duplicated_word, extra_word/unexpected_text, missing_word/spelling_mismatch, implied_parent_skin_mismatch/outfit_drift, full_body_parent_skin_mismatch, split_panel, outfit_mismatch, outfit_continuity_drift, hair_continuity_drift, hero_mismatch, unexpected_person (3 cast-policy variants), parent_as_character_silhouette, hero_skin_drift, extra_limbs, object_integrity, duplicated_hero, wrong_font, style_drift, bath_modesty. (Full verbatim in prompt.js:528-678.)

### Safety/fallback helpers (prompt.js)
- deescalateSceneForSignage (line 51): `[Print constraint] Do not paint legible in-world text...`
- compactSceneForImageSafetyRetry (82-84), minimalSafeSceneFallback (143-147): `Wholesome picture-book moment for spread ${n}...`

## B'. Quad per-spread turns — services/illustrator/promptQuad.js
`buildDualSpreadTurn` (reminders lines 104-112: one 4:1 frame, LEFT=spread A / RIGHT=spread B, exactly TWO captions total one per half, art-style match, seamless center, exact text), HERO LOCK block (120-149), `### QUAD BATCH ... LEFT HALF — SPREAD A ... RIGHT HALF — SPREAD B` scaffold, `buildDualCorrectionTurn` (185-190).

---

## C. Scene-policy fragments (no API call; embedded into illustrator scene text)
### services/illustrator/scenePolicyGate.js
- IMPLIED_PARENT_STAGING (8-10): `[Illustration staging — REQUIRED] Themed parent/caregiver: IMPLIED PRESENCE ONLY — hands, forearms, stroller push-bar, back-of-head, shoulder silhouette, or cropped torso with face hidden. NO full-face adult. ...`
- ADVENTURE_CAST_LOCK (12-14): `[Cast lock] Only the hero child and customer-confirmed cast may appear as recognizable full figures. Do not invent a second unrelated adult couple... `
### services/illustrator/illustrationPolicy.js — text-fragment formatters (no prompts), e.g. buildQaAllowedHumansNote.
### services/bookPipeline/illustrator/buildIllustrationSpec.js — assembles the SCENE text: PB_INFANT age-action constraint (34-41), caregiver lock block (69-85), off-cover cast block (133-149), caption-placement line, arc-context, and SCENE labels (Focal action / Location / Camera / Emotional beat / Hero ground truth / Hero outfit / World anchors / Recurring props / Avoid).
### renderAllSpreads.js / renderAllSpreadsQuad.js — COVER RE-ANCHOR CAUTION (single 336-339 / quad 543-544) + OFF-COVER CAST session note (764-787 / 1154-1174): "OFF-COVER CAST (story-only; partial presence only...)" + parent–child orientation HARD rules + partial-presence anatomy HARD rules.

---

## D. Vision QA prompts (all gemini-2.5-flash, strict JSON)

### D1. textQa.js — buildOcrPrompt (lines 234-256)
OCR + layout analyst → JSON {ocrText, leftText, rightText, centerText, crossesMidline, textBlockOverflow, textOnBothSides, fontLooksPlainBookSerif}. Coordinate system x∈[0,1], midpoint assignment; expected-text reference branch.

### D2. consistencyQa.js — buildConsistencyPrompt (lines 282-329, ~150 lines incl schema)
Compares COVER vs CANDIDATE interior. Image-part labels (IMAGE 0 real photo / IMAGE n BOOK COVER / RECENT APPROVED INTERIOR / GENERATED SPREAD UNDER REVIEW). Header asserts both read as the same rendering tradition; "Age & proportions across spreads (HARD)"; outfit-match guidance (pass unless clearly different garment set). Returns a large JSON schema: heroChildMatches, heroChildDifferences, heroAgeAndProportionsMatchCover(+Notes), outfitMatches, artStyleMatchesCover(+Notes), heroCount, heroBodyConnected(+Notes), splitPanel, explicitStranger(+description, branches on hasSecondaryOnCover), recurringItemConcerns, heroSkinToneMatchesCover(+Notes), impliedParentSkinMismatch(+Notes), impliedParentOutfitDrift(+Notes), fullBodyParentSkinMismatch(+Notes), tooManyHands(+Notes), objectIntegrityOk(+Notes), disembodiedLimb(+Notes), parentAsCharacterSilhouette(+Notes), parentTurnedAway(+Notes), bathModestyOk(+Notes). Optional caregiverSchema (caregiverShadowSubstitution/SkinDrift/phantomArms/caregiverBodyDuplicated +Notes/+Repair) and continuitySchema (hair/outfitConsistentWithRecentInteriors +Notes). Parent-theme = stricter (prefer fail on drift).

### D3. actionConsistencyQa.js — buildActionConsistencyPrompt (lines 180-213)
Judges (A) ACTION MATCH (image shows hero doing the text/focal action; audio-only verbs pass on a physical correlate; subtle physical verbs pass on any implied motion) and (B) AGE-ACTION POSSIBILITY (per PB_INFANT age limits). Returns {actionMatches, actionMismatchReason, ageActionPossible, ageActionReason}. Bias toward pass when uncertain.

---

## E. OpenAI gpt-image-2 adapter — services/illustrator/openaiImageSession.js
Stateless `/v1/images/edits`. `buildCombinedPrompt` (276-311) assembles: STATELESS header → `=== SYSTEM INSTRUCTION ===` (buildSystemInstruction square / quad) → `=== REFERENCE NOTES ===` (Ref 1 = cover, Refs 2..n = approved interiors) → `=== THIS SPREAD ===` (user prompt) → output hint (quad 4:1 / square 1:1 / legacy 16:9).

## F. Gemini chat session — services/illustrator/session.js
- establishCharacterReference (176-196): "BOOK COVER — CHARACTER + STYLE GROUND TRUTH" narrative (quad vs wide variant); acknowledge-text-only instruction (204).
- generateSpread re-anchor (245-247) + sendCorrection re-anchor (286-288).
- History-seeding strings (447/459/495/499) for accepted spreads and trimmed-history summaries.

---

## G. LEGACY single-image path — services/illustrationGenerator.js (`/generate-spread`)
Model `gemini-3.1-flash-image`; QA `gemini-2.5-flash`. (1788 lines.)
- ART_STYLE_CONFIG (122-214): style strings for pixar_premium/cinematic_3d (+ watercolor, digital_painting, gouache, pencil_sketch, paper_cutout, storybook_classic, anime, pixel_art, storybook, scandinavian_minimal, graphic_novel_cinematic) — each prefix/suffix/antiStyle. renderStyleBlock emits `${positive}. AVOID (hard no): ${antiStyle}.`
- sanitizePrompt suffix (255): appends `, wholesome, family-friendly, child-safe, innocent`. buildGenericSafePrompt (264).
- buildComicPanelPrompt (267-357): single graphic-novel panel; no in-image text; comic art-direction rules; text-width ≤35%.
- buildComicPagePrompt (371-495): full comic page WITH lettering (speech/thought/shout bubbles, captions, SFX), art style, outfit lock, parent no-face rules, no-family-members.
- buildCharacterPrompt (699-1116, the main legacy spread prompt, 200+ lines): character skin/feature anchor, NAME INTERPRETATION RULE, outfit lock, LOCKED APPEARANCE, "⚠️ CRITICAL RULES (READ FIRST...)" rules 1-8 (character count branches, anatomy, composition, family/parent, outfit, hairstyle, character-anchor, secondary lock), SCENE TO ILLUSTRATE, shot types, ADMIN OVERRIDE, BACKGROUND RULE, board-book composition (0-2), STYLE+renderStyleBlock, 16:9 anti-diptych rules, square format, TEXT RENDERING RULES (Lora-style serif, left/right 35%), ⚠️ MANDATORY PRE-GENERATE CHECKLIST (14 items), FINAL STYLE REMINDER.
- Style-reference part text (1159), first-spread reference (1167), anchor-images prefix (1741-1746).
- Inline vision QA: verifyImageText (653), checkCharacterConsistency (1520-1546, 4-dimension JSON), checkCharacterCount (1586-1588), checkTextPresentation (1640-1646), checkFontConsistency (1689-1694).

## H. Batch vision QA — services/illustrationQa.js (gemini-2.5-flash; also listed in side-flows report)
Ten checks: checkCharacterVisualConsistency (88-102), checkColorPaletteCoherence (156-166), checkFontTextConsistency (199-212), checkAnatomicalCorrectness (242-253), checkTextAccuracy (284-297), checkArtStyleConsistency (329-342), checkTextWidthPlacement (373-380), checkSceneTextAlignment (415-427), checkContentSafety (456-465, HARD BLOCK), checkDuplicateItems (496-516).


---

## 2.4 — Add-ons & Side Flows

# AI Model Prompts Inventory: Side Flows & Add-ons (giftmybook-children-worker)

> Covers cover generation, coloring book, comics, game assets, and illustration QA.
> Does NOT cover the main picture-book text + illustration pipeline (separate report).

## COVER GENERATION

### 1. Cover Harmonization (Cover Style Re-render to Interior 3D Style)
File: services/coverGenerator.js:184-193 — Gemini 3.1 Flash Image — image-to-image

```
INPUT: the attached image is the customer-approved book cover (composition and title may already be final).
TASK: Re-create this cover as a **cinematic 3D Pixar feature-film CGI key-art render** that matches the interior illustrations of the same product — the same 3D language as inside the book, not a separate art style.
PRESERVE: The same overall composition, the child's placement and pose, the same on-image title and subtitle (character-for-character if visible), the same number of people, and the same story mood. Do not invent a new layout.
TRANSFORM: If the input is 2D, watercolor, painterly, or flat illustrated, restyle it toward true 3D CGI in the same family as the interiors: believable 3D geometry, soft-feature-film character shading, PBR materials, clean volumetric lighting, modeled environment — do NOT increase skin/hair "photorealism" beyond a family-friendly 3D animated film look, and do NOT re-light faces to look like a real photograph.
FORBID: a different book title, extra characters, missing characters, or a new scene. No poster typography that ignores the input text.

STYLE LOCK (match book interiors):
[renderStyleBlock from ART_STYLE_CONFIG]
```

### 2. Back Cover Generation (Illustration + Text)
File: services/coverGenerator.js:343-353 — Gemini 3.1 Flash Image — illustration + text rendering (two variants: with/without reference)

WITH REFERENCE:
```
Create the back cover image for a book, rendered as a cinematic 3D Pixar-style CGI frame (NOT a 2D illustration, NOT a flat painting, NOT a soft storybook illustration).

STYLE REFERENCE: A small CROP from the front cover (corner/background) is attached ONLY to match color palette, lighting, and 3D rendering look. Do NOT copy or depict any person, child, or face from the reference. The main story character must NOT appear on the back cover.

LAYOUT REQUIREMENTS:
- This is the BACK COVER of the book — it should feel like a companion to the front cover
- Background: Use a softer, calmer version of the front cover's scene/colors — like a continuation of the world
- The main character should NOT appear on the back cover
- Include gentle, decorative elements from the story world (stars, clouds, or thematic elements from the front cover)

TEXT TO INCLUDE (render beautifully integrated into the illustration):
[Synopsis text (optional)]
[Heartfelt note with attribution (optional)]
Near the bottom center:
"Made with love for [childName]"
"GiftMyBook.com"

BARCODE: Include a realistic-looking fake barcode in the bottom-left corner (standard book barcode size, approximately 2" x 1.25"). It should look like a real ISBN barcode with vertical lines and numbers underneath, but the numbers can be fictional.

TEXT RULES:
- ALL text must be perfectly legible and correctly spelled
- FONT: Use Bubblegum Sans — rounded, bubbly, matching the interior pages exactly
- Use warm, soft colors that match the front cover palette
- Text should feel integrated into the illustration, not overlaid
- The overall feel should be warm, cozy, and premium

FORMAT: [Square 1:1 or Portrait 2:3 depending on bookFormat]

[Lulu cover print safety instructions - see buildCoverSafeZoneInstruction()]
```

WITHOUT REFERENCE:
```
Create the back cover image for a book, rendered as a cinematic 3D Pixar-style CGI frame (NOT a 2D illustration, NOT a flat painting, NOT a soft storybook illustration).

STYLE: No reference image is attached. Use a warm, premium 3D animated storybook look: cohesive palette, soft lighting, gentle decorative motifs — it should read as a calm companion to a personalized children's book back cover. No characters in the image.

[Same LAYOUT REQUIREMENTS and TEXT TO INCLUDE sections as above]
```

### 3. Upsell Cover Title Generation
File: services/coverGenerator.js:814-818 — GPT-5.4 — JSON titles

System:
```
You are a children's book title writer. Generate 4 short, irresistible book titles for a personalized children's book.
Each title must feel like a brand-new adventure for the same child.
Titles should be warm, specific, and emotionally evocative.
Do NOT use the word "adventure". Do NOT copy the original title.
Return JSON: { "titles": ["Title 1", "Title 2", "Title 3", "Title 4"] }
```
User:
```
Child: [childName], age [childAge].[genderNote]
Original book title: "[approvedTitle]".
Generate 4 completely different titles for their next book.
```

### 4. Upsell Cover Image Generation
File: services/coverGenerator.js:861-892 — Gemini 3.1 Flash Image — image with likeness (buildUpsellCoverPrompt)

```
REFERENCE IMAGE RULES: The attached image is ONLY a character-likeness reference for [childName]. Use it ONLY to match [childName]'s face, hair, skin tone, and build. Do NOT copy the composition, background, props, color palette, title treatment, typography, framing, or overall visual style of the reference image. The output must be a completely NEW illustration.

GENDER (AUTHORITATIVE): [childName] is a [genderWord]. [Depict as boy/girl/young child].
[If theme is 'mothers_day': LOVE TO MOM COVER sections with Mom appearance lock...]
[Otherwise: NO FAMILY MEMBERS rules...]

[If identity.characterDescription provided]
CHARACTER APPEARANCE LOCK: [characterDescription]

[If identity.characterAnchor provided]
PHYSICAL IDENTITY LOCK: [characterAnchor]

Book cover for a book titled "[title]". The main character is [childName], a [childAge]-year-old [genderWord]. Show [childName] in a warm, magical scene that feels full of possibility and wonder. Premium, inviting, irresistibly cute. Large bold title at top. "By GiftMyBook" at bottom.

ART STYLE: [renderStyleBlock(styleConfig)]
```

## COLORING BOOK ADD-ON

### 1. Trace-to-Coloring Page Conversion
File: services/coloringBookGenerator.js:46-62 — Gemini 3.1 Flash Image — buildTracePrompt
```
This is a children's book illustration. Convert it into a COLORING BOOK PAGE:
- Keep EVERY character, object, and scene element exactly as they appear — nothing removed or simplified
- Replace ALL colors with CLEAN BLACK OUTLINES ONLY on a PURE WHITE background
- Lines must be THICK and BOLD (suitable for a child to color with crayons or markers)
- CRITICAL — ALL AREAS INSIDE OUTLINES MUST BE PURE WHITE, INCLUDING:
  * Dark hair → draw hair strands as OUTLINES only, interior must be white
  * Dark or brown skin → draw the face/body shape as OUTLINES only, interior must be white
  * Dark clothing → draw fabric shape as OUTLINES with white interior
  * Dark objects (sofas, trees, shadows) → OUTLINES only, NO solid black fills
- ZERO solid fills anywhere — every enclosed area must be empty white so a child can color it
- NO fill colors, NO gray tones, NO shading, NO watercolor washes, NO color gradients
- Style: classic children's coloring book — like a Dover coloring book page
- [Age complexity instruction: SIMPLE/MODERATE/DETAILED based on child age]
- Maintain the EXACT SAME composition, proportions, characters and layout as the original
- PORTRAIT orientation — taller than wide (3:4 aspect ratio), like a standard coloring book page. Do NOT use landscape orientation.
- ABSOLUTELY NO TEXT, LETTERS, WORDS, NUMBERS, or LOGOS anywhere in the image — remove any text that appears in the source
```
Retry warning (dark fill detected):
```
⚠️ CRITICAL RETRY: The previous attempt had too much solid black. This is UNACCEPTABLE for a coloring book. ALL interior areas — including dark hair, dark skin, dark clothing — MUST be pure white with only outlines. Zero solid fills.
[Then re-send buildTracePrompt]
```

### 2. Coloring Page Generation from Scene Description
File: services/coloringBookGenerator.js:74-94 — Gemini 3.1 Flash Image — buildGeneratePrompt
```
Create an original COLORING BOOK PAGE for children. The scene:
[scenePrompt]
[If characterDescription: The main character looks like this: characterDescription]

STRICT RULES:
- BLACK OUTLINES ONLY on a PURE WHITE background — no fills, no gray, no shading, no gradients
- Lines must be THICK and BOLD, suitable for a young child to color with crayons or markers
- CRITICAL — ALL AREAS INSIDE OUTLINES MUST BE PURE WHITE, INCLUDING:
  * Hair → draw as outlined strands, white interior (never a solid dark mass)
  * Skin → draw face/body as outlined shape, white interior (even dark skin tones must be white inside)
  * Clothing, objects, backgrounds → outlined shapes, white interiors
  * ZERO solid black fills anywhere in the image
- Style: classic children's coloring book — like a Dover coloring book page
- Include rich background details (clouds, trees, objects) so the page is fun to color
- [Age complexity instruction]
- PORTRAIT orientation — taller than wide (3:4 aspect ratio), like a standard coloring book page. Do NOT use landscape orientation.
- ABSOLUTELY NO TEXT, LETTERS, WORDS, NUMBERS, or LOGOS anywhere in the image
```

### 3. Coloring Book Scene Planner
File: services/coloringBookGenerator.js:353-369 — Gemini 2.5 Flash — JSON scenes

System:
```
You are planning [count] original coloring book pages that accompany a children's picture book.
Book title: "[title]"
Child's name: [childName || 'the child'], age [age || 5]
[If storyMoments provided:
Story moments from the parent picture book (in order):
[numbered list]

EACH coloring scene must COMPLEMENT — not duplicate — one of these story moments. Think of them as "what happened just before / just after / the next day / a quieter parallel moment" for each spread. Reference specific locations, props, and characters named above so the coloring book feels like the same world. Do NOT simply retell the same scene the child already saw in color in the parent book.
ELSE:
Plan fun, varied adventure scenes for this child that would feel at home in a gentle picture-book world.]

For each scene provide:
- "title": short fun label, max 5 words (e.g. "Isabella Finds the Map")
- "prompt": detailed image generation prompt describing the coloring-page scene in one paragraph. Always name the child in the prompt and describe concrete actions, setting, and props.

Hard rules:
- Every scene features the same child as the hero.
- Scenes must be varied (different setting, pose, time of day, or activity from scene to scene).
- Keep scenes gentle, wholesome, age-appropriate; no peril, no dark imagery.

Return a JSON array: [{"title":"...","prompt":"..."}, ...]
Return ONLY valid JSON, no markdown.
```
User:
```
[If synopsis: Synopsis: [synopsis]]
[If characterDescription: Character: [characterDescription]]
Generate the scenes.
```

### 4. Coloring Book Back Cover Scene Planner
File: services/coloringBookGenerator.js:545-556 — Gemini 2.5 Flash — JSON scene selection
System:
```
You are designing the BACK COVER of a personalized children's coloring book for [childName][age].

Read the questionnaire below. Pick ONE small, concrete, heart-warming detail about this specific child that would make a charming pencil-sketch back-cover scene. Prefer unique personal details (a pet by name, a favorite toy, a cherished activity, a special place) over generic interests. Avoid sensitive or sad content.

Then describe a single calm pencil-sketch scene that features the child doing/holding/being-with that detail. The scene should complement the book cover — same child, gentle mood, one clear focal point.

Return ONLY valid JSON:
{
  "chosenDetail": "one short phrase naming the detail you picked",
  "scenePrompt": "one sentence describing the scene to draw, featuring the child and the chosen detail",
  "rationale": "one short sentence explaining why this detail is a good fit"
}
```
User: `[summarizeQuestionnaire output]`

### 5. Coloring Book Front Cover — Pencil Drawing from Parent Cover
File: services/coloringBookGenerator.js:445-458 — Gemini 3.1 Flash Image — convertCoverToColoringStyle
```
You are given a children's book cover. Re-create it as a GRAPHITE PENCIL DRAWING suitable as the cover of a coloring book companion to this same book.

- Keep the SAME characters, SAME composition, SAME poses, SAME outfits, SAME background elements as the original cover — this must clearly be the same cover, just in pencil-drawing form
- Render in HAND-DRAWN PENCIL style: graphite-on-paper look with soft tonal shading, visible fine hatching and cross-hatching, delicate pencil strokes
- Tones allowed: black, dark grey, mid grey, light grey, and white paper. Subtle gradients and soft shadows are fine — this is NOT a coloring page, it is finished pencil artwork.
- Avoid bold cartoon coloring-book outlines. Use sketchy, artist-quality pencil linework with natural variation in line weight.
- No color. Pure monochrome pencil drawing.
- RE-FRAME into PORTRAIT orientation (taller than wide, 3:4 aspect ratio). The source cover is square (1:1). Extend the scene naturally at the top and bottom so nothing important is cropped — do NOT letterbox or add blank bars, paint a pencil extension of the environment.

TITLE TEXT RULE:
- If the original cover already contains a title, name, or any typography, PRESERVE it exactly as it appears — reproduce those words in the same position and style, hand-lettered in pencil. This cover must keep its original title.
- Do NOT add any new text, labels, subtitles, author names, or logos that were not already in the source cover. Never invent a title. No "Coloring Book" stamp, no branding, no extra words.

Professional pencil-drawing quality suitable for a printed coloring book cover. The cover wrap PDF will embed this image full-bleed with no additional overlays — what you draw is what prints.
```

### 6. Coloring Book Back Cover (from Questionnaire)
File: services/coloringBookGenerator.js:723-751 — Gemini 3.1 Flash Image — buildBackCoverPrompt
```
Create the BACK COVER of a children's coloring book as a GRAPHITE PENCIL DRAWING.

SCENE TO DRAW:
[scenePrompt from planner]

The child ([childName][age]) must be the clear focal point, featured prominently in the scene.
[If characterDescription: The child looks like this: characterDescription]

STYLE REQUIREMENTS:
- HAND-DRAWN PENCIL style: graphite-on-paper look with soft tonal shading, visible fine hatching and cross-hatching, delicate pencil strokes
- Tones allowed: black, dark grey, mid grey, light grey, white paper. Subtle gradients and soft shadows are fine — this is NOT a coloring page, it is finished pencil artwork.
- Match the style of the FRONT cover exactly so both covers look like the same artist drew them.
- Avoid bold cartoon coloring-book outlines. Use sketchy, artist-quality pencil linework with natural variation in line weight.
- No color. Pure monochrome pencil drawing.
- Calmer and simpler than the front cover — ONE clear focal point (the child + the scene element), uncluttered background, plenty of clean paper.

COMPOSITION:
- PORTRAIT orientation (taller than wide, 3:4 aspect ratio)
- The child must be clearly depicted and recognizable as the same child on the front cover
- The pencil drawing should fill the frame naturally — no reserved white boxes, no barcode clear-zone, no ISBN area. We do not print a barcode or ISBN on this book.

STRICT:
- ABSOLUTELY NO TEXT, LETTERS, WORDS, NUMBERS, or LOGOS anywhere in the image — no title, no author name, no taglines, no back-cover blurb
- No frames, no borders, no decorative stickers — just the pencil scene on paper
```

### 7. Coloring Book Front Cover (from scratch)
File: services/coloringBookGenerator.js:697-712 — Gemini 3.1 Flash Image — buildFrontCoverPrompt
```
Create a children's coloring book FRONT COVER as a GRAPHITE PENCIL DRAWING.
Child's name: [childName], age [age]
[If characterDescription: The main character looks like this: characterDescription]

STYLE REQUIREMENTS:
- HAND-DRAWN PENCIL style: graphite-on-paper look with soft tonal shading, visible fine hatching and cross-hatching, delicate pencil strokes
- Tones allowed: black, dark grey, mid grey, light grey, and white paper. Subtle gradients and soft shadows are fine — this is finished pencil artwork.
- Whimsical, inviting composition with fun characters — the child should be the clear focal point
- No color. Pure monochrome pencil drawing.
- PORTRAIT orientation (taller than wide, 3:4 aspect ratio)
- ABSOLUTELY NO TEXT, LETTERS, WORDS, NUMBERS, or LOGOS anywhere in the image — no title, no author name, no subtitles, no branding
- The pencil drawing should fill the frame naturally — no reserved text boxes or clear bands
- Professional pencil-drawing quality suitable for a printed coloring book cover
```

## COMICS ADD-ON

### 1. Comic Cast Visual Bible — Character Visual Locks
File: services/comics/castVisualBible.js:115-143 — Gemini 2.5 Flash (Vision) — buildVisualLocksPrompt (JSON)
```
You are helping lock the visual identity of an ADULT character for a personalized graphic-novel-style comic. The attached image is a cropped reference photo of the real person this character is based on. Your job is to extract stable visual traits that an illustrator will reference on EVERY later panel so the rendered character is consistently recognizable as this person.

Return STRICT JSON only, no markdown, no commentary, exactly this shape:
{
  "face": "<identity-defining facial geometry, precise enough for an artist to redraw the SAME individual: overall face shape; eye shape and spacing; eyebrow shape and thickness; nose geometry; lip fullness and mouth width; jawline; cheekbones; chin shape; forehead height; any natural asymmetry. End with age range as a decade bracket only, e.g. '30s'>",
  "hair": "<color, texture, length, style, parting, hairline — exact enough to redraw>",
  "skinTone": "<precise artistic descriptor: depth + warmth/coolness + undertones>",
  "facialHair": "<exact description, or 'none'>",
  "glasses": "<frame style + color, or 'none'>",
  "build": "<height impression + general build>",
  "distinguishingFeatures": "<freckles, moles, scars, tattoos, jewelry, asymmetry — only if visible; else 'none'>",
  "suggestedOutfit": "<one tasteful, fully-clothed PG-13 outfit appropriate to the role, incorporating signatureColor if provided>",
  "signatureColor": "<dominant color used in suggestedOutfit; echo the provided signatureColor if any>"
}

Rules:
- PG-13, affectionate, respectful. Describe traits visible in the photo — do NOT speculate about ethnicity, religion, weight as a judgement, health, or sexuality. Do NOT include the person's actual name or any identifying text.
- Be FACTUAL and PRECISE: an illustrator must be able to draw the same person from your description alone.
- If a field is not visible, use "none" or a neutral default; never invent dramatic features.
- ADULT only — never describe the person as a child, teen, or minor.
[If context provided: Context: [context fields]]
```

### 2. Comic Cast Reference Sheet (Img2Img)
File: services/comics/castVisualBible.js:157-208 — Gemini 3.1 Flash Image — buildRefSheetPrompt
```
Create an ADULT character REFERENCE SHEET that is, FIRST AND FOREMOST, immediately recognizable as the EXACT person in the attached reference photo.

IDENTITY — priority #1, above all stylization:
- The attached image is the actual face of the real adult this character is based on. The rendered character MUST read instantly as the SAME individual — a friend should recognize them at a glance.
- PRESERVE THE EXACT FACIAL GEOMETRY of the reference: face shape, eye shape AND spacing, eyebrow shape, nose, mouth and lip fullness, jawline, cheekbones, chin, forehead, hairline, and any distinguishing marks or natural asymmetry. Do not "beautify", average, or generalize the face — keep it true to this specific person.
- Likeness is the #1 priority. When likeness and stylization conflict, favor likeness every time.

STYLE — required:
- A modern, semi-realistic / lightly-stylized graphic-novel portrait: accurate, realistic facial proportions and natural soft shading, rendered as a polished illustrated portrait of the real person.
- Affectionate, PG-13, tasteful. Fully clothed.

STYLE — forbidden (negative):
- Stylized but true-to-life proportions: do NOT over-cartoon, flatten, or exaggerate the features.
- NOT an actual photograph, NOT a 3D render.
- NOT a child's storybook illustration, NOT pixar, NOT anime.
- NO nudity, NO suggestive posing, NO gore, NO weapons aimed at the viewer.
- NO text, NO speech bubbles, NO captions, NO watermarks, NO logos, NO labels.
- NO multiple different people — single character only. NO children.

LAYOUT — single composite reference sheet, neutral / plain white background, the SAME character shown in three clearly separated views:
  1. PRIMARY — a LARGE, detailed head-and-shoulders FACE CLOSE-UP (neutral expression, eyes open, looking toward the viewer).
  2. SECONDARY (smaller) — front-facing full-figure standing pose (head to feet).
  3. SECONDARY (smaller) — three-quarter-view full-figure pose (slight turn, same outfit).
Consistent design across all three views: identical face, identical outfit, identical hair, identical proportions.

CHARACTER LOCKS — these traits must be visible and consistent across every view:
[From visualLocks or derived from reference photo]
[If context provided: Context: role, defining trait, signature prop, portrayal dial, art style hint...]

This sheet will be referenced on every later comic panel, so recognizability of this specific person matters more than dramatic composition or stylistic flourish.
```

### 3. Comics — Face Detection (Group Photo Bounding Boxes)
File: services/comics/detectFaces.js:128-132 — Gemini 2.5 Flash (Vision) — JSON
```
Detect every distinct human FACE in this group photo. For each face return a tight
bounding box. Respond ONLY as JSON: an array of objects
{ "box": [x, y, w, h], "confidence": 0..1 }
where x,y,w,h are fractions of image width/height in range 0..1 (x,y = top-left corner).
Do not include partial/background blurred faces below confidence 0.3. No prose.
```

## GAME ASSET GENERATION

### 1. Game Dialogue Generator
File: services/gameDialogue.js:50-94 — GPT-4o-mini — JSON dialogue
System:
```
You write warm, age-appropriate one-sentence dialogue lines for a toddler/preschool sandbox game.
Every line must be SHORT (max 10 words), spoken by the given speaker, and appropriate for ages 3-7.
Never include the child's age, parental instructions, product names, brands, or emoji.
If the speaker is a pet or a non-speaking object, use onomatopoeia ("Meow!", "Woof!") or a simple cheer.
Return ONLY valid JSON matching the requested shape; no prose, no preamble, no code fences.
```
User (abridged structure):
```
Write one dialogue line per interaction id below, plus 5 idle-chatter lines per NPC.
Context: { childName, childAge, momName, dadName, pet, theme, openingLine (if any) }
Interaction ids (each must be a key): [recipe IDs: eat_apple, drink_milk, teddy_on_character, ...]
NPC kinds (write idle_<kind>_1..5 for each): [mom, cat, ...]
Also produce: "opening" (narrator welcome <=10 words), "closing" (bedtime narrator <=10 words)
Output shape: { "dialogues": { "<lineId>": { "text": "<<=10 words>", "speaker": "child"|"mom"|"dad"|"narrator"|"cat"|"dog"|"bunny" } } }
Rules: speaker must be one of child/mom/dad/narrator/cat/dog/bunny/sibling; address childName by name in >=30% of lines; warm, silly, playful, never didactic.
```

### 2. Game NPC Character Generation (Grid)
File: services/gameNpcs.js:35-76 — Gemini 3.1 Flash Image — buildPrompt
```
Generate a 1×[cols] CHARACTER SHEET containing the following side by side: [MOM, DAD, CAT, etc.].

LAYOUT: [cols] equal-width cells in a single row, separated by thin white gutters. Each cell contains ONE character at the same baseline, same head height.

CHARACTERS:
- MOM: a warm smiling mother figure, standing relaxed, arms soft at sides, gentle welcoming expression.
- DAD: a warm smiling father figure, standing relaxed, arms soft at sides, friendly expression.
- CAT: a friendly small house cat sitting upright, tail curled around paws, bright eyes, soft furry body.
[etc. for dog, bunny, sibling]
[If briefMoments.momName etc.: The mother is called "[momName]" in the book... but DON'T include any text.]

CRITICAL:
- Pure white (#FFFFFF) background in every cell and gutter. NO shadows, props, gradients, or textures.
- NO text, letters, logos, or labels anywhere.
- Each character fills ~70% of their cell, centered.
- Soft 2-3px outer outline per character for a sticker-sheet feel.
- Match the art style (line weight, palette, rendering) of the reference images exactly.
- Style: [pixar_premium or provided style].

Output: ONE single image containing the character sheet. No annotations.
```

### 3. Game Character Pose Sheet (Grid) — 12 Poses
File: services/gameCharacter.js:54-115 — Gemini 3.1 Flash Image — gridPrompt
```
Generate a 4-row × 3-column POSE SHEET of the SAME character "[childName]" for a children's game.
[If age: The character is [age] years old.]
The character MUST match the identity shown in the reference images exactly — same face, skin tone, hair, clothing, style.

LAYOUT (critical): 4-row × 3-column grid with thin WHITE gutters separating 12 equal cells.
Row 1: [IDLE] [WALK-A] [WALK-B]
Row 2: [JUMP] [EAT] [SLEEP]
Row 3: [CHEER] [WAVE] [SIT]
Row 4: [READ] [DANCE] [SURPRISE]

CHARACTER POSITIONING (identical across cells): same character, same size, same facing; feet/base near bottom at same vertical position; head at same height; same proportions, only the pose changes; no ground shadow, no floor line, no props.

POSES (each cell exactly this pose):
- IDLE: standing relaxed, arms at sides, soft smile, open bright eyes, facing forward.
- WALK-A: mid-stride, LEFT foot forward, right lifting; RIGHT arm forward, LEFT back; happy smile.
- WALK-B: opposite stride (clearly different from WALK-A).
- JUMP: airborne, both feet off ground, knees tucked, arms in a V, open-mouth smile.
- EAT: holding food with both hands near mouth, eyes closed happily, cheeks puffed.
- SLEEP: upright, eyes closed, head tilted resting on palm-to-palm hands, peaceful smile.
- CHEER: arms up in a V, open-mouth joyful smile, feet apart.
- WAVE: right arm raised waving hello, left arm relaxed, big friendly smile.
- SIT: sitting cross-legged, hands on knees, calm smile, facing forward.
- READ: standing holding an open small book, looking down, gentle smile.
- DANCE: one foot lifted, arms asymmetric (one up one out), joyful open-mouth smile.
- SURPRISE: wide-eyed, both hands near cheeks, round "oh!" mouth.

BACKGROUND (CRITICAL — chromakey): every non-character pixel pure flat white (#FFFFFF); no off-white/cream/grey/gradient/texture/vignette; no ground plate, shadow plate, drop shadow, rim glow; no props/floor/wall; gutters also pure white; crisp character edges.
EDGES: sharp, well-defined; no anti-aliased halo; no outer glow/soft fade.
TEXT / DECOR: NO text, letters, labels, numbers, borders, logos, dividers, watermark anywhere.
RENDERING: same illustrated style as references; soft 2-3px outer INK outline per character; Style: [pixar_premium or provided style].
Output: ONE single image containing the 4×3 grid. No separate images, no text annotations.
```

## ILLUSTRATION QA (Vision — all Gemini 2.5 Flash, JSON output)

### 1. Character Visual Consistency — services/illustrationQa.js:88-102
```
You are reviewing [batch.length] illustrations from the same children's book ([imageLabels]).
[characterInfo: main character anchor, expected outfit, all characters]
For EACH character that appears in multiple images, check:
1. Is their face shape and features consistent?
2. Is their hair color/style consistent?
3. Is their skin tone consistent?
4. Are they wearing the same outfit (unless a scene change justifies it)?
5. Are body proportions consistent?
DO NOT flag: left/right mirroring, minor lighting differences, scene-specific accessories, eye open/closed state.
Return ONLY valid JSON:
{"characters": [{"name": "child", "consistent": true, "issues": [], "affectedImages": []}]}
Only flag OBVIOUS differences where the character would be unrecognizable.
```

### 2. Color Palette Coherence — services/illustrationQa.js:156-166
```
These [batch.length] images are from the same scene in a children's book.
Check if the color palette is coherent within this scene:
- Background colors should be consistent (same room = same wall color)
- Lighting should be consistent (same time of day)
- Character colors shouldn't shift (e.g., red shirt looking orange in one spread)
Note: Different scenes CAN have different palettes. Only flag jarring inconsistencies within the same scene.
Return ONLY valid JSON:
{"sceneCoherence": true, "issues": [], "affectedImages": []}
affectedImages = 1-based indices of images in this batch that break coherence.
```

### 3. Font & Text Consistency — services/illustrationQa.js:199-212
```
These are [batch.length] illustrated pages from the same children's book, shown in order.
Compare the text rendering across ALL pages:
1. Is the font family the same on every page?
2. Is the font size (relative to page) consistent?
3. Is the font weight/boldness consistent?
4. Is the text color the same throughout?
5. Is text placement style consistent (always top, always bottom, etc.)?
Find the MAJORITY style. Flag any pages that deviate from it.
Minor AI rendering variations are acceptable — only flag OBVIOUS differences.
Return ONLY valid JSON:
{"consistent": true, "outlierImages": [], "issues": []}
outlierImages = 1-based indices of images that differ from the majority.
```

### 4. Anatomical Correctness — services/illustrationQa.js:242-253
```
Check this children's book illustration for anatomical issues:
- Hands: correct number of fingers (5 per hand)? No extra or missing fingers?
- Arms/legs: correct number (2 of each), natural positions?
- Face: two eyes, one nose, one mouth, properly placed? Ears present and correct?
- No merged or extra body parts?
- No distorted or unnatural proportions?
Focus on the main character(s). Minor stylistic exaggerations are fine for children's book art.
Only flag CLEAR anatomical errors.
Return ONLY valid JSON:
{"passed": true, "issues": []}
```

### 5. Text Accuracy (OCR-like) — services/illustrationQa.js:284-297
```
Read ALL text visible in this children's book illustration.
Expected text: "[img.pageText]"
Compare what you see vs what was expected:
1. Is every word spelled correctly?
2. Is the full expected text present?
3. Is there any extra/garbled text that shouldn't be there?
4. Are there any AI-generated text artifacts (random letters, symbols)?
Minor formatting differences (line breaks, capitalization) are acceptable.
Only flag misspellings, missing words, garbled text, or extra gibberish.
Return ONLY valid JSON:
{"textAccurate": true, "extractedText": "what you actually read", "issues": []}
```

---

## ADDITIONAL: Front Cover scene prompts (services/coverGenerator.js)

### Front cover — Graphic Novel branch (coverGenerator.js:527-534) — Gemini image
```
A dramatic graphic novel cover illustration in a cinematic ${artStyle} style. The main character is a ${childAge}-year-old child named ${childName}. The scene should feel dynamic and action-oriented — suggesting an epic adventure. The child should be prominently featured in a heroic or dramatic pose. Background should be thematic with bold, graphic elements and dramatic lighting. Portrait image, 2:3 aspect ratio (width:height). The image must be taller than it is wide. Style: graphic novel / comic book cover aesthetic with strong composition.

${safeZoneInstruction}
```

### Front cover — default Pixar 3D branch (coverGenerator.js:535-541) — Gemini image
```
A cinematic 3D Pixar feature-film key art cover — a single high-resolution frame that could be the opening poster of a modern Pixar movie. The main character is a ${childAge}-year-old child named ${childName}, rendered as a believable 3D CGI character (real three-dimensional geometry, photoreal subsurface skin scattering, strand-by-strand hair, physically based materials — NOT a flat painting, NOT a watercolor, NOT a soft storybook illustration). The scene should feel inviting, wondrous, and cinematic — promising a real adventure from the very first frame. The child is the clear focal point, confident and emotionally expressive, with a strong silhouette and Pixar-quality facial acting. Background is a thematic 3D environment with ray-traced volumetric lighting, real depth, and genuine optical bokeh — fully modeled, not painted. ${aspectHint}

${safeZoneInstruction}
```

### Cover print safety / Lulu safe-zone (coverGenerator.js:132-143, buildCoverSafeZoneInstruction)
```
COVER PRINT SAFETY (CRITICAL — Lulu ${isHardcover ? 'hardcover casewrap' : 'paperback'}):
- The outer ~${sidePct}% of every edge of this image will be TRIMMED, BLED, OR WRAPPED around the book during printing. Anything placed there WILL BE CUT OFF or hidden on the inside of the cover.
- Keep ALL title text, the child's face, logos, subtitles, and any critical element at least ${topPct}% away from the TOP edge, at least ${bottomPct}% away from the BOTTOM edge, and at least ${sidePct}% away from the left and right edges.
- Place the title with generous top margin — the top of every letter (including tall letters like D, R, W, L, h) must sit well below the top ${topPct}% of the image. If the title is long, make it SMALLER rather than pushing it closer to the top.
- The background/illustration itself should still extend edge-to-edge (no white borders) — ONLY the critical content needs to stay inside the safe zone.
```

### Hero outfit vision snapshot (services/coverHeroOutfit.js:29-37) — Gemini 2.5 Flash (vision)
```
Look at this children's book COVER. The main child hero is the personalized protagonist.

Return STRICT JSON only:
{"outfit":"<one concise sentence listing visible garments, main colors, and accessories — exactly what the child is wearing on THIS cover image>"}

Rules:
- Describe ONLY the hero child's clothing/body wear (shirt, pants, dress, shoes, hat, etc.).
- If unclear, infer the dominant visible outfit; do not invent text from the title.
- No markdown, no extra keys.
```

---

## ADDITIONAL: Shared sprite style blocks (services/spriteStyle.js) — Gemini image

SPRITE_STYLE_BLOCK (10-18):
```
STYLE (MANDATORY — applies to the subject and every painted element):
- Don't Starve / Paper Mario family: thick dark ink outline (≈3-5% of the sprite short-edge), painterly gouache fills, matte highlights.
- Stylized flat-3D silhouette read at a glance; no photoreal textures, no airbrush gradients, no shiny plastic.
- Warm pastel palette with one saturated accent colour so the item pops against a neutral floor.
- Three-quarter orthographic view (≈35° above the horizon). Subject centered and upright.
- Soft baked cast shadow (elliptical, dark taupe, ≈30% opacity) directly under the subject on an otherwise TRANSPARENT canvas.
- No props, text, letters, watermarks, borders, floor lines, or backgrounds other than the baked shadow.
```
TRANSPARENT_BG_BLOCK (20-25):
```
BACKGROUND (ABSOLUTELY CRITICAL — we will chromakey this):
- Every pixel that is NOT the subject (and its own cast shadow) must be pure flat white #FFFFFF.
- No gradients, no off-white, no gray fringe, no rim glow, no halo.
- Crisp subject edges — no anti-aliased bloom, no outer soft fade.
```
CROP_BLOCK (27-32):
```
COMPOSITION:
- Square 1:1 aspect unless noted otherwise.
- Subject occupies ~70% of the frame height, centered horizontally.
- The subject's base (feet, wheels, pot bottom) rests at ~85% from the top so the cast shadow lives in the bottom band.
```

---

## ADDITIONAL GAME ASSETS

### Game Character — sequential fallback establishment (gameCharacter.js:433)
```
Study these references. You will generate 6 character pose sprites on pure white, keeping identity and style consistent. Acknowledge with text only.
```
### Game Character — face disc portrait (gameCharacter.js:561-578)
```
Generate a SINGLE head-and-shoulders portrait of the same character "${name}" from the reference images.
Same identity (face, skin tone, eyes, hair, expression) — match exactly.
COMPOSITION (critical):
- Tight head-and-shoulders crop, face centred in the frame.
- The top of the hair is ~10% from the top edge.
- The chin is ~60% from the top (so the whole face fits a face disc).
- Character facing the camera, soft warm smile, both eyes visible.
BACKGROUND (ABSOLUTELY CRITICAL — we will chromakey this out):
- Every non-character pixel is pure flat white (#FFFFFF).
- No gradient, no off-white, no shadow, no rim-light.
- Crisp character edges with no outer halo.
Style: ${style || 'pixar_premium'}, same illustrated style as the references.
Output: ONE portrait image only. No text, no watermark, no border.
```
### Game Character — avatar face cartoon-3D (gameCharacter.js:644-666)
```
Generate a SINGLE stylized cartoon-3D portrait of "${name}" from the reference images.
The portrait will be mapped onto the face of a low-poly cartoon 3D avatar.
STYLE (critical): Cartoon 3D / Two Point Hospital / Sims-lite aesthetic. Flat shading with a soft gradient, bold dark outline around the silhouette. Big friendly eyes, warm smile, pastel-saturated palette. NOT photoreal — stylized. Identity must still be recognisable.
COMPOSITION: Tight head-and-shoulders crop, face centred. Square 1:1. Top of hair ~10% from top; chin ~65% from top. Facing camera head-on; both eyes visible.
BACKGROUND (chromakey): every non-character pixel pure flat white (#FFFFFF). No gradient/off-white/shadow/rim-light. Crisp edges, no halo.
Output: ONE portrait image only. No text, no watermark, no border, no accessories covering the face.
```

### Game Character Atlas — 4×4 parts grid (gameCharacterAtlas.js:88-134) — Gemini image
```
Generate ONE image containing a 4×4 grid of CHARACTER PARTS for "${name}".
These parts will be assembled by a 2D rigging engine into a living character, so identity, skin tone, hair, clothing, and line weight MUST match the reference images exactly.
GRID LAYOUT (16 cells, 4 rows × 4 columns, thin white gutters between cells):
Row 1 (HEAD POSES): [head-front] [head-3q-left] [head-3q-right] [head-down]
Row 2 (EYES only, floating on white): [eyes-open] [eyes-closed] [eyes-look-left] [eyes-look-right]
Row 3 (MOUTHS only): [mouth-smile] [mouth-open] [mouth-surprise] [mouth-frown]
Row 4 (BODY PARTS, no head): [body-standing] [arm-left] [arm-right] [hair-back]
[+ detailed per-cell instructions, character consistency, pure-white background, no text]
ANCHOR POINTS (return as JSON block after the image):
{"anchors":{"neck":{...},"eyeL":{...},"eyeR":{...},"mouth":{...},"shoulderL":{...},"shoulderR":{...}}}
Output: ONE single 1:1 image containing the 4×4 grid + optional JSON text block.
```

### Game Pose Anims — 2×2 frame sheet (gamePoseAnims.js:54-117) — Gemini image
WALK/JUMP/CHEER animation grids; same character across 4 cells, only pose changes; pure white chromakey background; per-anim frame descriptions (stride-A/contact-R/stride-B/contact-L for WALK; crouch/takeoff/apex/land for JUMP; rise-1/rise-2/peak/settle for CHEER). Output ONE 2×2 grid image, no text.

### Game Hero Props (gameHeroProps.js:35-46, via spritePrompt) — Gemini image
```
Draw a single children's-book hero prop: ${prop.prompt || 'a '+prop.name}.
SUBJECT RULES:
- The subject is exactly "${prop.name || prop.id}" — nothing else in frame, no child, no hand, no environment.
- Friendly child-safe design, rounded corners, no sharp blades or scary detailing.
- If the prop could be "on" or "off" (lamp / candle), render it in its neutral / off state.
```

### Game NPC Sprite (gameNpcSprite.js:22-39, via spritePrompt) — Gemini image
```
Draw a full-body children's-book NPC: ${subject (cat/dog/mom/dad/named)}.
SUBJECT RULES:
- The subject is exactly "${name||kind}" — one character, full body in frame, feet to crown visible.
- Friendly, approachable pose; arms at sides or waving.
- Do NOT draw the child hero, any props, or any secondary characters.
```

### Game Objects sticker-sheet (gameObjects.js:64-94) — Gemini image
Coordinated rows×cols grid of items, one per cell, shared art style, pure-white chromakey background, no text/labels/borders. Output ONE sticker sheet.

### Game Object Variants strip (gameObjectVariants.js:108-133) — Gemini image
Horizontal strip of N state-variants of the SAME object (stove off/heating/flames/pot, fridge, bath, sink, tv, toilet, washer, oven, toybox, bed — see VARIANT_HINTS 32-85). Identical silhouette/angle across cells, only state changes; pure white background; aspect N:1.

### Game World Assets (gameWorldAssets.js) — Gemini image (chat session)
- Session establishment (268-269): "These references establish the art style ... Acknowledge with text only — do not generate an image yet."
- ROOM_PROMPTS (26-74): kitchen / bedroom / bathroom / playground / restaurant — wide 16:9 empty-room scenes, NO characters, warm palette, no text/logos.
- OBJECT_PROMPTS (76-131): ~42 object descriptions (apple, banana, bread, milk, cupcake, ... map, compass, binoculars, crayons, easel, letter).
- Asset framing (133-154): room framing (16:9 edge-to-edge, no characters) + object framing (single centered object, square, pure-white background, sticker outline).

---

## CROSS-CUTTING: Narrative Pattern Selector (services/narrativePatterns.js)
Primary OpenAI gpt-4.1-mini (temp 0.4, JSON); fallback Gemini gemini-3-flash-preview. Feeds writer/critic.

System (buildSelectorPrompt 214-249):
```
You are a narrative pattern selector for children's books.
Given a story's parameters, select the best combination of storytelling patterns from the library below.
STORY PARAMETERS: Format ${story_type}; Age ${age}; Emotional goal ${goal||'joy'}; Setting ${setting}; Tone ${tone||'playful'}
PATTERN LIBRARY: ${patternList}
SELECTION RULES:
1. ALWAYS include: concrete_opening, understated_peak, physical_emotion
2. Then select: 1 tension, 1 structure, 1 character, 1 surprise pattern
3. Optional: 1 language pattern (only if it fits tone and age)
4. Maximum ${maxPatterns} patterns total${gnInstruction}
ANTI-GENERIC RULE: Do NOT select patterns just because they're safe. Choose patterns that create TENSION and SPECIFICITY for this particular story.
QUALITY RULES: each pattern needs a specific concrete "how_to_apply" (1-2 sentences) referencing setting/characters/goal; "strategy" explains how patterns work together; don't repeat the description.
Return JSON:
{ "selected_patterns": [ { "id": "pattern_id", "how_to_apply": "..." } ], "strategy": "..." }
```
User (376): `Select the best narrative patterns for this story. Return JSON only.`


---

# 3. giftmybook-worker (general/adult books, ebooks, audiobooks, comics)

# giftmybook-worker — Verbatim AI Prompt Inventory

This document captures the **full verbatim text** of every AI prompt in `/home/user/giftmybook-worker`, organized strictly by flow (A → F). Each entry lists a short name, flow step + order, file:line, model/provider, role, and the exact prompt text (templates retain their placeholder expressions).

## Model aliases & routing

**`services/gemini.js:19-35`** — `MODELS` map (provider auto-detected from model-name prefix):

```js
const MODELS = {
  // Primary models (OpenAI)
  writing: 'gpt-5.4',         // Chapter writing — best creative quality
  smart: 'gpt-5.4',           // Large context: planning
  fast: 'gpt-5.4-mini',       // Small mechanical tasks
  // Gemini 3.x (preview — require -preview suffix)
  g3pro: 'gemini-3.1-pro-preview',    // Most advanced reasoning
  g3flash: 'gemini-3-flash-preview',  // Fast + agentic, best value for writing
  g3lite: 'gemini-3.1-flash-lite-preview', // Cheapest, fastest
  // Gemini 2.5
  pro: 'gemini-2.5-pro',      // Planning, revisions
  flash: 'gemini-2.5-flash',  // Post-processing
  // DeepSeek (v4 family)
  deepseek: 'deepseek-v4-pro',       // Strong reasoning — structured planning
  deepseekFast: 'deepseek-v4-flash', // Cheap mid-tier — director/judge style tasks
};
```

**`services/writer/config.js:13-37`** — Writer role → model assignments (`{ primary, fallback, temperature }`):

| Role | Primary | Fallback | Temp |
|------|---------|----------|------|
| characterExtractor | gemini-2.5-flash | gpt-5.4-mini | 0.3 |
| briefAnalyzer | gemini-2.5-flash | gpt-5.4-mini | 0.3 |
| briefDigest | gemini-2.5-flash | gpt-5.4-mini | 0.3 |
| voiceSheet | gemini-2.5-flash | gpt-5.4-mini | 0.5 |
| planner | deepseek-v4-pro | gemini-2.5-pro | 1.0 |
| planCritic | gemini-2.5-flash | gpt-5.4-mini | 0.4 |
| planImprover | deepseek-v4-pro | gemini-2.5-pro | 0.7 |
| writer | gpt-5.4 | gemini-2.5-pro | 0.8 |
| storyBible | gemini-2.5-flash | gpt-5.4-mini | 0.3 |
| finalScan | gemini-2.5-flash | gpt-5.4-mini | 0.2 |
| illustration | gemini-2.5-flash | gpt-5.4-mini | 0.3 |

---

# Table of Contents

- **FLOW A — BOOK WRITING**
  - A0 WRITING_GUIDE (shared system prefix) + HARD RULES block
  - A1.1 Character + pet extraction
  - A1.2 Brief digest + coverage
  - A2.1 Voice cards
  - A3.1 Draft plan (system + schema + user)
  - A3.2 Plan critic
  - A3.3 Plan improver
  - A3.4 Title grammar fix
  - A3.5 Invented-character detection
  - A4.1 Chapter writer (CORE) — system + user + CAST block + storyBible context
  - A4.2 Chapter continuation
  - A4.3 StoryBible chapter extraction
  - A4.4 Incremental dedup
  - A5.1 Final scan
  - A6 Theme fragments (comedy / memoir / base)
  - A7 Dormant prompts (DEFINED-BUT-NOT-WIRED)
- **FLOW B — ILLUSTRATIONS**
  - B1 Scene selection (system + user + schema + ART_STYLES)
  - B2 Image generation (prompt + character description lock)
- **FLOW C — COMICS**
  - C1 planComicScript (system + user + schema)
  - C2 draftDialogue (system + user + schema)
  - C3 render (panel prompt + lettering rules + face QA + text QA)
  - C6 replan
  - C-theme Comics theme fragments
- **FLOW D — AUDIOBOOK** (TTS templates, not LLM)
- **FLOWS E & F** — NO AI

---

# FLOW A — BOOK WRITING (`services/writer/`)

## A0 — WRITING_GUIDE (shared system prefix)

- **Step/order:** A0 (prepended to most A-flow system prompts via `buildSystemPrompt`)
- **File:** `services/writer/prompts/system.js:9-116`; `buildSystemPrompt` at `:122-124`
- **Model/provider:** N/A (text injected into other roles' system prompts)
- **Role:** Shared writing-guide foundation

`buildSystemPrompt(basePrompt)` returns `WRITING_GUIDE + '\n---\n\n' + basePrompt`.

```
CORE PRINCIPLE
You are writing a book as a personal gift. The subject is a real, specific person. Every scene, every observation must feel like it could only have been written about this person — not a type of person, not a character sketch, but the actual human described in the inputs.
Your prose goal: write like a sharp novelist. The best writing in these books comes from specific, true details treated with commitment — not from generic passages dressed in a character's name.

RULE 1 — SCENE FIRST, ALWAYS
Never open a chapter with summary, biography, or character description.
Every chapter must open in a live scene — something is happening, right now, to a specific person in a specific place. The reader lands mid-action.
The character's personality, history, and relationships must emerge through action and dialogue — never through description of what kind of person they are.

RULE 2 — NAMED PEOPLE APPEAR EARLY AND OFTEN
The gift-giver's inputs will include names of family members, friends, and loved ones. These names must appear within the first two pages of Chapter 1 and recur naturally throughout the book — not just in the chapters named after them.
If the inputs include: spouse/partner, children, parents, siblings, or close friends — each of these people must have at least one full scene in the book where they drive the action, not just react.
Children especially: give them specific dialogue and at least one moment where they say or do something that surprises or moves the subject. Use their name, always.

RULE 3 — THE SUBJECT'S QUIRK MUST BE A SPECIFIC ENGINE, NOT A LABEL
Every subject has a central quirk. This quirk must:
- Be demonstrated, never announced. Show the behavior; do not name it.
- Escalate across the book. Chapter 3's version should be more extreme or nuanced than Chapter 1's.
- Create consequences that involve other named people.
- Connect to something the subject genuinely cares about.
If you find yourself writing "she was the kind of person who..." — stop. Show it instead.

RULE 4 — THE EMOTIONAL CORE MUST BE REAL
Every book must have a beating heart. Identify the central emotional truth in the inputs and return to it in:
- A quiet moment near the midpoint of the book
- A full scene in the final 20% that is the emotional peak — not a recap, but the moment the whole book builds toward
- The final paragraph of the epilogue

RULE 5 — SPECIFIC SETTINGS OVER GENERIC ONES
Use the real places in the subject's life whenever the inputs provide them. What does it smell like? What's the light? What would only happen here?

RULE 6 — CHAPTER TITLES ARE A PROMISE
Every chapter title makes a promise to the reader. The chapter must deliver specifically on that promise.

WRITING TECHNIQUES
- Specific objects anchor scenes. Pick one object per chapter and commit to it.
- Dialogue reveals character faster than description. Let voices do the characterization work.
- Real stakes make stories work. Ground every chapter in something that actually matters to the subject.

STRUCTURAL REQUIREMENTS
- Chapter 1 opens in a live scene within the first paragraph
- At least 3 named people from the inputs appear by end of Chapter 2
- The subject's core trait has escalated by the midpoint compared to Chapter 1
- There is one quiet, emotionally honest scene near the midpoint
- Children or key family members have their own dialogue, not just mentions
- The final 20% of the book contains the emotional peak
- The epilogue ends on a specific image or moment, not a general statement

RESTRAINT RULES

BREVITY
- Your default output is too long. Cut 30% from your instinct.
- BANNED PATTERN: observation → reflection → rephrased reflection → insight. CUT THE MIDDLE. Write: observation → strongest insight. That's it.
- Breakfast scenes, routine moments, internal reflection blocks: these run longest. Halve them. The reader gets it faster than you think.
- One paragraph of internal reflection per scene, maximum. Then return to action or dialogue.
- If you wrote a strong line, STOP. Do not follow it with a weaker version.
- Not every scene needs a metaphor. Maximum 1 extended metaphor per chapter.

IDEA DISCIPLINE
- State each emotional truth ONCE. If you wrote "knowing where they are isn't enough," do NOT later write "maps don't show feelings" — that's the same idea.
- After a powerful insight, MOVE TO A NEW IDEA. Do not circle back with a softer restatement.
- When two sentences make the same point in different words, delete the weaker one.

DIALOGUE BREVITY
- Most dialogue lines are 1-8 words. Not 1-8 sentences.
- Characters interrupt. Sentences go unfinished. People say "yeah" and "ok."
- No character delivers a speech longer than 3 sentences.
- At least 40% of dialogue should be plain and functional, not clever.

SCENE STRUCTURE VARIETY
- BANNED PATTERN: [detect flaw] → [escalate] → [use analogy] → [dominate/win]
  This pattern must NOT appear in more than 2 chapters total.
- Each chapter must use a DIFFERENT scene structure. Options:
  - Dialogue-driven (minimal narration, story told through conversation)
  - Observational (protagonist watches, doesn't intervene)
  - Physical/action (something happens, minimal inner monologue)
  - Quiet/reflective (sincere, small, human)
  - Escalating (OK for 2-3 chapters only)

QUIET MOMENTS
- Every book needs at least 2 chapters where the intensity drops.
- Include one moment per chapter where a character simply exists without performing.
- After an intense sequence, write one paragraph of stillness before continuing.

SCENE AND CHAPTER ENDINGS
- When you write a strong final line, STOP. Do not add a softer restatement after it.
- The last paragraph of every chapter should be SHORT: 1-3 sentences maximum.
- BANNED ending pattern: strong insight → reflection paragraph → softer restatement. Cut everything after the strong insight.
- If your chapter's last paragraph is more than 3 sentences, you've gone too far. Cut back.

EMOTIONAL CONTRAST
- If everything is intense, nothing is. Alternate intensity deliberately.
- The emotional peak of the book MUST be preceded by a quiet chapter.
```

### A0b — HARD RULES block (`formatRulesForPrompt`)

- **File:** `services/writer/prompts/rules.js:87-101` (injected into the chapter-writer user prompt)
- **Role:** Hard constraints block. Placeholders interpolate `SENTENCE_LIMITS.maxDialogueWords` (25), `SENTENCE_LIMITS.maxNarrationWords` (35), `MAX_SENTENCES_PER_PARAGRAPH` (6), and the AI-tell blocklist split into single words and phrases.

```
HARD RULES (NEVER VIOLATE)
- No em dashes (—) in story text. Use commas, periods, or restructure.
- Never write: "She was the kind of person who..." or any variant.
- Maximum 1 extended metaphor per chapter. Zero stacked metaphors.
- Dialogue lines max ${SENTENCE_LIMITS.maxDialogueWords} words. Narration sentences max ${SENTENCE_LIMITS.maxNarrationWords} words.
- No paragraph may contain more than ${MAX_SENTENCES_PER_PARAGRAPH} sentences. One beat per paragraph. Break on speaker change, action shift, or topic pivot.
- No paragraph may open with: Furthermore, Moreover, Additionally, In addition.
- Prefer plain, concrete, emotionally resonant words over abstract or technical ones (say "math problem" not "equation", "ran" not "traversed"). When two correct words are available, pick the one a 10-year-old hears clearly.
- BANNED WORDS: ${singleWords.join(', ')}
- BANNED PHRASES: ${phrases.join('; ')}
```

`AI_TELL_BLOCKLIST` (source of BANNED WORDS/PHRASES): delve, delved, delving, intricate, intricacies, tapestry, rich tapestry, Furthermore, Moreover, Additionally, In addition, It is worth noting, It's worth noting, not just a, in that moment, a testament to, the very fabric of, navigating the complexities, at the end of the day, needless to say, it goes without saying, in a world where, little did they know, unbeknownst to, a myriad of, in the realm of, nestled, bustling, pivotal, nuanced, multifaceted, embark, landscape, paradigm, foster, leverage, facilitate, comprehensive, underscores, underscored, resonated, juxtaposition.

---

## A1.1 — Character + pet extraction

- **Step/order:** A1.1 (Phase 1 UNDERSTAND, first LLM call)
- **File:** system `services/writer/pipeline/understand.js:19-41`; user `:321-323`; schema `extract_characters_v6` `:43-91`
- **Model/provider:** `characterExtractor` → gemini-2.5-flash (fallback gpt-5.4-mini), temp 0.3, function call
- **Role:** Character analyst (function-calling extraction)

**System (`CHARACTER_SYSTEM_PROMPT`):**

```
You are an expert character analyst. Extract ALL character information from the provided brief — not just names and relationships but the COMPLETE picture of each person.

1. PERSISTENCE: Extract every character mentioned anywhere in the brief.
2. NO GUESSING: Extract only what is explicitly stated or clearly implied.
3. PLANNING: First scan the entire brief for all person mentions, then extract each field.

For EACH PERSON (human) extract: Name, Relationship, Gender, Pronouns, Personality traits, Quirks, Hobbies, Job, Dreams, Key memories, Pet details (free-text notes about their animals, if any).

SEPARATELY list every NAMED PET or animal in `named_pets`: name, species/type, which person they belong to, and any short notes.
Always pass `named_pets` in the function call (use an empty array if there are no animals).
Pets must NEVER appear as rows in `characters` — only people belong there.

RULES:
- Include the main character (protagonist) as the first entry in characters
- Include ALL named people, even if mentioned only once
- Every named animal (dog, cat, etc.) goes in named_pets, not as a person
- For each named_pets.owner_first_name: use the real human first name from the Character List / brief. Never use "narrator", "the narrator", "author", or "protagonist" as owner_first_name — map those to the protagonist's actual first name.
- NAME ORDER IS CANONICAL: the Character List below shows each person's name in the EXACT order the user typed. Preserve that order verbatim. Put the FIRST word of the typed name into `first_name` and the rest into `last_name`. Never reorder, swap, or "fix" what looks like an unusual order. Example: "Grannie Annie" → first_name="Grannie", last_name="Annie" (NOT first_name="Annie", last_name="Grannie"). Example: "Mamaw Carrie" → first_name="Mamaw", last_name="Carrie". Familial titles ("Grannie", "Mamaw", "Nana", "Papaw", etc.) are part of the name and must stay in their original position.
```

**User (`:321-323`):**

```
### Character List from Brief
"""
${charactersList}
"""

### Full Brief (All Answered Questions)
"""
${data}
"""

### TASK

Extract ALL people in `characters`, every named animal in `named_pets`, using extract_characters_v6.
```

**Schema (`extract_characters_v6`, `:43-91`):** function with `characters[]` (first_name, last_name, relationship, gender, pronouns, personality_traits[], quirks[], hobbies[], job, dreams[], key_memories[], pet_details; required first_name, relationship) and `named_pets[]` (name, species, owner_first_name, owner_last_name, notes; required name). Required: `characters`.

---

## A1.2 — Brief digest + coverage

- **Step/order:** A1.2 (Phase 1 UNDERSTAND, combined digest + coverage in one call)
- **File:** system `DIGEST_SYSTEM_PROMPT` `:127-134` + coverage addendum `:434-437`; user `:465-469`; schema `:136-210` extended at `:446-457`
- **Model/provider:** `briefDigest` → gemini-2.5-flash (fallback gpt-5.4-mini), temp 0.3, function call `build_brief_digest`
- **Role:** Brief-to-digest transformer + coverage checker

**System (`DIGEST_SYSTEM_PROMPT`):**

```
Transform questionnaire answers into a BRIEF DIGEST for fiction writers.
For each answer, extract:
1. USABLE FACTS: Specific, concrete details a writer can put into a scene
2. SCENE SEEDS: 2-3 specific scene ideas that could ONLY come from this answer
3. EMOTIONAL CORE: What this answer reveals about the person's heart

Do NOT summarize or genericize. Preserve the SPECIFIC details.
Output grouped by: PERSONALITY_ENGINE, WORLD, RELATIONSHIPS, MEMORIES, DREAMS, SIGNATURE_DETAILS.
```

**Coverage addendum appended to system (`:434-437`):**

```
ADDITIONALLY: Compare the questionnaire answers against the extracted character profiles provided. Identify any named person, dream, hobby, memory, quirk, job, or pet that appears in the answers but is MISSING from the extracted profiles. Include these as coverage_gaps in your response.
```

**User (`:465-469`):**

```
### QUESTIONNAIRE ANSWERS
"""
${questionsText}
"""

### EXTRACTED CHARACTER PROFILES
"""
${profileSummary}
"""

### TASK

1. Transform answers into structured BRIEF DIGEST with SIGNATURE_DETAILS (5-10 most unique details).
2. Compare against extracted profiles — report any MISSING elements as coverage_gaps.

Return results using build_brief_digest.
```

**Schema (`build_brief_digest`):** personality_engine[], world[], relationships[], memories[], dreams[] (each item: detail, scene_seeds[], emotional_core; relationships also person_name), signature_details[] (strings), plus extended `coverage_gaps[]` (element_type, description). Base required: personality_engine, world, relationships, memories, dreams, signature_details.

---

## A2.1 — Voice cards

- **Step/order:** A2.1 (Phase 1, voice sheet)
- **File:** system `VOICE_CARDS_SYSTEM_PROMPT` `services/writer/context/voiceSheet.js:16-31`; user `:96-105`; schema `:33-61`
- **Model/provider:** `voiceSheet` → gemini-2.5-flash (fallback gpt-5.4-mini), temp 0.5, function call `build_voice_cards`. Theme `getVoiceSheetInstructions()` appended to system.
- **Role:** Character voice-card builder

**System (`VOICE_CARDS_SYSTEM_PROMPT`):**

```
Given these character profiles, create a VOICE CARD for each major character.
For each character, provide:

1. SPEECH PATTERN: How do they talk? Short sentences or long? Formal or casual?
   Contractions or not? Complete thoughts or fragments?
2. TWO SPEECH QUIRKS: Pick exactly 2 distinctive verbal habits.
3. SIGNATURE PHRASES: 2-3 phrases they return to (max 3 uses per book)
4. BANNED WORDS: Words this character would NEVER say
5. CONFLICT RESPONSE: How do they react when challenged?
6. DIALOGUE EXAMPLES: Write 5 sample lines showing this character's voice
7. ROLE: protagonist / straight-man / catalyst / observer / comic-relief

CRITICAL RULES:
- The PROTAGONIST talks the most but their style must be distinct from AI-default
- The STRAIGHT-MAN character speaks in 1-5 words per line, zero metaphors, zero escalation
- No two characters should have the same sentence length tendency
- Children speak like children, not like articulate adults
```

**User (`:96-105`):**

```
### CHARACTER PROFILES
"""
${characterDetails}
"""
${digestContext}

### TASK

Create a VOICE CARD for each major character (skip minor characters with no personality info). Each character must have a DISTINCT voice. Ensure no two characters share the same sentence length tendency. The protagonist's voice must NOT sound like generic AI output.

Return results using the build_voice_cards function.
```

**Schema (`build_voice_cards`):** characters[] each with name, role (protagonist|straight-man|catalyst|observer|comic-relief), speechPattern, speechQuirks[], signaturePhrases[], bannedWords[], conflictResponse, dialogueExamples[], sentenceLengthTendency (short|medium|long). All required.

---

## A3.1 — Draft plan

- **Step/order:** A3.1 (Phase 2 PLAN, draft generation)
- **File:** system builder `buildPlanSystemPrompt` `services/writer/pipeline/plan.js:76-127` + `PLAN_SCHEMA_INSTRUCTION` `:31-51`; user `:433-440`
- **Model/provider:** `planner` → deepseek-v4-pro (fallback gemini-2.5-pro), temp 1.0, `textCompletion({ jsonMode: true })`. System wrapped in `buildSystemPrompt(...)` (A0) and theme `getPlanningInstructions()` inserted between plan rules and schema.
- **Role:** Manuscript-plan generator

**System core (`buildPlanSystemPrompt(sectionsPerChapter)`):**

```
You are a professional book writing plan generator. Create a DETAILED GENERATION PLAN with ONE ESCALATING PLOT that drives the entire book.

### STORY ARC REQUIREMENTS

1. ONE CENTRAL PROBLEM/GOAL introduced in Chapter 1, resolved by the final chapter
2. ESCALATING STAKES — each chapter makes the situation more difficult/urgent
3. CAUSE AND EFFECT — each chapter's events caused by the previous
4. CONTINUOUS PRESSURE — the central problem is present in every chapter
5. ONE CLIMAX in the final chapter

CHARACTER RULES:
- Use ONLY characters from the Cast List. Do NOT invent family members.
- You MAY introduce minor supporting characters who are NOT family.
- Each plot point must be a single TEXT PARAGRAPH.
- Each brief character keeps the SAME role and life stage across all chapters. Do not split or re-age them.
- When two cast members share a first name, use the bare first name in plot points where only one of them appears. When both appear in the same plot point or chapter beat, add a single clear cue if needed (the NAME DISAMBIGUATION block lists hints such as "baby Henry" or "Cubby the dog"); do not repeat heavy disambiguation in every sentence. Never copy internal metadata, nested parentheses, "owned by …", or "The Narrator" from that block into plot text.

TIMELINE: Define all stages of any process UPFRONT in Chapter 1-2. Maximum 4-5 stages. Never introduce new stages after the midpoint.

ANTAGONIST: NEVER invent external villains unless the brief explicitly mentions them. Conflict comes from real personality traits, family dynamics, and daily life.

SCENE FOCUS: Each chapter has ONE primary conflict/topic. Max 2 secondary beats.

SCENE PATTERNS (mandatory variety):
- DOMINANCE: Protagonist confronts and wins (max 40% of chapters)
- REVERSAL: Someone outplays the protagonist using her own logic
- IGNORE: Protagonist's authority gently ignored — family moves on
- AMBUSH: Emotional moment hits protagonist when guard is down
- ALLIANCE: Protagonist teams up with someone else
Must contain at least 1 REVERSAL, 1 AMBUSH, 1 IGNORE.

VARIETY:
- No two consecutive chapters: same opening_type or humor_intensity
- At least 1 LOW intensity chapter between chapters 5-8
- Emotional peak in the final 20%
- Maximum 2 chapters can use "escalation" scene structure

CHAPTER TYPES: opening (first), climax (emotional peak), standard (most), transitional (bridge, short), epilogue (final)

OUTCOME VARIETY: Protagonist wins max 60%, at least 2 LOSS, at least 1 VULNERABLE. No more than 2 consecutive WIN outcomes.

PACING: Each chapter includes at least 1 [PACING] beat (quiet, low-intensity moment).

EXTERNAL CONSEQUENCES:
- At least 2 chapters must include a moment where the protagonist's behavior causes REAL friction: a misunderstanding that isn't immediately resolved, a missed event, someone's feelings genuinely hurt, or an external situation made worse.
- "Safe resolution" is the enemy of tension. In at least 1 chapter, the protagonist must be WRONG and the consequences must linger into the next chapter.
- Internal realization alone is not a consequence. Something must change externally.

BRIEF ELEMENTS: Each chapter specifies brief_elements_to_cover using EXACT wording from SIGNATURE_DETAILS. Every signature detail must appear in at least one chapter.

EXCLUSION NOTES: Each chapter lists scenes/beats belonging to ADJACENT chapters to prevent duplication when chapters are written in parallel.

NO REAL CELEBRITY NAMES. Replace with fictional equivalents.

CONTENT SAFETY: Keep all content appropriate for general audiences.

Each chapter must have EXACTLY ${sectionsPerChapter} plot points.
```

**Schema instruction (`PLAN_SCHEMA_INSTRUCTION`):**

```
### OUTPUT FORMAT
Return ONLY a single JSON object. No prose, no markdown fences, no commentary.
Top-level shape: { "chapters": Chapter[] }

Each Chapter has these fields (all required unless noted):
- chapter_number: integer
- chapter_title: string
- plot_points: string[]
- brief_elements_to_cover: string[] (may be empty)
- exclusion_notes: string (may be empty)
- humor_intensity: string (may be empty)
- opening_type: string (may be empty)
- scene_structure: string (may be empty)
- protagonist_outcome: string
- scene_focus: string
- scene_pattern: one of "DOMINANCE" | "REVERSAL" | "IGNORE" | "AMBUSH" | "ALLIANCE"
- chapter_type: one of "opening" | "climax" | "standard" | "transitional" | "epilogue"
- character_notes: string
- protagonist_vulnerability_beat: string
- challenger_wins_moment: string

Strictly emit valid JSON. No trailing commas. No comments.
```

**User (`:433-440`):**

```
CAST LIST (COMPLETE — DO NOT ADD):
${characterDetails}

${book.userCustomInstructions ? 'USER INSTRUCTIONS:\n' + book.userCustomInstructions + '\n\n' : ''}${briefCoverageSection}${digestSection}${voiceSection}Book: ${JSON.stringify({ title, genre })}

Table of Contents:
${book.tableOfContents.map(c => `Chapter ${c.chapterNumber}: ${c.title}, Description: ${c.description}`).join('\n')}

Generate plans for ALL ${expectedCount} chapters. Each MUST have EXACTLY ${sectionsPerChapter} plot points.
```
(Retry appends: `\n\nPREVIOUS ATTEMPT FAILED: ${validation.error}. Generate ALL ${expectedCount} chapters.`)

---

## A3.2 — Plan critic

- **Step/order:** A3.2 (Phase 2, critic review)
- **File:** `CRITIC_PROMPT` `services/writer/pipeline/plan.js:131-149`; user `:507-511`
- **Model/provider:** `planCritic` → gemini-2.5-flash (fallback gpt-5.4-mini), temp 0.4, `textCompletion`. System = `buildSystemPrompt(CRITIC_PROMPT + theme.getPlanCritiqueInstructions())`.
- **Role:** Narrative-arc critic

**System (`CRITIC_PROMPT`):**

```
Analyze the OVERALL NARRATIVE ARC of this manuscript plan.

CHECK:
1. Central spine — one escalating problem?
2. Escalation — does it genuinely get harder?
3. Cause-effect chain — each chapter follows from the previous?
4. Crisis point before resolution?
5. Character consistency — no imaginary family?
6. No repeated scenes/beats across chapters?
7. Variety — no consecutive same opening_type/humor_intensity?
8. Outcome distribution — max 60% WIN, at least 1 LOSS?
9. Pattern distribution — max 40% DOMINANCE, at least 1 REVERSAL/AMBUSH/IGNORE?
10. Pacing beats in every chapter?
11. Title-content alignment?
12. Brief element coverage?
13. No real celebrity names?
14. No duplicate dramatic beats?
15. Theme variety across chapters?

Provide feedback (max 20 points).
```

**User (`:507-511`):**

```
### CAST LIST
"""
${characterDetails}
"""

${userInstructions ? '### USER INSTRUCTIONS\n"""\n' + userInstructions + '\n"""\n\n' : ''}${briefSection}### MANUSCRIPT PLAN
"""
${planJson}
"""

Analyze the narrative arc.
```

---

## A3.3 — Plan improver

- **Step/order:** A3.3 (Phase 2, plan revision)
- **File:** `IMPROVER_PROMPT` `services/writer/pipeline/plan.js:153-156`; user `:545-550`
- **Model/provider:** `planImprover` → deepseek-v4-pro (fallback gemini-2.5-pro), temp 0.7, `textCompletion({ jsonMode: true })`. System = `buildSystemPrompt(IMPROVER_PROMPT + '\n\n' + PLAN_SCHEMA_INSTRUCTION)`.
- **Role:** Manuscript-plan reviser

**System (`IMPROVER_PROMPT`):**

```
Revise the manuscript plan to address ALL feedback while maintaining requirements.

Requirements: one escalating plot, cause-effect chain, variety in openings/humor/patterns, outcome variety, pacing beats, brief element coverage, no real names.
```

**User (`:545-550`):**

```
### CAST LIST
"""
${characterDetails}
"""

${briefSection}${signatureReminder}### ORIGINAL PLAN
"""
${planJson}
"""

### FEEDBACK
"""
${feedback || 'No feedback.'}
"""

### TOC
"""
${book.tableOfContents.map(c => `Chapter ${c.chapterNumber}: ${c.title}`).join('\n')}
"""

Revise the plan to address all feedback.
```

---

## A3.4 — Title grammar fix

- **Step/order:** A3.4 (Phase 2, post-plan title cleanup)
- **File:** `services/writer/pipeline/plan.js:211-212`
- **Model/provider:** `storyBible` → gemini-2.5-flash, temp 0, `textCompletion`
- **Role:** Copy editor (JSON fix map)

**System (`:211`):** `You are a copy editor. Fix grammar in chapter titles. Return ONLY valid JSON.`

**User (`:212`):**

```
Review these chapter titles for grammar errors. Fix subject-verb agreement, singular/plural, spelling.

${titles}

Return JSON: {"3": "Fixed Title"} or {} if all correct.
```

---

## A3.5 — Invented-character detection

- **Step/order:** A3.5 (Phase 2, post-plan cast reconciliation)
- **File:** system `services/writer/pipeline/plan.js:280-290`; user `:288-290`; schema `report_new_characters` `:242-263`
- **Model/provider:** `planCritic` → gemini-2.5-flash, temp 0.1, function call `report_new_characters`
- **Role:** New-character detector

**System (`:280-287`):**

```
You are checking a manuscript plan for NEW characters that were NOT mentioned in the original brief.

RULES:
- Only report actual CHARACTER NAMES (people who speak, act, or are named as individuals).
- Do NOT report: descriptive words (Worrier, Hero), titles (Mom, Dad, Professor), pronouns (Their, She), place names (Ireland, Afghanistan), or generic references (the neighbor, a friend, the teacher) unless they have a specific name.
- Do NOT report any character already in the KNOWN CHARACTERS list.
- If no new characters were invented, return an empty array.
```

**User (`:288-290`):**

```
### KNOWN CHARACTERS FROM BRIEF
${knownNamesList}

### MANUSCRIPT PLAN
${planSummary}

Report any NEW named characters using report_new_characters. If none, return empty array.
```

**Schema (`report_new_characters`):** new_characters[] (name, role, chapters[]; required name, role).

---

## A4.1 — Chapter writer (CORE)

- **Step/order:** A4.1 (Phase 2 WRITE — the central creative call)
- **File:** system `CHAPTER_WRITER_SYSTEM` `services/writer/pipeline/draft.js:97-152`; user assembly `:340-367`; CAST block `formatCastBlockForPrompt` `:33-92`; storyBible context `getRelevantContext` `services/writer/context/storyBible.js:170-284`
- **Model/provider:** `writer` → gpt-5.4 (fallback gemini-2.5-pro), temp 0.8, `textCompletion`, maxOutputTokens 16384. System = `buildSystemPrompt(CHAPTER_WRITER_SYSTEM)` (A0 prepended), Gemini context-cached.
- **Role:** Literary fiction chapter writer

**System (`CHAPTER_WRITER_SYSTEM`):**

```
You are a literary fiction writer crafting a complete chapter of a personalized book.

WRITING PRINCIPLES:
- Write in the voice established by the voice sheet. Every sentence should sound like this specific narrator.
- Cover ALL plot points in the order given. Weave them into a single continuous narrative.
- Transitions between plot points should feel natural — not like separate sections glued together.
- Build an emotional arc within the chapter: rising tension, a turning point, and resolution or hook.
- Not every conflict resolves safely. If the plot point involves tension, let at least
  one consequence land. Someone leaves the room. A plan falls through. A feeling is hurt.
  The reader needs to feel that actions have weight.
- Open EVERY chapter in a live scene — action, dialogue, or sensory moment. NEVER open with summary or backstory.
- End with a hook or emotional beat that makes the reader want to continue.
- When you land a powerful closing line, STOP WRITING. Do not add paragraphs that
  soften, explain, or restate the ending. Trust the reader. Trust your line.

PROSE RULES:
- Show, don't tell. Action and dialogue over description and summary.
- Narration sentences: max ${SENTENCE_LIMITS.maxNarrationWords} words. Dialogue lines: max ${SENTENCE_LIMITS.maxDialogueWords} words.
- Paragraphs: max ${MAX_SENTENCES_PER_PARAGRAPH} sentences. One beat per paragraph. Break on speaker change, action shift, or topic pivot.
- Vary sentence length deliberately. Short sentences for impact. Longer ones for flow.
- No em dashes — use commas, periods, or restructure.
- No AI-tell vocabulary: never use "tapestry", "testament", "mosaic", "symphony of", "whirlwind of", "nestled", "landscape of", "mused", "a dance of", "unbeknownst".
- No formulaic transitions: never use "little did they know", "as if on cue", "it was then that".
- Ground scenes in specific sensory details — sights, sounds, textures, smells.

REPETITION RULES:
- Maximum 1 extended metaphor per chapter. Zero stacked metaphors.
- Do NOT repeat ideas, phrases, images, or emotional beats within the same chapter.
- Do NOT restate the same idea or emotional truth in different words within the same chapter.
  "Control isn't connection" and "tracking someone isn't the same as knowing them" are the SAME idea.
  State it once with your strongest phrasing, then move on.
- Do NOT use the same sentence structure more than twice in a row.
- Do NOT start consecutive paragraphs the same way.
- If the ANTI-ECHO section is provided, avoid those patterns entirely.

DIALOGUE RULES:
- Each character must sound distinct — different vocabulary, rhythm, sentence length.
- Keep speeches SHORT. No monologues. Max 3 sentences per dialogue turn.
- Use interruptions, trailing off, and half-sentences for realism.
- Attribution: prefer action beats ("She set down the cup.") over "she said" when possible.

PRONOUN RULES:
- Follow the CAST block exactly. Every pronoun must match the listed pronouns for each person.
- When two characters of the same gender are in a scene, use names more often to avoid ambiguity.

CHARACTER ROLE RULES:
- Each name in the CAST has ONE relationship and ONE life stage. Never portray the same person as both an adult and a child within or across chapters.
- When two CAST members share a first name, use the bare first name whenever only one of them is in the scene. When both are in the same scene, clarify once if needed (examples in the NAME DISAMBIGUATION block are hints only), then write naturally — do not hammer the same "Name the dog" phrase throughout. Never paste internal parentheses, "owned by …", or "The Narrator" from that block into the manuscript.

NAME ORDER RULES — STRICT:
- Use each character's name EXACTLY as it appears in the CAST block. Never reorder, swap, or "naturalize" the order of name tokens.
- If the CAST says "Grannie Annie", write "Grannie Annie" — NEVER "Annie Grannie". If the CAST says "Mamaw Carrie", write "Mamaw Carrie" — NEVER "Carrie Mamaw".
- Familial titles like "Grannie", "Granny", "Mamaw", "Nana", "Papaw", "Pop-Pop", "Grandma", "Grandpa" stay in the position the CAST shows. Do not assume the title belongs after the given name just because that feels more standard.
- Short-form references are fine ("Annie said", "Grannie smiled") — but whenever you write the full name, use the CAST's exact ordering.

OUTPUT: Write ONLY the story text. No meta-commentary, no section headers, no plot point labels, no instructions.
```

**User assembly (`:340-367`):**

```
Write the COMPLETE Chapter ${chapterNum}: "${chapterTitle}"

${themeWritingInstructions}

${bibleContext}

### PLOT POINTS (cover ALL in this order, weave into one continuous narrative)
1. ${plotPoints[0]}
2. ${plotPoints[1]}
... (numbered list of all plot points)

${castBlock}

${voiceCardsBlock}

${rulesBlock}

${chapterPlan.exclusion_notes ? '### DO NOT INCLUDE\n' + exclusion_notes + '\n\n' : ''}${previousChaptersText ? '### ANTI-ECHO (do not repeat these patterns)\n"""\n' + previousChaptersText.slice(-3000) + '\n"""\n\n' : ''}WORD COUNT: Write between ${minWords} and ${maxWords} words. Under ${minWords} = rejected. Over ${maxWords} = rejected.
```

**CAST block (`formatCastBlockForPrompt`, `:74-84`)** — assembled string:

```
### CAST (the only living-being proper nouns for this book)

PEOPLE
- ${full} (${relationship, lifeStage}, ${pronouns}) — ${hobbies joined by '; '}
...

ANIMALS / PETS (NOT people — never the subject of human-only actions like kissing goodbye, driving someone to work, or speaking as a spouse)
- ${petName} (${species}) — ${owner}'s pet. ${notes}
...

RULES
- Use only the names above for living beings. Do not invent new proper nouns for people or pets.
- If a name has an obvious short form in this cast or the brief (e.g. Theodore / Theo), pick one form and use it consistently throughout the book.
- Each name in the CAST has ONE relationship and ONE life stage. Never portray the same person as both an adult and a child. If the plot needs a different-aged character with the same name, use a distinct display label.
- Each character keeps the same hobbies, sports, and interests across the entire book. Do not switch them between chapters (e.g. soccer → football). If a character has no listed interest, do not invent a new one in a later chapter.
```
(Followed by an optional NAME DISAMBIGUATION block from `formatDuplicateNamesBlock`.)

**StoryBible relevant context (`getRelevantContext`, `:170-284`)** — composed of these section headers (capped ~2000 chars), each filled with computed data:

```
### PREVIOUS CHAPTER ENDING
Chapter ${chapterNum - 1} ("${prevChapter.title}") ended with:
"""
${lastFew}.
"""
Continue naturally. Do NOT re-summarize previous events.

### FACTS TO MAINTAIN
- ${fact} (Ch.${chapter})

### EMOTIONAL REVELATIONS ALREADY MADE (DO NOT REPEAT)
- "${beat}" (Ch.${chapter})
BUILD on them with new consequences.

### STORY SO FAR (Chapter ${chapterNum} of ${totalChapters} — carry this thread forward; do not re-write these scenes)
- Ch.${n}: ${summary}
This chapter must move the arc forward from where it stands.

### METAPHOR DOMAINS USED
- "${domain}" (${count}x)
Choose FRESH figurative language.

### OVERUSED ACTIONS
- "${action}" (${count}x)
Choose a DIFFERENT physical gesture for anxiety/habit in this chapter.

### SIGNATURE PHRASE BUDGET
- "${phrase}": EXHAUSTED   /   - "${phrase}": ${remaining} uses left
```

---

## A4.2 — Chapter continuation

- **Step/order:** A4.2 (Phase 2, runs only if chapter < 70% of min words)
- **File:** `services/writer/pipeline/draft.js:400-407`
- **Model/provider:** `writer` → gpt-5.4 (fallback gemini-2.5-pro), temp 0.8, maxOutputTokens 8192. Same system prompt as A4.1.
- **Role:** Chapter continuation writer

**User (`:400-407`):**

```
Continue writing Chapter ${chapterNum}: "${chapterTitle}"

${themeWritingInstructions}

${castBlock}
### CHAPTER SO FAR
"""
${chapterText}
"""

### REMAINING PLOT POINTS TO COVER
1. ${remainingPlotPoint}
...

Continue SEAMLESSLY from where the text left off. Write until the chapter has a satisfying ending.
TARGET: reach at least ${minWords} total words.
```

---

## A4.3 — StoryBible chapter extraction

- **Step/order:** A4.3 (Phase 2, after each chapter — records facts/beats)
- **File:** system `services/writer/context/storyBible.js:460`; user prompt `:442-456`
- **Model/provider:** `storyBible` → gemini-2.5-flash, temp 0.2, `textCompletion`, maxOutputTokens 2000
- **Role:** Story analyst (JSON extraction)

**System (`:460`):** `You are a story analyst. Return ONLY valid JSON, nothing else.`

**User (`:442-456`):**

```
Analyze this chapter and return a JSON object with three fields:

1. "summary": 2-3 sentence summary of KEY SCENES and EVENTS (what physically happened, where, which characters)
2. "facts": Array of specific factual claims that must stay consistent (ages, dates, relationships, locations, jobs, life/death status, physical descriptions)
3. "emotional_beats": Array of major emotional revelations, confessions, or physical emotional reactions (prefix physical ones with "[PHYSICAL]")

Characters: ${castNames || 'N/A'}

CHAPTER TEXT:
"""
${chapterText.slice(0, 8000)}
"""

IMPORTANT: Return ONLY valid JSON on a single line. All string values must be on one line (no newlines inside strings).
Format: { "summary": "...", "facts": ["..."], "emotional_beats": ["..."] }
```

---

## A4.4 — Incremental dedup

- **Step/order:** A4.4 (Phase 2, after each batch on recent chapters)
- **File:** system `services/writer/pipeline/draft.js:466-475`; user `:476-478`
- **Model/provider:** `storyBible` → gemini-2.5-flash, temp 0.2, `textCompletion`, maxOutputTokens 4096
- **Role:** Deduplication editor (FIND/REPLACE)

**System (`:466-475`):**

```
You are a deduplication editor. Find and fix REPEATED phrases, ideas, metaphors, and sentence patterns.

RULES:
- Only fix genuine repetitions — same idea expressed multiple times, echoed phrases, repeated metaphors.
- IDEA ECHOES: Two sentences that make the same emotional point in different words count as duplication. Keep the stronger one, remove the weaker.
- Do NOT rewrite for style. Do NOT change meaning.
- For each fix, output FIND/REPLACE blocks with the EXACT text to find and its replacement.
- Replacements should remove the duplicate while keeping the text flowing naturally.
- If removing a sentence entirely, REPLACE with empty string.
- Check ACROSS chapters too — same image or phrase appearing in multiple chapters.
```

**User (`:476-478`):**

```
${priorContext ? '### PRIOR CHAPTER ENDINGS (for cross-chapter dedup)\n' + priorContext + '\n\n' : ''}### RECENT CHAPTERS TO DEDUP
${recentText}

Find duplicates and output FIND/REPLACE blocks. If clean, output "NO_CHANGES".
```

---

## A5.1 — Final scan

- **Step/order:** A5.1 (Phase 3 FINISH — detection-only quality scan)
- **File:** system `services/writer/pipeline/revise.js:96-106`; user `:107-111`; schema `report_book_issues` `:26-55`
- **Model/provider:** `finalScan` → gemini-2.5-flash, temp 0.2, function call `report_book_issues`, maxOutputTokens 4096
- **Role:** Book quality reviewer (detection only — no rewrite)

**System (`:96-106`):**

```
You are a book quality reviewer. Scan these chapter excerpts and report any issues.

CHECK FOR:
1. CONTINUITY: Name/fact contradictions across chapters (e.g., eye color changes, timeline errors)
2. PRONOUNS: Wrong pronoun for a character based on the cast list
3. REPETITION: Same phrase, metaphor, or sentence opening repeated across multiple chapters
4. MISSING BRIEF: Signature details from the brief that don't appear in any excerpt
5. BROKEN TEXT: Incomplete sentences, orphaned dialogue, or formatting errors
6. NAME COLLISION: Two CAST members share a first name and the text fails to disambiguate them (use type "name_collision").
7. ROLE CONSISTENCY: A CAST member is portrayed with contradictory relationships or life stages across chapters — e.g. an adult in one chapter and a toddler in another (use type "role_consistency").
8. OVERSTACKED PARAGRAPHS: A paragraph crams more than 6 sentences together without breaks (use type "overstacked_paragraph").

Only report REAL issues. Do not invent problems. If the book is clean, return an empty issues array.
```

**User (`:107-111`):**

```
### CAST
${castList}

${dupBlock ? dupBlock + '\n\n' : ''}### CHAPTER EXCERPTS
${excerpts}
${sigDetails}

Scan and report using report_book_issues.
```

**Schema (`report_book_issues`):** issues[] (type [continuity|pronoun|repetition|missing_brief|broken_text|name_collision|role_consistency|overstacked_paragraph], chapter, severity [low|medium|high], description) + overall_quality (1-10 int). Required: issues, overall_quality.

---

## A6 — Theme fragments

These are *fragments* injected into the A-flow prompts above (planning, critique, writing, voice sheet) per active theme. Models inherited from the calling step.

### A6-comedy (`services/writer/themes/comedy.js`)

**`getVoiceSheetInstructions()` (`:27-34`)** — appended to A2.1 system:

```
COMEDY VOICE REQUIREMENTS:
- The protagonist's voice must have a SPECIFIC comedy style: deadpan, self-deprecating, observational, or absurdist. Pick ONE and commit.
- The straight-man character speaks plainly: short sentences, no metaphors, no escalation.
- At least one character should be a "reactor" — their facial expressions and body language ARE the punchline to the protagonist's setups.
- Children's dialogue should be accidentally funny, not written-to-be-funny.
```

**`getPlanningInstructions()` (`:39-78`)** — appended to A3.1 system:

```
### COMEDY PLANNING RULES

RUNNING GAGS:
- Establish 2-3 running gags in the first 3 chapters.
- Each gag must ESCALATE: the second appearance is bigger, the third is the biggest.
- At least one gag must have a CALLBACK in the final chapter that recontextualizes it.
- Running gags must involve SPECIFIC objects or behaviors, not abstract concepts.

COMEDY STRUCTURE:
- The humor comes from the SPECIFICITY of this person's life, not from generic joke structures.
- Every chapter needs at least one moment where the reader can visualize the exact scene.
- Comedy beats should follow: SETUP (establish normal) → ESCALATION (normal goes wrong) → PAYOFF (consequences are specific and surprising).
- Do NOT stack multiple joke setups without payoffs. Each setup must pay off within the same chapter.

EMOTIONAL CONTRAST (CRITICAL FOR COMEDY):
- The funniest chapter must be followed by the most sincere chapter.
- The emotional peak of the book should land HARDER because of the comedy around it.
- At least 2 chapters should have LOW humor intensity — these earn the comedy elsewhere.
- A funny moment followed by a genuine moment is more powerful than two funny moments in a row.

THE STRAIGHT-MAN RELATIONSHIP:
- The primary relationship person (spouse, partner, best friend) is the straight-man.
- The straight-man must have their own arc: they aren't just reacting to the protagonist.
- At least one chapter where the straight-man has the funniest moment (role reversal).
- The straight-man's patience should have limits that create real (not comedy) tension.

RULE OF THREE:
- When listing examples, always aim for 3: two that establish the pattern, one that breaks it.
- The third item should be the surprise, the escalation, or the absurd one.

MISDIRECTION:
- At least 2 chapters should set the reader up to expect one thing and deliver another.
- The misdirection should be CHARACTER-driven: the character's quirk leads them somewhere unexpected.

CATCHPHRASES AND CALLBACKS:
- If a character has a catchphrase, limit to 2-3 uses max across the entire book.
- The final use should be the most meaningful (emotional, not just comedic).
- At least 3 callbacks to earlier chapters in the final third of the book.
```

**`getPlanCritiqueInstructions()` (`:80-88`)** — appended to A3.2 system:

```
COMEDY-SPECIFIC CRITIQUE:
- Are running gags established early and do they escalate?
- Does the emotional contrast work (funny chapters next to sincere ones)?
- Is the straight-man character fully developed, not just a reactor?
- Are there callbacks to earlier content in the final third?
- Is humor coming from specificity or from generic joke structures?
- Are there at least 2 LOW humor-intensity chapters?
```

**`getWritingInstructions(chapterPlan)` (`:111-143`)** — prepended to A4.1 user. Base block plus an intensity-specific tail (LOW or HIGH):

```
### COMEDY WRITING RULES

HUMOR SOURCE: The humor must come from the SPECIFICITY of this person's life.
- What makes this funny is that it could only happen to THIS person in THIS situation.
- Generic observations ("marriage, am I right?") are forbidden. Be specific.
- The funniest line in each scene should be something only this character would say or do.

COMEDY MECHANICS:
- After the funniest moment in a scene, write ONE plain sentence, then move on.
- Do not stack jokes. One per paragraph max. Let situations be funny.
- Never explain why something is funny.
- The straight-man character's REACTION is often funnier than the protagonist's action.
- Dialogue is funnier than narration. Let characters be funny through what they say.

COMEDY RESTRAINT:
- Not every paragraph needs to be funny. Functional paragraphs that move the story are essential.
- After a big comedic set-piece, allow a full paragraph of normalcy before the next joke.
- If you catch yourself writing an extended analogy — stop. Cut it to one sentence.

[if LOW] CHAPTER INTENSITY: LOW
This chapter is primarily sincere. Humor should be warm and gentle, not aggressive or absurd. Focus on genuine human moments. Any humor should come from character, not situations.

[if HIGH] CHAPTER INTENSITY: HIGH
This chapter is a comedy set-piece. Escalation is expected but must still be grounded. The situation should get increasingly absurd while the characters remain recognizably human.
```

(Also defined: `getRevisionInstructions()` `:145-151`, `getQualityGateInstructions()` `:181-188`, `getProseRules()` `:192-198` — used by dormant/quality passes.)

### A6-memoir (`services/writer/themes/memoir.js`)

**`getVoiceSheetInstructions()` (`:27-35`):**

```
MEMOIR VOICE REQUIREMENTS:
- The narrator's voice has TWO registers: the EXPERIENCING SELF (in-the-moment, present tense emotions) and the REFLECTING SELF (looking back with wisdom and perspective).
- The experiencing self is vivid and immediate. The reflecting self is warm and wiser.
- Other characters' voices should be distinct but filtered through the narrator's memory — slightly idealized, slightly compressed, the way we actually remember people.
- The narrator should have verbal tics that ground the voice: specific word choices, sentence rhythm patterns, recurring phrases that feel organic.
```

**`getPlanningInstructions()` (`:40-93`):**

```
### MEMOIR PLANNING RULES

CRITICAL: THIS IS A MEMOIR, NOT A NOVEL.
Plan the entire book in FIRST PERSON. The narrator tells their own story using "I."
All chapter summaries should use "I" — not "she" or "he."

THE CONTROLLING QUESTION:
Every memoir has a central question the narrator is trying to answer by telling this story.
- Identify it from the brief: "Why did I become who I am?" / "What did that relationship really mean?" / "How did I survive that period of my life?"
- The controlling question should be hinted at in Chapter 1 and answered (or accepted) in the final chapter.
- Every chapter should advance the reader's understanding of the answer.

SCENE VS. REFLECTION BALANCE:
- Good memoirs alternate between SCENE (dramatic, in-the-moment, dialogue-driven) and REFLECTION (narrator looking back with perspective).
- Each chapter should contain both, but in different proportions:
  - Scene-heavy chapters (70% scene / 30% reflection) for dramatic moments
  - Reflection-heavy chapters (30% scene / 70% reflection) for transitional periods
- Never an entire chapter of pure scene OR pure reflection.

THE DUAL NARRATOR:
- The EXPERIENCING SELF tells what happened (immediate, present-tense emotions)
- The REFLECTING SELF tells what it meant (wisdom, hindsight, humor about past self)
- Include at least one "What I didn't know then..." or "Looking back, I realize..." per chapter. These are the connective tissue of memoir.

TEMPORAL COMPRESSION:
- Time does NOT move linearly in memoir. Some years get a paragraph. Key moments get pages.
- Each chapter should cover a PERIOD (a summer, a year, a season of life), not just one scene.
- Anchor each chapter with 2-3 vivid, fully-dramatized memories connected by reflective tissue.

EMOTIONAL ARC (THREE-ACT):
ACT 1 (Chapters 1-4): ESTABLISHING THE SELF
- Who I was. The world I lived in. The people who shaped me.
- Warmth and nostalgia dominant. The reader falls in love with this world.

ACT 2 (Chapters 5-10): THE CHALLENGE
- Something tests who I thought I was. Growth, loss, change, revelation.
- Complexity enters. The narrator's understanding deepens.
- At least 2 chapters where the narrator is wrong about something important.

ACT 3 (Chapters 11-end): UNDERSTANDING
- What I learned. How I changed. What I carry forward.
- The controlling question is answered (or accepted as unanswerable).
- The final chapter should feel like arrival, not summary.

REAL STAKES:
- At least 2 chapters where the narrator's behavior causes friction that doesn't resolve within the same chapter. Memoir without cost is nostalgia, not truth.

VULNERABILITY:
- The narrator must admit fault in at least 3 chapters. Memoir without vulnerability is PR.
- Show the narrator being wrong, unkind, afraid, or foolish — with compassion, not self-flagellation.
- The most powerful moments in memoir are when the narrator risks embarrassment for truth.
```

**`getPlanCritiqueInstructions()` (`:96-104`):**

```
MEMOIR-SPECIFIC CRITIQUE:
- Is there a clear controlling question driving the memoir?
- Is everything in first person ("I"), not third person?
- Does each chapter have both scene and reflection?
- Is there temporal compression (not every chapter = one event)?
- Does the narrator show vulnerability (admitting fault, being wrong)?
- Is there a clear three-act emotional arc?
- Does the final chapter answer or accept the controlling question?
```

**`getWritingInstructions(chapterPlan)` (`:138-194`)** — base block + scene-structure tail (REFLECTION-HEAVY or SCENE-HEAVY):

```
### MEMOIR WRITING RULES

CRITICAL: Write ENTIRELY in first person. The narrator is "I."
This is not a novel with a character. This is someone telling you their life.

THE DUAL NARRATOR:
- EXPERIENCING SELF: Write the scenes as if you are living them right now. Use present-tense emotions even in past-tense narration. "I walked into the kitchen and my stomach dropped" — not "I had felt nervous."
- REFLECTING SELF: Between scenes, add brief reflective passages. "What I didn't know then was that this would be the last summer..." "Looking back, I think that moment was when everything shifted."
- The reflecting self should appear at least once per chapter but never dominate.

SCENE CRAFT:
- Each scene needs a SPECIFIC PHYSICAL ANCHOR: an object, a place, a sensory detail that makes this memory REAL.
- Dialogue in memoir should sound slightly compressed — the way we actually remember conversations. Not every word, but the words that mattered.
- Show the narrator's state of mind through action, not through telling: "I reorganized the spice rack for the third time" beats "I was anxious."

TEMPORAL MOVEMENT:
- You can compress time within a chapter: "That whole summer, I..." / "By October..." / "Three years later, when I finally..."
- Time jumps should feel natural, not jarring. A reflective sentence bridges them.
- Not every moment needs to be dramatized. Some memories work better as summary.

VULNERABILITY REQUIREMENT:
- In this chapter, find at least one moment where the narrator admits to being wrong, scared, selfish, or foolish.
- Write it with compassion, not self-pity. The reader should feel warmth, not discomfort.

EMOTIONAL TRUTH:
- Every chapter should end with the reader knowing something about the narrator's inner life that they didn't know at the start.
- The emotional core of each chapter is WHAT IT MEANT, not just WHAT HAPPENED.

REFLECTION DISCIPLINE:
- Each reflective passage is 1-3 sentences. Never a full paragraph of rumination.
- NEVER follow a reflection with a rephrased version of the same reflection.
- The reflecting self earns ONE observation per scene. Make it count.

[if reflective] CHAPTER MODE: REFLECTION-HEAVY
This chapter leans reflective. Anchor it with 1-2 specific scenes, but let the narrator's voice and perspective carry most of the weight.

[if dialogue-driven/action-driven] CHAPTER MODE: SCENE-HEAVY
This chapter is dramatic and immediate. Lean into specific scenes, dialogue, and action. Reflection should be brief and emerge naturally.
```

(Also defined: `getRevisionInstructions()` `:196-203`, `getQualityGateInstructions()` `:238-246`, `getProseRules()` `:250-256`.)

### A6-base (`services/writer/themes/base.js`)

**`getStyleInjection(stylePromptInjection)` (`:91-97`)** — appended when an author style is supplied:

```
### AUTHOR STYLE VOICE (OVERRIDE)

You are writing in a SPECIFIC author's style. This OVERRIDES the default voice.
The style rules below take priority over any conflicting voice/humor instructions above.

${stylePromptInjection}
```

---

## A7 — Dormant prompts (DEFINED-BUT-NOT-WIRED)

These quality-pass prompts are defined in `services/writer/quality/` but are **not wired into the active pipeline** (the live pipeline ends at A5.1 final scan, which is detection-only). System prompts captured verbatim; long FIND/REPLACE user templates summarized.

### A7.1 — Compress (`quality/compress.js`)

**System `COMPRESS_SYSTEM` (`:20-43`):**

```
You are a prose editor tightening fiction text. Your goal is to reduce word count while preserving all story content, character voice, and emotional impact.

REMOVE:
- Filler phrases ("in fact", "it seemed as though", "for some reason")
- Unnecessary adjectives and adverbs (keep only the strongest)
- Redundant explanation after a strong line or joke
- Sentences that repeat an idea already expressed
- Purple prose and overwritten descriptions
- Unnecessary "he thought" / "she felt" attribution when the POV is clear

PRESERVE:
- All plot events, character actions, and dialogue exchanges
- Character voice and speech patterns
- Strong imagery and unique phrasing
- Emotional beats and turning points
- Scene transitions and chapter flow
- Every named character must still appear

SENTENCE RULES:
- Narration sentences max ${SENTENCE_LIMITS.maxNarrationWords} words
- Dialogue lines max ${SENTENCE_LIMITS.maxDialogueWords} words
- Break long sentences into shorter ones when needed

Output ONLY the compressed text. No commentary, no explanations.
```

**User (`:92-93`, summarized):** `Compress this chapter from ~${chapterWords} words to ~${targetWords} words (${targetPct}% reduction).` followed by the chapter text in triple quotes. Model `prosePolish`, temp 0.3.

### A7.2 — Dedup Tier-3 LLM (`quality/dedup.js:160-164`)

**System (`:160-161`):**

```
You are an editor removing repetitive phrases. Use surgical FIND/REPLACE format. Only fix genuine repetitions — do not rewrite style.
```

**User (`:162-164`, summarized):** `Remove repeated phrases, sentence structures, and word clusters from this chapter.` + chapter text + `Output ONLY FIND/REPLACE blocks:\nFIND: exact text\nREPLACE: replacement\n\nIf no duplicates, output "NO_CHANGES".` Model `dedup`.

### A7.3 — Pronouns (`quality/pronouns.js:109-125`, user `:130`)

**System (assembled, `:109-125`):**

```
You are a pronoun accuracy editor. Check that every pronoun in NARRATION matches the correct gender for each character.

${registryBlock}

CRITICAL RULES:
1. Only fix pronouns in NARRATION, not inside dialogue (text within quotes "...").
   Characters may correctly use any pronoun when speaking about third parties.
2. Be EXTREMELY careful when two same-gender characters appear in the same scene.
   Only fix a pronoun if you are CERTAIN which character it refers to.
3. "her" can be possessive (her book) or object (saw her). Check context carefully.
4. Do NOT change style, wording, or anything other than wrong pronouns.
5. When unsure, DO NOT FIX. A wrong "fix" is worse than a missed error.

${sameGenderWarnings ? 'SAME-GENDER WARNING:\n' + warnings + '\n\n' : ''}For each fix, output:
---EDIT---
FIND: exact wrong text (include surrounding words for context)
REPLACE: corrected text
CONFIDENCE: 0.0-1.0

If all pronouns are correct, output "NO_FIXES_NEEDED".
```

**User (`:130`):** `Chapter ${chapterNumber}:\n"""\n${chapterText}\n"""\n\nCheck all pronouns in narration only.` Model `pronouns`.

### A7.4 — Prose passes (`quality/prose.js`)

Multiple sibling prose passes, each `textCompletion` with a short system prompt and a FIND/REPLACE or full-rewrite user template (summarized).

- **Voice enforcer (`:66-75`):** `You are a voice consistency editor. Your job is to ensure dialogue matches character voice cards.` + RULES (fix off-voice dialogue, don't rewrite narration, minimal changes, output COMPLETE chapter, unchanged if clean) + appended `formatVoiceCardsForEdit(voiceCards)`. Model `voiceEnforcer`.
- **Overwritten/long-dialogue fixer (`:175-177`):** `You are a prose editor. Fix overwritten paragraphs and long dialogue lines. Use surgical FIND/REPLACE format. Preserve meaning and voice.` Model `prosePolish`.
- **Observation-critique pattern remover (`:259-262`):** `Remove the observation-and-critique pattern from this paragraph. Replace with a brief action or transition that connects smoothly to surrounding paragraphs. Output ONLY the rewritten paragraph.` Model `prosePolish`, temp 0.3.
- **Protagonist last-word rebalancer (`:304-308`):** `Rewrite this exchange so a different character gets the final line. The protagonist should NOT have the last word. Output ONLY the rewritten exchange. The rewritten text MUST end with a complete sentence and proper punctuation.` temp 0.5.
- **Rhythm/monotone fixer (`:442-445`):** `You are a prose rhythm editor. This paragraph has monotonous sentence lengths (all ~same word count). Vary the rhythm: mix short punchy sentences (3-8 words) with medium ones (10-20) and an occasional longer one. Preserve meaning, voice, and content. Output ONLY the rewritten paragraph.` temp 0.5.
- **On-the-nose dialogue fixer (`:520-523`):** `You are a dialogue editor. Fix on-the-nose dialogue that states emotions directly. Replace with subtext — actions, silences, deflections, or indirect speech that implies the emotion.` (User FIND/REPLACE.) temp 0.5.
- **Long-sentence splitter (`:595-598`):** `You are a sentence editor. Split long sentences into shorter, punchier ones. Preserve all meaning, voice, and content. Output FIND/REPLACE blocks.` temp 0.3.
- **Repeated-opening fixer (`:670-673`):** `You are a prose variety editor. Fix repeated sentence openings by varying the structure. Keep voice and meaning intact. Output FIND/REPLACE blocks.` temp 0.5.
- **Omnibus fixer (`:829-840`):**

```
You are a prose editor. Fix ALL of the following issues in the chapter.

RULES:
- Preserve the author's voice and all story content.
- Only change what is specifically flagged.
- For rhythm fixes, vary sentence lengths.
- For dialogue, keep character voice but shorten.
- For overwriting, reduce to max 1 simile and 1 metaphor per paragraph.
- Output the COMPLETE edited chapter text.
- If nothing needs fixing, output the chapter text unchanged.
```
(User: chapter text + `## ISSUES TO FIX (${issues.length} categories)` + flagged items + `Output the FULL chapter text with all fixes applied.`) temp 0.4.

### A7.5 — Safety review (`quality/safetyReview.js`)

**Per-chapter safety (`:62-71`):**

```
You are a final safety reviewer for a book chapter. Check for and fix:

1. PRONOUN ERRORS: Wrong he/she/they for known characters. Use the character list below.
2. BROKEN TEXT: Orphaned words, incomplete sentences, sentences that start mid-thought.
3. FORMATTING: Unclosed quotes, orphaned dialogue tags, broken paragraph boundaries.
4. CONTINUITY WITHIN CHAPTER: A character doing something impossible given what happened earlier in the same chapter.

If you find issues, output the COMPLETE chapter text with fixes applied.
If the chapter is clean, output it UNCHANGED.
Do NOT rewrite for style. Only fix errors.

### CHARACTERS
${characterContext}
```
(User: `### Chapter ${n}: "${title}"` + chapter text.) Model `safetyReview`.

**Cross-chapter structural review (`:125-132`):**

```
You are a structural reviewer checking a book for cross-chapter issues.

Check for:
1. STRUCTURAL DUPLICATION: Two chapters that cover essentially the same ground
2. REPEATED EMOTIONAL BEATS: The same revelation, confession, or emotional climax in multiple chapters
3. OVERUSED MOTIFS: A metaphor, image, or phrase that appears in too many chapters
4. TONAL REPETITION: Multiple consecutive chapters with the same emotional register

Output a brief report. List ONLY actual problems found. If the book is clean, say "NO_ISSUES".
```
(User: `### CHAPTER SUMMARIES` + per-chapter opening/ending excerpts.)

---

# FLOW B — ILLUSTRATIONS (`services/agents/illustrationAgent.js`)

## B1 — Scene selection

- **Step/order:** B1 (one scene chosen per chapter)
- **File:** system `buildSceneSelectionSystemPrompt` `:60-66`; user `buildSceneSelectionPrompt` `:180-202`; schema `select_illustration_scene` `:68-93`; styles `ART_STYLES` `:19-45`
- **Model/provider:** Gemini (function/JSON) — uses `sceneGuidance` from the genre-resolved art style
- **Role:** Visual director (scene picker)

**System (`:63-66`):**

```
You are a visual director selecting scenes for black-and-white book illustrations. Pick the single most visually striking, concrete moment from the chapter text.

Genre guidance: ${sceneGuidance}
```

**`ART_STYLES` (`:19-45`)** — `{style, sceneGuidance}` per category:

```
adult.style: Sophisticated editorial ink illustration in the tradition of classic New Yorker magazine illustrations. Fine pen-and-ink work with elegant cross-hatching and confident contour lines. Use fine hatching for shadows, bold contour lines for figures, and stippling for subtle textures. Refined composition with generous negative space. Reminiscent of the work of Edward Gorey or Charles Addams — precise, atmospheric, with understated wit in the details.
adult.sceneGuidance: Pick emotionally resonant, character-driven moments. Favour nuanced interactions, contemplative scenes, or dramatic turning points over action sequences.

children.style: Whimsical pen-and-ink book illustration in the tradition of Quentin Blake or Roald Dahl illustrations. Playful, energetic linework with expressive characters and slightly exaggerated proportions. Loose but confident ink strokes, charming cross-hatching for depth, and lively compositions full of movement and personality. Warm storybook feel with a hand-drawn quality.
children.sceneGuidance: Pick moments of wonder, discovery, humour, or friendship. Favour scenes with clear visual storytelling that a young reader can immediately understand.

ya.style: Dynamic graphic-novel-style ink illustration inspired by manga-influenced Western comics. Bold confident linework with dramatic contrast and cinematic framing. Sharp character rendering with selective cross-hatching for depth. Strong use of negative space and dramatic angles. Energetic and visually striking.
ya.sceneGuidance: Pick high-energy or emotionally intense moments — confrontations, revelations, or pivotal character beats. Favour cinematic compositions with dramatic angles.
```

**User (`buildSceneSelectionPrompt`, `:180-202`):**

```
Read this chapter and select ONE specific visual moment that would make a striking book illustration.

Rules:
- Pick a CONCRETE moment (a person doing something in a place), not an abstract concept
- Focus on what can be SEEN, not what is felt or thought
- Prefer moments with character interaction or emotional weight
- The scene must be describable in 2-3 sentences of visual detail

Chapter title: "${chapter.title}"
Chapter text:
"""
${chapter.text}
"""

Main character description: ${characterDescription}

Return JSON:
{
  "scene": "2-3 sentence visual description of the moment",
  "mood": "one of: warm / dramatic / humorous / nostalgic / tense / calm / inspirational",
  "environment": "brief setting description (indoor/outdoor, time of day, key objects)",
  "composition": "suggested framing (e.g. medium shot, close-up, wide establishing shot)"
}
```

**Schema (`select_illustration_scene`, `:68-93`):** scene, mood, environment, composition (all required, descriptions as above).

## B2 — Image generation

- **Step/order:** B2 (image render from selected scene)
- **File:** prompt `buildIllustrationPrompt` `:140-173`; character lock `buildCharacterDescriptionLock` `:99-135`
- **Model/provider:** Gemini image model (`gemini-2.5-flash-image` fallback) with child photo reference
- **Role:** Image-generation prompt

**Character description lock (`:116-134`)** — assembled per character: `- ${fullName} (${relationship}) | Gender: ${gender} | Traits: ${topTraits}`, optionally prefixed `Main character — Age: ${age}` and always suffixed `Do NOT alter their age.`

**Image prompt (`buildIllustrationPrompt`, `:144-173`):**

```
Create a BLACK-AND-WHITE pencil sketch / ink drawing for a printed book interior (NO colour, NO gray tones).

STYLE:
${style}
Medium: black ink on white paper. Traditional pen-and-ink illustration style — hatching and cross-hatching for shading, no washes, no gradients, no digital colouring, no greyscale fills.
Maintain consistent line weight throughout — medium for contours, fine for details and hatching, bold for emphasis. All shading through ink techniques only: hatching, cross-hatching, stippling. No digital gradients or fills.

VISUAL CONSISTENCY:
Maintain consistent character design, proportions, and artistic style across all illustrations in the book. Use the reference photo to match the main character's appearance, build, and features. Do NOT alter their age.

CHARACTERS:
${characterDescriptionLock}

SCENE:
Chapter ${chapterNumber}: ${sceneData.scene}

COMPOSITION:
${sceneData.composition}
Use rule-of-thirds placement for the main subject. Include meaningful foreground and background elements that establish the setting. Leave intentional negative space for visual breathing room.

MOOD / TONE:
${sceneData.mood}

ENVIRONMENT DETAILS:
${sceneData.environment}

RESTRICTIONS:
No text, no typography, no colour/color, no photorealism, no modern UI elements. BLACK AND WHITE INK DRAWING ONLY — like a pencil sketch or woodcut print.

Ensure stylistic and character consistency with previous chapter illustrations.
```

---

# FLOW C — COMICS (`services/comics/`)

## C1 — planComicScript

- **Step/order:** C1 (panel-script planning, per section)
- **File:** system `buildPlannerSystemPrompt` `scriptPlanner.js:411-444`; user `buildSectionUserPrompt` `:731-772`; schema `generate_comic_panel_script` `:297-387`
- **Model/provider:** function call `generate_comic_panel_script`; system wrapped in `buildSystemPrompt` (A0). Theme provides `getComicTone()`, `getStagingRules()`, `getPlanningInstructions()`.
- **Role:** Comic-book showrunner (panel-script planner)

**System (`buildPlannerSystemPrompt`, `:434-443`)** — base text + injected theme tone/staging/planning + HARD CONSTRAINTS:

```
You are a comic-book showrunner planning the PANEL SCRIPT for an admin-only adult-leaning gift comic. Your output is a director's blueprint — every panel lists who is in it, how it is framed, the comedy beat it carries, and the spoken lines.

${tone}

${staging}

${planning}

### HARD CONSTRAINTS (NON-NEGOTIABLE)

1. ONE CONTINUOUS ADVENTURE with continuity from page 1 to the final page.
2. Every character in the CAST ROSTER must appear in `cast` on at least ONE panel.
3. Every character must get at least ONE panel with `beat_type === "spotlight"`
   AND have their characterId listed in `is_hero_panel_for` on that panel.
4. Allocate `is_hero_panel_for` so EVERY character reaches their `heroPanelsTarget`
   (default 2) HERO panels distributed across the book (not bunched).
5. No panel may list more than 4 characterIds in `cast`. If a beat needs more,
   SPLIT it across consecutive panels.
6. LENGTH (MANDATORY): this is a FULL graphic novel, not a pamphlet. Emit AT LEAST ${budget.targetPanels} panels total (target ≈ ${budget.interiorPages} printed interior pages). Spread them across ~${budget.targetStoryPages} script pages at 4–6 panels per page. Do NOT stop early or summarize — keep writing distinct beats until you have at least ${budget.targetPanels} panels, sustaining the arc (setup → escalation → climax → payoff) across the entire book.
7. Use ONLY characterIds from the CAST ROSTER. Do not invent characters.
8. Running gags must be VISUAL (a recurring prop, body-language tic, setting detail).
   Establish 2–3 of them in the first 10 pages and pay one off in the final 20%.
```

**User (`buildSectionUserPrompt`, `:747-771`):**

```
CAST ROSTER (USE THESE characterIds — DO NOT INVENT):
${rosterBlock}

RELATIONSHIP GRAPH (use to seed panel groupings):
${relationshipBlock}

${userInstructions ? 'USER INSTRUCTIONS:\n' + userInstructions + '\n\n' : ''}BOOK BRIEF:
${JSON.stringify({ title, occasion, premise, tone, artStyle }, null, 2)}

### SECTION ${sectionIndex + 1} OF ${numSections}
This section covers roughly pages ${startPage}–${endPage} of a ${interiorPages}-page book.
Narrative arc position: ${arcPositionFor(sectionIndex, numSections)}.
Lean on these beat types: ${arcBeatsFor(sectionIndex, numSections)}.

STORY SO FAR (continuity — keep names, props, and ongoing gags consistent):
${continuitySummary}${coverageNudge}

Emit the `generate_comic_panel_script` function call with ONLY this section's panels: exactly ${lo}–${hi} panels (target ${PANELS_PER_SECTION}), grouped onto script pages at 4–6 panels per page. Do NOT re-emit earlier panels and do NOT plan the whole book — just this section. Keep ≤4 characterIds per panel.[ This is the FINAL section: bring the story to a satisfying close and pay off the running gags.]
```
(`coverageNudge`, when present: `UNDER-COVERED CAST (feature these prominently in this section — give them close/medium HERO panels and a spotlight beat so they reach quota by the end):` + bulleted characterIds.)

**Schema (`generate_comic_panel_script`, `:297-387`):** Top-level `pages[]` → `{page_number, panels[]}`; each panel: panel_number, shot (enum), cast[] (≤4 characterIds), is_hero_panel_for[], setting, action, beat_type (enum), shotType (wide|medium|close), dialogue[] (DIALOGUE_ITEM_SCHEMA, 1–12 words), caption (overlay, never explains the joke), sfx[] (SFX_ITEM_SCHEMA), is_splash (bool, rare). Required per panel: panel_number, shot, cast, is_hero_panel_for, setting, action, beat_type. Function description requires ≥~150 panels / ~30 pages, every roster char ≥1 panel + ≥1 spotlight + 2 hero panels, ≤4 named per panel.

## C2 — draftDialogue

- **Step/order:** C2 (dialogue pass over planned panels, batched)
- **File:** system `buildDialogueSystemPrompt` `dialoguePass.js:118-142`; user `buildDialogueUserPrompt` `:144-164`; schema `write_panel_dialogue` `:31-56`
- **Model/provider:** function call `write_panel_dialogue`; system wrapped in `buildSystemPrompt` (A0) + theme tone/writing. BATCH_SIZE 8, MAX_LINE_WORDS 12.
- **Role:** Comic dialogue writer

**System (`buildDialogueSystemPrompt`, `:122-141`):**

```
You are a comic-book dialogue writer drafting speech bubbles and captions for a comedy gift comic. Voice each line distinctly, keep bubbles SHORT, never explain the joke, and respect PG-13 limits.

${tone}

${writing}

### OUTPUT RULES
- Each bubble line: ≤${MAX_LINE_WORDS} words. Multiple bubbles per panel are fine.
- Emit each line as a structured object: { speaker (characterId), text, bubbleType, anchor }.
  bubbleType is 'speech' (normal), 'thought' (internal monologue), or 'shout' (yelling).
  anchor is the speaker's mouth position as fractions of the panel {x:0..1, y:0..1} (default {x:0.5, y:0.85}); it points the bubble tail.
- Only emit lines for characterIds listed in that panel's cast.
- If the panel is funnier silent (visual gag), emit an empty dialogue[] for it.
- Captions are optional narration/banner text ("MEANWHILE…"). Sound effects go in sfx[] ("CRASH!").
- This lettering is composited as a separate overlay LAYER — it is NOT drawn into the artwork. Write the words; do not describe how to draw them.
- Keep the lines WITTY and in-voice, and preserve running gags / continuity with the panel beat.
- Use the `write_panel_dialogue` function call. Return one entry per requested panel.
```

**User (`buildDialogueUserPrompt`, `:159-163`):**

```
CAST ROSTER:
${rosterShortBlock}

PANELS TO WRITE DIALOGUE FOR:
${panelLines}

Emit `write_panel_dialogue` with one entry per panel above (use the same page_number + panel_number). Keep each line under ${MAX_LINE_WORDS} words. Use only the characterIds listed in cast.
```
(`panelLines` per panel: page/panel number, shot, beat_type, cast names, setting, action, existing caption.)

**Schema (`write_panel_dialogue`):** panels[] (page_number, panel_number, dialogue[], caption, sfx[]; required page_number, panel_number).

## C3 — render

- **Step/order:** C3 (per-panel image render + QA)
- **File:** panel prompt `buildPanelPrompt` `panelRenderer.js:369-400`; `EMBEDDED_LETTERING_RULES` `:288-303`; face QA `panelQA.js:119-129`; text QA `panelQA.js:242-249`
- **Model/provider:** Gemini image model (img2img with reference sheets); QA uses Gemini Vision (`VISION_MODEL`, temp 0)
- **Role:** Panel renderer + lettering + vision QA

**Panel prompt (`buildPanelPrompt`, `:383-399`):**

```
Render ONE comic panel.

ART STYLE:
${styleBlock}

CHARACTERS IN THIS PANEL (img2img — condition on each attached reference sheet):
${characterPromptBlock(cast, faceForwardIds)}

SETTING: ${panel.setting || '(unspecified)'}
ACTION: ${panel.action || '(unspecified)'}
${framingInstruction(panel, faceForwardIds)}
${letteringInstruction(panel, cast)}${stricterBlock}${noteHint}

HARD RULES:
- Use ONLY the characters listed above. Do not add unnamed faces in the foreground.
- Keep every character on-model with their reference sheet (same person across panels).
- PG-13 affectionate-roast tone: no nudity, no explicit content, no graphic gore.
```
(`stricterBlock`, set on text-QA re-renders: `TEXT QA RE-RENDER — STRICTEST LETTERING: the previous render had clipped or garbled text. Make every balloon noticeably SMALLER and pull it well inside the panel (large margin from all edges). Letter the EXACT words only, spelled perfectly, with extra spacing. Absolutely no letter may touch or cross the border.` `noteHint`: `ADMIN REGEN NOTE (honor this directive):\n${promptNote}`)

**`EMBEDDED_LETTERING_RULES` (`:288-303`)** — appended via `letteringInstruction` when the panel has text:

```
LETTERING RULES (draw the text below INTO the art as part of the illustration):
- Render professional comic-book speech balloons / narration box / sound effects with the EXACT text given — hand-lettered, clearly part of the drawn page.
- Use the provided wording VERBATIM. Do NOT invent, paraphrase, translate, add, or repeat any words.
- Spell every word EXACTLY as written. Clear, evenly-sized, legible comic lettering; standard comic-book font look; high contrast (black text on a white balloon).
- Keep EVERY balloon, narration box, tail and letter FULLY INSIDE the panel with a clear margin from all four edges. Never let a balloon or any letter touch, cross, or get cropped by the panel border. Shrink or reposition balloons rather than clipping them.
- SAFE AREA: place ALL balloons, narration boxes, captions and SFX inside the CENTRAL safe area of the panel — keep every word well away from all four edges (at least ~10% of the panel width/height of clear space on every side). The outer edges may be trimmed during layout, so keep all lettering centred and clear of every border.
- Keep balloons small and the text short; place each balloon near its speaker with the tail pointing to that speaker. Do not cover any character's face with a balloon.
```
(Silent panel emits instead: `NO LETTERING: this panel has no dialogue, caption, or sound effects — draw NO text, NO speech balloons, and NO signs/labels with readable words.`)

**Face QA vision prompt (`panelQA.js:120-128`):**

```
You are a comic-book QA reviewer. The first image is a rendered comic panel drawn in a stylized comic-art style. Each following labeled image is the locked reference for one expected character. For EACH expected character, decide whether THAT person's face is present in the panel AND recognizable as the reference person. Return per-character recognizable + confidence (0..1). IMPORTANT: the panel is stylized comic art, NOT a photo — a clearly stylized but recognizable depiction of the same person (matching hair, face shape, signature features) SHOULD count as recognizable even if it is not a photo-exact likeness. Only mark NOT recognizable when the face is absent, a back-of-head, heavily obscured/cropped, or clearly a different person.

Expected characters: ${expected.map(e => `${e.name} [${e.characterId}]`).join(', ')}
```

**Text QA vision prompt (`panelQA.js:243-249`):**

```
You are a comic-book lettering QA reviewer. The image is a rendered comic panel whose speech balloons, narration box and sound effects are DRAWN INTO the art. Decide whether the panel contains the expected text, whether any balloon/letter is clipped or crosses the panel border, and whether the lettering is legible and correctly spelled. List any expected string that is missing, garbled, or misspelled.

EXPECTED TEXT (verbatim):
${expectedText.map((t, i) => `${i + 1}. "${t}"`).join('\n')}
```

## C6 — replan

- **Step/order:** C6 (re-plan specific panels — same slots)
- **File:** user `buildReplanUserPrompt` `scriptPlanner.js:1065-1087`; system reuses `buildPlannerSystemPrompt` (C1); schema `replan_comic_panels`
- **Model/provider:** function call `replan_comic_panels`
- **Role:** Targeted panel re-planner

**User (`buildReplanUserPrompt`, `:1079-1086`):**

```
CAST ROSTER (USE THESE characterIds — DO NOT INVENT):
${rosterBlock}

RELATIONSHIP GRAPH:
${relationshipBlock}

${note ? 'ADMIN STEERING NOTE:\n' + note + '\n\n' : ''}RE-PLAN ONLY THESE PANELS (keep the same page_number + panel_number slots):
${panelLines}

Emit `replan_comic_panels` with one entry per panel above. Keep ≤4 cast per panel, use only roster characterIds, and preserve continuity with the surrounding book.
```
(`panelLines` per target: `### PAGE n PANEL m` + JSON of shot, beat_type, cast, is_hero_panel_for, setting, action, caption.)

## C-theme — Comics theme fragments (`services/writer/themes/comics.js`)

Injected into C1/C2 prompts. `ComicsWriter` extends `ComedyWriter`.

**`getComicTone()` (`:28-50`):**

```
### COMIC TONE — AFFECTIONATE ROAST (PG-13)

TONE TARGET:
- The comic is a gift. Every joke is at the cast's expense the way friends roast each other: warm, specific, and recognizable. Never cruel, never humiliating, never punching down.
- "Affectionate roast" means the punchline always lands on a true, lovable quirk — the kind of detail that would make the recipient laugh out loud, not wince.
- Adult-leaning humor is welcome (innuendo, mild profanity in dialogue, hangovers, awkward dating, work frustration, parenthood chaos), but it stays PG-13.

PG-13 GUARDRAILS (HARD):
- No explicit sexual content, no nudity, no on-page sex acts. Innuendo and flirtation are fine.
- Profanity used sparingly for comic punctuation only; never slurs, never gendered/racial epithets.
- No graphic violence, no blood-spatter, no torture. Slapstick injuries (anvil, banana peel, faceplant) are fine.
- No drug glorification. Alcohol jokes (a hangover panel, a margarita gag) are acceptable.
- No real public-figure names — fictionalize celebrities the way the comedy theme already does.

AFFECTIONATE-ROAST RULES:
- Every roast must be earned by a CONCRETE trait from the cast roster (definingTrait, quirks, signatureProp). Generic stereotypes are forbidden.
- For each character we mock, give them at least one moment of genuine win or warmth. The reader should finish the book feeling the cast loves each other.
- The narrator/captions should never explain the joke. Let the panel be funny.
```

**`getStagingRules()` (`:54-87`):**

```
### COMIC STAGING RULES (HARD CONSTRAINTS)

NAMED-CAST BUDGET PER PANEL:
- HARD LIMIT: a panel may name at most **4** characters in its `cast` array.
- This is a visual-clarity rule: more than 4 distinct faces in one panel turns into mush.
- Crowd scenes are not banned, but they MUST use tiered framing:
    • foreground = the ≤4 named characters who carry the beat,
    • midground/background = unnamed silhouettes, blurred extras, or a callback to the "meet the crew" roster page ("the whole gang from page 2 is here, just smaller").
- If a beat genuinely needs >4 named characters in the same moment, SPLIT it across consecutive panels (panel A: first 4, panel B: the rest, ideally with an action cue that links them).

FACE-COVERAGE / HERO-PANEL QUOTA:
- Every named character in the roster must reach their `heroPanelsTarget` (default **2**) HERO panels across the book.
- A HERO panel is one where the character is:
    • in the foreground,
    • shot at MEDIUM or closer (no establishing/wide for hero panels),
    • clearly identifiable by face/silhouette (no back-of-head, no obscured face),
    • named in `is_hero_panel_for` for that panel.
- The planner MUST distribute hero panels across the book — do not pack one character's hero quota into a single page.

EVERY-CHARACTER GUARANTEES:
- Every character in `castRoster` appears in at least one panel's `cast` array.
- Every character gets at least one `spotlight` beat — a panel whose `beat_type` is "spotlight" and whose `is_hero_panel_for` lists that character.
- Leads (tier 1) and core (tier 2) carry the through-line; ensemble (tier 3) get fewer panels but still hit their quota.

CONTINUITY:
- The comic is ONE continuous adventure. Running gags established early must escalate and pay off, and at least one callback should land in the final 20% of the page budget.
- Signature props/colors from each character's visualLocks must read consistently across panels — if Marco always has the red mug, Marco always has the red mug.
```

**`getPlanningInstructions()` (`:91-116`)** — `super.getPlanningInstructions()` (comedy A6) + comic-script adapter:

```
### COMIC-SCRIPT PLANNING ADAPTER

You are NOT writing prose chapters. You are writing a PANEL SCRIPT — a director's blueprint for the artist who will draw every panel.

STRUCTURE:
- Pages contain panels (3–6 panels per page is typical).
- Each panel is a single frozen moment: one shot, one beat, one piece of action.
- Beats follow the comedy escalation arc (SETUP → ESCALATION → PAYOFF) but expressed as VISUAL beats — what the reader SEES, not what they read in narration.
- Running gags must be VISUAL gags: a recurring prop, a body-language tic, a setting detail.
- "Rule of three" still applies — two panels that set the pattern, a third that breaks it.
- Callbacks should pay off in a later panel by re-staging an earlier composition with a twist (same shot, different outcome).

CONTINUITY:
- The whole book is ONE adventure. No anthology of unrelated gags — every page must follow from the previous page.
- Establish 2–3 visual running gags in the first ~10 pages and escalate them.
- The emotional peak in the final 20% must be EARNED by the comedy that preceded it.
```

**`getWritingInstructions(panelOrChapterPlan)` (`:120-138`)** — `super.getWritingInstructions()` (comedy A6) + comic-bubble adapter:

```
### COMIC DIALOGUE RULES (BUBBLE-LENGTH)

- Speech bubbles are SHORT. Aim for 1–12 words per bubble; 20 is a hard ceiling.
- Stack thoughts across multiple bubbles instead of writing one long bubble.
- No internal monologue paragraphs. If a character is thinking, use a caption or a single thought bubble — never a wall of text.
- Captions are for NARRATION or SFX ("MEANWHILE…", "THREE HOURS LATER", "BANG!"). Captions never explain the joke and never re-state what the picture shows.
- Dialogue tags ("said", "muttered") do not exist in comics — the bubble tail does that.
- Voice each line so the reader can identify the speaker from word choice alone (use each character's definingTrait + signature speech pattern from the voice sheet).
- PG-13: punchy, adult-leaning, never explicit. Roast affectionately.
```

---

# FLOW D — AUDIOBOOK (`services/audiobookGenerator.js`)

**NO LLM.** This flow uses **Google Cloud Text-to-Speech**. The "prompts" below are SSML / performance / spoken-line templates, not model prompts.

**Children's-story SSML body (`buildChildrenStorySsml`, `:560-599`):** wraps performance-extracted sentences in `<speak><prosody rate="${baseRate}%">…</prosody></speak>`. Per-sentence: comma → `<break time="140ms"/>`, semicolon → `<break time="180ms"/>`, dash → `<break time="200ms"/>—`. Exclamation → `<prosody pitch="+2st"><emphasis level="strong">…</emphasis></prosody>` (tail 440ms); question → `<prosody pitch="+1st" rate="…%">…</prosody>` (tail 460ms); ellipsis → append `<break time="500ms"/>` (tail 380ms); default tail 320ms.

**Plain-text fallback (`buildChildrenStoryPlainText`, `:601-623`):** normalizes whitespace/punctuation; for lines >120 chars, inserts newlines at commas/semicolons/dashes; joins sentences with blank lines.

**Segment intros (`synthesizeSegmentIntro`, `:757-835`):** localized/UI-phrase variants plus SSML fallbacks:
- Graphic scene (`:807`): `<speak><break time="700ms"/>Scene ${sceneNumber} of ${totalScenes}.${titlePart}<break time="1200ms"/></speak>` (titlePart = `<break time="450ms"/>${escapeXml(chapterTitle)}` unless redundant); localized non-en line: `${gScene.scene} ${sceneNumber} ${gScene.of} ${totalScenes}.${titlePart}`.
- Children spread (`:818-820`): redundant/untitled → `<speak><break time="700ms"/></speak>` (or 0.7s silence WAV); titled → `<speak><break time="600ms"/>${escapeXml(chapterTitle)}<break time="900ms"/></speak>`.
- Title page (`:825`): `<speak><break time="700ms"/>Title page.<break time="1200ms"/></speak>`.
- Dedication page (`:831`): `<speak><break time="700ms"/>Dedication.<break time="1200ms"/></speak>`.

**Chapter intro (`synthesizeChapterIntro`, `:741`):** `<speak><break time="1s"/>Chapter ${chapterNumber}<break time="500ms"/>${safeTitle}<break time="1500ms"/></speak>` (plain fallback: `Chapter ${chapterNumber}... ${chapterTitle}.`).

**Intro line (`:1008-1013`):** uiPhrases.intro, else children → `${title}. ${subtitle}.` or `Let's read ${title}.`; else `${title}. ${subtitle}.` or `${title}`.

**Outro line (`:1157-1162`):** uiPhrases.outro, else children → `The end. Thank you for listening to this story.`; else `The end. ${title}. Thank you for listening.`

---

# FLOWS E & F — NO AI

- **Flow E — Cover generation (`services/coverGenerator.js`):** NO AI. Confirmed by grep — no `textCompletion`/`functionCall`/`openai`/`gemini`/`generateContent`/`anthropic` references. Pure pdf-lib / image assembly.
- **Flow F — Ebook / DOCX / PDF builders (`services/ebookEpubBuilder.js`, `ebookEpubPostProcess.js`, `ebookPdfBuilder.js`, `docxGenerator.js`, `pdfGenerator.js`):** NO AI. Confirmed by grep — no LLM/image-model calls. Deterministic document assembly only.
