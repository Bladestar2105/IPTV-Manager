import { fail, MAX_CANDIDATES } from './context.js';

const FEATURE_ACTIONS = {
  list: ['create_category','rename_category','assign_channel','rename_channel','hide_channel','reorder_channel'],
  cleanup: ['rename_category','rename_channel','hide_channel','reorder_channel'],
  duplicates: ['hide_channel'],
  epg: ['epg_mapping'],
  sync: ['create_category','assign_channel','rename_channel']
};
const string=(max=200)=>({type:'string',maxLength:max});
const number={type:'integer',minimum:1};
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const ACTION_SCHEMAS = [
  object({type:{type:'string',const:'create_category'},key:string(80),name:string(160),category_type:{type:'string',enum:['live','movie','series']}}),
  object({type:{type:'string',const:'rename_category'},category_id:number,value:string(160)}),
  object({type:{type:'string',const:'rename_channel'},user_channel_id:number,value:string(200)}),
  object({type:{type:'string',const:'hide_channel'},user_channel_id:number,value:{type:'boolean',const:true}}),
  object({type:{type:'string',const:'reorder_channel'},user_channel_id:number,value:{type:'integer',minimum:0,maximum:1000000}}),
  object({type:{type:'string',const:'assign_channel'},provider_channel_id:number,category_id:number}),
  object({type:{type:'string',const:'assign_channel'},provider_channel_id:number,category_key:string(80)}),
  object({type:{type:'string',const:'epg_mapping'},provider_channel_id:number,epg_channel_id:string(200),source_type:{type:'string',enum:['provider','custom']},source_id:number})
];
function actionTypes(feature) {
  if(!Object.hasOwn(FEATURE_ACTIONS,feature)) fail('AI_INVALID_ACTION');
  return FEATURE_ACTIONS[feature];
}
export function proposalSchema(feature) {
  const allowed=actionTypes(feature);
  return object({summary:string(2000),actions:{type:'array',items:{anyOf:ACTION_SCHEMAS.filter(schema=>allowed.includes(schema.properties.type.const))},maxItems:80}});
}
export function validateFeatureActions(feature,actions) {
  const allowed=actionTypes(feature);
  if(!Array.isArray(actions)||actions.length>MAX_CANDIDATES) fail('AI_INVALID_ACTIONS');
  if(actions.some(action=>!action||typeof action!=='object'||Array.isArray(action)||!allowed.includes(action.type))) fail('AI_INVALID_ACTION');
}
