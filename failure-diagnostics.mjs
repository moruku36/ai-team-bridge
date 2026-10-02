// Private failure diagnostics only; never put these messages into the audit journal.
export function redactDiagnostics(text) {
  return String(text??'').slice(0,2*1024*1024)
    .replace(/-----BEGIN [^-]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [^-]+-----/g,'[REDACTED KEY MATERIAL]')
    .replace(/\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/g,'[REDACTED TOKEN]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[REDACTED JWT]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi,'[REDACTED AUTHORIZATION]')
    .replace(/(["']?(?:[A-Za-z_]{0,64}(?:token|api[_-]?key|secret|password)|authorization|cookie|set-cookie|account[_-]?id|organi[sz]ation[_-]?id)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi,'$1[REDACTED]')
    .replace(/https?:\/\/[^\s<>"']+/gi,'[REDACTED URL]')
    .replace(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}/g,'[REDACTED EMAIL]')
    .replace(/\b(?:session_|cse_|req_)[A-Za-z0-9_-]+\b/g,'[REDACTED IDENTIFIER]');
}

export function parseProviderFailure(stdout) {
  const text=String(stdout??'');
  let value;
  try{value=JSON.parse(text);}catch{
    for(const line of text.split(/\r?\n/)) {
      try{const v=JSON.parse(line);if(v.event==='result')value=v.result;else if(v.type==='result')value=v;}catch{}
    }
  }
  if(!value||typeof value!=='object'||Array.isArray(value))return {parseable:false};
  const summary={parseable:true};
  const message=v=>redactDiagnostics(v).slice(0,4096);
  for(const field of ['type','subtype','status'])if(typeof value[field]==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(value[field]))summary[field]=value[field];
  for(const field of ['code','message','error_code','error_type'])if(typeof value[field]==='string')summary[field]=message(value[field]);
  for(const field of ['num_turns','duration_ms','duration_api_ms'])if(Number.isInteger(value[field])&&value[field]>=0)summary[field]=value[field];
  if(typeof value.stop_reason==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(value.stop_reason))summary.stop_reason=value.stop_reason;
  if(typeof value.is_error==='boolean')summary.isError=value.is_error;
  if(typeof value.error==='string')summary.error=message(value.error);
  else if(value.error&&typeof value.error==='object') {
    summary.error={};
    for(const field of ['type','code','message'])if(typeof value.error[field]==='string')summary.error[field]=message(value.error[field]);
  }
  if(Array.isArray(value.errors))summary.errors=value.errors.slice(0,16).map(v=>typeof v==='string'?message(v):{type:typeof v?.type==='string'?message(v.type):'UNKNOWN',message:typeof v?.message==='string'?message(v.message):'UNKNOWN'});
  if(value.is_error===true&&typeof value.result==='string')summary.errorResult=message(value.result);
  return summary;
}

export function diagnosticEnvelope(outcome,result) {
  const stderr=redactDiagnostics(outcome.stderr);
  return {schema:1,state:result.state,reason:result.reason,providerExitCode:Number.isInteger(outcome.exitCode)?outcome.exitCode:null,
    durationMs:Number.isFinite(outcome.durationMs)?Math.round(outcome.durationMs):0,
    outputObserved:outcome.outputObserved===true,providerOutcome:parseProviderFailure(outcome.stdout),
    stderrRedacted:stderr.slice(0,8192),stderrTruncated:stderr.length>8192,stderrSnippetLimitChars:8192,rawStdoutStored:false,rawStderrStored:false,
    redaction:'Pattern-based redaction; access remains private. Never publish diagnostic contents.'};
}
