import { GoogleGenerativeAI } from '@google/generative-ai';

export interface FramedQuestion {
  emoji: string;
  assessment: string;
  improvedQuestion: string;
  examples: string[];
}

const MODELS_TO_TRY = ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-flash-latest'];

const fallbackResponse: FramedQuestion = {
  emoji: '❓',
  assessment: 'Please add the subject, the exact issue, and the details people need to help.',
  improvedQuestion: 'I need help with [subject]. The specific issue is [problem]. What details or steps should I share to get a useful answer?',
  examples: [
    'I need help with [specific topic]. I tried [what I did], but [what happened].',
    'Has anyone dealt with [specific issue] in [relevant situation]? I need help with [desired outcome].'
  ]
};

function parseResponse(text: string): FramedQuestion | null {
  const jsonText = text.match(/\{[\s\S]*\}/)?.[0] || text;

  try {
    const parsed = JSON.parse(jsonText);
    if (
      typeof parsed.emoji === 'string' &&
      parsed.emoji.trim().length > 0 &&
      typeof parsed.assessment === 'string' &&
      typeof parsed.improvedQuestion === 'string' &&
      Array.isArray(parsed.examples) &&
      parsed.examples.length >= 2 &&
      parsed.examples.slice(0, 2).every((example: unknown) => typeof example === 'string')
    ) {
      return {
        emoji: parsed.emoji.trim(),
        assessment: parsed.assessment,
        improvedQuestion: parsed.improvedQuestion,
        examples: parsed.examples.slice(0, 2)
      };
    }
  } catch { /* Use the fallback response when Gemini returns invalid JSON. */ }

  return null;
}

function buildPrompt(question: string): string {
  return `
You are the group's brutally helpful expert who has seen enough vague questions to question reality.

QUESTION:
---
${question}
---

DO NOT solve it. Fix the question.

RULES:
- Understand the user's intent first.
- Preserve their intent and all mentioned subject details.
- Use SIMPLE, beginner-friendly language.
- Make it sound like a real WhatsApp/Discord group member, NOT documentation.
- If the question is vague, use maximum developer sarcasm.
- Be blunt, ruthless, witty, and concise.
- Make the missing context impossible to ignore.
- No mercy for questions with almost no useful information.
- NO cringe, dad jokes, motivational garbage, corporate AI language, or emoji spam.
- Choose exactly ONE relevant emoji for the response and return it in the "emoji" field.
- Roast the QUESTION, NEVER the user.
- If clear, only improve it slightly.
- Mention ONLY the biggest missing detail.
- Give EXACTLY 2 relevant examples.
- NEVER solve or invent details.
- ENTIRE JSON MUST stay under 400 characters.

ROAST STYLE:
- Roast vague wording such as "anyone know this?" or "help please".
- Make the missing subject, situation, or goal impossible to ignore.

OUTPUT ONLY VALID JSON:
{
  "emoji": "one relevant emoji",
  "assessment": "...",
  "improvedQuestion": "...",
  "examples": ["...", "..."]
}

FINAL CHECK:
- Easy to understand
- Maximum roast when deserved
- Exactly 2 examples
- No solution
- Valid JSON
- Under 400 characters
`;
}

async function generateWithGemini(ai: GoogleGenerativeAI, prompt: string): Promise<FramedQuestion | null> {
  for (const modelName of MODELS_TO_TRY) {
    try {
      const model = ai.getGenerativeModel({
        model: modelName,
        generationConfig: { responseMimeType: 'application/json' },
        systemInstruction: 'You are a concise, friendly question editor for any group topic. Return valid JSON only.'
      });
      const response = await model.generateContent(prompt);
      const framedQuestion = parseResponse(response.response.text());
      if (framedQuestion) return framedQuestion;
    } catch (error) {
      console.warn(`[Question] Gemini model ${modelName} failed:`, error);
    }
  }

  return null;
}

export async function frameTechnicalQuestion(question: string): Promise<FramedQuestion> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return fallbackResponse;

  const framedQuestion = await generateWithGemini(
    new GoogleGenerativeAI(apiKey),
    buildPrompt(question)
  );

  return framedQuestion || fallbackResponse;
}
