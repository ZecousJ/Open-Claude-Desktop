/** Agent questions (request_user_input); QuestionsCard shows them. */
export interface Question {
  id: string;
  header?: string;
  question: string;
  isOther?: boolean;
  isSecret?: boolean;
  options?: { label: string; description?: string }[] | null;
}

export function questionAnswers(
  questions: Question[],
  answers: Record<string, string>,
): { answers: Record<string, { answers: string[] }> } | { error: string } {
  const missing = questions.find((q) => !answers[q.id]?.trim());
  if (missing) return { error: "Answer every question to continue." };
  return {
    answers: Object.fromEntries(
      questions.map((q) => [q.id, { answers: [answers[q.id].trim()] }]),
    ),
  };
}
