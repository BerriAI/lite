/** Output styles (5.7): session-constant presentation preferences appended to
 * the SYSTEM PROMPT tail. They shape HOW the assistant writes, never WHAT it is
 * allowed to do — subordinate to safety constraints, mode, and permissions.
 * Placement rationale: the style is session configuration (like model), so it
 * lives in the byte-stable cached prefix; changing it is an idle-only config
 * change with a revision bump, exactly like changing the model or planner. */
export const OUTPUT_STYLES = {
  concise: 'Keep responses minimal: lead with the answer or the change, with no preamble and no recap of the request. Prefer short sentences, code, and file paths over prose, and skip narrating routine steps. Say only what the user needs to act.',
  explanatory: 'Explain your reasoning as you work: say why you chose this approach, what alternatives you considered, and what tradeoffs the choice carries. Name the consequences of nontrivial decisions so the user can evaluate them. Keep each explanation proportional to the weight of the decision.',
  learning: 'Teach while you work: when you use a concept, API, or pattern the user may not know, briefly explain what it is and why it fits here. Connect each change to the underlying principle so the user could apply it independently next time. Favor clarity over brevity, but never pad.',
} as const;
export type BuiltinOutputStyle = keyof typeof OUTPUT_STYLES;
/** fileBytes: custom .speedrail/styles/<name>.md files are truncated to this cap —
 * a style is a short standing preference, not a second instructions file. */
export const STYLE_LIMITS = { fileBytes: 4096, nameChars: 64 } as const;
