import db from '../../database/db.js';
import streamManager from '../streamManager.js';
import { providerSourceKey } from '../../utils/helpers.js';
import { safeText } from './context.js';

export function unknownDiagnostics() {
  return ['stream_reachability','protocol_export_delivery','client_share_filters','epg_program_delivery',
    'upstream_connection_limits','playback_health','selected_session_identity']
    .map(code=>({code,certainty:'unknown',reason:'not_measured'}));
}

async function userConnections(userId,limit) {
  const observedAt=Date.now();
  try {
    let rows,backend;
    // The usual StreamManager readers clean up stale sessions. Diagnosis must only observe.
    if(streamManager.redis) {
      backend='redis';
      rows=Object.values(await streamManager.redis.hGetAll('iptv:streams')).map(value=>JSON.parse(value)).filter(row=>Number(row.user_id)===userId);
    } else if(streamManager.db) {
      backend='sqlite';
      rows=streamManager.db.prepare('SELECT id,user_id,channel_name,ip,provider_id,start_time,last_activity,worker_pid FROM current_streams WHERE user_id=?').all(userId);
    } else return {code:'local_user_connections',certainty:'unknown',reason:'session_store_unavailable'};
    const active=rows.filter(row=>!streamManager.isStale(row,observedAt));
    const count=new Set(active.map(row=>JSON.stringify([row.channel_name,row.ip,row.provider_id]))).size;
    return {code:'local_user_connections',certainty:'proven',value:{scope:'recorded_user_sessions',backend,
      active_sessions:count,configured_limit:limit,limit_reached:limit>0&&count>=limit,
      stale_records_ignored:rows.length-active.length,observed_at:observedAt}};
  } catch {
    return {code:'local_user_connections',certainty:'unknown',reason:'session_store_unavailable'};
  }
}

export async function localDiagnosis(context) {
  const user=db.prepare('SELECT max_connections,hdhr_enabled FROM users WHERE id=?').get(context.userId);
  const connections=await userConnections(context.userId,user.max_connections);
  const findings=[
    {code:'visible_channels',certainty:'proven',value:context.rows.filter(row=>row.user_channel_id&&!row.is_hidden).length},
    {code:'epg_mapping_missing',certainty:'proven',value:context.rows.filter(row=>row.stream_type==='live'&&!row.manual_epg_id&&!row.epg_channel_id).length},
    connections,...unknownDiagnostics()
  ];
  if(connections.value?.limit_reached) findings.push({code:'new_connection_may_be_blocked',certainty:'possible',
    reason:'local_limit_reached_but_existing_session_reuse_may_be_allowed'});
  // Bound the detailed preview; aggregate counts above still cover the entire context page.
  for(const row of context.rows.slice(0,40)) {
    const assigned=Boolean(row.user_channel_id),visible=assigned&&!row.is_hidden;
    let episodes=null;
    if(row.stream_type==='series') {
      const source=db.prepare('SELECT p.url,pc.remote_stream_id FROM provider_channels pc JOIN providers p ON p.id=pc.provider_id WHERE pc.id=?').get(row.provider_channel_id);
      episodes=Boolean(db.prepare('SELECT 1 FROM provider_series_episodes WHERE source_key=? AND series_remote_id=? LIMIT 1').get(providerSourceKey(source.url),source.remote_stream_id));
    }
    const epgId=row.manual_epg_id||row.epg_channel_id;
    findings.push({code:'channel_diagnostics',certainty:'proven',value:{provider_channel_id:row.provider_channel_id,
      user_channel_id:row.user_channel_id,category_id:row.user_category_id,name:safeText(row.custom_name||row.name,200),
      assigned,hidden:Boolean(row.is_hidden),
      local_export_filters:{scope:'account_catalog',account_catalog:visible,content_type:row.stream_type,
        m3u_playlist:visible&&episodes!==false,series_episodes_cached:episodes,
        hdhr_enabled:Boolean(user.hdhr_enabled),hdhr_lineup:visible&&row.stream_type==='live'&&Boolean(user.hdhr_enabled)},
      epg_mapping:row.stream_type==='live'?{configured:Boolean(epgId),origin:epgId?(row.manual_epg_id?'manual':'provider'):null,
        epg_channel_id:epgId?safeText(epgId,200):null}:null}});
  }
  return {findings,coverage:{diagnostic_entries_total:context.rows.length,
    diagnostic_entries_shown:Math.min(context.rows.length,40),diagnostic_entries_partial:context.rows.length>40}};
}
