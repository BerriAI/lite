export interface QuestionOption { id: string; label: string; description?: string; }
export interface QuestionRequest {
  id: string;
  sessionId: string;
  turnId: string;
  messageId: string;
  toolCallId: string;
  question: string;
  options: QuestionOption[];
  createdAt: number;
}
export type QuestionAnswer = { kind: 'option'; optionId: string } | { kind: 'text'; text: string };
export interface QuestionResolution { id: string; status: 'answered' | 'cancelled' | 'interrupted'; }
export interface AnswerReceipt { id: string; status: 'answered'; answer: QuestionAnswer; }
