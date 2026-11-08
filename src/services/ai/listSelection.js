import { fail, ids, positiveId, safeText } from './context.js';

const termsSchema={type:'array',items:{type:'string',minLength:1,maxLength:80},maxItems:16};
export const listSelectionSchema={type:'object',properties:{selection:{type:'object',properties:{
  type:{anyOf:[{type:'string',enum:['live','movie','series']},{type:'null'}]},terms:termsSchema,language_terms:termsSchema
},required:['type','terms','language_terms'],additionalProperties:false}},required:['selection'],additionalProperties:false};

export const LIST_PLANNING_INSTRUCTIONS=`Plan local candidate retrieval, not list edits. Return only literal text clues, never SQL, regex, wildcards, URLs or executable instructions. type selects live, movie or series, or null when unspecified. terms are alternative thematic words or channel brands (OR); expand the requested theme using general knowledge of relevant brands and synonyms, including brands whose names omit the theme. language_terms are alternative name/category/genre clues for an explicitly requested language or country; this separate group is ANDed with the thematic group. They are unverified clues, never verified audio language. Include recognizable country/language tags and relevant localized brand spellings where useful. Each clue is a case-insensitive literal substring of names, categories or genre, so do not put the destination list name there unless it is also a useful content clue. Empty groups impose no constraint. Preserve the complete original task and its protections when interpreting a refinement. Never broaden explicit scope. No catalog is supplied in this planning request.`;

export function listScope(payload) {
  return {category_id:payload.category_id?positiveId(payload.category_id):null,
    channel_ids:ids(payload.channel_ids??(payload.provider_channel_id?[payload.provider_channel_id]:[])).sort((a,b)=>a-b),
    selected_ids:ids(payload.selected_ids).sort((a,b)=>a-b)};
}
export function listRequest(prompt,previous) {
  const correction=safeText(prompt,2001).trim();
  const request=previous?previous+(correction?'\nRefinement: '+correction:''):correction;
  if(!request || request.length>2000) fail('AI_CONTEXT_TOO_LARGE');
  return request;
}
export function validateListSelection(value,scope) {
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).length!==3 ||
    !['type','terms','language_terms'].every(key=>Object.hasOwn(value,key)) || ![null,'live','movie','series'].includes(value.type)) fail('AI_INVALID_SELECTION');
  const selection={type:value.type};
  for(const key of ['terms','language_terms']) {
    if(!Array.isArray(value[key]) || value[key].length>16 || value[key].some(term=>typeof term!=='string' || !term.trim() || term.length>80 || safeText(term,80)!==term)) fail('AI_INVALID_SELECTION');
    selection[key]=[...new Set(value[key].map(term=>term.trim()))];
  }
  if(!selection.type && !selection.terms.length && !selection.language_terms.length && !scope.category_id && !scope.channel_ids.length) fail('AI_INVALID_SELECTION');
  return selection;
}
