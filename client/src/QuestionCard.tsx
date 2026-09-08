import { useId, useRef } from 'react';
import { ArrowRight, MessageCircleQuestion, Square } from 'lucide-react';
import type { QuestionAnswer, QuestionRequest } from '../../shared/questions';

export interface QuestionDraft { optionId: string | null; custom: boolean; text: string }
export const emptyQuestionDraft = (): QuestionDraft => ({ optionId: null, custom: false, text: '' });
interface Props {
  request: QuestionRequest;
  draft: QuestionDraft;
  onChange: (draft: QuestionDraft) => void;
  onAnswer: (answer: QuestionAnswer) => Promise<void>;
  onStop: () => void;
  busy: boolean;
  disabled: boolean;
  error?: string;
}

export function QuestionCard({ request, draft, onChange, onAnswer, onStop, busy, disabled, error }: Props) {
  const id = useId(), submitting = useRef(false);
  const valid = draft.custom ? Boolean(draft.text.trim()) && draft.text.length <= 8000 : request.options.some(option => option.id === draft.optionId);
  const locked = busy || disabled;
  async function submit() {
    if (locked || !valid || submitting.current) return;
    const answer: QuestionAnswer = draft.custom ? { kind: 'text', text: draft.text.trim() } : { kind: 'option', optionId: draft.optionId! };
    submitting.current = true;
    try { await onAnswer(answer); } finally { submitting.current = false; }
  }
  return <section className="question-card" aria-label="Question from agent" aria-busy={busy}>
    <div className="question-heading"><span className="question-icon"><MessageCircleQuestion size={19} /></span><div><strong>Question from agent</strong><p>Choose a direction so I can continue.</p></div><span className="question-badge">Your input</span></div>
    <fieldset className="question-options" disabled={locked} aria-describedby={`${id}-note`}><legend>{request.question}</legend>
      {request.options.map((option, index) => <label className={`question-option ${!draft.custom && draft.optionId === option.id ? 'selected' : ''}`} key={option.id}>
        <input type="radio" name={id} value={option.id} checked={!draft.custom && draft.optionId === option.id} aria-labelledby={`${id}-option-${index}`} aria-describedby={option.description ? `${id}-description-${index}` : undefined} onChange={() => onChange({ ...draft, custom: false, optionId: option.id })} />
        <span><strong id={`${id}-option-${index}`}>{option.label}</strong>{option.description && <small id={`${id}-description-${index}`}>{option.description}</small>}</span>
      </label>)}
      <label className={`question-option custom ${draft.custom ? 'selected' : ''}`}><input type="radio" name={id} aria-label="Custom reply" checked={draft.custom} onChange={() => onChange({ ...draft, custom: true, optionId: null })} /><span><strong>Custom reply</strong><small>Share a different option or add context.</small></span></label>
      {draft.custom && <div className="question-custom"><label htmlFor={`${id}-answer`}>Custom reply</label><textarea id={`${id}-answer`} value={draft.text} rows={3} maxLength={8000} placeholder="Tell the agent what you have in mind…" onChange={event => onChange({ ...draft, text: event.target.value })} /><span>{draft.text.length.toLocaleString()} / 8,000</span></div>}
    </fieldset>
    <p className="question-note" id={`${id}-note`}>Your answer is sent to the model. It does not grant permission to run tools. Do not include passwords or API keys.</p>
    {error && <div className="question-error" role="alert">{error}</div>}
    <div className="question-actions"><button className="button secondary" disabled={disabled} onClick={onStop}><Square size={12} />Stop response</button><button className="button primary" disabled={locked || !valid} onClick={() => void submit()}>{busy ? <span className="send-loading" /> : <ArrowRight size={14} />}<span>Submit answer</span></button></div>
  </section>;
}
