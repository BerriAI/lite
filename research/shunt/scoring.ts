export const expectedAnswers: Record<string, Record<string, string | number>> = {
  'large-read': {MAX_RETRIES:7, RETRY_DELAY_MS:1750, DEFAULT_REGION:'eu-west-4', MAX_BATCH:48},
  'cross-file-read': {MAX_RETRIES:7, MAX_BATCH:48, burst:37, refillMs:2450, primary:'/relay/v3', fallback:'/relay/safe'},
  'targeted-read': {MAX_RETRIES:7, RETRY_DELAY_MS:1750, DEFAULT_REGION:'eu-west-4', MAX_BATCH:48},
  'debug-read': {authRetries:0, tempRetries:3},
};

export function correctAnswer(name: string, text: string): boolean {
  const expected=expectedAnswers[name];
  if(!expected)return false;
  const candidates=[...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(match=>match[1]);
  candidates.push(text.slice(text.indexOf('{'),text.lastIndexOf('}')+1));
  return candidates.some(candidate=>{
    try{
      const parsed=JSON.parse(candidate);
      const values=Array.isArray(parsed.exports)?Object.fromEntries(parsed.exports.map((item:{name:string;value:unknown})=>[item.name,item.value])):parsed;
      return Object.entries(expected).every(([key,value])=>values[key]===value);
    }catch{return false;}
  });
}
