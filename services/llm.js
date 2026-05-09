/**
 * services/llm.js
 *
 * Canonical text-LLM entry point for the entire worker.
 *
 * Historically the codebase carried three near-identical copies of OpenAI/
 * Gemini HTTP plumbing (`storyPlanner.js`, `services/qualityGates.js`,
 * `services/writer/themes/base.js`) plus a more sophisticated unified client
 * tucked under `services/bookPipeline/llm/openaiClient.js`. This module is the
 * single public surface; it re-exports the bookPipeline client (which has the
 * good retry/truncation/fallback/auth-error logic) so every caller goes
 * through one code path.
 *
 * Use `callText({ model, systemPrompt, userPrompt, ... })` for new code.
 * Existing files (storyPlanner, qualityGates, writer/themes/base) keep their
 * file-local `callOpenAI` / `callGeminiText` / `callLLM` function names but
 * those are now thin delegators to `callText` so behavior, telemetry, and
 * model routing live in one place.
 *
 * Image generation and vision QA stay on their own clients (different
 * provider/quality trade-offs).
 */

const {
  callText,
  LlmTransientError,
  LlmAuthError,
  LlmParseError,
  LlmTruncationError,
  parseJsonLoose,
  fetchWithTimeout,
  assertLlmConfig,
} = require('./bookPipeline/llm/openaiClient');

module.exports = {
  callText,
  LlmTransientError,
  LlmAuthError,
  LlmParseError,
  LlmTruncationError,
  parseJsonLoose,
  fetchWithTimeout,
  assertLlmConfig,
};
