import { fail, safeText } from './context.js';

export const LIST_GROUP_BATCH_SIZE=80;
export const listGroupingSchema={type:'object',properties:{selected_ids:{type:'array',items:{type:'integer',minimum:1},maxItems:LIST_GROUP_BATCH_SIZE}},required:['selected_ids'],additionalProperties:false};
const INSTRUCTIONS='Select supplied records matching the complete task for this new category. Use names, catalog clues and general knowledge of channel brands; include every matching numbered or quality variant. Catalog language labels do not verify audio. Release years have the supplied provenance; provider ratings are not IMDb scores. No external lookup has been performed. Return selected_ids only, each matching ID once, or an empty array. Do not propose other edits or explanations.';

function modelItem(item) {
  return {id:item.provider_channel_id,name:item.name,
    ...(item.original_name&&item.original_name!==item.name?{original_name:item.original_name}:{}),
    ...(item.category?{category:safeText(item.category,80)}:{}),
    ...(item.genre?{genre:safeText(item.genre,40)}:{}),
    ...(item.release_year?{release_year:item.release_year,year_source:item.year_source}:{}),
    ...(item.provider_rating!==null&&item.provider_rating!==undefined?{provider_rating:item.provider_rating,rating_source:'provider'}:{})};
}
function selectedIds(data,items) {
  if(!data||Object.keys(data).length!==1||!Array.isArray(data.selected_ids)||data.selected_ids.length>LIST_GROUP_BATCH_SIZE) fail('AI_INVALID_RESPONSE');
  const supplied=new Set(items.map(item=>item.id)),seen=new Set();
  for(const id of data.selected_ids) {
    if(!Number.isSafeInteger(id)||id<1||seen.has(id)||!supplied.has(id)) fail('AI_INVALID_CANDIDATE');
    seen.add(id);
  }
  return data.selected_ids;
}
function summary(language,count,name) {
  const text={
    de:`${count} Einträge für die neue Kategorie „${name}“ vorgeschlagen. Auswahl anhand von Kataloghinweisen; Tonspur und externe Bewertungen sind nicht bestätigt. Änderungen benötigen Bestätigung.`,
    en:`Proposed ${count} entries for the new category “${name}”. Selection uses catalog clues; audio and external ratings are unverified. Changes require confirmation.`,
    fr:`${count} entrées proposées pour la nouvelle catégorie « ${name} ». Sélection selon le catalogue ; audio et notes externes non vérifiés. Confirmation requise.`,
    el:`Προτάθηκαν ${count} εγγραφές για τη νέα κατηγορία «${name}». Η επιλογή βασίζεται στον κατάλογο· ήχος και εξωτερικές βαθμολογίες δεν επαληθεύτηκαν. Απαιτείται επιβεβαίωση.`
  };
  return text[language]||text.en;
}

export async function reviewListGrouping(context,category,{ask,fits,remainingCalls,progress,language}) {
  const selected=new Set();
  const items=[...new Map(context.items.map(item=>[item.provider_channel_id,modelItem(item)])).values()],batches=[];
  for(let offset=0;offset<items.length;) {
    let batch=items.slice(offset,offset+LIST_GROUP_BATCH_SIZE);
    while(!fits({new_category:category,items:batch},listGroupingSchema,INSTRUCTIONS)) {
      if(batch.length===1) fail('AI_CONTEXT_TOO_LARGE');
      batch=batch.slice(0,Math.ceil(batch.length/2));
    }
    batches.push(batch);offset+=batch.length;
  }
  if(!context.coverage.requires_narrowing) context.coverage.required_review_calls=batches.length;
  if(batches.length>remainingCalls) {
    const capacity=batches.slice(0,remainingCalls).reduce((count,batch)=>count+batch.length,0);
    Object.assign(context.coverage,{processed:0,partial:true,requires_narrowing:true,budget_limited:true,
      candidate_limit:capacity,expanded_candidate_limit:capacity});
    context.items=[];context.refs.length=0;
    return {actions:[],summary:''};
  }
  progress?.({stage:'processing',processed:0,total:context.items.length});
  let processed=0;
  for(const batch of batches) {
    const reply=await ask({new_category:category,items:batch},listGroupingSchema,INSTRUCTIONS);
    for(const id of selectedIds(reply.data,batch)) selected.add(id);
    processed+=batch.length;
    progress?.({stage:'processing',processed:processed===items.length?context.items.length:processed,total:context.items.length});
  }
  const actions=selected.size?[
    {type:'create_category',key:'new_list',name:category.name,category_type:category.type},
    ...[...selected].map(id=>({type:'assign_channel',provider_channel_id:id,category_key:'new_list'}))
  ]:[];
  return {actions,summary:summary(language,selected.size,category.name)};
}
