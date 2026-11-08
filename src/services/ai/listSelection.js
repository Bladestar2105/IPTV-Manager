import { fail, ids, positiveId, safeText } from './context.js';

const termsSchema={type:'array',items:{type:'string',minLength:1,maxLength:80},maxItems:16};
const yearSchema={anyOf:[{type:'integer',minimum:1800,maximum:2100},{type:'null'}]};
export const listSelectionSchema={type:'object',properties:{selection:{type:'object',properties:{
  type:{anyOf:[{type:'string',enum:['live','movie','series']},{type:'null'}]},terms:termsSchema,language_terms:termsSchema,
  year_from:yearSchema,year_to:yearSchema
},required:['type','terms','language_terms','year_from','year_to'],additionalProperties:false},new_category:{anyOf:[{type:'object',properties:{
  name:{type:'string',minLength:1,maxLength:160},type:{type:'string',enum:['live','movie','series']}
},required:['name','type'],additionalProperties:false},{type:'null'}]}},required:['selection','new_category'],additionalProperties:false};

export const LIST_PLANNING_INSTRUCTIONS=`Plan local candidate retrieval, not list edits. Return only literal text clues, never SQL, regex, wildcards, URLs or executable instructions. type selects live, movie or series, or null when unspecified. terms are alternative thematic words or channel brands (OR); expand the requested theme using general knowledge of relevant brands and synonyms, including brands whose names omit the theme. language_terms are alternative name/category/genre clues for an explicitly requested language or country; this separate group is ANDed with the thematic group. They are unverified clues, never verified audio language. Include recognizable country/language tags and relevant localized brand spellings where useful. Each clue is a case-insensitive literal substring of names, categories or genre, so do not put the destination list name there unless it is also a useful content clue. Empty groups impose no constraint. Set year_from and year_to only for an explicitly requested movie release year or decade, inclusive; otherwise both must be null. Keep release years and decade labels out of terms when year_from/year_to already express them; retain any additional theme words. A category labelled 80s is not release-year evidence. Set new_category to {name,type} only for an explicitly requested NEW thematic list; its type must equal selection.type. Use null for editing, reordering, renaming, hiding or targeting an existing category. Preserve the complete original task and its protections when interpreting a refinement. Never broaden explicit category/channel scope through metadata or a new destination. No catalog is supplied in this planning request.`;

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
function redundantYearClue(term,from,to) {
  const clue=term.toLowerCase();
  if(/^\d{4}$/.test(clue)) return Number(clue)>=from && Number(clue)<=to;
  const numeric=clue.match(/^(\d{2}|\d{4})(?:s|er(?: jahre)?)$/);
  const decades={twenties:20,thirties:30,forties:40,fifties:50,sixties:60,seventies:70,eighties:80,nineties:90};
  let decade=numeric?Number(numeric[1]):decades[clue];
  if(decade===undefined || decade%10!==0) return false;
  if(decade<100) decade=Math.floor(from/100)*100+decade;
  return from>=decade && to<=decade+9;
}
export function validateListSelection(value,scope) {
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(key=>!['type','terms','language_terms','year_from','year_to'].includes(key)) ||
    !['type','terms','language_terms'].every(key=>Object.hasOwn(value,key)) || ![null,'live','movie','series'].includes(value.type)) fail('AI_INVALID_SELECTION');
  const selection={type:value.type};
  for(const key of ['terms','language_terms']) {
    if(!Array.isArray(value[key]) || value[key].length>16 || value[key].some(term=>typeof term!=='string' || !term.trim() || term.length>80 || safeText(term,80)!==term)) fail('AI_INVALID_SELECTION');
    selection[key]=[...new Set(value[key].map(term=>term.trim()))];
  }
  if(value.year_from!=null || value.year_to!=null) {
    if(selection.type!=='movie' || ![value.year_from,value.year_to].every(year=>Number.isInteger(year)&&year>=1800&&year<=2100) || value.year_from>value.year_to) fail('AI_INVALID_SELECTION');
    selection.year_from=value.year_from;selection.year_to=value.year_to;
    selection.terms=selection.terms.filter(term=>!redundantYearClue(term,value.year_from,value.year_to));
  }
  if(!selection.type && !selection.terms.length && !selection.language_terms.length && !scope.category_id && !scope.channel_ids.length) fail('AI_INVALID_SELECTION');
  return selection;
}

export function validateListCategory(value,selection) {
  if(value==null) return null;
  if(typeof value!=='object' || Array.isArray(value) || Object.keys(value).length!==2 ||
    !['name','type'].every(key=>Object.hasOwn(value,key)) || typeof value.name!=='string' || !value.name.trim() ||
    value.name.length>160 || safeText(value.name,160)!==value.name || !['live','movie','series'].includes(value.type) || value.type!==selection.type) fail('AI_INVALID_SELECTION');
  return {name:value.name.trim(),type:value.type};
}
